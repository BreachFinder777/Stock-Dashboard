import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  ComposedChart,
  Line,
  Bar,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
  Cell,
} from "recharts";

/* ════════════════════════════════════════════════════════
   CONFIGURATION
   ════════════════════════════════════════════════════════ */

const API = "https://stock-dashboard-production-a827.up.railway.app/";
const WS  = "https://stock-dashboard-production-a827.up.railway.app/";

const PERIODS = [
  { label: "1D",  value: "1d"  },
  { label: "5D",  value: "5d"  },
  { label: "1M",  value: "1mo" },
  { label: "3M",  value: "3mo" },
  { label: "6M",  value: "6mo" },
  { label: "1Y",  value: "1y"  },
  { label: "2Y",  value: "2y"  },
  { label: "YTD", value: "ytd" },
];

const INTERVAL_MAP = {
  "1d":  ["1m","5m","15m"],
  "5d":  ["5m","15m","30m","1h"],
  "1mo": ["30m","1h","1d"],
  "3mo": ["1d","1wk"],
  "6mo": ["1d","1wk"],
  "1y":  ["1d","1wk"],
  "2y":  ["1wk","1mo"],
  "ytd": ["1d","1wk"],
};

const DEFAULT_INTERVAL = {
  "1d":"5m","5d":"15m","1mo":"1d","3mo":"1d",
  "6mo":"1d","1y":"1wk","2y":"1wk","ytd":"1d",
};

const QUICK_STOCKS = [
  { name: "Reliance", ticker: "RELIANCE.NS" },
  { name: "TCS",      ticker: "TCS.NS"      },
  { name: "SBI",      ticker: "SBIN.NS"     },
  { name: "HDFC",     ticker: "HDFCBANK.NS" },
  { name: "Infosys",  ticker: "INFY.NS"     },
  { name: "BHEL",     ticker: "BHEL.NS"     },
];

const OVERLAYS = [
  { key: "sma20",  label: "SMA 20",    color: "#fbbf24" },
  { key: "sma50",  label: "SMA 50",    color: "#fb923c" },
  { key: "ema12",  label: "EMA 12",    color: "#34d399" },
  { key: "ema26",  label: "EMA 26",    color: "#22d3ee" },
  { key: "vwap",   label: "VWAP",      color: "#a78bfa" },
  { key: "bb",     label: "Bollinger", color: "#f472b6" },
];

/* ════════════════════════════════════════════════════════
   THEME
   ════════════════════════════════════════════════════════ */

const T = {
  bg:          "#060b14",
  bgCard:      "#0d1421",
  bgCardAlt:   "#111c2e",
  bgHover:     "#1a2842",
  border:      "#1c2d4a",
  green:       "#10b981",
  greenDim:    "rgba(16,185,129,0.12)",
  red:         "#ef4444",
  redDim:      "rgba(239,68,68,0.12)",
  blue:        "#3b82f6",
  gold:        "#f59e0b",
  purple:      "#8b5cf6",
  cyan:        "#06b6d4",
  pink:        "#ec4899",
  text:        "#e2e8f0",
  textDim:     "#94a3b8",
  textMuted:   "#64748b",
  grid:        "#1e293b",
  font:        "'Inter',-apple-system,BlinkMacSystemFont,sans-serif",
};

/* ════════════════════════════════════════════════════════
   HELPERS
   ════════════════════════════════════════════════════════ */

const f2  = (v) => (v != null ? Number(v).toFixed(2) : "--");
const f1  = (v) => (v != null ? Number(v).toFixed(1) : "--");
const fK  = (v) => {
  if (v == null) return "--";
  if (Math.abs(v) >= 1e12) return (v/1e12).toFixed(1)+"T";
  if (Math.abs(v) >= 1e9)  return (v/1e9).toFixed(1)+"B";
  if (Math.abs(v) >= 1e6)  return (v/1e6).toFixed(1)+"M";
  if (Math.abs(v) >= 1e3)  return (v/1e3).toFixed(1)+"K";
  return String(v);
};

function flatten(point) {
  const i = point.indicators || {};
  return {
    time: point.time, open: point.open, high: point.high,
    low: point.low, close: point.close, volume: point.volume,
    rsi: i.rsi_14, sma20: i.sma_20, sma50: i.sma_50,
    ema12: i.ema_12, ema26: i.ema_26, macd: i.macd,
    macdSignal: i.macd_signal, macdHist: i.macd_histogram,
    bbUpper: i.bb_upper, bbMiddle: i.bb_middle, bbLower: i.bb_lower,
    vwap: i.vwap, atr: i.atr_14, stochK: i.stoch_k,
    stochD: i.stoch_d, obv: i.obv,
  };
}

