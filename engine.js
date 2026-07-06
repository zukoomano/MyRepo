// Auto-extracted signal engine (framework-free)

function calcEMA(arr, period) {
  const k = 2 / (period + 1);
  const result = [];
  let ema = null;
  for (let i = 0; i < arr.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    if (i === period - 1) {
      ema = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    } else {
      ema = arr[i] * k + ema * (1 - k);
    }
    result.push(ema);
  }
  return result;
}

function calcSMA(arr, period) {
  return arr.map((_, i) =>
    i < period - 1 ? null : arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period
  );
}

function calcRSI(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  result[period] = 100 - 100 / (1 + ag / (al || 1e-10));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    result[i] = 100 - 100 / (1 + ag / (al || 1e-10));
  }
  return result;
}

function calcATR(highs, lows, closes, period = 14) {
  const tr = highs.map((h, i) =>
    i === 0 ? h - lows[i] : Math.max(h - lows[i], Math.abs(h - closes[i-1]), Math.abs(lows[i] - closes[i-1]))
  );
  return calcEMA(tr, period);
}

function calcMACD(closes) {
  const e12 = calcEMA(closes, 12);
  const e26 = calcEMA(closes, 26);
  const macd = closes.map((_, i) => e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null);
  const sig  = calcEMA(macd.map(v => v ?? 0), 9);
  return macd.map((v, i) => ({ macd: v, signal: sig[i], hist: v != null && sig[i] != null ? v - sig[i] : null }));
}

function calcBB(closes, period = 20, mult = 2) {
  const mid = calcSMA(closes, period);
  return closes.map((_, i) => {
    if (mid[i] == null) return { upper: null, mid: null, lower: null, bw: null };
    const s = closes.slice(i - period + 1, i + 1);
    const std = Math.sqrt(s.reduce((acc, v) => acc + (v - mid[i]) ** 2, 0) / period);
    const upper = mid[i] + mult * std, lower = mid[i] - mult * std;
    return { upper, mid: mid[i], lower, bw: ((upper - lower) / mid[i]) * 100 };
  });
}

function calcVWAP(highs, lows, closes, vols) {
  let tpv = 0, tv = 0;
  return closes.map((c, i) => { const tp = (highs[i]+lows[i]+c)/3; tpv += tp*(vols[i]||1000); tv += vols[i]||1000; return tpv/tv; });
}

function calcADX(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period * 2) return { adx:null, plusDI:null, minusDI:null };
  const tr=[], pDM=[], mDM=[];
  for (let i=1;i<n;i++){
    const up = highs[i]-highs[i-1];
    const dn = lows[i-1]-lows[i];
    pDM.push((up>dn && up>0)?up:0);
    mDM.push((dn>up && dn>0)?dn:0);
    tr.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  }
  const wilder = arr => {
    const res=[]; let sum=0;
    for (let i=0;i<period;i++) sum+=arr[i];
    res[period-1]=sum;
    for (let i=period;i<arr.length;i++){ sum = sum - sum/period + arr[i]; res[i]=sum; }
    return res;
  };
  const trS=wilder(tr), pS=wilder(pDM), mS=wilder(mDM);
  const dx=[];
  for (let i=period-1;i<tr.length;i++){
    if (!trS[i]) { dx.push(0); continue; }
    const pDI=100*pS[i]/trS[i], mDI=100*mS[i]/trS[i];
    const den=pDI+mDI;
    dx.push(den? 100*Math.abs(pDI-mDI)/den : 0);
  }
  let adx=null;
  if (dx.length>=period){
    let a = dx.slice(0,period).reduce((x,y)=>x+y,0)/period;
    for (let i=period;i<dx.length;i++) a=(a*(period-1)+dx[i])/period;
    adx=a;
  }
  const li=tr.length-1;
  const plusDI  = trS[li]? 100*pS[li]/trS[li] : null;
  const minusDI = trS[li]? 100*mS[li]/trS[li] : null;
  return { adx, plusDI, minusDI };
}

function currentSession(){
  const h = new Date().getUTCHours();
  const asian  = (h>=0 && h<8);     // Tokyo / Sydney
  const london = (h>=8 && h<17);    // London
  const ny     = (h>=13 && h<22);   // New York
  let name = (london&&ny)?"London/NY overlap" : london?"London" : ny?"New York" : asian?"Asian":"Off-session";
  return { asian, london, ny, name, h };
}

