import { useState, useEffect, useMemo, useRef } from "react";
import { Zap, TrendingUp, Activity, Radio, Settings2, Info, Key } from "lucide-react";

// ---------------------------------------------------------------------------
// LIVE DATA INTEGRATION NOTES
// ---------------------------------------------------------------------------
// This scanner can run on real data by supplying API keys in the Criteria
// panel (stored only in component state — nothing is persisted or sent
// anywhere but the providers below).
//
// 1) POLYGON.IO / MASSIVE (required for live mode) — powers price / volume /
//    RVol / gap. Polygon rebranded to "Massive"; the free "Stocks Basic" plan
//    is EOD/reference data only and does NOT include the full-market
//    snapshot endpoint below — you'll get a 403 "not entitled" error on it
//    until you're on a paid Starter/Developer plan or higher.
//      Live endpoint: GET /v2/snapshot/locale/us/markets/stocks/tickers
//      rvol = day.v / prevDay.v (proxy — true RVol needs a 20/30-day avg,
//             available on paid aggregate tiers)
//    Because the free plan can still call the *grouped daily* endpoint
//    (one full day of OHLCV for every US stock, for a specific past date),
//    this file automatically falls back to that on a 403 so the free tier
//    isn't left with nothing — see fetchGroupedFallback below. That mode is
//    NOT real-time: it compares the two most recent completed sessions.
//
// 2) FINNHUB (optional — float proxy) — only called for tickers that already
//    pass the other 4 pillars, to stay well inside the free 60 req/min limit.
//    shareOutstanding (millions) is used as a float proxy — real float
//    (excluding locked/insider shares) needs a paid source like Fintel.
// ---------------------------------------------------------------------------

async function parsePolygonError(res) {
  const status = res.status;
  try {
    const j = await res.json();
    return { status, message: j.message || j.error || JSON.stringify(j) };
  } catch {
    return { status, message: await res.text() };
  }
}

async function fetchPolygonSnapshot(apiKey) {
  const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?apiKey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    const { status, message } = await parsePolygonError(res);
    const err = new Error(message);
    err.status = status;
    throw err;
  }
  const json = await res.json();
  return (json.tickers || [])
    .filter((t) => t.day && t.prevDay && t.day.c > 0 && t.prevDay.v > 0)
    .map((t) => {
      const price = t.day.c || t.min?.c || 0;
      const prevClose = t.prevDay.c || price;
      const volume = t.day.v || 0;
      return {
        symbol: t.ticker,
        sector: "—",
        price: +price.toFixed(2),
        prevClose: +prevClose.toFixed(2),
        change: +(t.todaysChangePerc ?? 0).toFixed(2),
        gap: +(t.todaysChangePerc ?? 0).toFixed(2),
        volume,
        avgVol: t.prevDay.v,
        rvol: +(volume / t.prevDay.v).toFixed(2),
        float: null, // filled in by Finnhub enrichment below, if configured
        high: t.day.h || price,
        low: t.day.l || price,
        lastTick: 0,
      };
    });
}

// Free-tier fallback: grouped daily bars for a specific past date. Steps
// backward from yesterday to skip weekends/holidays until it finds data,
// then does the same for the day before that, so we can diff two sessions.
async function fetchGroupedDay(apiKey, date) {
  const dateStr = date.toISOString().slice(0, 10);
  const res = await fetch(
    `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${dateStr}?adjusted=true&apiKey=${apiKey}`
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const { message } = await parsePolygonError(res);
    throw new Error(message);
  }
  const json = await res.json();
  return json.results && json.results.length ? json.results : null;
}

