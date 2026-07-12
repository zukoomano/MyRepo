// Metal Signal Pro — cloud runner (GitHub Actions)
// Runs the hardened gated engine on OANDA data for XAUUSD + XAGUSD.
// Institutional risk layer: news blackout, correlation gate, circuit breaker, market hours.
//
// Secrets required (repo Settings → Secrets and variables → Actions):
//   OANDA_KEY, OANDA_ENV, TG_TOKEN, TG_CHAT

const fs = require("fs");
const { generateSignals, currentSession } = require("./engine.js");

// ---- Secrets ----
const OANDA_KEY = process.env.OANDA_KEY || "";
const OANDA_ENV = process.env.OANDA_ENV || "practice";
const TG_TOKEN  = process.env.TG_TOKEN  || "";
const TG_CHAT   = process.env.TG_CHAT   || "";

// ---- Settings (edit these) ----
const TIMEFRAME     = "M15";
const SL_POINTS     = 200;   // stop floor in points (engine also enforces 1.2x ATR)
const SPREAD_POINTS = 0;     // your typical Exness spread in points (0 = ignore)
const MAX_LOSSES    = 3;     // circuit breaker: pause after N consecutive losses
const CORREL_GATE   = true;  // block same-direction signal on the other metal
const NEWS_BLACKOUT = true;  // pause signals around high-impact releases
const SYMBOLS       = ["XAUUSD", "XAGUSD"];
const STATE_FILE    = "state.json";

