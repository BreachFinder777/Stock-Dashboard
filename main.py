"""
Stock Analytics API v2.1 — Yahoo rate-limit safe
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import yfinance as yf
from fastapi import (
    FastAPI,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# ── Logging ──────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("stock-api")


# ══════════════════════════════════════════
#  YAHOO FINANCE RATE LIMIT CONFIG
# ══════════════════════════════════════════
# Yahoo allows roughly 2000 requests/hour
# Safe budget: ~30 requests/minute max

YAHOO_MIN_GAP = 2.0          # minimum seconds between ANY yfinance call
_last_yahoo_call = 0.0        # timestamp of last call


def yahoo_throttle():
    """Global throttle — ensures we never call Yahoo too fast."""
    global _last_yahoo_call
    now = time.time()
    wait = YAHOO_MIN_GAP - (now - _last_yahoo_call)
    if wait > 0:
        time.sleep(wait)
    _last_yahoo_call = time.time()


def safe_history(ticker_str: str, **kwargs) -> pd.DataFrame:
    """Rate-limited wrapper around yf.Ticker().history()"""
    yahoo_throttle()
    try:
        return yf.Ticker(ticker_str).history(**kwargs)
    except Exception as e:
        if "Too Many Requests" in str(e) or "Rate" in str(e):
            log.warning(f"Yahoo rate limited, waiting 30s...")
            time.sleep(30)
            return yf.Ticker(ticker_str).history(**kwargs)
        raise


# ── Cache ────────────────────────────────
class TTLCache:
    def __init__(self, max_size=300):
        self._store: Dict[str, Tuple[float, Any]] = {}
        self._max = max_size

    def get(self, key: str):
        entry = self._store.get(key)
        if not entry:
            return None
        if time.time() >= entry[0]:
            del self._store[key]
            return None
        return entry[1]

    def set(self, key: str, value, ttl=60):
        if len(self._store) >= self._max:
            now = time.time()
            self._store = {
                k: v for k, v in self._store.items() if v[0] > now
            }
        self._store[key] = (time.time() + ttl, value)

    @property
    def size(self):
        return len(self._store)


cache = TTLCache()


# ── Rate Limiter (for API clients) ───────
class RateLimiter:
    def __init__(self, limit=60, window=60):
        self._hits: Dict[str, List[float]] = defaultdict(list)
        self._limit = limit
        self._window = window

    def allow(self, client: str) -> bool:
        now = time.time()
        cutoff = now - self._window
        self._hits[client] = [
            t for t in self._hits[client] if t > cutoff
        ]
        if len(self._hits[client]) >= self._limit:
            return False
        self._hits[client].append(now)
        return True


limiter = RateLimiter()


# ── Technical Analysis ───────────────────
class TA:
    @staticmethod
    def rsi(close: pd.Series, period=14) -> pd.Series:
        delta = close.diff()
        gain = delta.clip(lower=0)
        loss = (-delta).clip(lower=0)
        avg_gain = gain.ewm(
            alpha=1 / period, min_periods=period, adjust=False
        ).mean()
        avg_loss = loss.ewm(
            alpha=1 / period, min_periods=period, adjust=False
        ).mean()
        rs = avg_gain / avg_loss.replace(0, 1e-10)
        return 100 - (100 / (1 + rs))

    @staticmethod
    def sma(close, period):
        return close.rolling(window=period).mean()

    @staticmethod
    def ema(close, period):
        return close.ewm(span=period, adjust=False).mean()

    @staticmethod
    def macd(close, fast=12, slow=26, signal=9):
        ema_f = close.ewm(span=fast, adjust=False).mean()
        ema_s = close.ewm(span=slow, adjust=False).mean()
        macd_line = ema_f - ema_s
        sig_line = macd_line.ewm(span=signal, adjust=False).mean()
        hist = macd_line - sig_line
        return macd_line, sig_line, hist

    @staticmethod
    def bollinger(close, period=20, std=2.0):
        mid = close.rolling(window=period).mean()
        s = close.rolling(window=period).std()
        return mid + std * s, mid, mid - std * s

    @staticmethod
    def vwap(df):
        tp = (df["High"] + df["Low"] + df["Close"]) / 3
        cum = (tp * df["Volume"]).cumsum()
        vol = df["Volume"].cumsum().replace(0, 1e-10)
        return cum / vol

    @staticmethod
    def atr(df, period=14):
        tr = pd.concat([
            df["High"] - df["Low"],
            (df["High"] - df["Close"].shift()).abs(),
            (df["Low"] - df["Close"].shift()).abs(),
        ], axis=1).max(axis=1)
        return tr.rolling(window=period).mean()

    @staticmethod
    def stochastic(df, k=14, d=3):
        low_k = df["Low"].rolling(k).min()
        high_k = df["High"].rolling(k).max()
        stoch_k = 100 * (df["Close"] - low_k) / (
            high_k - low_k
        ).replace(0, 1e-10)
        stoch_d = stoch_k.rolling(d).mean()
        return stoch_k, stoch_d

    @staticmethod
    def obv(df):
        direction = np.sign(df["Close"].diff())
        return (direction * df["Volume"]).fillna(0).cumsum()

    @classmethod
    def enrich(cls, df):
        out = df.copy()
        c = out["Close"]
        out["rsi_14"] = cls.rsi(c)
        out["sma_20"] = cls.sma(c, 20)
        out["sma_50"] = cls.sma(c, 50)
        out["ema_12"] = cls.ema(c, 12)
        out["ema_26"] = cls.ema(c, 26)
        out["macd"], out["macd_signal"], out["macd_histogram"] = cls.macd(c)
        out["bb_upper"], out["bb_middle"], out["bb_lower"] = cls.bollinger(c)
        out["vwap"] = cls.vwap(out)
        out["atr_14"] = cls.atr(out)
        out["stoch_k"], out["stoch_d"] = cls.stochastic(out)
        out["obv"] = cls.obv(out)
        return out


# ── Signal Engine ────────────────────────
class SignalEngine:
    @classmethod
    def evaluate(cls, df):
        if len(df) < 2:
            return []

        cur = df.iloc[-1]
        prev = df.iloc[-2]
        price = float(cur["Close"])
        signals = []

        def safe(col):
            v = cur.get(col)
            return float(v) if pd.notnull(v) else None

        # RSI
        rsi = safe("rsi_14")
        if rsi is not None:
            if rsi < 30:
                signals.append({"indicator": "RSI", "signal": "BUY",
                                "value": round(rsi, 1),
                                "detail": f"RSI {rsi:.1f} — oversold"})
            elif rsi > 70:
                signals.append({"indicator": "RSI", "signal": "SELL",
                                "value": round(rsi, 1),
                                "detail": f"RSI {rsi:.1f} — overbought"})
            else:
                signals.append({"indicator": "RSI", "signal": "NEUTRAL",
                                "value": round(rsi, 1),
                                "detail": f"RSI {rsi:.1f} — neutral"})

        # MACD
        m, ms_ = safe("macd"), safe("macd_signal")
        pm = prev.get("macd")
        ps = prev.get("macd_signal")
        if all(pd.notnull(v) for v in [m, ms_, pm, ps]):
            pm, ps = float(pm), float(ps)
            if pm <= ps and m > ms_:
                signals.append({"indicator": "MACD", "signal": "BUY",
                                "value": round(m, 4),
                                "detail": "Bullish crossover"})
            elif pm >= ps and m < ms_:
                signals.append({"indicator": "MACD", "signal": "SELL",
                                "value": round(m, 4),
                                "detail": "Bearish crossover"})
            else:
                signals.append({
                    "indicator": "MACD",
                    "signal": "BUY" if m > ms_ else "SELL",
                    "value": round(m, 4),
                    "detail": f"MACD {'above' if m > ms_ else 'below'} signal",
                })

        # Bollinger
        bbu, bbl = safe("bb_upper"), safe("bb_lower")
        if bbu and bbl:
            if price >= bbu:
                signals.append({"indicator": "Bollinger", "signal": "SELL",
                                "detail": "Price at upper band"})
            elif price <= bbl:
                signals.append({"indicator": "Bollinger", "signal": "BUY",
                                "detail": "Price at lower band"})
            else:
                signals.append({"indicator": "Bollinger",
                                "signal": "NEUTRAL",
                                "detail": "Price inside bands"})

        # Stochastic
        sk = safe("stoch_k")
        if sk is not None:
            if sk < 20:
                signals.append({"indicator": "Stochastic", "signal": "BUY",
                                "value": round(sk, 1),
                                "detail": f"%K {sk:.1f} — oversold"})
            elif sk > 80:
                signals.append({"indicator": "Stochastic", "signal": "SELL",
                                "value": round(sk, 1),
                                "detail": f"%K {sk:.1f} — overbought"})
            else:
                signals.append({"indicator": "Stochastic",
                                "signal": "NEUTRAL",
                                "value": round(sk, 1),
                                "detail": f"%K {sk:.1f}"})

        # VWAP
        vw = safe("vwap")
        if vw:
            signals.append({
                "indicator": "VWAP",
                "signal": "BUY" if price > vw else "SELL",
                "value": round(vw, 2),
                "detail": f"Price {'above' if price > vw else 'below'} VWAP",
            })

        return signals


# ── WebSocket Manager ────────────────────
class WSManager:
    def __init__(self):
        self._pool: Dict[str, List[WebSocket]] = defaultdict(list)

    async def connect(self, ticker, ws):
        await ws.accept()
        self._pool[ticker].append(ws)
        log.info(f"WS+ {ticker} (total {self.count})")

    def disconnect(self, ticker, ws):
        if ws in self._pool.get(ticker, []):
            self._pool[ticker].remove(ws)
        if ticker in self._pool and not self._pool[ticker]:
            del self._pool[ticker]
        log.info(f"WS- {ticker} (total {self.count})")

    async def broadcast(self, ticker, payload):
        dead = []
        for ws in self._pool.get(ticker, []):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            if ws in self._pool.get(ticker, []):
                self._pool[ticker].remove(ws)

    @property
    def count(self):
        return sum(len(v) for v in self._pool.values())


ws_mgr = WSManager()


# ── Helper ───────────────────────────────
def safe_round(val, decimals=2):
    if pd.notnull(val):
        return round(float(val), decimals)
    return None


def time_fmt(idx, interval):
    intraday = interval in ("1m", "2m", "5m", "15m", "30m", "1h")
    return idx.strftime("%H:%M") if intraday else idx.strftime("%Y-%m-%d")


# ══════════════════════════════════════════
#  CACHED DATA FETCHER (single source of truth)
# ══════════════════════════════════════════

def fetch_enriched(ticker: str, period: str, interval: str) -> pd.DataFrame:
    """
    Single function for ALL data fetching.
    Uses cache so multiple features share the same Yahoo call.
    """
    key = f"df:{ticker}:{period}:{interval}"
    hit = cache.get(key)
    if hit is not None:
        return hit

    log.info(f"Yahoo fetch: {ticker} {period}/{interval}")
    df = safe_history(ticker, period=period, interval=interval)

    if df.empty:
        raise HTTPException(404, f"No data for {ticker}")

    df = TA.enrich(df)

    # Cache longer for slower timeframes
    ttl = 30 if interval in ("1m", "5m") else 90 if interval in ("15m", "30m") else 180
    cache.set(key, df, ttl)
    return df


def fetch_quote_data(ticker: str) -> dict:
    """Cached quote — reuses data, single Yahoo call."""
    key = f"quote:{ticker}"
    hit = cache.get(key)
    if hit is not None:
        return hit

    log.info(f"Yahoo quote: {ticker}")
    yahoo_throttle()
    stock = yf.Ticker(ticker)
    hist = stock.history(period="5d")

    if hist.empty:
        raise HTTPException(404, f"No data for {ticker}")

    last_row = hist.iloc[-1]
    prev_close = float(hist["Close"].iloc[-2]) if len(hist) > 1 else 0
    price = float(last_row["Close"])
    change = price - prev_close
    pct = (change / prev_close * 100) if prev_close else 0

    # info can fail — that's ok
    info = {}
    try:
        info = stock.info or {}
    except Exception:
        pass

    result = {
        "ticker": ticker,
        "price": round(price, 2),
        "change": round(change, 2),
        "change_percent": round(pct, 2),
        "open": round(float(last_row["Open"]), 2),
        "high": round(float(last_row["High"]), 2),
        "low": round(float(last_row["Low"]), 2),
        "prev_close": round(prev_close, 2),
        "volume": int(last_row["Volume"]),
        "market_cap": info.get("marketCap"),
        "pe_ratio": info.get("trailingPE"),
        "week_52_high": info.get("fiftyTwoWeekHigh"),
        "week_52_low": info.get("fiftyTwoWeekLow"),
        "timestamp": datetime.now().isoformat(),
    }

    cache.set(key, result, 60)  # cache quote for 60s
    return result


# ══════════════════════════════════════════
#  APP
# ══════════════════════════════════════════
BOOT = time.time()

app = FastAPI(title="Stock Analytics API", version="2.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    ip = request.client.host if request.client else "unknown"
    if not limiter.allow(ip):
        return JSONResponse(429, {"detail": "Rate limit exceeded"})
    t0 = time.time()
    response = await call_next(request)
    ms = (time.time() - t0) * 1000
    log.info(f"{request.method} {request.url.path} -> {response.status_code} ({ms:.0f}ms)")
    return response


# ── Health ───────────────────────────────
@app.get("/health")
def health():
    return {
        "status": "healthy",
        "uptime": round(time.time() - BOOT, 1),
        "cache_size": cache.size,
        "ws_connections": ws_mgr.count,
    }


# ── Chart ────────────────────────────────
@app.get("/api/stock/{ticker}/chart")
def get_chart(
    ticker: str,
    period: str = Query("1d"),
    interval: str = Query("5m"),
):
    ticker = ticker.upper()
    key = f"chart:{ticker}:{period}:{interval}"
    hit = cache.get(key)
    if hit is not None:
        return hit

    try:
        df = fetch_enriched(ticker, period, interval)

        data = []
        for idx, r in df.iterrows():
            data.append({
                "time": time_fmt(idx, interval),
                "open": round(float(r["Open"]), 2),
                "high": round(float(r["High"]), 2),
                "low": round(float(r["Low"]), 2),
                "close": round(float(r["Close"]), 2),
                "volume": int(r["Volume"]),
                "indicators": {
                    "rsi_14": safe_round(r.get("rsi_14")),
                    "sma_20": safe_round(r.get("sma_20")),
                    "sma_50": safe_round(r.get("sma_50")),
                    "ema_12": safe_round(r.get("ema_12")),
                    "ema_26": safe_round(r.get("ema_26")),
                    "macd": safe_round(r.get("macd"), 4),
                    "macd_signal": safe_round(r.get("macd_signal"), 4),
                    "macd_histogram": safe_round(r.get("macd_histogram"), 4),
                    "bb_upper": safe_round(r.get("bb_upper")),
                    "bb_middle": safe_round(r.get("bb_middle")),
                    "bb_lower": safe_round(r.get("bb_lower")),
                    "vwap": safe_round(r.get("vwap")),
                    "atr_14": safe_round(r.get("atr_14"), 4),
                    "stoch_k": safe_round(r.get("stoch_k")),
                    "stoch_d": safe_round(r.get("stoch_d")),
                    "obv": safe_round(r.get("obv"), 0),
                },
            })

        result = {
            "ticker": ticker,
            "period": period,
            "interval": interval,
            "points": len(data),
            "data": data,
        }

        ttl = 30 if interval in ("1m", "5m", "15m") else 120
        cache.set(key, result, ttl)
        return result

    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Chart error: {e}")
        raise HTTPException(500, f"Error fetching {ticker}: {str(e)}")


# ── Quote ────────────────────────────────
@app.get("/api/stock/{ticker}/quote")
def get_quote(ticker: str):
    ticker = ticker.upper()
    try:
        return fetch_quote_data(ticker)
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Quote error: {e}")
        raise HTTPException(500, str(e))


# ── Info ─────────────────────────────────
@app.get("/api/stock/{ticker}/info")
def get_info(ticker: str):
    ticker = ticker.upper()
    key = f"info:{ticker}"
    hit = cache.get(key)
    if hit is not None:
        return hit

    try:
        log.info(f"Yahoo info: {ticker}")
        yahoo_throttle()
        info = yf.Ticker(ticker).info or {}

        if not info or "shortName" not in info:
            return {"ticker": ticker, "name": ticker}

        result = {
            "ticker": ticker,
            "name": info.get("longName") or info.get("shortName", ticker),
            "sector": info.get("sector"),
            "industry": info.get("industry"),
            "country": info.get("country"),
            "website": info.get("website"),
            "description": info.get("longBusinessSummary"),
            "employees": info.get("fullTimeEmployees"),
            "market_cap": info.get("marketCap"),
            "pe_ratio": info.get("trailingPE"),
            "forward_pe": info.get("forwardPE"),
            "dividend_yield": info.get("dividendYield"),
            "beta": info.get("beta"),
            "week_52_high": info.get("fiftyTwoWeekHigh"),
            "week_52_low": info.get("fiftyTwoWeekLow"),
            "avg_volume": info.get("averageVolume"),
            "exchange": info.get("exchange"),
        }

        cache.set(key, result, 600)
        return result

    except Exception as e:
        log.error(f"Info error: {e}")
        return {"ticker": ticker, "name": ticker}


# ── Signals ──────────────────────────────
@app.get("/api/stock/{ticker}/signals")
def get_signals(
    ticker: str,
    period: str = Query("1mo"),
    interval: str = Query("1d"),
):
    ticker = ticker.upper()
    try:
        df = fetch_enriched(ticker, period, interval)
        sigs = SignalEngine.evaluate(df)

        buys = sum(1 for s in sigs if s["signal"] == "BUY")
        sells = sum(1 for s in sigs if s["signal"] == "SELL")
        neutrals = sum(1 for s in sigs if s["signal"] == "NEUTRAL")

        overall = "BUY" if buys > sells else "SELL" if sells > buys else "NEUTRAL"

        return {
            "ticker": ticker,
            "timestamp": datetime.now().isoformat(),
            "overall": overall,
            "buy_count": buys,
            "sell_count": sells,
            "neutral_count": neutrals,
            "signals": sigs,
        }

    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Signals error: {e}")
        raise HTTPException(500, str(e))


# ── Fibonacci ────────────────────────────
@app.get("/api/stock/{ticker}/fibonacci")
def get_fibonacci(ticker: str, period: str = Query("3mo")):
    ticker = ticker.upper()
    try:
        df = fetch_enriched(ticker, period, "1d")

        hi = float(df["High"].max())
        lo = float(df["Low"].min())
        diff = hi - lo

        return {
            "ticker": ticker,
            "period": period,
            "levels": {
                "0.0%": round(hi, 2),
                "23.6%": round(hi - 0.236 * diff, 2),
                "38.2%": round(hi - 0.382 * diff, 2),
                "50.0%": round(hi - 0.500 * diff, 2),
                "61.8%": round(hi - 0.618 * diff, 2),
                "78.6%": round(hi - 0.786 * diff, 2),
                "100.0%": round(lo, 2),
            },
        }

    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Fibonacci error: {e}")
        raise HTTPException(500, str(e))


# ── Search ───────────────────────────────
@app.get("/api/search/{query}")
def search_stocks(query: str, limit: int = Query(8)):
    key = f"search:{query.lower()}"
    hit = cache.get(key)
    if hit is not None:
        return hit

    results = []

    try:
        yahoo_throttle()
        search = yf.Search(query, max_results=limit)
        for q in search.quotes:
            results.append({
                "symbol": q.get("symbol", ""),
                "name": (
                    q.get("longname") or q.get("shortname")
                    or q.get("longName") or q.get("shortName") or "N/A"
                ),
                "exchange": q.get("exchange"),
                "type": q.get("quoteType"),
            })
    except Exception as e:
        log.warning(f"Search failed: {e}, trying direct lookup")
        try:
            t = query.upper()
            yahoo_throttle()
            hist = yf.Ticker(t).history(period="1d")
            if not hist.empty:
                results.append({
                    "symbol": t, "name": t,
                    "exchange": None, "type": "EQUITY",
                })
        except Exception:
            pass

    cache.set(key, results, 300)
    return results


# ── Compare ──────────────────────────────
@app.get("/api/compare")
def compare_stocks(
    tickers: str = Query(...),
    period: str = Query("3mo"),
):
    symbols = [t.strip().upper() for t in tickers.split(",") if t.strip()]
    if len(symbols) < 2:
        raise HTTPException(400, "Need at least 2 tickers")
    if len(symbols) > 10:
        raise HTTPException(400, "Max 10 tickers")

    try:
        yahoo_throttle()
        raw = yf.download(
            symbols, period=period, interval="1d",
            group_by="ticker", progress=False,
        )

        if raw.empty:
            raise HTTPException(404, "No data")

        closes = pd.DataFrame()
        for sym in symbols:
            try:
                col = raw[sym]["Close"].dropna() if len(symbols) > 1 else raw["Close"].dropna()
                closes[sym] = col
            except (KeyError, Exception):
                continue

        if closes.empty:
            raise HTTPException(404, "No valid data")

        normalised = (closes / closes.iloc[0]) * 100
        corr = closes.pct_change().dropna().corr()

        chart_data = []
        for d in normalised.index:
            point = {"date": d.strftime("%Y-%m-%d")}
            for s in normalised.columns:
                v = normalised.loc[d, s]
                if pd.notnull(v):
                    point[s] = round(float(v), 2)
            chart_data.append(point)

        performance = {}
        for sym in closes.columns:
            s = closes[sym].dropna()
            if len(s) < 2:
                continue
            ret = ((s.iloc[-1] / s.iloc[0]) - 1) * 100
            vol = s.pct_change().std() * (252 ** 0.5) * 100
            performance[sym] = {
                "return_pct": round(float(ret), 2),
                "volatility_pct": round(float(vol), 2),
                "start": round(float(s.iloc[0]), 2),
                "end": round(float(s.iloc[-1]), 2),
                "high": round(float(s.max()), 2),
                "low": round(float(s.min()), 2),
            }

        corr_matrix = {
            r: {c: round(float(corr.loc[r, c]), 4) for c in corr.columns}
            for r in corr.index
        }

        return {
            "tickers": symbols, "period": period,
            "chart": chart_data, "correlation": corr_matrix,
            "performance": performance,
        }

    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Compare error: {e}")
        raise HTTPException(500, str(e))


# ── Market Overview ──────────────────────
@app.get("/api/market/overview")
def market_overview():
    key = "market:overview"
    hit = cache.get(key)
    if hit is not None:
        return hit

    market = {
        "indices": ["^GSPC", "^DJI", "^IXIC", "^BSESN", "^NSEI"],
        "mega_cap": [
            "RELIANCE.NS", "TCS.NS", "HDFCBANK.NS",
            "INFY.NS", "SBIN.NS", "BHEL.NS",
        ],
    }

    all_syms = [s for group in market.values() for s in group]

    try:
        yahoo_throttle()
        raw = yf.download(
            all_syms, period="5d", interval="1d",
            group_by="ticker", progress=False,
        )
    except Exception as e:
        log.error(f"Market error: {e}")
        return {"indices": [], "mega_cap": []}

    result = {}
    for category, syms in market.items():
        items = []
        for sym in syms:
            try:
                df = raw[sym] if len(all_syms) > 1 else raw
                df = df.dropna()
                if len(df) < 2:
                    continue
                price = float(df["Close"].iloc[-1])
                prev = float(df["Close"].iloc[-2])
                items.append({
                    "symbol": sym,
                    "price": round(price, 2),
                    "change": round(price - prev, 2),
                    "change_pct": round((price - prev) / prev * 100, 2),
                    "volume": int(df["Volume"].iloc[-1]),
                })
            except Exception:
                continue
        result[category] = items

    cache.set(key, result, 120)  # cache 2 min
    return result


# ── Legacy ───────────────────────────────
@app.get("/api/stock/{ticker}")
def legacy_stock(ticker: str):
    ticker = ticker.upper()
    try:
        df = fetch_enriched(ticker, "1d", "1m")

        data = []
        for idx, r in df.iterrows():
            data.append({
                "time": idx.strftime("%H:%M"),
                "price": round(float(r["Close"]), 2),
                "volume": int(r["Volume"]),
                "rsi": safe_round(r.get("rsi_14")),
            })

        return {"ticker": ticker, "data": data}

    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Legacy error: {e}")
        raise HTTPException(500, str(e))


# ══════════════════════════════════════════
#  WEBSOCKET — FIXED (no more rate limiting)
# ══════════════════════════════════════════

WS_POLL_INTERVAL = 60  # seconds between Yahoo calls (was 5!)

@app.websocket("/ws/{ticker}")
async def live_stream(ws: WebSocket, ticker: str):
    """
    Streams price updates every 60 seconds.
    
    FIXES:
    - Poll every 60s instead of 5s (12x fewer requests)
    - Single Yahoo call instead of 2
    - Uses cache so multiple WS clients share same data
    - Exponential backoff on errors
    """
    ticker = ticker.upper()
    await ws_mgr.connect(ticker, ws)

    consecutive_errors = 0
    MAX_ERRORS = 5

    try:
        while True:
            try:
                # ── Use CACHED quote (0 or 1 Yahoo call) ──
                quote = fetch_quote_data(ticker)

                # ── Get RSI from cached chart data ──
                rsi_val = None
                try:
                    chart_key = f"df:{ticker}:1d:5m"
                    df = cache.get(chart_key)
                    if df is not None and not df.empty:
                        last_rsi = df["rsi_14"].iloc[-1]
                        if pd.notnull(last_rsi):
                            rsi_val = round(float(last_rsi), 2)
                except Exception:
                    pass

                payload = {
                    "ticker":     ticker,
                    "price":      quote["price"],
                    "change":     quote["change"],
                    "change_pct": quote["change_percent"],
                    "volume":     quote["volume"],
                    "high":       quote["high"],
                    "low":        quote["low"],
                    "rsi":        rsi_val,
                    "timestamp":  datetime.now().isoformat(),
                }

                await ws_mgr.broadcast(ticker, payload)
                consecutive_errors = 0  # reset on success

            except Exception as e:
                consecutive_errors += 1
                log.error(
                    f"WS error ({ticker}) "
                    f"[{consecutive_errors}/{MAX_ERRORS}]: {e}"
                )

                if consecutive_errors >= MAX_ERRORS:
                    log.warning(
                        f"WS {ticker}: too many errors, "
                        f"backing off 120s"
                    )
                    await asyncio.sleep(120)
                    consecutive_errors = 0
                    continue

            # ── Wait for next cycle ──
            # Listen for pings OR timeout after interval
            backoff = min(
                WS_POLL_INTERVAL * (2 ** consecutive_errors),
                300  # max 5 minutes
            )
            try:
                await asyncio.wait_for(
                    ws.receive_text(),
                    timeout=backoff,
                )
            except asyncio.TimeoutError:
                pass

    except WebSocketDisconnect:
        ws_mgr.disconnect(ticker, ws)
    except Exception:
        ws_mgr.disconnect(ticker, ws)


# ── Startup ──────────────────────────────
@app.on_event("startup")
async def startup():
    log.info("=" * 50)
    log.info("  Stock Analytics API v2.1")
    log.info("  Yahoo rate-limit safe")
    log.info("  WS poll: every 60s (not 5s)")
    log.info("  http://127.0.0.1:8000/docs")
    log.info("=" * 50)


# ── Run ──────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8000,
        log_level="info",
    )