async function fetchGroupedFallback(apiKey) {
  const cursor = new Date();
  const sessions = [];
  for (let i = 0; i < 10 && sessions.length < 2; i++) {
    cursor.setDate(cursor.getDate() - 1);
    const results = await fetchGroupedDay(apiKey, new Date(cursor));
    if (results) sessions.push(results);
  }
  if (sessions.length < 2) throw new Error("Couldn't find two recent trading sessions.");
  const [latest, prior] = sessions;
  const priorByTicker = new Map(prior.map((r) => [r.T, r]));
  return latest
    .filter((r) => priorByTicker.has(r.T) && r.c > 0 && priorByTicker.get(r.T).v > 0)
    .map((r) => {
      const p = priorByTicker.get(r.T);
      const volume = r.v || 0;
      return {
        symbol: r.T,
        sector: "—",
        price: +r.c.toFixed(2),
        prevClose: +p.c.toFixed(2),
        change: +(((r.c - p.c) / p.c) * 100).toFixed(2),
        gap: +(((r.c - p.c) / p.c) * 100).toFixed(2),
        volume,
        avgVol: p.v,
        rvol: +(volume / p.v).toFixed(2),
        float: null,
        high: r.h || r.c,
        low: r.l || r.c,
        lastTick: 0,
      };
    });
}

async function enrichFloat(candidates, finnhubKey) {
  const results = await Promise.all(
    candidates.map(async (s) => {
      try {
        const res = await fetch(`https://finnhub.io/api/v2/stock/profile2?symbol=${s.symbol}&token=${finnhubKey}`);
        if (!res.ok) return s;
        const j = await res.json();
        const shares = j.shareOutstanding; // millions
        return typeof shares === "number" ? { ...s, float: +shares.toFixed(1) } : s;
      } catch {
        return s;
      }
    })
  );
  return results;
}

const SECTORS = ["Biotech", "Mining", "Tech", "Energy", "Cannabis", "Shipping", "Crypto-adj", "Retail"];
const SYLL = ["AX", "BI", "CN", "DR", "EL", "FX", "GN", "HR", "IO", "KV", "LX", "MN", "NV", "OP", "QR", "RT", "SL", "TV", "UX", "VN"];

function randSymbol(used) {
  let s;
  do {
    const len = 3 + Math.floor(Math.random() * 2);
    s = "";
    while (s.length < len) s += SYLL[Math.floor(Math.random() * SYLL.length)];
    s = s.slice(0, len);
  } while (used.has(s));
  used.add(s);
  return s;
}

function seedStock(used) {
  const price = +(2 + Math.random() * 18).toFixed(2);
  const float = +(0.3 + Math.random() * 60).toFixed(1);
  const avgVol = Math.round(50_000 + Math.random() * 900_000);
  const rvolBase = Math.random() < 0.35 ? 3 + Math.random() * 9 : 0.4 + Math.random() * 2.5;
  const volume = Math.round(avgVol * rvolBase);
  const gap = Math.random() < 0.4 ? -8 + Math.random() * 45 : -5 + Math.random() * 10;
  const change = gap + (Math.random() - 0.4) * 6;
  return {
    symbol: randSymbol(used),
    sector: SECTORS[Math.floor(Math.random() * SECTORS.length)],
    price,
    prevClose: +(price / (1 + change / 100)).toFixed(2),
    change: +change.toFixed(2),
    gap: +gap.toFixed(2),
    volume,
    avgVol,
    rvol: +(volume / avgVol).toFixed(2),
    float,
    high: +(price * (1 + Math.random() * 0.08)).toFixed(2),
    low: +(price * (1 - Math.random() * 0.08)).toFixed(2),
    lastTick: 0,
  };
}

function jitter(s) {
  const priceMove = s.price * (Math.random() - 0.48) * 0.02;
  const price = Math.max(0.5, +(s.price + priceMove).toFixed(2));
  const change = +(((price - s.prevClose) / s.prevClose) * 100).toFixed(2);
  const volAdd = Math.round(s.avgVol * (0.002 + Math.random() * 0.02) * (s.rvol > 3 ? 3 : 1));
  const volume = s.volume + volAdd;
  return {
    ...s,
    price,
    change,
    gap: s.gap,
    volume,
    rvol: +(volume / s.avgVol).toFixed(2),
    high: Math.max(s.high, price),
    low: Math.min(s.low, price),
    lastTick: priceMove >= 0 ? 1 : -1,
  };
}