async function apiFetch(path) {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ════════════════════════════════════════════════════════
   WEBSOCKET HOOK
   ════════════════════════════════════════════════════════ */

function useWebSocket(ticker) {
  const [live, setLive] = useState(null);
  const wsRef = useRef(null);
  const retryRef = useRef(null);

  useEffect(() => {
    if (!ticker) return;
    let mounted = true;

    const connect = () => {
      try {
        const ws = new WebSocket(`${WS}/ws/${ticker}`);
        ws.onmessage = (e) => {
          try { if (mounted) setLive(JSON.parse(e.data)); } catch {}
        };
        ws.onclose = () => {
          if (mounted) retryRef.current = window.setTimeout(connect, 5000);
        };
        ws.onerror = () => ws.close();
        wsRef.current = ws;
      } catch {}
    };

    connect();
    return () => {
      mounted = false;
      window.clearTimeout(retryRef.current);
      wsRef.current?.close();
    };
  }, [ticker]);

  return live;
}

/* ════════════════════════════════════════════════════════
   SHARED STYLES
   ════════════════════════════════════════════════════════ */

const tooltipBox = {
  backgroundColor: T.bgCardAlt, border: `1px solid ${T.border}`,
  borderRadius: 8, padding: "10px 14px", fontSize: 12, color: T.text,
  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
};

const pill = (active, color = T.blue) => ({
  padding: "6px 14px", borderRadius: 20, border: "none", cursor: "pointer",
  fontSize: 12, fontWeight: 600, transition: "all 0.15s",
  backgroundColor: active ? color : T.bgCardAlt,
  color: active ? "#fff" : T.textDim,
});

const card = {
  backgroundColor: T.bgCard, borderRadius: 12, padding: 16,
  border: `1px solid ${T.border}`, marginBottom: 12,
};

/* ════════════════════════════════════════════════════════
   CUSTOM TOOLTIPS
   ════════════════════════════════════════════════════════ */

function PriceTooltip({ active, payload }) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div style={tooltipBox}>
      <div style={{ color: T.textMuted, marginBottom: 6 }}>{d.time}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 16px", fontSize: 12 }}>
        <span>O <b style={{ color: T.text }}>{f2(d.open)}</b></span>
        <span>H <b style={{ color: T.green }}>{f2(d.high)}</b></span>
        <span>L <b style={{ color: T.red }}>{f2(d.low)}</b></span>
        <span>C <b style={{ color: T.text }}>{f2(d.close)}</b></span>
      </div>
      <div style={{ marginTop: 4, color: T.textDim }}>Vol: {fK(d.volume)}</div>
    </div>
  );
}

function SubTooltip({ active, payload, label, fields }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={tooltipBox}>
      <div style={{ color: T.textMuted, marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.stroke || p.fill || T.text }}>
          {p.name}: <b>{f2(p.value)}</b>
        </div>
      ))}
    </div>
  );
}

/* ════════════════════════════════════════════════════════
   MAIN APP
   ════════════════════════════════════════════════════════ */

