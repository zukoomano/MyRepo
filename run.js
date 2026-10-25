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
const TIMEFRAME     = "M30"; // analyse 30-minute candles
const SL_POINTS     = 200;   // stop floor in points (engine also enforces 1.2x ATR)
const SPREAD_POINTS = 0;     // your typical Exness spread in points (0 = ignore)
const MAX_LOSSES    = 3;     // circuit breaker: pause after N consecutive losses
const CORREL_GATE   = true;  // block same-direction signal on the other metal
const NEWS_BLACKOUT = true;  // pause signals around high-impact releases
const SYMBOLS       = ["XAUUSD", "XAGUSD", "USDJPY"];
const STATE_FILE    = "state.json";

// Per-symbol properties (metals vs JPY pair differ in decimals, pip size)
function symProps(sym){
  if(sym==="USDJPY") return { inst:"USD_JPY", decimals:3, pointSize:0.001, kind:"fx" };
  if(sym==="XAGUSD") return { inst:"XAG_USD", decimals:4, pointSize:0.01,  kind:"metal" };
  return                     { inst:"XAU_USD", decimals:2, pointSize:0.01,  kind:"metal" };
}

// ---- Helpers ----
function fmt(v, s){ return v==null ? "-" : Number(v).toFixed(symProps(s).decimals); }
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
  if (symbol === "USDJPY") return null;                 // FX pair is independent of the metals
  const other = symbol === "XAUUSD" ? "XAGUSD" : "XAUUSD";
  if (st.lastDir[other] === dir)
    return `Correlation gate — already ${dir} on ${other}. Gold & silver move together; this doubles the same bet.`;
  return null;
}

// ---- OANDA ----
async function fetchOANDA(symbol) {
  const inst = symProps(symbol).inst;
  const gran = { M15:"M15", M30:"M30", H1:"H1" }[TIMEFRAME] || "M15";
  const host = OANDA_ENV === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
  const url = `${host}/v3/instruments/${inst}/candles?granularity=${gran}&count=250&price=M`;
  const res = await fetch(url, { headers: { "Authorization": "Bearer " + OANDA_KEY } });
  if (!res.ok) throw new Error(`OANDA HTTP ${res.status}`);
  const data = await res.json();
  if (!data.candles) throw new Error("no candles");
  // Closed candles only: the still-forming candle is dropped so signals never repaint
  const out = data.candles.filter(c => c.complete).map(c => ({
    time: new Date(c.time).getTime(),
    open:+c.mid.o, high:+c.mid.h, low:+c.mid.l, close:+c.mid.c, volume:c.volume||1000,
  }));
  if (out.length < 60) throw new Error("too few candles");
  return out;
}

async function sendTelegram(text, html) {
  if (!TG_TOKEN || !TG_CHAT) { console.log("No Telegram creds — skipping send."); return; }
  const body = { chat_id: TG_CHAT, text };
  if (html) body.parse_mode = "HTML";   // used only for the recap table (monospace <pre>)
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify(body),
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

// ---- TRACKING START: win/loss scorecard ----
const LOG_FILE  = "signals.json";
const EXPIRE_MS = 5*24*3600*1000;   // a signal that hits neither TP1 nor SL within 5 days closes as EXPIRED
function loadLog(){ try { return JSON.parse(fs.readFileSync(LOG_FILE,"utf8")); } catch(e){ return []; } }
function saveLog(log){ fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2)); }