function genUniverse(n) {
  const used = new Set();
  return Array.from({ length: n }, () => seedStock(used));
}

const DEFAULT_CRITERIA = {
  minRvol: 5,
  minVolume: 500_000,
  minGap: 10,
  priceMin: 2,
  priceMax: 20,
  maxFloat: 20,
};

function fmtVol(v) {
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(0) + "K";
  return String(v);
}

// Heatmap cell coloring — mirrors the shaded-cell style of typical scanner UIs.
function pctHeat(pct) {
  if (pct == null) return null;
  const t = Math.min(Math.abs(pct) / 150, 1);
  if (pct >= 0) return { bg: `hsl(142, 65%, ${68 - t * 33}%)`, fg: t > 0.15 ? "#062712" : "#0a3d1f" };
  return { bg: `hsl(350, 75%, ${88 - t * 22}%)`, fg: "#5c0c18" };
}
function floatHeat(floatM) {
  if (floatM == null) return null;
  const t = 1 - Math.min(floatM / 30, 1); // smaller float = stronger cyan
  if (t <= 0.02) return null;
  return { bg: `hsl(189, 85%, ${82 - t * 40}%)`, fg: "#043038" };
}
function volHeat(volume) {
  const t = Math.min(Math.max((Math.log10(volume + 1) - 5) / 3, 0), 1);
  return { bg: `hsl(212, 45%, ${78 - t * 32}%)`, fg: t > 0.4 ? "#f2f7fc" : "#0e2740" };
}
function rvolHeat(rvol, threshold) {
  const t = Math.min(rvol / (threshold * 2.5), 1);
  if (rvol < 1) return null;
  return { bg: `hsl(142, 55%, ${80 - t * 42}%)`, fg: t > 0.35 ? "#062712" : "#0a3d1f" };
}

function scoreOf(s, c) {
  let n = 0;
  if (s.rvol >= c.minRvol) n++;
  if (s.volume >= c.minVolume) n++;
  if (s.gap >= c.minGap) n++;
  if (s.price >= c.priceMin && s.price <= c.priceMax) n++;
  if (s.float != null && s.float <= c.maxFloat) n++;
  return n;
}