function detectSMC(candles) {
  if (candles.length < 10) return { bullishFVG:false, bearishFVG:false, bullishOB:false, bearishOB:false };
  const l5 = candles.slice(-5);
  let bFVG=false, rFVG=false;
  for (let i=0;i<l5.length-2;i++) { if(l5[i].high<l5[i+2].low) bFVG=true; if(l5[i].low>l5[i+2].high) rFVG=true; }
  const l10=candles.slice(-10); let bOB=false,rOB=false;
  for (let i=1;i<l10.length-1;i++){const c=l10[i],n=l10[i+1];if(c.close<c.open&&n.close>n.open&&n.close-n.open>(c.open-c.close)*1.5)bOB=true;if(c.close>c.open&&n.close<n.open&&n.open-n.close>(c.close-c.open)*1.5)rOB=true;}
  return { bullishFVG:bFVG,bearishFVG:rFVG,bullishOB:bOB,bearishOB:rOB };
}

function findSwings(candles, lb = 2) {
  const highs = [], lows = [];
  for (let i = lb; i < candles.length - lb; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lb; j <= i + lb; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low  <= candles[i].low)  isLow  = false;
    }
    if (isHigh) highs.push({ idx: i, price: candles[i].high });
    if (isLow)  lows.push({ idx: i, price: candles[i].low });
  }
  return { highs, lows };
}

function analyzeStructure(candles) {
  const { highs, lows } = findSwings(candles, 2);
  const out = {
    trend: "NEUTRAL", trendDetail: "Not enough structure",
    bos: "NEUTRAL", bosDetail: "No break of structure",
    choch: "NEUTRAL", chochDetail: "No change of character",
  };
  if (highs.length < 2 || lows.length < 2) return out;

  const h1 = highs[highs.length - 1], h2 = highs[highs.length - 2];
  const l1 = lows[lows.length - 1],  l2 = lows[lows.length - 2];
  const price = candles[candles.length - 1].close;

  // TREND — higher highs & higher lows = up; lower highs & lower lows = down
  const HH = h1.price > h2.price, HL = l1.price > l2.price;
  const LH = h1.price < h2.price, LL = l1.price < l2.price;
  if (HH && HL)      { out.trend = "BUY";  out.trendDetail = "Uptrend — HH + HL"; }
  else if (LH && LL) { out.trend = "SELL"; out.trendDetail = "Downtrend — LH + LL"; }
  else               { out.trend = "NEUTRAL"; out.trendDetail = "Ranging / mixed structure"; }

  // BOS — price breaks the most recent swing in the direction of trend
  if (price > h1.price)      { out.bos = "BUY";  out.bosDetail = `Bullish BOS — broke ${h1.price.toFixed(2)}`; }
  else if (price < l1.price) { out.bos = "SELL"; out.bosDetail = `Bearish BOS — broke ${l1.price.toFixed(2)}`; }
  else { out.bosDetail = `Inside range ${l1.price.toFixed(2)}–${h1.price.toFixed(2)}`; }

  // CHoCH — first counter-trend break after a trend (reversal hint)
  if ((LH || LL) && price > h1.price)      { out.choch = "BUY";  out.chochDetail = "Bullish CHoCH — downtrend broken up"; }
  else if ((HH || HL) && price < l1.price) { out.choch = "SELL"; out.chochDetail = "Bearish CHoCH — uptrend broken down"; }
  else { out.chochDetail = "No reversal shift yet"; }

  return out;
}

function detectLiquiditySweep(candles) {
  const { highs, lows } = findSwings(candles, 2);
  const last = candles[candles.length - 1];
  if (highs.length < 1 || lows.length < 1)
    return { signal: "NEUTRAL", detail: "No swing liquidity mapped" };

  const recentHigh = Math.max(...highs.slice(-3).map(h => h.price));
  const recentLow  = Math.min(...lows.slice(-3).map(l => l.price));

  // Sell-side sweep (grabbed lows, closed back up) → bullish
  if (last.low < recentLow && last.close > recentLow)
    return { signal: "BUY", detail: `Swept lows @ ${recentLow.toFixed(2)}, closed back up` };
  // Buy-side sweep (grabbed highs, closed back down) → bearish
  if (last.high > recentHigh && last.close < recentHigh)
    return { signal: "SELL", detail: `Swept highs @ ${recentHigh.toFixed(2)}, closed back down` };

  return { signal: "NEUTRAL", detail: "No sweep on last candle" };
}