// Check open signals for one symbol against candles that closed AFTER the signal candle.
// TP1 first = WIN, SL first = LOSS. Both inside one candle = order unknown, counted as LOSS (conservative).
function resolveOpen(log, sym, candles, now){
  now = now || Date.now();
  const closed = [];
  for (const s of log) {
    if (s.sym !== sym || s.status !== "OPEN") continue;
    for (const c of candles) {
      if (c.time <= s.candleTime) continue;
      const hitSL = s.dir === "BUY" ? c.low  <= s.sl  : c.high >= s.sl;
      const hitTP = s.dir === "BUY" ? c.high >= s.tp1 : c.low  <= s.tp1;
      if (hitSL || hitTP) { s.status = hitSL ? "LOSS" : "WIN"; s.closedAt = c.time; break; }
    }
    if (s.status === "OPEN" && now - s.candleTime > EXPIRE_MS) { s.status = "EXPIRED"; s.closedAt = now; }
    if (s.status !== "OPEN") closed.push(s);
  }
  return closed;
}

function scorecard(log){
  const done = log.filter(s => s.status === "WIN" || s.status === "LOSS");
  const open = log.filter(s => s.status === "OPEN").length;
  const expired = log.filter(s => s.status === "EXPIRED").length;
  if (!done.length) return `📒 Record: no closed signals yet (${open} open)`;
  const w = done.filter(s => s.status === "WIN").length, l = done.length - w;
  const netR = done.reduce((a, s) => a + (s.status === "WIN" ? s.rr : -1), 0);
  return `📒 Record: ${w}W / ${l}L · win rate ${(w/done.length*100).toFixed(0)}% (break-even ~33% at 2:1)` +
         ` · net ${netR >= 0 ? "+" : ""}${netR.toFixed(1)}R · ${open} open${expired ? ` · ${expired} expired` : ""}`;
}

function resultLine(s){
  const icon = s.status === "WIN" ? "✅" : s.status === "LOSS" ? "❌" : "⌛";
  const what = s.status === "WIN" ? `TP1 ${fmt(s.tp1, s.sym)} hit`
             : s.status === "LOSS" ? `SL ${fmt(s.sl, s.sym)} hit`
             : "neither TP1 nor SL in 5 days";
  return `${icon} ${s.sym} ${s.dir} from ${fmt(s.entry, s.sym)} — ${what}`;
}

// ---- Signal table: Date | Pair | Signal | Result ----
const LOG_MD = "signal-log.md";
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function istShort(ms, withYear){
  const d = new Date(ms + 330*60000), p = n => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}${withYear ? " " + d.getUTCFullYear() : ""} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
const RESULT_LABEL = { WIN: "✅ Win (TP1 hit)", LOSS: "❌ Loss (SL hit)", OPEN: "⏳ Open", EXPIRED: "⌛ Expired (no TP1/SL in 5 days)" };
const RESULT_SHORT = { WIN: "Win", LOSS: "Loss", OPEN: "Open", EXPIRED: "Expired" };

// Full history, newest first — GitHub shows this as a proper table
function writeLogMd(log, now){
  const rows = [...log].sort((a, b) => b.sentAt - a.sentAt);
  const md = [
    `# Signal log`,
    ``,
    `Updated ${istShort(now, true)} IST`,
    ``,
    scorecard(log).replace("📒 ", "**") .replace(/^(\*\*Record:)/, "$1**"),
    ``,
    `| Date (IST) | Pair | Signal | Result |`,
    `|---|---|---|---|`,
    ...rows.map(s => `| ${istShort(s.sentAt, true)} | ${s.sym} | ${s.dir} | ${RESULT_LABEL[s.status]} |`),
    ``,
    `Win = TP1 reached before SL. Loss = SL reached first, or both inside the same ${TIMEFRAME} candle (order unknown). ` +
    `Expired signals are left out of the win rate. Entry is the published price; spread is not deducted.`,
    ``,
  ].join("\n");
  fs.writeFileSync(LOG_MD, md);
}