function App() {
  /* ── state ────────────────────────────── */
  const [view, setView]                     = useState("chart");
  const [ticker, setTicker]                 = useState("RELIANCE.NS");
  const [period, setPeriod]                 = useState("1d");
  const [intv, setIntv]                     = useState("5m");
  const [searchTerm, setSearchTerm]         = useState("");
  const [suggestions, setSuggestions]       = useState([]);
  const [chartData, setChartData]           = useState([]);
  const [quote, setQuote]                   = useState(null);
  const [signals, setSignals]              = useState(null);
  const [fib, setFib]                       = useState(null);
  const [info, setInfo]                     = useState(null);
  const [activeOverlays, setActiveOverlays] = useState(new Set(["sma20"]));
  const [subPanel, setSubPanel]             = useState("RSI");
  const [loading, setLoading]               = useState(false);
  const [error, setError]                   = useState(null);

  // compare
  const [cmpInput, setCmpInput]   = useState("RELIANCE.NS,TCS.NS,INFY.NS");
  const [cmpPeriod, setCmpPeriod] = useState("3mo");
  const [cmpData, setCmpData]     = useState(null);
  const [cmpLoading, setCmpLoading] = useState(false);

  // market
  const [marketData, setMarketData] = useState(null);

  const searchRef = useRef(null);
  const live = useWebSocket(view === "chart" ? ticker : null);

  /* ── derived ──────────────────────────── */
  const last  = chartData[chartData.length - 1];
  const first = chartData[0];
  const price = live?.price ?? quote?.price ?? last?.close;
  const prev  = quote?.prev_close ?? first?.close;
  const chg   = price && prev ? price - prev : 0;
  const pct   = prev ? (chg / prev) * 100 : 0;
  const isUp  = chg >= 0;
  const trend = isUp ? T.green : T.red;

  /* ── close search on outside click ───── */
  useEffect(() => {
    const fn = (e) => {
      if (searchRef.current && !searchRef.current.contains(e.target))
        setSuggestions([]);
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);

  /* ── debounced search ────────────────── */
  useEffect(() => {
    if (searchTerm.length < 2) { setSuggestions([]); return; }
    const t = window.setTimeout(() => {
      apiFetch(`/api/search/${searchTerm}`)
        .then(setSuggestions)
        .catch(() => setSuggestions([]));
    }, 350);
    return () => window.clearTimeout(t);
  }, [searchTerm]);

  /* ── fetch chart data ────────────────── */
  const fetchChart = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/stock/${ticker}/chart?period=${period}&interval=${intv}`
      );
      setChartData((res.data || []).map(flatten));
    } catch (e) {
      setError(e.message);
      setChartData([]);
    } finally {
      setLoading(false);
    }
  }, [ticker, period, intv]);

  useEffect(() => { fetchChart(); }, [fetchChart]);

  // auto-refresh every 60 s
  useEffect(() => {
    const id = window.setInterval(fetchChart, 60000);
    return () => window.clearInterval(id);
  }, [fetchChart]);

  /* ── fetch sidebar data ──────────────── */
  useEffect(() => {
    const load = async () => {
      const [q, s, fb, inf] = await Promise.allSettled([
        apiFetch(`/api/stock/${ticker}/quote`),
        apiFetch(`/api/stock/${ticker}/signals?period=1mo&interval=1d`),
        apiFetch(`/api/stock/${ticker}/fibonacci?period=3mo`),
        apiFetch(`/api/stock/${ticker}/info`),
      ]);
      if (q.status   === "fulfilled") setQuote(q.value);
      if (s.status   === "fulfilled") setSignals(s.value);
      if (fb.status  === "fulfilled") setFib(fb.value);
      if (inf.status === "fulfilled") setInfo(inf.value);
    };
    load();
  }, [ticker]);

  /* ── fetch market overview ───────────── */
  useEffect(() => {
    if (view === "market" && !marketData) {
      apiFetch("/api/market/overview").then(setMarketData).catch(() => {});
    }
  }, [view, marketData]);

  /* ── handlers ────────────────────────── */
  const selectTicker = (t) => {
    setTicker(t.toUpperCase());
    setSearchTerm("");
    setSuggestions([]);
    setQuote(null); setSignals(null); setFib(null); setInfo(null);
    setView("chart");
  };

  const changePeriod = (p) => {
    setPeriod(p);
    setIntv(DEFAULT_INTERVAL[p] || "1d");
  };

  const toggleOverlay = (key) => {
    setActiveOverlays((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const fetchCompare = async () => {
    setCmpLoading(true);
    try {
      const data = await apiFetch(
        `/api/compare?tickers=${encodeURIComponent(cmpInput)}&period=${cmpPeriod}`
      );
      setCmpData(data);
    } catch { setCmpData(null); }
    finally { setCmpLoading(false); }
  };

  /* ════════════════════════════════════════
     RENDER
     ════════════════════════════════════════ */

  const intervals = INTERVAL_MAP[period] || ["1d"];

  return (
    <div style={{
      display:"flex", flexDirection:"column", width:"100vw", height:"100vh",
      backgroundColor:T.bg, color:T.text, fontFamily:T.font,
      overflow:"hidden",
    }}>

      {/* ─────── TOP BAR ─────── */}
      <div style={{
        display:"flex", alignItems:"center", gap:12, padding:"12px 20px",
        borderBottom:`1px solid ${T.border}`, flexShrink:0,
      }}>
        {/* Logo */}
        <div style={{ fontSize:20, fontWeight:800, marginRight:8, color:T.blue }}>
          📈 StockPro
        </div>

        {/* Search */}
        <div ref={searchRef} style={{ position:"relative", width:320, zIndex:100 }}>
          <input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search ticker or company..."
            style={{
              width:"100%", padding:"8px 14px", borderRadius:8,
              border:`1px solid ${T.border}`, backgroundColor:T.bgCard,
              color:T.text, outline:"none", fontSize:13,
            }}
          />
          {suggestions.length > 0 && (
            <div style={{
              position:"absolute", top:"110%", left:0, right:0, zIndex:101,
              backgroundColor:T.bgCard, borderRadius:10,
              border:`1px solid ${T.border}`,
              boxShadow:"0 12px 40px rgba(0,0,0,0.7)", overflow:"hidden",
            }}>
              {suggestions.map((s) => (
                <div
                  key={s.symbol}
                  onMouseDown={() => selectTicker(s.symbol)}
                  style={{
                    padding:"10px 14px", cursor:"pointer",
                    borderBottom:`1px solid ${T.border}`,
                    display:"flex", justifyContent:"space-between", alignItems:"center",
                    transition:"background 0.1s",
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = T.bgHover}
                  onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                >
                  <b style={{ color:T.blue, fontSize:13 }}>{s.symbol}</b>
                  <span style={{ color:T.textMuted, fontSize:11, maxWidth:180, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {s.name}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Quick stocks */}
        <div style={{ display:"flex", gap:6, marginLeft:24, flexWrap:"wrap", zIndex: 102 }}>
          {QUICK_STOCKS.map((s) => (
            <button
              key={s.ticker}
              onClick={() => selectTicker(s.ticker)}
              style={{
                ...pill(ticker === s.ticker, trend),
                fontSize: 11, padding: "5px 12px",
                zIndex: 103, position: 'relative' // Added zIndex and position
              }}
            >
              {s.name}
            </button>
          ))}
        </div>

        {/* Spacer */}
        <div style={{ flex:1 }} />

        {/* Live price in header */}
        {price != null && view === "chart" && (
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:18, fontWeight:700, color:trend }}>
              ₹{f2(price)}
            </div>
            <div style={{ fontSize:11, color:trend }}>
              {chg >= 0 ? "+" : ""}{f2(chg)} ({pct >= 0 ? "+" : ""}{f2(pct)}%)
            </div>
          </div>
        )}
      </div>

      {/* ─────── CONTROLS BAR ─────── */}
      <div style={{
        display:"flex", alignItems:"center", gap:8, padding:"10px 20px",
        borderBottom:`1px solid ${T.border}`, flexShrink:0, flexWrap:"wrap",
      }}>
        {/* View tabs */}
        {[
          { key:"chart",   label:"📊 Chart"   },
          { key:"compare", label:"⚖️ Compare" },
          { key:"market",  label:"🌍 Market"  },
        ].map((v) => (
          <button key={v.key} onClick={() => setView(v.key)}
            style={{ ...pill(view === v.key), marginRight: 4 }}
          >
            {v.label}
          </button>
        ))}

        <div style={{ width:1, height:24, backgroundColor:T.border, margin:"0 8px" }} />

        {/* Period selector */}
        {view === "chart" && PERIODS.map((p) => (
          <button key={p.value} onClick={() => changePeriod(p.value)}
            style={pill(period === p.value, T.purple)}
          >
            {p.label}
          </button>
        ))}

        {view === "chart" && (
          <div style={{ width:1, height:24, backgroundColor:T.border, margin:"0 8px" }} />
        )}

        {/* Interval selector */}
        {view === "chart" && intervals.map((iv) => (
          <button key={iv} onClick={() => setIntv(iv)}
            style={pill(intv === iv, T.cyan)}
          >
            {iv}
          </button>
        ))}

        {view === "chart" && (
          <>
            <div style={{ width:1, height:24, backgroundColor:T.border, margin:"0 8px" }} />
            {/* Overlay toggles */}
            {OVERLAYS.map((o) => (
              <button key={o.key} onClick={() => toggleOverlay(o.key)}
                style={{
                  ...pill(activeOverlays.has(o.key), o.color),
                  fontSize: 11, padding: "4px 10px",
                }}
              >
                {o.label}
              </button>
            ))}
          </>
        )}

        {loading && (
          <span style={{ marginLeft:"auto", fontSize:11, color:T.textMuted }}>
            ⏳ Loading...
          </span>
        )}
      </div>

      {/* ─────── MAIN CONTENT ─────── */}
      <div style={{ flex:1, display:"flex", overflow:"hidden" }}>

        {/* ═══ CHART VIEW ═══ */}
        {view === "chart" && (
          <>
            {/* Left: charts */}
            <div style={{
              flex:1, display:"flex", flexDirection:"column",
              padding:16, gap:8, minWidth:0, overflow:"hidden",
            }}>
              {error ? (
                <div style={{
                  flex:1, display:"flex", alignItems:"center", justifyContent:"center",
                  color:T.red, fontSize:16,
                }}>
                  ⚠️ {error}
                </div>
              ) : (
                <>
                  {/* PRICE CHART */}
                  <div style={{
                    flex:5, minHeight:200, backgroundColor:T.bgCard,
                    borderRadius:12, border:`1px solid ${T.border}`, padding:"12px 8px 4px",
                  }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={chartData} syncId="main">
                        <CartesianGrid strokeDasharray="3 3" stroke={T.grid} vertical={false} />
                        <XAxis dataKey="time" hide />
                        <YAxis
                          domain={["auto","auto"]} orientation="right"
                          tick={{ fontSize:10, fill:T.textMuted }}
                          tickFormatter={(v) => `₹${v}`}
                          axisLine={false} tickLine={false}
                        />
                        <Tooltip content={<PriceTooltip />} />

                        {/* Price line */}
                        <Line
                          type="monotone" dataKey="close" stroke={trend}
                          strokeWidth={2} dot={false}
                          activeDot={{ r:5, stroke:T.bg, strokeWidth:2 }}
                        />

                        {/* Overlay: SMA 20 */}
                        {activeOverlays.has("sma20") && (
                          <Line type="monotone" dataKey="sma20" stroke="#fbbf24"
                            strokeWidth={1.2} dot={false} connectNulls />
                        )}
                        {/* Overlay: SMA 50 */}
                        {activeOverlays.has("sma50") && (
                          <Line type="monotone" dataKey="sma50" stroke="#fb923c"
                            strokeWidth={1.2} dot={false} connectNulls />
                        )}
                        {/* Overlay: EMA 12 */}
                        {activeOverlays.has("ema12") && (
                          <Line type="monotone" dataKey="ema12" stroke="#34d399"
                            strokeWidth={1.2} dot={false} connectNulls />
                        )}
                        {/* Overlay: EMA 26 */}
                        {activeOverlays.has("ema26") && (
                          <Line type="monotone" dataKey="ema26" stroke="#22d3ee"
                            strokeWidth={1.2} dot={false} connectNulls />
                        )}
                        {/* Overlay: VWAP */}
                        {activeOverlays.has("vwap") && (
                          <Line type="monotone" dataKey="vwap" stroke="#a78bfa"
                            strokeWidth={1.2} dot={false} strokeDasharray="4 2" connectNulls />
                        )}
                        {/* Overlay: Bollinger Bands */}
                        {activeOverlays.has("bb") && (
                          <>
                            <Line type="monotone" dataKey="bbUpper" stroke="#f472b6"
                              strokeWidth={1} dot={false} strokeDasharray="4 3" connectNulls />
                            <Line type="monotone" dataKey="bbMiddle" stroke="#f472b6"
                              strokeWidth={1} dot={false} strokeDasharray="2 2" opacity={0.5} connectNulls />
                            <Line type="monotone" dataKey="bbLower" stroke="#f472b6"
                              strokeWidth={1} dot={false} strokeDasharray="4 3" connectNulls />
                          </>
                        )}
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>

                  {/* VOLUME CHART */}
                  <div style={{
                    flex:1.5, minHeight:60, backgroundColor:T.bgCard,
                    borderRadius:12, border:`1px solid ${T.border}`, padding:"4px 8px",
                  }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={chartData} syncId="main">
                        <XAxis dataKey="time" hide />
                        <YAxis hide />
                        <Tooltip
                          contentStyle={tooltipBox} labelStyle={{ color:T.textMuted }}
                          formatter={(v) => [fK(v), "Volume"]}
                        />
                        <Bar dataKey="volume" barSize={3} opacity={0.7}>
                          {chartData.map((d, i) => (
                            <Cell
                              key={i}
                              fill={d.close >= d.open ? T.green : T.red}
                            />
                          ))}
                        </Bar>
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>

                  {/* SUB-INDICATOR PANEL */}
                  <div style={{
                    flex:2.5, minHeight:100, backgroundColor:T.bgCard,
                    borderRadius:12, border:`1px solid ${T.border}`, padding:"8px 8px 4px",
                    display:"flex", flexDirection:"column",
                  }}>
                    {/* Tabs */}
                    <div style={{ display:"flex", gap:6, marginBottom:6, paddingLeft:8 }}>
                      {["RSI","MACD","Stochastic"].map((tab) => (
                        <button key={tab} onClick={() => setSubPanel(tab)}
                          style={{ ...pill(subPanel === tab, T.gold), fontSize:11, padding:"4px 12px" }}>
                          {tab}
                        </button>
                      ))}
                      {last && subPanel === "RSI" && (
                        <span style={{
                          marginLeft:"auto", fontSize:12, fontWeight:700, paddingRight:8,
                          color: last.rsi > 70 ? T.red : last.rsi < 30 ? T.green : T.textDim,
                        }}>
                          RSI: {f1(last.rsi)}
                        </span>
                      )}
                    </div>

                    <div style={{ flex:1, minHeight:0 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        {subPanel === "RSI" ? (
                          <ComposedChart data={chartData} syncId="main">
                            <CartesianGrid strokeDasharray="3 3" stroke={T.grid} vertical={false} />
                            <XAxis dataKey="time" tick={{ fontSize:9, fill:T.textMuted }} minTickGap={40} axisLine={false} />
                            <YAxis domain={[0,100]} ticks={[30,50,70]} orientation="right"
                              tick={{ fontSize:9, fill:T.textMuted }} axisLine={false} tickLine={false} />
                            <Tooltip content={<SubTooltip />} />
                            <ReferenceLine y={70} stroke={T.red} strokeDasharray="3 3" opacity={0.5} />
                            <ReferenceLine y={30} stroke={T.green} strokeDasharray="3 3" opacity={0.5} />
                            <ReferenceLine y={50} stroke={T.textMuted} strokeDasharray="2 4" opacity={0.3} />
                            <Line type="monotone" dataKey="rsi" name="RSI" stroke={T.gold}
                              strokeWidth={1.8} dot={false} connectNulls />
                          </ComposedChart>
                        ) : subPanel === "MACD" ? (
                          <ComposedChart data={chartData} syncId="main">
                            <CartesianGrid strokeDasharray="3 3" stroke={T.grid} vertical={false} />
                            <XAxis dataKey="time" tick={{ fontSize:9, fill:T.textMuted }} minTickGap={40} axisLine={false} />
                            <YAxis orientation="right" tick={{ fontSize:9, fill:T.textMuted }}
                              axisLine={false} tickLine={false} />
                            <Tooltip content={<SubTooltip />} />
                            <ReferenceLine y={0} stroke={T.textMuted} strokeDasharray="2 4" opacity={0.4} />
                            <Bar dataKey="macdHist" name="Histogram" barSize={3} opacity={0.7}>
                              {chartData.map((d, i) => (
                                <Cell key={i} fill={d.macdHist >= 0 ? T.green : T.red} />
                              ))}
                            </Bar>
                            <Line type="monotone" dataKey="macd" name="MACD" stroke={T.blue}
                              strokeWidth={1.5} dot={false} connectNulls />
                            <Line type="monotone" dataKey="macdSignal" name="Signal" stroke={T.gold}
                              strokeWidth={1.5} dot={false} connectNulls />
                          </ComposedChart>
                        ) : (
                          <ComposedChart data={chartData} syncId="main">
                            <CartesianGrid strokeDasharray="3 3" stroke={T.grid} vertical={false} />
                            <XAxis dataKey="time" tick={{ fontSize:9, fill:T.textMuted }} minTickGap={40} axisLine={false} />
                            <YAxis domain={[0,100]} ticks={[20,50,80]} orientation="right"
                              tick={{ fontSize:9, fill:T.textMuted }} axisLine={false} tickLine={false} />
                            <Tooltip content={<SubTooltip />} />
                            <ReferenceLine y={80} stroke={T.red} strokeDasharray="3 3" opacity={0.5} />
                            <ReferenceLine y={20} stroke={T.green} strokeDasharray="3 3" opacity={0.5} />
                            <Line type="monotone" dataKey="stochK" name="%K" stroke={T.cyan}
                              strokeWidth={1.5} dot={false} connectNulls />
                            <Line type="monotone" dataKey="stochD" name="%D" stroke={T.pink}
                              strokeWidth={1.5} dot={false} connectNulls />
                          </ComposedChart>
                        )}
                      </ResponsiveContainer>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Right: sidebar */}
            <div style={{
              width:300, padding:"16px 16px 16px 0", overflowY:"auto",
              display:"flex", flexDirection:"column", gap:0, flexShrink:0,
            }}>
              {/* Quote Card */}
              <div style={card}>
                <div style={{ fontSize:11, color:T.textMuted, textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>
                  Live Quote
                </div>
                <div style={{ fontSize:24, fontWeight:800, color:trend }}>
                  ₹{f2(price)}
                </div>
                <div style={{
                  fontSize:13, fontWeight:600, color:trend, marginBottom:12,
                  display:"flex", alignItems:"center", gap:6,
                }}>
                  <span style={{
                    display:"inline-block", padding:"2px 8px", borderRadius:6,
                    backgroundColor: isUp ? T.greenDim : T.redDim,
                  }}>
                    {chg >= 0 ? "▲" : "▼"} {f2(Math.abs(chg))} ({f2(Math.abs(pct))}%)
                  </span>
                </div>
                {quote && (
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"6px 12px", fontSize:12 }}>
                    <div><span style={{ color:T.textMuted }}>Open</span> <b>₹{f2(quote.open)}</b></div>
                    <div><span style={{ color:T.textMuted }}>Prev</span> <b>₹{f2(quote.prev_close)}</b></div>
                    <div><span style={{ color:T.textMuted }}>High</span> <b style={{ color:T.green }}>₹{f2(quote.high)}</b></div>
                    <div><span style={{ color:T.textMuted }}>Low</span> <b style={{ color:T.red }}>₹{f2(quote.low)}</b></div>
                    <div><span style={{ color:T.textMuted }}>Vol</span> <b>{fK(quote.volume)}</b></div>
                    <div><span style={{ color:T.textMuted }}>MCap</span> <b>{fK(quote.market_cap)}</b></div>
                    {quote.pe_ratio && (
                      <div><span style={{ color:T.textMuted }}>P/E</span> <b>{f2(quote.pe_ratio)}</b></div>
                    )}
                    {quote.week_52_high && (
                      <div><span style={{ color:T.textMuted }}>52wH</span> <b>₹{f2(quote.week_52_high)}</b></div>
                    )}
                  </div>
                )}
                {live && (
                  <div style={{ marginTop:8, fontSize:10, color:T.textMuted }}>
                    🔴 Live via WebSocket
                  </div>
                )}
              </div>

              {/* Signals Card */}
              {signals && (
                <div style={card}>
                  <div style={{ fontSize:11, color:T.textMuted, textTransform:"uppercase", letterSpacing:1, marginBottom:10 }}>
                    Signal Analysis
                  </div>
                  {/* Overall verdict */}
                  <div style={{
                    display:"flex", alignItems:"center", justifyContent:"center",
                    padding:"10px", borderRadius:10, marginBottom:12,
                    backgroundColor: signals.overall === "BUY" ? T.greenDim
                      : signals.overall === "SELL" ? T.redDim : T.bgCardAlt,
                  }}>
                    <span style={{
                      fontSize:20, fontWeight:900,
                      color: signals.overall === "BUY" ? T.green
                        : signals.overall === "SELL" ? T.red : T.textDim,
                    }}>
                      {signals.overall === "BUY" ? "🟢" : signals.overall === "SELL" ? "🔴" : "🟡"}{" "}
                      {signals.overall}
                    </span>
                  </div>
                  {/* Score bar */}
                  <div style={{
                    display:"flex", height:6, borderRadius:3, overflow:"hidden",
                    marginBottom:12, backgroundColor:T.bgCardAlt,
                  }}>
                    <div style={{ flex:signals.buy_count, backgroundColor:T.green }} />
                    <div style={{ flex:signals.neutral_count, backgroundColor:T.gold }} />
                    <div style={{ flex:signals.sell_count, backgroundColor:T.red }} />
                  </div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, marginBottom:10 }}>
                    <span style={{ color:T.green }}>Buy: {signals.buy_count}</span>
                    <span style={{ color:T.gold }}>Neutral: {signals.neutral_count}</span>
                    <span style={{ color:T.red }}>Sell: {signals.sell_count}</span>
                  </div>
                  {/* Individual signals */}
                  <div style={{ maxHeight:180, overflowY:"auto" }}>
                    {signals.signals.map((s, i) => (
                      <div key={i} style={{
                        display:"flex", justifyContent:"space-between", alignItems:"center",
                        padding:"5px 0", borderBottom:`1px solid ${T.border}`, fontSize:11,
                      }}>
                        <span style={{ color:T.textDim }}>{s.indicator}</span>
                        <span style={{
                          fontWeight:700, fontSize:10, padding:"2px 8px", borderRadius:4,
                          backgroundColor: s.signal === "BUY" ? T.greenDim
                            : s.signal === "SELL" ? T.redDim : T.bgCardAlt,
                          color: s.signal === "BUY" ? T.green
                            : s.signal === "SELL" ? T.red : T.textDim,
                        }}>
                          {s.signal}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Fibonacci Card */}
              {fib?.levels && (
                <div style={card}>
                  <div style={{ fontSize:11, color:T.textMuted, textTransform:"uppercase", letterSpacing:1, marginBottom:10 }}>
                    Fibonacci Levels
                  </div>
                  {Object.entries(fib.levels).map(([level, val]) => (
                    <div key={level} style={{
                      display:"flex", justifyContent:"space-between",
                      padding:"4px 0", fontSize:12,
                      borderBottom:`1px solid ${T.border}`,
                    }}>
                      <span style={{ color:T.purple, fontWeight:600 }}>{level}</span>
                      <span style={{ color:T.text }}>₹{f2(val)}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Company Info Card */}
              {info && (
                <div style={card}>
                  <div style={{ fontSize:11, color:T.textMuted, textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>
                    Company Info
                  </div>
                  <div style={{ fontSize:15, fontWeight:700, marginBottom:4, color:T.text }}>
                    {info.name}
                  </div>
                  <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:8 }}>
                    {info.sector && (
                      <span style={{
                        fontSize:10, padding:"3px 8px", borderRadius:4,
                        backgroundColor:T.bgCardAlt, color:T.textDim,
                      }}>
                        {info.sector}
                      </span>
                    )}
                    {info.industry && (
                      <span style={{
                        fontSize:10, padding:"3px 8px", borderRadius:4,
                        backgroundColor:T.bgCardAlt, color:T.textDim,
                      }}>
                        {info.industry}
                      </span>
                    )}
                  </div>
                  {info.description && (
                    <p style={{
                      fontSize:11, color:T.textDim, lineHeight:1.5,
                      maxHeight:80, overflowY:"auto", margin:0,
                    }}>
                      {info.description}
                    </p>
                  )}
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"4px 12px", fontSize:11, marginTop:8 }}>
                    {info.beta && <div><span style={{ color:T.textMuted }}>Beta</span> <b>{f2(info.beta)}</b></div>}
                    {info.dividend_yield && <div><span style={{ color:T.textMuted }}>Div</span> <b>{(info.dividend_yield*100).toFixed(2)}%</b></div>}
                    {info.employees && <div><span style={{ color:T.textMuted }}>Emp</span> <b>{fK(info.employees)}</b></div>}
                    {info.exchange && <div><span style={{ color:T.textMuted }}>Exch</span> <b>{info.exchange}</b></div>}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* ═══ COMPARE VIEW ═══ */}
        {view === "compare" && (
          <div style={{ flex:1, padding:20, overflowY:"auto" }}>
            {/* Input bar */}
            <div style={{ display:"flex", gap:10, marginBottom:20, alignItems:"center" }}>
              <input
                value={cmpInput}
                onChange={(e) => setCmpInput(e.target.value)}
                placeholder="AAPL,MSFT,GOOGL"
                style={{
                  flex:1, maxWidth:500, padding:"10px 14px", borderRadius:8,
                  border:`1px solid ${T.border}`, backgroundColor:T.bgCard,
                  color:T.text, outline:"none", fontSize:13,
                }}
              />
              {PERIODS.slice(0,6).map((p) => (
                <button key={p.value} onClick={() => setCmpPeriod(p.value)}
                  style={pill(cmpPeriod === p.value, T.purple)}>
                  {p.label}
                </button>
              ))}
              <button onClick={fetchCompare}
                style={{
                  padding:"10px 24px", borderRadius:8, border:"none",
                  backgroundColor:T.blue, color:"#fff", fontWeight:700,
                  cursor:"pointer", fontSize:13,
                }}
              >
                {cmpLoading ? "Loading..." : "Compare"}
              </button>
            </div>

            {cmpData && (
              <div style={{ display:"flex", gap:20, flexWrap:"wrap" }}>
                {/* Normalised chart */}
                <div style={{
                  flex:"1 1 600px", ...card, minHeight:400,
                  display:"flex", flexDirection:"column",
                }}>
                  <div style={{ fontSize:11, color:T.textMuted, textTransform:"uppercase", letterSpacing:1, marginBottom:12 }}>
                    Normalised Price (Base 100)
                  </div>
                  <div style={{ flex:1 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={cmpData.chart}>
                        <CartesianGrid strokeDasharray="3 3" stroke={T.grid} vertical={false} />
                        <XAxis dataKey="date" tick={{ fontSize:10, fill:T.textMuted }} minTickGap={30} />
                        <YAxis orientation="right" tick={{ fontSize:10, fill:T.textMuted }} axisLine={false} />
                        <Tooltip contentStyle={tooltipBox} />
                        <ReferenceLine y={100} stroke={T.textMuted} strokeDasharray="2 4" opacity={0.3} />
                        {cmpData.tickers.map((sym, i) => {
                          const colors = [T.blue, T.green, T.gold, T.pink, T.cyan, T.purple, T.red, "#fff", "#8b5cf6", "#f97316"];
                          return (
                            <Line key={sym} type="monotone" dataKey={sym} name={sym}
                              stroke={colors[i % colors.length]} strokeWidth={2}
                              dot={false} connectNulls />
                          );
                        })}
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Performance table */}
                <div style={{ flex:"1 1 300px", ...card }}>
                  <div style={{ fontSize:11, color:T.textMuted, textTransform:"uppercase", letterSpacing:1, marginBottom:12 }}>
                    Performance Summary
                  </div>
                  <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                    <thead>
                      <tr style={{ color:T.textMuted, borderBottom:`1px solid ${T.border}` }}>
                        <th style={{ textAlign:"left", padding:"6px 4px" }}>Ticker</th>
                        <th style={{ textAlign:"right", padding:"6px 4px" }}>Return</th>
                        <th style={{ textAlign:"right", padding:"6px 4px" }}>Volatility</th>
                        <th style={{ textAlign:"right", padding:"6px 4px" }}>High</th>
                        <th style={{ textAlign:"right", padding:"6px 4px" }}>Low</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(cmpData.performance).map(([sym, p]) => (
                        <tr key={sym} style={{ borderBottom:`1px solid ${T.border}` }}>
                          <td style={{ padding:"8px 4px", fontWeight:700, color:T.blue }}>{sym}</td>
                          <td style={{
                            padding:"8px 4px", textAlign:"right", fontWeight:700,
                            color: p.return_pct >= 0 ? T.green : T.red,
                          }}>
                            {p.return_pct >= 0 ? "+" : ""}{p.return_pct}%
                          </td>
                          <td style={{ padding:"8px 4px", textAlign:"right", color:T.textDim }}>
                            {p.volatility_pct}%
                          </td>
                          <td style={{ padding:"8px 4px", textAlign:"right" }}>₹{f2(p.high)}</td>
                          <td style={{ padding:"8px 4px", textAlign:"right" }}>₹{f2(p.low)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* Correlation Matrix */}
                  {cmpData.correlation && (
                    <>
                      <div style={{
                        fontSize:11, color:T.textMuted, textTransform:"uppercase",
                        letterSpacing:1, marginTop:20, marginBottom:10,
                      }}>
                        Correlation Matrix
                      </div>
                      <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
                        <thead>
                          <tr>
                            <th style={{ padding:4 }}></th>
                            {Object.keys(cmpData.correlation).map((s) => (
                              <th key={s} style={{ padding:4, color:T.blue, fontWeight:600 }}>{s}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(cmpData.correlation).map(([row, cols]) => (
                            <tr key={row}>
                              <td style={{ padding:4, color:T.blue, fontWeight:600 }}>{row}</td>
                              {Object.values(cols).map((v, i) => {
                                const intensity = Math.abs(v);
                                const bg = v >= 0
                                  ? `rgba(16,185,129,${intensity * 0.3})`
                                  : `rgba(239,68,68,${intensity * 0.3})`;
                                return (
                                  <td key={i} style={{
                                    padding:4, textAlign:"center", borderRadius:4,
                                    backgroundColor:bg, fontWeight: v === 1 ? 700 : 400,
                                  }}>
                                    {v.toFixed(2)}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══ MARKET OVERVIEW ═══ */}
        {view === "market" && (
          <div style={{ flex:1, padding:20, overflowY:"auto" }}>
            {!marketData ? (
              <div style={{ color:T.textMuted, textAlign:"center", marginTop:60 }}>
                Loading market data...
              </div>
            ) : (
              Object.entries(marketData).map(([category, items]) => (
                <div key={category} style={{ marginBottom:28 }}>
                  <h3 style={{
                    fontSize:13, color:T.textMuted, textTransform:"uppercase",
                    letterSpacing:2, marginBottom:12,
                  }}>
                    {category === "indices" ? "📊 Major Indices" : "🏢 Mega-Cap Stocks"}
                  </h3>
                  <div style={{
                    display:"grid",
                    gridTemplateColumns:"repeat(auto-fill, minmax(220px, 1fr))",
                    gap:12,
                  }}>
                    {items.map((item) => {
                      const up = item.change >= 0;
                      return (
                        <div
                          key={item.symbol}
                          onClick={() => selectTicker(item.symbol)}
                          style={{
                            ...card, cursor:"pointer", marginBottom:0,
                            transition:"all 0.15s",
                            borderColor: T.border,
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.borderColor = T.blue}
                          onMouseLeave={(e) => e.currentTarget.style.borderColor = T.border}
                        >
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                            <span style={{ fontWeight:700, fontSize:14, color:T.blue }}>
                              {item.symbol}
                            </span>
                            <span style={{
                              fontSize:10, padding:"3px 8px", borderRadius:4,
                              backgroundColor: up ? T.greenDim : T.redDim,
                              color: up ? T.green : T.red, fontWeight:700,
                            }}>
                              {up ? "▲" : "▼"} {Math.abs(item.change_pct).toFixed(2)}%
                            </span>
                          </div>
                          <div style={{ fontSize:20, fontWeight:700, marginTop:6, color:T.text }}>
                            ₹{f2(item.price)}
                          </div>
                          <div style={{ fontSize:12, color: up ? T.green : T.red, marginTop:2 }}>
                            {up ? "+" : ""}{f2(item.change)}
                          </div>
                          <div style={{ fontSize:10, color:T.textMuted, marginTop:4 }}>
                            Vol: {fK(item.volume)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;