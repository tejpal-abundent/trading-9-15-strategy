// Higher-timeframe trend-alignment checks for the Multi-TF Pullback strategy.
//
// Direction bias rule (must be true on all of Monthly, Weekly, Daily):
//   bullish = EMA9 > EMA15  AND both sloping up
//   bearish = EMA9 < EMA15  AND both sloping down

const BINANCE_INTERVAL = {
  "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1H": "1h", "2H": "2h", "4H": "4h", "6H": "6h", "12H": "12h",
  "1D": "1d", "1W": "1w", "1M": "1M",
};

export async function fetchCandles(symbol, timeframe, limit = 200) {
  const interval = BINANCE_INTERVAL[timeframe];
  if (!interval) throw new Error(`Unknown timeframe: ${timeframe}`);
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${timeframe} error: ${res.status}`);
  const data = await res.json();
  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// Full EMA series (not just the last value) so we can read slope.
export function emaSeries(closes, period) {
  if (closes.length < period) return [];
  const m = 2 / (period + 1);
  const out = new Array(closes.length).fill(null);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * m + ema * (1 - m);
    out[i] = ema;
  }
  return out;
}

// Returns { direction: "bullish" | "bearish" | null, ema9, ema15, slope9, slope15 }
export function emaAlignment(candles, slopeLookback = 3) {
  const closes = candles.map((c) => c.close);
  const e9 = emaSeries(closes, 9);
  const e15 = emaSeries(closes, 15);
  const i = closes.length - 1;
  const ema9 = e9[i];
  const ema15 = e15[i];
  if (ema9 == null || ema15 == null) {
    return { direction: null, ema9, ema15, slope9: null, slope15: null };
  }
  const prev9 = e9[i - slopeLookback];
  const prev15 = e15[i - slopeLookback];
  if (prev9 == null || prev15 == null) {
    return { direction: null, ema9, ema15, slope9: null, slope15: null };
  }
  const slope9 = ema9 - prev9;
  const slope15 = ema15 - prev15;

  let direction = null;
  if (ema9 > ema15 && slope9 > 0 && slope15 > 0) direction = "bullish";
  else if (ema9 < ema15 && slope9 < 0 && slope15 < 0) direction = "bearish";

  return { direction, ema9, ema15, slope9, slope15 };
}

// True when all provided TF alignments share the same non-null direction.
export function agree(...alignments) {
  const dirs = alignments.map((a) => a.direction);
  if (dirs.some((d) => d == null)) return null;
  return dirs.every((d) => d === dirs[0]) ? dirs[0] : null;
}

// "Has price pulled back into the EMA9-EMA15 zone on the entry TF?"
// True if the current candle's range overlaps the [min(e9,e15), max(e9,e15)] band.
export function priceInZone(candle, ema9, ema15, tolerancePct = 0.5) {
  if (ema9 == null || ema15 == null) return false;
  const lo = Math.min(ema9, ema15) * (1 - tolerancePct / 100);
  const hi = Math.max(ema9, ema15) * (1 + tolerancePct / 100);
  return candle.low <= hi && candle.high >= lo;
}