function detectSupplyDemand(candles) {
  const n = candles.length;
  const win = candles.slice(-30);
  const price = candles[n - 1].close;
  const atr = win.reduce((s, c) => s + (c.high - c.low), 0) / win.length;

  let demand = null, supply = null;
  for (let i = 1; i < win.length - 1; i++) {
    const body = Math.abs(win[i].close - win[i].open);
    if (body > atr * 1.6) {
      if (win[i].close > win[i].open) demand = { lo: win[i - 1].low, hi: win[i - 1].high };
      else                            supply = { lo: win[i - 1].low, hi: win[i - 1].high };
    }
  }
  if (demand && price >= demand.lo && price <= demand.hi * 1.002)
    return { signal: "BUY", detail: `In demand zone ${demand.lo.toFixed(2)}–${demand.hi.toFixed(2)}` };
  if (supply && price <= supply.hi && price >= supply.lo * 0.998)
    return { signal: "SELL", detail: `In supply zone ${supply.lo.toFixed(2)}–${supply.hi.toFixed(2)}` };
  if (demand && price > demand.hi)
    return { signal: "BUY", detail: `Above demand ${demand.lo.toFixed(2)}–${demand.hi.toFixed(2)}` };
  if (supply && price < supply.lo)
    return { signal: "SELL", detail: `Below supply ${supply.lo.toFixed(2)}–${supply.hi.toFixed(2)}` };
  return { signal: "NEUTRAL", detail: "No active zone" };
}

function detectFibonacci(candles, trend) {
  const { highs, lows } = findSwings(candles, 2);
  const out = { signal:"NEUTRAL", detail:"No clean swing for Fib", levels:null, ext:null };
  if (highs.length < 1 || lows.length < 1) return out;

  const lastHigh = highs[highs.length - 1];
  const lastLow  = lows[lows.length - 1];
  const price = candles[candles.length - 1].close;

  // Decide swing direction by which extreme came last
  const upLeg = lastLow.idx < lastHigh.idx; // low then high => up leg (retrace = pullback down)
  const hi = lastHigh.price, lo = lastLow.price, range = hi - lo;
  if (range <= 0) return out;

  const fib = p => upLeg ? hi - range * p : lo + range * p;
  const levels = { "23.6": fib(0.236), "38.2": fib(0.382), "50.0": fib(0.5), "61.8": fib(0.618), "78.6": fib(0.786) };

  // Extensions (targets beyond the swing in trend direction)
  const ext = upLeg
    ? { "127.2": hi + range*0.272, "161.8": hi + range*0.618 }
    : { "127.2": lo - range*0.272, "161.8": lo - range*0.618 };

  // Golden pocket = 61.8%–65%; trigger when price sits in the 50–61.8 zone
  const zoneHi = Math.max(fib(0.5), fib(0.618));
  const zoneLo = Math.min(fib(0.5), fib(0.618));
  const inPocket = price >= zoneLo && price <= zoneHi;

  if (inPocket) {
    // Buy the pullback in an up leg / uptrend; sell the pullback in a down leg/downtrend
    if (upLeg && trend !== "SELL")  out.signal = "BUY";
    else if (!upLeg && trend !== "BUY") out.signal = "SELL";
    out.detail = `Price in 61.8% golden pocket (${zoneLo.toFixed(2)}–${zoneHi.toFixed(2)})`;
  } else {
    out.detail = `61.8% @ ${fib(0.618).toFixed(2)} | 50% @ ${fib(0.5).toFixed(2)}`;
  }
  out.levels = levels; out.ext = ext; out.upLeg = upLeg;
  return out;
}

