// Metal Signal Pro — cloud runner (GitHub Actions)
// Runs the gated engine on OANDA data for XAUUSD + XAGUSD, sends Telegram alerts.
// One signal per metal per direction: won't repeat until direction flips.

const fs = require("fs");
const { generateSignals, currentSession } = require("./engine.js");

// ---- Secrets from environment (set in GitHub repo Settings → Secrets) ----
const OANDA_KEY   = process.env.OANDA_KEY   || "";
const OANDA_ENV   = process.env.OANDA_ENV   || "practice";   // "practice" or "live"
const TG_TOKEN    = process.env.TG_TOKEN    || "";
const TG_CHAT     = process.env.TG_CHAT     || "";

// ---- Settings ----
const TIMEFRAME   = "M15";
const TP_POINTS   = 20;
const TP2_POINTS  = 40;
const SL_POINTS   = 20;
const SYMBOLS     = ["XAUUSD", "XAGUSD"];
const STATE_FILE  = "state.json";

// ---- OANDA fetch (Node has global fetch on v18+) ----
async function fetchOANDA(symbol) {
  const inst = symbol === "XAUUSD" ? "XAU_USD" : "XAG_USD";
  const gran = { M15:"M15", M30:"M30", H1:"H1" }[TIMEFRAME] || "M15";
  const host = OANDA_ENV === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
  const url = `${host}/v3/instruments/${inst}/candles?granularity=${gran}&count=200&price=M`;
  const res = await fetch(url, { headers: { "Authorization": "Bearer " + OANDA_KEY } });
  if (!res.ok) throw new Error(`OANDA HTTP ${res.status} for ${symbol}`);
  const data = await res.json();
  if (!data.candles) throw new Error("OANDA: no candles for " + symbol);
  const out = data.candles.map(c => ({
    time: new Date(c.time).getTime(),
    open: +c.mid.o, high: +c.mid.h, low: +c.mid.l, close: +c.mid.c,
    volume: c.volume || 1000,
  }));
  if (out.length < 60) throw new Error("OANDA: too few candles for " + symbol);
  return out;
}

function fmt(v, symbol){ return v==null ? "-" : (symbol==="XAUUSD" ? Number(v).toFixed(2) : Number(v).toFixed(4)); }

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log("No Telegram creds — skipping send."); return; }
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text }),
  });
  const j = await res.json().catch(()=>({}));
  if (!j.ok) console.log("Telegram error:", JSON.stringify(j));
  else console.log("Telegram sent.");
}

function buildMsg(sig, symbol) {
  const dir = sig.overall === "BUY" ? "🟢" : "🔴";
  return [
    `🚨 *${sig.overall}* ${dir}  ${symbol} · ${TIMEFRAME}`,
    `━━━━━━━━━━━━━━━━━━`,
    `Entry: ${fmt(sig.levels.entry, symbol)}`,
    `SL:    ${fmt(sig.levels.sl, symbol)}`,
    `TP1:   ${fmt(sig.levels.tp1, symbol)}`,
    `TP2:   ${fmt(sig.levels.tp2, symbol)}`,
    `━━━━━━━━━━━━━━━━━━`,
    `🕐 ${new Date().toUTCString()}`,
  ].join("\n");
}

function loadState(){ try { return JSON.parse(fs.readFileSync(STATE_FILE,"utf8")); } catch(e){ return { lastDir: {} }; } }
function saveState(st){ fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2)); }

// US market holidays + weekend gap — skip analysis so no fake weekend/holiday signals
const US_HOLIDAYS = new Set([
  "2026-01-01","2026-01-19","2026-02-16","2026-04-03","2026-05-25","2026-06-19","2026-07-03","2026-09-07","2026-11-26","2026-12-25",
  "2027-01-01","2027-01-18","2027-02-15","2027-03-26","2027-05-31","2027-06-18","2027-07-05","2027-09-06","2027-11-25","2027-12-24"
]);
function isMarketClosed(){
  const now = new Date();
  const day = now.getUTCDay(), h = now.getUTCHours();
  if (day === 6) return { closed:true, reason:"Weekend" };
  if (day === 0 && h < 22) return { closed:true, reason:"Weekend (reopens Mon 03:30 IST / Sun 22:00 UTC)" };
  if (day === 5 && h >= 22) return { closed:true, reason:"Weekend (closed Sat 03:30 IST / Fri 22:00 UTC)" };
  if (US_HOLIDAYS.has(now.toISOString().slice(0,10))) return { closed:true, reason:"US market holiday" };
  return { closed:false, reason:"" };
}

(async () => {
  if (!OANDA_KEY) { console.error("OANDA_KEY secret missing."); process.exit(1); }

  const mc = isMarketClosed();
  if (mc.closed) { console.log("Market closed (" + mc.reason + ") — skipping analysis."); return; }

  const sess = currentSession();
  // Sessions all enabled by default in cloud (Asian/London/NY); off-session pauses signals.
  const sessionActive = sess.asian || sess.london || sess.ny;
  const opts = { tpPoints: TP_POINTS, tp2Points: TP2_POINTS, slPoints: SL_POINTS,
                 sessionActive, sessionName: sess.name, dxyBias: "NEUTRAL", dxyDetail: "" };

  const st = loadState();
  st.lastDir = st.lastDir || {};
  let changed = false;

  for (const sym of SYMBOLS) {
    try {
      const candles = await fetchOANDA(sym);
      const sig = generateSignals(candles, opts);
      const verdict = sig ? sig.overall : "NEUTRAL";
      console.log(`${sym}: ${verdict}${sig?` (${sig.conf}%)`:""} | session ${sess.name}`);

      if (sig && verdict !== "NEUTRAL") {
        if (st.lastDir[sym] !== verdict) {          // new or flipped → alert once
          await sendTelegram(buildMsg(sig, sym));
          st.lastDir[sym] = verdict; changed = true;
        } else {
          console.log(`${sym}: same ${verdict} as last — no repeat.`);
        }
      } else {
        if (st.lastDir[sym]) { delete st.lastDir[sym]; changed = true; }  // reset on NEUTRAL
      }
    } catch (e) {
      console.error(`${sym} error:`, e.message);
    }
  }

  if (changed) saveState(st);
  console.log("Done.", changed ? "State updated." : "No state change.");
})();