// Once-a-day Telegram recap of the last 24 hours, in a fixed-width table
function recapText(log, now){
  const recent = log.filter(s => now - s.sentAt <= 24*3600*1000).sort((a, b) => a.sentAt - b.sentAt);
  if (!recent.length) return null;
  const pad = (s, n) => String(s).padEnd(n);
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const table = [
    pad("Date", 13) + pad("Pair", 8) + pad("Signal", 7) + "Result",
    ...recent.map(s => pad(istShort(s.sentAt), 13) + pad(s.sym, 8) + pad(s.dir, 7) + RESULT_SHORT[s.status]),
  ].join("\n");
  return `📋 Signals in the last 24 hours (IST)\n<pre>${esc(table)}</pre>\n${esc(scorecard(log))}\nFull history: ${LOG_MD} in your repo.`;
}
// ---- TRACKING END ----

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

  const blocks = [];      // only NEW BUY/SELL opportunities go in here
  const log = loadLog();  // every signal ever sent, with its outcome
  const results = [];     // signals that closed (TP1 / SL / expired) this run
  for (const sym of SYMBOLS) {
    try {
      const candles = await fetchOANDA(sym);
      results.push(...resolveOpen(log, sym, candles));
      const symOpts = { ...opts, pointSize: symProps(sym).pointSize };
      const sig = generateSignals(candles, symOpts);
      const v = sig ? sig.overall : "NEUTRAL";

      let blocked = null;
      if (v !== "NEUTRAL") {
        if (nb) blocked = nb;
        else blocked = correlationBlocked(st, sym, v);
      }

      const isNew = (v !== "NEUTRAL") && !blocked && (st.lastDir[sym] !== v);
      console.log(`${sym}: ${v}${sig?` (${sig.conf}%)`:""}${isNew?" [NEW]":""}${blocked?" [BLOCKED]":""} | ${sess.name}`);
      if (isNew) {
        blocks.push(metalBlock(sym, sig, true, null));            // alert ONLY on a fresh opportunity
        const last = candles[candles.length - 1];
        log.push({ id: `${sym}-${last.time}`, sym, dir: v, tf: TIMEFRAME,
                   entry: sig.levels.entry, sl: sig.levels.sl, tp1: sig.levels.tp1, tp2: sig.levels.tp2,
                   rr: parseFloat(sig.levels.rr) || 2, candleTime: last.time, sentAt: Date.now(), status: "OPEN" });
      }
      if (!blocked) st.lastDir[sym] = v;
    } catch (e) {
      console.error(`${sym} error:`, e.message);              // logged only — no Telegram noise
    }
  }

  if (blocks.length) {
    const msg = [
      `🚨 *Trade opportunity* · ${TIMEFRAME} · ${utcIST()}`,
      `━━━━━━━━━━━━━━━━━━`,
      blocks.join("\n\n"),
      `━━━━━━━━━━━━━━━━━━`,
      `_Signals are not guaranteed. Test on demo first._`,
    ].join("\n");
    await sendTelegram(msg);
    console.log(`Done. Sent ${blocks.length} opportunity alert(s).`);
  } else if (st.lastHeartbeat !== today()) {
    // One short proof-of-life per day, so silence means "no setup", not "bot broken"
    await sendTelegram(`✅ Metal Signal Pro is running · ${utcIST()}\nNo new opportunity right now — you'll only hear from me when there is one.\n\n${scorecard(log)}`);
    console.log("No opportunity. Daily heartbeat sent.");
  } else {
    console.log("No new opportunity — nothing sent.");
  }

  if (results.length) {
    await sendTelegram([`📊 Signal results · ${utcIST()}`, ...results.map(resultLine), "", scorecard(log)].join("\n"));
    console.log(`Closed ${results.length} tracked signal(s).`);
  }
  console.log(scorecard(log));

  // Daily recap table (first run of each UTC day = 05:30 IST onwards), only if there were signals
  if (st.lastRecap !== today()) {
    const recap = recapText(log, Date.now());
    if (recap) { await sendTelegram(recap, true); console.log("Daily recap sent."); }
    st.lastRecap = today();
  }
  writeLogMd(log, Date.now());

  if (st.lastHeartbeat !== today()) st.lastHeartbeat = today();
  saveLog(log);
  saveState(st);
})().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