function generateSignals(candles, opts) {
  opts = opts || {};
  if (!candles||candles.length<60) return null;
  const closes=candles.map(c=>c.close), highs=candles.map(c=>c.high), lows=candles.map(c=>c.low), vols=candles.map(c=>c.volume);
  const n=candles.length, price=closes[n-1];

  // EMA 9/21
  const ema9=calcEMA(closes,9),ema21=calcEMA(closes,21);
  const [e9,e21,pe9,pe21]=[ema9[n-1],ema21[n-1],ema9[n-2],ema21[n-2]];
  const emaSig=e9>e21?"BUY":"SELL";
  const freshEma=pe9!=null&&pe21!=null&&((pe9<pe21&&e9>e21)||(pe9>pe21&&e9<e21));
  const emaDetail=`EMA9: ${e9?.toFixed(2)} | EMA21: ${e21?.toFixed(2)}${freshEma?" — FRESH CROSS ✦":""}`;

  // RSI
  const rsiArr=calcRSI(closes), rsiVal=rsiArr[n-1];
  const rsiSig=rsiVal>=70?"SELL":rsiVal<=30?"BUY":rsiVal>=55?"BUY":rsiVal<=45?"SELL":"NEUTRAL";
  const rsiDetail=`RSI(14): ${rsiVal?.toFixed(1)}${rsiVal>=70?" — Overbought ⚠":rsiVal<=30?" — Oversold ⚠":""}`;

  // MACD
  const macdArr=calcMACD(closes),{macd:mv,signal:sv}=macdArr[n-1],{macd:pmv,signal:psv}=macdArr[n-2];
  const macdSig=mv>sv?"BUY":"SELL";
  const freshMacd=pmv!=null&&((pmv<psv&&mv>sv)||(pmv>psv&&mv<sv));
  const macdDetail=`MACD: ${mv?.toFixed(3)} | Signal: ${sv?.toFixed(3)}${freshMacd?" — CROSS ✦":""}`;

  // Bollinger Bands
  const bbArr=calcBB(closes),bb=bbArr[n-1];
  const prevBWs=bbArr.slice(-21,-1).filter(b=>b.bw!=null).map(b=>b.bw);
  const avgBW=prevBWs.length?prevBWs.reduce((a,b)=>a+b,0)/prevBWs.length:bb.bw;
  const squeeze=bb.bw<avgBW*0.65;
  const bbSig=price>bb.upper?"SELL":price<bb.lower?"BUY":price>bb.mid?"BUY":"SELL";
  const bbDetail=`${squeeze?"SQUEEZE | ":""}Upper:${bb.upper?.toFixed(2)} Mid:${bb.mid?.toFixed(2)} Lower:${bb.lower?.toFixed(2)}`;

  // S&R Pivots
  const ph=Math.max(...highs.slice(-20)),pl=Math.min(...lows.slice(-20)),pc=closes[n-20];
  const pp=(ph+pl+pc)/3,r1=2*pp-pl,s1=2*pp-ph;
  const srSig=price>pp?(price<r1?"BUY":"SELL"):(price>s1?"SELL":"BUY");
  const srDetail=`PP:${pp.toFixed(2)} | R1:${r1.toFixed(2)} | S1:${s1.toFixed(2)}`;

  // ICT/SMC
  const smc=detectSMC(candles),hasBull=smc.bullishFVG||smc.bullishOB,hasBear=smc.bearishFVG||smc.bearishOB;
  const smcSig=hasBull&&!hasBear?"BUY":hasBear&&!hasBull?"SELL":"NEUTRAL";
  const smcDetail=`FVG:${smc.bullishFVG?"↑Bull":smc.bearishFVG?"↓Bear":"–"} OB:${smc.bullishOB?"↑Bull":smc.bearishOB?"↓Bear":"–"}`;

  // VWAP
  const vwapArr=calcVWAP(highs,lows,closes,vols),vwapVal=vwapArr[n-1];
  const vwapSig=price>vwapVal?"BUY":"SELL";
  const pct=((price-vwapVal)/vwapVal*100).toFixed(2);
  const vwapDetail=`VWAP:${vwapVal?.toFixed(2)} | Price ${pct>0?"+":""}${pct}% from VWAP`;

  // Market structure: Trend, BOS, CHoCH
  const struct=analyzeStructure(candles);
  // Liquidity sweep
  const sweep=detectLiquiditySweep(candles);
  // Supply / Demand
  const sd=detectSupplyDemand(candles);
  const fib=detectFibonacci(candles, struct.trend);

  const atrArr=calcATR(highs,lows,closes),atr=atrArr[n-1]||0;
  const pointSize = 0.01;

  // ===== STAGE 1: REGIME (trend vs range) =====
  // Higher-timeframe bias proxy: longer EMAs on current data
  const biasFast = calcEMA(closes, 50)[n-1];
  const slowLen  = n>140 ? 100 : Math.max(40, Math.floor(n/2));
  const biasSlow = calcEMA(closes, slowLen)[n-1];
  let htf = "NEUTRAL";
  if(biasFast!=null && biasSlow!=null){
    if(biasFast>biasSlow && price>biasSlow) htf="BUY";
    else if(biasFast<biasSlow && price<biasSlow) htf="SELL";
  }
  const adxRes = calcADX(highs, lows, closes, 14);
  const adxVal = adxRes.adx;
  const strongTrend = adxVal!=null && adxVal>=20;
  const regime = (struct.trend!=="NEUTRAL" && !squeeze && strongTrend) ? "TREND" : "RANGE";

  // ===== STAGE 2: LOCATION (is price at a meaningful level?) =====
  const nearLvl = (a,b)=> Math.abs(a-b) <= Math.max(atr*0.4, 15*pointSize);
  let locBuy=false, locSell=false; const locWhy=[];
  if(sd.signal==="BUY"){locBuy=true;locWhy.push("demand zone");} else if(sd.signal==="SELL"){locSell=true;locWhy.push("supply zone");}
  if(fib.signal==="BUY"){locBuy=true;locWhy.push("fib pocket");} else if(fib.signal==="SELL"){locSell=true;locWhy.push("fib pocket");}
  if(nearLvl(price,s1)||price<=bb.lower){locBuy=true;locWhy.push("support/lower band");}
  if(nearLvl(price,r1)||price>=bb.upper){locSell=true;locWhy.push("resistance/upper band");}
  if(sweep.signal==="BUY"){locBuy=true;locWhy.push("swept lows");} else if(sweep.signal==="SELL"){locSell=true;locWhy.push("swept highs");}

  // ===== STAGE 3: TRIGGER (confirmation of a turn) =====
  const o1=candles[n-1].open,c1=candles[n-1].close,o0=candles[n-2].open,c0=candles[n-2].close;
  const bullEngulf = c0<o0 && c1>o1 && c1>=o0 && o1<=c0;
  const bearEngulf = c0>o0 && c1<o1 && o1>=c0 && c1<=o0;
  const rsiPrev=rsiArr[n-2];
  let trigBuy=false, trigSell=false; const trigWhy=[];
  if(freshMacd&&macdSig==="BUY"){trigBuy=true;trigWhy.push("MACD cross");} if(freshMacd&&macdSig==="SELL"){trigSell=true;trigWhy.push("MACD cross");}
  if(freshEma&&emaSig==="BUY"){trigBuy=true;trigWhy.push("EMA cross");} if(freshEma&&emaSig==="SELL"){trigSell=true;trigWhy.push("EMA cross");}
  if(struct.bos==="BUY"){trigBuy=true;trigWhy.push("BOS up");} if(struct.bos==="SELL"){trigSell=true;trigWhy.push("BOS down");}
  if(struct.choch==="BUY"){trigBuy=true;trigWhy.push("CHoCH up");} if(struct.choch==="SELL"){trigSell=true;trigWhy.push("CHoCH down");}
  if(sweep.signal==="BUY"){trigBuy=true;} if(sweep.signal==="SELL"){trigSell=true;}
  if(bullEngulf){trigBuy=true;trigWhy.push("bull engulf");} if(bearEngulf){trigSell=true;trigWhy.push("bear engulf");}
  if(rsiPrev!=null&&rsiPrev<=45&&rsiVal>45){trigBuy=true;trigWhy.push("RSI reclaim");} if(rsiPrev!=null&&rsiPrev>=55&&rsiVal<55){trigSell=true;trigWhy.push("RSI roll");}

  // ADX read (trend strength + DI direction)
  const adxDir = (adxRes.plusDI!=null && adxRes.minusDI!=null) ? (adxRes.plusDI>adxRes.minusDI?"BUY":"SELL") : "NEUTRAL";
  const adxSig = (adxVal!=null && adxVal>=25) ? adxDir : "NEUTRAL";
  const adxDetail = adxVal!=null ? `ADX ${adxVal.toFixed(0)} ${adxVal>=25?"(strong)":adxVal>=20?"(building)":"(weak/range)"} | +DI ${adxRes.plusDI?.toFixed(0)} -DI ${adxRes.minusDI?.toFixed(0)}` : "ADX n/a";
  // DXY read (dollar) — metals move inverse to USD; bias passed in via opts
  const dxyBias = opts.dxyBias || "NEUTRAL";
  const dxyDetail = opts.dxyDetail || (dxyBias==="NEUTRAL"?"Dollar data unavailable":`Dollar favours metals ${dxyBias}`);

  // ===== indicator reads (for confluence + breakdown) =====
  const reads=[
    {name:"Trend (Structure)", signal:struct.trend, detail:struct.trendDetail, icon:"📐"},
    {name:"ADX (Strength)",   signal:adxSig,  detail:adxDetail,  icon:"📶"},
    {name:"EMA Cross (9/21)", signal:emaSig,  detail:emaDetail,  icon:"📈"},
    {name:"RSI (14)",         signal:rsiSig,  detail:rsiDetail,  icon:"📊"},
    {name:"MACD",             signal:macdSig, detail:macdDetail, icon:"⚡"},
    {name:"Bollinger Bands",  signal:bbSig,   detail:bbDetail,   icon:"〰"},
    {name:"Support/Resistance",signal:srSig,  detail:srDetail,   icon:"🔲"},
    {name:"ICT / SMC",        signal:smcSig,  detail:smcDetail,  icon:"🎯"},
    {name:"VWAP",             signal:vwapSig, detail:vwapDetail, icon:"💹"},
    {name:"DXY (Dollar)",     signal:dxyBias, detail:dxyDetail,  icon:"💵"},
    {name:"BOS",              signal:struct.bos,   detail:struct.bosDetail,   icon:"💥"},
    {name:"CHoCH",            signal:struct.choch, detail:struct.chochDetail, icon:"🔄"},
    {name:"Liquidity Sweep",  signal:sweep.signal, detail:sweep.detail,       icon:"🌊"},
    {name:"Supply / Demand",  signal:sd.signal,    detail:sd.detail,          icon:"📦"},
    {name:"Fibonacci (61.8%)",signal:fib.signal,   detail:fib.detail,         icon:"🌀"},
  ];
  const supBuy = reads.filter(r=>r.signal==="BUY").length;
  const supSell= reads.filter(r=>r.signal==="SELL").length;

  // ===== STAGE 4: GATED DECISION =====
  const decide=(side)=>{
    const htfA = (htf===side);
    const locA = side==="BUY"?locBuy:locSell;
    const trigA= side==="BUY"?trigBuy:trigSell;
    const sup  = side==="BUY"?supBuy:supSell;
    let sc=0,gates=0;
    if(htfA){sc+=25;gates++;} if(locA){sc+=25;gates++;} if(trigA){sc+=25;gates++;}
    sc += Math.round(sup/reads.length*25);
    return {htfA,locA,trigA,sup,sc,gates};
  };
  const B=decide("BUY"), S=decide("SELL");

  let overall="NEUTRAL", conf=0, decided=false;
  if(regime==="TREND" && htf!=="NEUTRAL"){
    const z = (htf==="BUY")?B:S;
    if(z.htfA && z.locA && z.trigA){ overall=htf; conf=Math.min(95,z.sc); decided=true; }                       // ideal pullback entry
    else if(z.htfA && z.trigA && z.sup>=Math.ceil(reads.length*0.5)){ overall=htf; conf=Math.min(78,z.sc); decided=true; } // momentum continuation
  }
  if(!decided){ // RANGE, or trend without a clear bias → require location + trigger (mean-reversion / setup)
    const buyReady  = B.locA && B.trigA;
    const sellReady = S.locA && S.trigA;
    if(buyReady && !sellReady){ overall="BUY"; conf=Math.min(85,B.sc); }
    else if(sellReady && !buyReady){ overall="SELL"; conf=Math.min(85,S.sc); }
    else if(buyReady && sellReady){ // conflicting levels — defer to confluence lean
      if(B.sup>S.sup){ overall="BUY"; conf=Math.min(72,B.sc); }
      else if(S.sup>B.sup){ overall="SELL"; conf=Math.min(72,S.sc); }
    }
  }
  if(overall==="NEUTRAL") conf=Math.max(B.sc,S.sc);

  // ===== STAGE 5: SESSION FILTER (suppress off-session signals) =====
  const sessionActive = (opts.sessionActive===undefined) ? true : opts.sessionActive;
  const sessionName = opts.sessionName || "—";
  if(!sessionActive && overall!=="NEUTRAL"){ overall="NEUTRAL"; }

  // ===== Breakdown shown in the app: 5 gate rows + reads =====
  const gateRow=(name,sig,detail,icon)=>({name,signal:sig,detail,icon});
  const regimeSig = "NEUTRAL";
  const locSig = locBuy&&!locSell?"BUY":locSell&&!locBuy?"SELL":locBuy&&locSell?"NEUTRAL":"NEUTRAL";
  const trigSig = trigBuy&&!trigSell?"BUY":trigSell&&!trigBuy?"SELL":trigBuy&&trigSell?"NEUTRAL":"NEUTRAL";
  const strategies=[
    gateRow("① Regime", regimeSig, regime==="TREND"?`Trending (${struct.trend==="BUY"?"up":"down"}) · ADX ${adxVal!=null?adxVal.toFixed(0):"–"}`:`Ranging · ADX ${adxVal!=null?adxVal.toFixed(0):"–"}`, "🧭"),
    gateRow("② HTF Bias", htf, htf==="NEUTRAL"?"Mixed — no directional bias":`Higher-timeframe favours ${htf}`, "🗺"),
    gateRow("③ Location", locSig, locWhy.length?("At: "+locWhy.join(", ")):"Not at a key level", "📍"),
    gateRow("④ Trigger", trigSig, trigWhy.length?("Fired: "+trigWhy.join(", ")):"No confirmation yet", "🔫"),
    gateRow("⑤ Session", sessionActive?"NEUTRAL":"NEUTRAL", sessionActive?`Active: ${sessionName}`:`Off-session (${sessionName}) — signals paused`, "🕐"),
    ...reads,
  ];
  const total=strategies.length;
  const buys = strategies.filter(s=>s.signal==="BUY").length;
  const sells= strategies.filter(s=>s.signal==="SELL").length;

  // ===== Structure-based targets (stop beyond invalidation, TP at next level) =====
  const tpPts  = opts.tpPoints  != null ? opts.tpPoints  : 20;
  const tp2Pts = opts.tp2Points != null ? opts.tp2Points : 40;
  const slPts  = opts.slPoints  != null ? opts.slPoints  : 20;
  const sw = findSwings(candles,2);
  const swLows  = sw.lows.map(l=>l.price);
  const swHighs = sw.highs.map(h=>h.price);
  const lastSwingLow  = swLows.length ? swLows[swLows.length-1]  : Math.min(...lows.slice(-10));
  const lastSwingHigh = swHighs.length? swHighs[swHighs.length-1]: Math.max(...highs.slice(-10));
  const buffer = Math.max(atr*0.25, 10*pointSize);
  let sl,tp1,tp2;
  if(overall==="BUY"){
    sl = lastSwingLow - buffer;
    if(sl>=price || price-sl < slPts*pointSize) sl = price - slPts*pointSize;     // floor
    const aboves = swHighs.filter(h=>h>price+5*pointSize);
    tp1 = aboves.length ? Math.min(...aboves) : (r1>price?r1:price+tpPts*pointSize);
    if(tp1-price < tpPts*pointSize) tp1 = price + tpPts*pointSize;                 // floor
    tp2 = Math.max(tp1, price + tp2Pts*pointSize);
  } else if(overall==="SELL"){
    sl = lastSwingHigh + buffer;
    if(sl<=price || sl-price < slPts*pointSize) sl = price + slPts*pointSize;
    const belows = swLows.filter(l=>l<price-5*pointSize);
    tp1 = belows.length ? Math.max(...belows) : (s1<price?s1:price-tpPts*pointSize);
    if(price-tp1 < tpPts*pointSize) tp1 = price - tpPts*pointSize;
    tp2 = Math.min(tp1, price - tp2Pts*pointSize);
  }
  const rr = sl ? (Math.abs((tp1-price)/(sl-price))).toFixed(2) : "–";
  // Convert SL/TP distances to points for display
  const slPtsOut = sl!=null?Math.round(Math.abs(price-sl)/pointSize):slPts;
  const tpPtsOut = tp1!=null?Math.round(Math.abs(tp1-price)/pointSize):tpPts;
  const tp2PtsOut= tp2!=null?Math.round(Math.abs(tp2-price)/pointSize):tp2Pts;

  return {overall,conf,buys,sells,strategies,
    levels:{entry:price,sl,tp1,tp2,rr,tpPts:tpPtsOut,tp2Pts:tp2PtsOut,slPts:slPtsOut},
    fib,atr,price,squeeze,regime,htf,timestamp:new Date()};
}

module.exports = { generateSignals, currentSession };
