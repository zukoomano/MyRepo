// Metal Signal Pro — Backtest
// Runs the EXACT signal engine over historical OANDA candles and reports the
// REAL win rate, R/R, and net result. It does not target any number — it measures.
//
// Usage:  OANDA_KEY=yourtoken node backtest.js
// Optional env: OANDA_ENV=practice|live  TF=M15|M30|H1  SYMBOL=XAUUSD|XAGUSD  RR=2

const { generateSignals } = require("./engine.js");

const OANDA_KEY = process.env.OANDA_KEY || "";
const OANDA_ENV = process.env.OANDA_ENV || "practice";
const TF        = process.env.TF || "M15";
const SYMBOL    = process.env.SYMBOL || "XAUUSD";
const RR        = parseFloat(process.env.RR || "2");     // reward:risk ratio to test
const SL_POINTS = parseInt(process.env.SL || "200", 10); // stop distance in points (0.01)
const CANDLES   = parseInt(process.env.N || "4000", 10); // how many past candles to test

const POINT = 0.01;

async function fetchHistory(symbol, tf, total) {
  const inst = symbol === "XAUUSD" ? "XAU_USD" : "XAG_USD";
  const gran = { M15:"M15", M30:"M30", H1:"H1" }[tf] || "M15";
  const host = OANDA_ENV === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
  let all = [];
  let to = null;
  // OANDA caps 5000 candles/request; page backwards
  while (all.length < total) {
    const count = Math.min(5000, total - all.length);
    let url = `${host}/v3/instruments/${inst}/candles?granularity=${gran}&count=${count}&price=M`;
    if (to) url += `&to=${encodeURIComponent(to)}`;
    const res = await fetch(url, { headers: { "Authorization": "Bearer " + OANDA_KEY } });
    if (!res.ok) throw new Error(`OANDA HTTP ${res.status}`);
    const data = await res.json();
    if (!data.candles || !data.candles.length) break;
    const batch = data.candles.filter(c => c.complete).map(c => ({
      time: new Date(c.time).getTime(),
      open:+c.mid.o, high:+c.mid.h, low:+c.mid.l, close:+c.mid.c, volume:c.volume||1000,
    }));
    all = batch.concat(all);
    to = new Date(batch[0].time).toISOString();
    if (batch.length < count) break;
  }
  return all;
}

function simulate(candles) {
  const opts = { tpPoints: Math.round(SL_POINTS*RR), tp2Points: Math.round(SL_POINTS*RR*2),
                 slPoints: SL_POINTS, sessionActive: true, sessionName: "backtest",
                 dxyBias: "NEUTRAL", dxyDetail: "" };

  const trades = [];
  let open = null;            // {dir, entry, sl, tp, openIdx}
  let lastDir = null;

  // Walk forward: at each bar, form a signal on data up to i, then see how it resolves after
  for (let i = 220; i < candles.length - 1; i++) {
    // Manage an open trade against this bar's high/low
    if (open) {
      const c = candles[i];
      let hitTP=false, hitSL=false;
      if (open.dir === "BUY")  { if (c.low <= open.sl) hitSL=true; if (c.high >= open.tp) hitTP=true; }
      else                     { if (c.high >= open.sl) hitSL=true; if (c.low <= open.tp) hitTP=true; }
      if (hitSL && hitTP) { trades.push({ ...open, result:"SL", exitIdx:i }); open=null; }  // conservative: SL first
      else if (hitSL)     { trades.push({ ...open, result:"SL", exitIdx:i }); open=null; }
      else if (hitTP)     { trades.push({ ...open, result:"TP", exitIdx:i }); open=null; }
    }

    if (open) continue; // one trade at a time

    const slice = candles.slice(0, i+1);
    const sig = generateSignals(slice, opts);
    if (!sig || sig.overall === "NEUTRAL") { lastDir = null; continue; }
    // Only take a NEW signal (direction changed) — mirrors live "no stacking"
    if (sig.overall === lastDir) continue;
    lastDir = sig.overall;

    const entry = sig.levels.entry;
    const dir = sig.overall;
    const sl = dir === "BUY" ? entry - SL_POINTS*POINT : entry + SL_POINTS*POINT;
    const tp = dir === "BUY" ? entry + SL_POINTS*RR*POINT : entry - SL_POINTS*RR*POINT;
    open = { dir, entry, sl, tp, openIdx:i };
  }

  return trades;
}

function report(trades) {
  const wins = trades.filter(t => t.result === "TP").length;
  const losses = trades.filter(t => t.result === "SL").length;
  const total = wins + losses;
  const winRate = total ? (wins/total*100) : 0;

  // Net in R multiples: each win = +RR, each loss = -1
  const netR = wins*RR - losses*1;
  // Breakeven win rate needed for this R/R
  const breakeven = 100 / (1 + RR);

  console.log("\n════════════════════════════════════════");
  console.log(`  BACKTEST RESULT — ${SYMBOL} · ${TF}`);
  console.log("════════════════════════════════════════");
  console.log(`  Reward : Risk tested   : ${RR} : 1  (SL ${SL_POINTS}pts, TP ${SL_POINTS*RR}pts)`);
  console.log(`  Trades taken           : ${total}   (${wins} win / ${losses} loss)`);
  console.log(`  WIN RATE               : ${winRate.toFixed(1)}%`);
  console.log(`  Break-even win rate    : ${breakeven.toFixed(1)}%  (need to beat this to profit)`);
  console.log(`  Net result             : ${netR>=0?"+":""}${netR.toFixed(1)}R  (R = one risk unit)`);
  console.log("────────────────────────────────────────");
  if (total < 20) {
    console.log("  ⚠ Too few trades to trust — widen the test (raise N).");
  } else if (winRate > breakeven + 5) {
    console.log(`  ✅ PROFITABLE in this sample: ${winRate.toFixed(1)}% beats the ${breakeven.toFixed(1)}% break-even.`);
  } else if (winRate >= breakeven) {
    console.log(`  ⚖ MARGINAL: just above break-even. Edge is thin — costs/spread could erase it.`);
  } else {
    console.log(`  ❌ NOT profitable in this sample: ${winRate.toFixed(1)}% is below the ${breakeven.toFixed(1)}% needed.`);
  }
  console.log("════════════════════════════════════════");
  console.log("  Note: past results do NOT guarantee future performance.");
  console.log("  Spread, slippage & swaps are NOT included — real results are usually worse.\n");
}

(async () => {
  if (!OANDA_KEY) { console.error("Set OANDA_KEY. Example: OANDA_KEY=xxx node backtest.js"); process.exit(1); }
  console.log(`Fetching ~${CANDLES} ${TF} candles for ${SYMBOL} …`);
  const candles = await fetchHistory(SYMBOL, TF, CANDLES);
  console.log(`Got ${candles.length} candles. Running engine bar-by-bar (this takes a moment)…`);
  const trades = simulate(candles);
  report(trades);
})().catch(e => { console.error("Backtest error:", e.message); process.exit(1); });