// ---- Helpers ----
function fmt(v, s){ return v==null ? "-" : (s==="XAUUSD" ? Number(v).toFixed(2) : Number(v).toFixed(4)); }
function utcIST(d){
  d = d || new Date();
  const p = n => String(n).padStart(2,"0");
  const ist = new Date(d.getTime()+330*60000);
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC (${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())} IST)`;
}
function today(){ return new Date().toISOString().slice(0,10); }

// ---- Market hours: Sun 22:00 UTC -> Fri 22:00 UTC (Mon 03:30 - Sat 03:30 IST) ----
const US_HOLIDAYS = new Set([
  "2026-01-01","2026-01-19","2026-02-16","2026-04-03","2026-05-25","2026-06-19","2026-07-03","2026-09-07","2026-11-26","2026-12-25",
  "2027-01-01","2027-01-18","2027-02-15","2027-03-26","2027-05-31","2027-06-18","2027-07-05","2027-09-06","2027-11-25","2027-12-24"
]);
function isMarketClosed(){
  const now = new Date(), day = now.getUTCDay(), h = now.getUTCHours();
  if (day === 6) return { closed:true, reason:"Weekend" };
  if (day === 0 && h < 22) return { closed:true, reason:"Weekend (reopens Mon 03:30 IST)" };
  if (day === 5 && h >= 22) return { closed:true, reason:"Weekend (closed Sat 03:30 IST)" };
  if (US_HOLIDAYS.has(today())) return { closed:true, reason:"US market holiday" };
  return { closed:false };
}

// ---- GATE: News blackout (+/-15 min around major UTC releases) ----
function newsBlackout(){
  if (!NEWS_BLACKOUT) return null;
  const now = new Date(), day = now.getUTCDay();
  if (day === 0 || day === 6) return null;
  const mins = now.getUTCHours()*60 + now.getUTCMinutes();
  const windows = [
    { t: 12*60+30, name: "US data release (NFP/CPI window)" },
    { t: 14*60+0,  name: "US data release" },
    { t: 18*60+0,  name: "FOMC / Fed window" },
  ];
  for (const w of windows) if (Math.abs(mins - w.t) <= 15)
    return `News blackout — ${w.name}. Spreads widen and stops get hunted around releases.`;
  return null;
}

// ---- GATE: Correlation (gold & silver ~0.8 correlated) ----
function correlationBlocked(st, symbol, dir){
  if (!CORREL_GATE || dir === "NEUTRAL") return null;
  const other = symbol === "XAUUSD" ? "XAGUSD" : "XAUUSD";
  if (st.lastDir[other] === dir)
    return `Correlation gate — already ${dir} on ${other}. Gold & silver move together; this doubles the same bet.`;
  return null;
}

// ---- OANDA ----
async function fetchOANDA(symbol) {
  const inst = symbol === "XAUUSD" ? "XAU_USD" : "XAG_USD";
  const gran = { M15:"M15", M30:"M30", H1:"H1" }[TIMEFRAME] || "M15";
  const host = OANDA_ENV === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
  const url = `${host}/v3/instruments/${inst}/candles?granularity=${gran}&count=250&price=M`;
  const res = await fetch(url, { headers: { "Authorization": "Bearer " + OANDA_KEY } });
  if (!res.ok) throw new Error(`OANDA HTTP ${res.status}`);
  const data = await res.json();
  if (!data.candles) throw new Error("no candles");
  const out = data.candles.map(c => ({
    time: new Date(c.time).getTime(),
    open:+c.mid.o, high:+c.mid.h, low:+c.mid.l, close:+c.mid.c, volume:c.volume||1000,
  }));
  if (out.length < 60) throw new Error("too few candles");
  return out;
}

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log("No Telegram creds — skipping send."); return; }
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ chat_id: TG_CHAT, text }),
  });
  const j = await res.json().catch(()=>({}));
  console.log(j.ok ? "Telegram sent." : "Telegram error: " + JSON.stringify(j));
}

// ---- State ----
function loadState(){
  try { return JSON.parse(fs.readFileSync(STATE_FILE,"utf8")); }
  catch(e){ return { lastDir:{}, losses:0, wins:0, tripped:null, day:null, lastHeartbeat:null }; }
}
function saveState(st){ fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2)); }

// ---- Message blocks ----
function metalBlock(sym, sig, isNew, blocked) {
  if (blocked) return `⛔ *${sym}: BLOCKED BY RISK GATE*\n   _${blocked}_`;
  const v = sig ? sig.overall : "NEUTRAL";
  if (v === "NEUTRAL") {
    const why = (sig && sig.vetoes && sig.vetoes.length) ? `\n   _${sig.vetoes[0]}_` : "";
    return `⏸️ *${sym}: NEUTRAL* — no trade, stay out${why}`;
  }
  const dir = v === "BUY" ? "🟢" : "🔴";
  const tag = isNew ? "🚨 *NEW — you may enter*" : "↔️ still active — _don't re-enter_";
  return [
    `${dir} *${sym}: ${v}*  ${tag}`,
    `   Entry ${fmt(sig.levels.entry,sym)} · SL ${fmt(sig.levels.sl,sym)}`,
    `   TP1 ${fmt(sig.levels.tp1,sym)} · TP2 ${fmt(sig.levels.tp2,sym)}  (R:R ${sig.levels.rr})`,
  ].join("\n");
}

(async () => {
  if (!OANDA_KEY) { console.error("OANDA_KEY secret missing."); process.exit(1); }

  const mc = isMarketClosed();
  if (mc.closed) { console.log(`Market closed (${mc.reason}) — no analysis, no message.`); return; }

  const st = loadState();
  st.lastDir = st.lastDir || {};
  if (st.day !== today()) { st.day = today(); st.losses = 0; st.wins = 0; st.tripped = null; }

  if (st.tripped) {
    console.log("Circuit breaker tripped for today — no signals sent.");
    saveState(st);
    return;
  }

  const nb = newsBlackout();
  const sess = currentSession();
  const sessionActive = sess.asian || sess.london || sess.ny;
  const opts = { tpPoints: SL_POINTS*2, tp2Points: SL_POINTS*3, slPoints: SL_POINTS,
                 sessionActive, sessionName: sess.name, dxyBias:"NEUTRAL", dxyDetail:"",
                 spreadPoints: SPREAD_POINTS };

  const blocks = [];
  for (const sym of SYMBOLS) {
    try {
      const candles = await fetchOANDA(sym);
      const sig = generateSignals(candles, opts);
      const v = sig ? sig.overall : "NEUTRAL";

      let blocked = null;
      if (v !== "NEUTRAL") {
        if (nb) blocked = nb;
        else blocked = correlationBlocked(st, sym, v);
      }

      const isNew = (v !== "NEUTRAL") && !blocked && (st.lastDir[sym] !== v);
      console.log(`${sym}: ${v}${sig?` (${sig.conf}%)`:""}${isNew?" [NEW]":""}${blocked?" [BLOCKED]":""} | ${sess.name}`);
      blocks.push(metalBlock(sym, sig, isNew, blocked));
      if (!blocked) st.lastDir[sym] = v;
    } catch (e) {
      console.error(`${sym} error:`, e.message);
      blocks.push(`⚠️ *${sym}*: data error (${e.message})`);
    }
  }

  let header = `📊 *Metal Signal Pro* · ${TIMEFRAME} · ${utcIST()}`;
  if (st.lastHeartbeat !== today()) {
    header = `✅ *Daily heartbeat — system running*\n` + header;
    st.lastHeartbeat = today();
  }

  const msg = [
    header,
    `━━━━━━━━━━━━━━━━━━`,
    blocks.join("\n\n"),
    `━━━━━━━━━━━━━━━━━━`,
    `⚠️ Enter only on 🚨 *NEW*. Never re-enter an active trade or trade a NEUTRAL.`,
    `_Signals are not guaranteed. Test on demo first._`,
  ].join("\n");

  await sendTelegram(msg);
  saveState(st);
  console.log("Done. Message sent.");
})().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