export default function ExplosiveScanner() {
  const [stocks, setStocks] = useState(() => genUniverse(48));
  const [criteria, setCriteria] = useState(DEFAULT_CRITERIA);
  const [live, setLive] = useState(true);
  const [sortKey, setSortKey] = useState("score");
  const [sortDir, setSortDir] = useState("desc");
  const [showSettings, setShowSettings] = useState(false);
  const [flashRows, setFlashRows] = useState({});
  const [polygonKey, setPolygonKey] = useState("");
  const [finnhubKey, setFinnhubKey] = useState("");
  const [liveStatus, setLiveStatus] = useState("idle"); // idle | loading | ok | error
  const [liveError, setLiveError] = useState("");
  const tickRef = useRef(0);

  const useLiveData = polygonKey.trim().length > 0;

  // Simulated mode
  useEffect(() => {
    if (!live || useLiveData) return;
    const id = setInterval(() => {
      tickRef.current += 1;
      setStocks((prev) => {
        const next = prev.map((s) => (Math.random() < 0.55 ? jitter(s) : s));
        if (tickRef.current % 9 === 0) {
          const used = new Set(next.map((s) => s.symbol));
          const idx = Math.floor(Math.random() * next.length);
          next[idx] = seedStock(used);
        }
        const flashes = {};
        next.forEach((s) => {
          if (s.lastTick) flashes[s.symbol] = s.lastTick;
        });
        setFlashRows(flashes);
        return next;
      });
    }, 1400);
    return () => clearInterval(id);
  }, [live, useLiveData]);

  // Live mode — tries the real-time snapshot first; on a 403 (free-tier
  // entitlement block), falls back to the grouped-daily EOD endpoint so the
  // free plan still shows something useful. Polls at a free-tier-safe rate.
  useEffect(() => {
    if (!live || !useLiveData) return;
    let cancelled = false;

    async function poll() {
      setLiveStatus("loading");
      try {
        let snapshot;
        let mode = "live";
        try {
          snapshot = await fetchPolygonSnapshot(polygonKey.trim());
        } catch (err) {
          if (err.status === 403) {
            mode = "eod";
            snapshot = await fetchGroupedFallback(polygonKey.trim());
          } else {
            throw err;
          }
        }
        snapshot = snapshot.filter(
          (s) => s.price >= 1 && s.price <= 50 && s.volume >= 50000
        );
        if (finnhubKey.trim()) {
          const shortlist = snapshot.filter(
            (s) =>
              s.rvol >= criteria.minRvol &&
              s.volume >= criteria.minVolume &&
              s.gap >= criteria.minGap &&
              s.price >= criteria.priceMin &&
              s.price <= criteria.priceMax
          );
          const enriched = await enrichFloat(shortlist.slice(0, 40), finnhubKey.trim());
          const byName = new Map(enriched.map((s) => [s.symbol, s]));
          snapshot = snapshot.map((s) => byName.get(s.symbol) || s);
        }
        if (!cancelled) {
          setStocks(snapshot);
          setLiveStatus(mode === "eod" ? "eod" : "ok");
          setLiveError("");
        }
      } catch (err) {
        if (!cancelled) {
          setLiveStatus("error");
          setLiveError(err.message || "Fetch failed");
        }
      }
    }

    poll();
    // EOD fallback data doesn't change intraday, so poll far less often once
    // we've fallen into that mode to avoid burning free-tier calls for no reason.
    const intervalMs = liveStatus === "eod" ? 5 * 60_000 : 15_000;
    const id = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [live, useLiveData, polygonKey, finnhubKey, criteria.minRvol, criteria.minVolume, criteria.minGap, criteria.priceMin, criteria.priceMax, liveStatus === "eod"]);

  const scored = useMemo(
    () => stocks.map((s) => ({ ...s, score: scoreOf(s, criteria) })),
    [stocks, criteria]
  );

  const filtered = useMemo(() => scored.filter((s) => s.score >= 1), [scored]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const dir = sortDir === "desc" ? -1 : 1;
      return (a[sortKey] - b[sortKey]) * dir;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  const explosiveCount = filtered.filter((s) => s.score === 5).length;

  function toggleSort(key) {
    if (sortKey === key) setSortDir(sortDir === "desc" ? "asc" : "desc");
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function updateCriterion(key, value) {
    setCriteria((c) => ({ ...c, [key]: value }));
  }

  const amber = "#4fc3f7";
  const bg = "#0e1c30";
  const panel = "#152841";
  const headerBar = "#16283f";
  const border = "#233c58";
  const textDim = "#7d92ab";
  const green = "#2ecc71";
  const red = "#ff6b7a";

  const columns = [
    { key: "change", label: "Chg from close (%)" },
    { key: "symbol", label: "Symbol" },
    { key: "price", label: "Price" },
    { key: "volume", label: "Volume" },
    { key: "float", label: "Float" },
    { key: "rvol", label: "Rel volume" },
    { key: "gap", label: "Gap (%)" },
    { key: "score", label: "Signal" },
  ];

  return (
    <div
      style={{
        background: bg,
        color: "#e7edf5",
        fontFamily: "'Inter', -apple-system, 'Segoe UI', sans-serif",
        minHeight: "100vh",
        padding: "0",
        boxSizing: "border-box",
      }}
    >
      <style>{`
        @keyframes scanline {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @keyframes flashUp { 0% { background-color: rgba(46,204,113,0.35); } 100% { background-color: transparent; } }
        @keyframes flashDown { 0% { background-color: rgba(255,107,122,0.3); } 100% { background-color: transparent; } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
        .flash-up { animation: flashUp 1.1s ease-out; }
        .flash-down { animation: flashDown 1.1s ease-out; }
        .row:hover td { filter: brightness(1.08); }
        ::-webkit-scrollbar { height: 8px; width: 8px; }
        ::-webkit-scrollbar-thumb { background: #2c4562; border-radius: 4px; }
      `}</style>

      {/* Title bar */}
      <div
        style={{
          background: headerBar,
          borderBottom: `1px solid ${border}`,
          padding: "12px 18px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Zap size={16} color={amber} fill={amber} />
          <span style={{ fontSize: 14.5, fontWeight: 600, color: "#e7edf5" }}>
            Explosive demand scanner
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11,
              color: textDim,
              marginLeft: 6,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: !live ? textDim : liveStatus === "error" ? red : liveStatus === "eod" ? amber : green,
                animation: live ? "pulse 1.6s ease-in-out infinite" : "none",
              }}
            />
            {!live
              ? "Paused"
              : useLiveData
              ? liveStatus === "error"
                ? "Feed error"
                : liveStatus === "loading"
                ? "Fetching…"
                : liveStatus === "eod"
                ? "EOD mode · free plan"
                : "Online · Polygon"
              : "Online · simulated"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            onClick={() => setLive((v) => !v)}
            style={{
              background: live ? "transparent" : amber,
              color: live ? amber : "#04202e",
              border: `1px solid ${amber}`,
              borderRadius: 4,
              padding: "5px 12px",
              fontSize: 11.5,
              fontFamily: "inherit",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {live ? "Pause" : "Resume"}
          </button>
          <button
            onClick={() => setShowSettings((v) => !v)}
            style={{
              background: "transparent",
              color: "#e7edf5",
              border: `1px solid ${border}`,
              borderRadius: 4,
              padding: "5px 10px",
              fontSize: 11.5,
              fontFamily: "inherit",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Settings2 size={13} /> Criteria
          </button>
        </div>
      </div>

      <div style={{ padding: "16px 18px" }}>

      {/* scan sweep bar */}
      <div style={{ position: "relative", height: 2, background: border, overflow: "hidden", marginBottom: 14, borderRadius: 2 }}>
        {live && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "40%",
              height: "100%",
              background: `linear-gradient(90deg, transparent, ${amber}, transparent)`,
              animation: "scanline 2.6s linear infinite",
            }}
          />
        )}
      </div>

      {/* simulated data banner */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          background: panel,
          border: `1px solid ${border}`,
          borderLeft: `3px solid ${amber}`,
          borderRadius: 3,
          padding: "8px 12px",
          fontSize: 11.5,
          color: textDim,
          marginBottom: 16,
        }}
      >
        <Info size={14} color={amber} style={{ flexShrink: 0, marginTop: 1 }} />
        {useLiveData ? (
          liveStatus === "eod" ? (
            <span>
              Your Massive/Polygon plan doesn't include the real-time snapshot endpoint, so this is running on{" "}
              <span style={{ color: amber }}>end-of-day data</span> instead — comparing the two most recent completed
              sessions, refreshed every 5 min. Not live intraday. Upgrade to a paid Stocks plan at{" "}
              <span style={{ color: amber }}>massive.com/pricing</span> for real-time scanning. Float column{" "}
              {finnhubKey.trim() ? "is enriched via Finnhub for shortlisted names" : "is empty — add a Finnhub key below to fill it in"}.
            </span>
          ) : (
            <span>
              Live on <span style={{ color: amber }}>Polygon.io</span>, polled every 15s (free-tier safe).
              {liveError && <span style={{ color: red }}> Last error: {liveError}</span>}
              {" "}Float column {finnhubKey.trim() ? "is enriched via Finnhub for shortlisted names" : "is empty — add a Finnhub key below to fill it in"}. RVol is day-volume ÷ prior-day volume (a proxy, not a true 20-day average).
            </span>
          )
        ) : (
          <span>
            Running on <span style={{ color: amber }}>simulated tick data</span> — add a Polygon.io API key in CRITERIA below to scan real quotes.
          </span>
        )}
      </div>

      {/* settings panel */}
      {showSettings && (
        <div
          style={{
            background: panel,
            border: `1px solid ${border}`,
            borderRadius: 4,
            padding: 16,
            marginBottom: 16,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 14,
          }}
        >
          <div style={{ gridColumn: "1 / -1", borderBottom: `1px solid ${border}`, paddingBottom: 12, marginBottom: 2 }}>
            <div style={{ fontSize: 10.5, color: textDim, marginBottom: 8, letterSpacing: 0.5, display: "flex", alignItems: "center", gap: 6 }}>
              <Key size={12} /> LIVE DATA KEYS (kept in-session only, never persisted)
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
              <input
                type="password"
                placeholder="Polygon.io API key (enables live mode)"
                value={polygonKey}
                onChange={(e) => setPolygonKey(e.target.value)}
                style={{
                  background: bg,
                  border: `1px solid ${border}`,
                  borderRadius: 3,
                  color: "#e8e2d4",
                  fontFamily: "inherit",
                  fontSize: 12,
                  padding: "7px 10px",
                }}
              />
              <input
                type="password"
                placeholder="Finnhub API key (optional, for float)"
                value={finnhubKey}
                onChange={(e) => setFinnhubKey(e.target.value)}
                style={{
                  background: bg,
                  border: `1px solid ${border}`,
                  borderRadius: 3,
                  color: "#e8e2d4",
                  fontFamily: "inherit",
                  fontSize: 12,
                  padding: "7px 10px",
                }}
              />
            </div>
          </div>
          {[
            { key: "minRvol", label: "Min relative volume", suffix: "×", min: 1, max: 20, step: 0.5 },
            { key: "minVolume", label: "Min total volume", suffix: "", min: 50000, max: 5000000, step: 50000 },
            { key: "minGap", label: "Min gap / % gain", suffix: "%", min: 0, max: 50, step: 1 },
            { key: "priceMin", label: "Price floor", suffix: "$", min: 0.5, max: 20, step: 0.5 },
            { key: "priceMax", label: "Price ceiling", suffix: "$", min: 2, max: 50, step: 0.5 },
            { key: "maxFloat", label: "Max float (M shares)", suffix: "M", min: 1, max: 50, step: 1 },
          ].map((f) => (
            <div key={f.key}>
              <div style={{ fontSize: 10.5, color: textDim, marginBottom: 4, letterSpacing: 0.5 }}>
                {f.label.toUpperCase()}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="range"
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  value={criteria[f.key]}
                  onChange={(e) => updateCriterion(f.key, parseFloat(e.target.value))}
                  style={{ flex: 1, accentColor: amber }}
                />
                <span style={{ fontSize: 12, color: amber, minWidth: 54, textAlign: "right" }}>
                  {f.key === "minVolume" ? fmtVol(criteria[f.key]) : criteria[f.key]}
                  {f.suffix}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* pillar chips */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {[
          `RVol ≥ ${criteria.minRvol}×`,
          `Vol ≥ ${fmtVol(criteria.minVolume)}`,
          `Gap ≥ ${criteria.minGap}%`,
          `$${criteria.priceMin}–$${criteria.priceMax}`,
          `Float ≤ ${criteria.maxFloat}M`,
        ].map((label) => (
          <span
            key={label}
            style={{
              fontSize: 11,
              color: amber,
              border: `1px solid ${amber}55`,
              background: "#1e1706",
              padding: "3px 9px",
              borderRadius: 12,
            }}
          >
            {label}
          </span>
        ))}
        <span style={{ fontSize: 11, color: green, border: `1px solid ${green}55`, background: "#0c1f14", padding: "3px 9px", borderRadius: 12, marginLeft: "auto" }}>
          {explosiveCount} meeting ALL 5 pillars
        </span>
      </div>

      {/* table */}
      <div style={{ border: `1px solid ${border}`, borderRadius: 4, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 720 }}>
          <thead>
            <tr style={{ background: panel, borderBottom: `1px solid ${border}` }}>
              {columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => toggleSort(col.key)}
                  style={{
                    textAlign: col.key === "symbol" ? "left" : "right",
                    padding: "9px 12px",
                    color: sortKey === col.key ? amber : textDim,
                    cursor: "pointer",
                    userSelect: "none",
                    fontWeight: 600,
                    fontSize: 11.5,
                    whiteSpace: "nowrap",
                  }}
                >
                  {col.label}
                  {sortKey === col.key ? (sortDir === "desc" ? " ▾" : " ▴") : ""}
                </th>
              ))}
              <th style={{ textAlign: "left", padding: "9px 12px", color: textDim, fontWeight: 600, letterSpacing: 0.3, fontSize: 11.5 }}>
                Sector
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => {
              const explosive = s.score === 5;
              const flash = flashRows[s.symbol];
              const chgH = pctHeat(s.change);
              const gapH = pctHeat(s.gap);
              const floH = floatHeat(s.float);
              const volH = volHeat(s.volume);
              const rvH = rvolHeat(s.rvol, criteria.minRvol);
              return (
                <tr
                  key={s.symbol}
                  className={`row ${flash === 1 ? "flash-up" : flash === -1 ? "flash-down" : ""}`}
                  style={{ borderBottom: `1px solid ${border}` }}
                >
                  <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600, background: chgH?.bg, color: chgH?.fg }}>
                    {s.change >= 0 ? "+" : ""}
                    {s.change.toFixed(2)}
                  </td>
                  <td style={{ padding: "8px 12px", fontWeight: 700, color: explosive ? amber : "#e7edf5", display: "flex", alignItems: "center", gap: 6 }}>
                    {explosive && <TrendingUp size={12} color={amber} />}
                    {s.symbol}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }}>${s.price.toFixed(2)}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", background: volH.bg, color: volH.fg }}>
                    {fmtVol(s.volume)}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right", background: floH?.bg, color: floH?.fg }}>
                    {s.float != null ? `${s.float.toFixed(1)}M` : "—"}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right", background: rvH?.bg, color: rvH?.fg, fontWeight: s.rvol >= criteria.minRvol ? 700 : 400 }}>
                    {s.rvol.toFixed(2)}×
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right", background: gapH?.bg, color: gapH?.fg }}>
                    {s.gap >= 0 ? "+" : ""}
                    {s.gap.toFixed(2)}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }}>
                    <div style={{ display: "inline-flex", gap: 2 }}>
                      {Array.from({ length: 5 }).map((_, i) => (
                        <div
                          key={i}
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 1,
                            background: i < s.score ? (explosive ? amber : "#5c7595") : "#233c58",
                          }}
                        />
                      ))}
                    </div>
                  </td>
                  <td style={{ padding: "8px 12px", color: textDim, whiteSpace: "nowrap", fontSize: 12 }}>{s.sector}</td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={9} style={{ padding: 24, textAlign: "center", color: textDim }}>
                  No tickers matching current criteria right now.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 10, fontSize: 11, color: textDim, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <span>Scanning {stocks.length} tickers · showing {sorted.length} with ≥1 pillar met · click headers to sort</span>
        <span>Signal dots = pillars met (5/5 = explosive setup)</span>
      </div>
      </div>
    </div>
  );
}
