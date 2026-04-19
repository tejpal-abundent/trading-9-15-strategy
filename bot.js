/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";
import {
  fetchCandles as fetchCandlesHT,
  emaAlignment,
  agree,
  priceInZone,
} from "./src/higher-tf.js";
import {
  captureChart,
  askGeminiVision,
  fillRubric,
  getTodaysCost,
  recordCost,
} from "./src/visual.js";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your BitGet credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  const paperOnly = (process.env.PAPER_TRADING ?? "true") !== "false";
  if (missing.length > 0 && !paperOnly) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  } else if (missing.length > 0 && paperOnly) {
    console.log(
      `\nℹ️  BitGet credentials missing — fine, paper-trading mode. ` +
        `Add them when you flip PAPER_TRADING=false.`,
    );
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  pullbackTolerancePct: parseFloat(
    process.env.PULLBACK_TOLERANCE_PCT || "0.5",
  ),
  useVisualConfirmation:
    (process.env.USE_VISUAL_CONFIRMATION ?? "true") !== "false",
  visualModel: process.env.VISUAL_MODEL || "gemini-2.5-flash",
  minLlmScore: parseInt(process.env.MIN_LLM_SCORE || "7"),
  maxLlmSpendUsdPerDay: parseFloat(
    process.env.MAX_LLM_SPEND_USD_PER_DAY || "2",
  ),
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// Market-data + EMA helpers now live in src/higher-tf.js and are imported
// above. Keeping bot.js focused on orchestration, config, execution.

// ─── Candlestick helpers ────────────────────────────────────────────────────

export function candleBody(c) { return Math.abs(c.close - c.open); }
export function candleRange(c) { return c.high - c.low; }
export function upperWick(c) { return c.high - Math.max(c.open, c.close); }
export function lowerWick(c) { return Math.min(c.open, c.close) - c.low; }

// Hammer / Hanging Man share the same shape: long lower wick, tiny upper wick,
// small body. Context (up- vs down-trend) distinguishes intent.
export function isHammerShape(c) {
  const body = candleBody(c);
  const range = candleRange(c);
  if (range === 0) return false;
  const lw = lowerWick(c);
  const uw = upperWick(c);
  return (
    lw >= 2 * body &&
    lw >= range * 0.5 &&
    uw <= range * 0.15 &&
    body <= range * 0.3
  );
}

export function isSolidGreen(c) {
  const body = c.close - c.open;
  const range = candleRange(c);
  if (range === 0) return false;
  return body > 0 && body >= range * 0.6;
}

export function isSolidRed(c) {
  const body = c.open - c.close;
  const range = candleRange(c);
  if (range === 0) return false;
  return body > 0 && body >= range * 0.6;
}

export function wickToBodyRatio(c, side = "lower") {
  const body = candleBody(c);
  if (body === 0) return Infinity;
  return (side === "lower" ? lowerWick(c) : upperWick(c)) / body;
}

// 5-bar pivot: candle is a swing high if its high exceeds the two bars each
// side; same logic mirrored for swing lows.
export function findSwings(candles, lookback = 2) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].high });
    if (isLow) lows.push({ index: i, price: candles[i].low });
  }
  return { highs, lows };
}

// True if a candle's body-to-wick range overlaps any zone within tolerance.
export function touchesZone(candle, zones, tolerancePct = 0.3) {
  for (const z of zones) {
    if (typeof z !== "number" || !Number.isFinite(z)) continue;
    const hi = z * (1 + tolerancePct / 100);
    const lo = z * (1 - tolerancePct / 100);
    if (candle.low <= hi && candle.high >= lo) return true;
  }
  return false;
}

export function calcRR(entry, stop, target) {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  return risk === 0 ? 0 : reward / risk;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

// Kept for backwards-compat / tests — still exported for the Zone Failure
// fixture tests. The new MTF Pullback check is in runMtfSafetyCheck below.
export function runSafetyCheck(candles, ema21, ema200) {
  const results = [];
  const check = (label, required, actual, pass, core = false, weight = 0) => {
    results.push({ label, required, actual, pass, core, weight });
    const icon = pass ? "✅" : "🚫";
    const tag = core ? " [CORE]" : "";
    console.log(`  ${icon}${tag} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check (Zone Failure Reversal) ───────────────\n");

  const failureCandle = candles[candles.length - 1];
  const signalCandle = candles[candles.length - 2];
  const historical = candles.slice(0, -1);
  const swings = findSwings(historical.slice(-60), 2);
  const recentSwingHighs = swings.highs.slice(-5).map((s) => s.price);
  const recentSwingLows = swings.lows.slice(-5).map((s) => s.price);

  const signalShape = isHammerShape(signalCandle);
  const solidGreen = isSolidGreen(failureCandle);
  const solidRed = isSolidRed(failureCandle);

  // Direction detection
  const priceAbove200 = failureCandle.close > ema200;
  const priceBelow200 = failureCandle.close < ema200;
  let direction = null;
  if (priceAbove200 && signalShape && solidGreen) direction = "LONG";
  else if (priceBelow200 && signalShape && solidRed) direction = "SHORT";

  if (!direction) {
    console.log("  No valid Zone Failure setup on last two candles.\n");
    results.push({
      label: "Valid Zone Failure pattern on last two candles",
      required:
        "Hammer+SolidRed in downtrend (short) OR HangingMan+SolidGreen in uptrend (long)",
      actual: `shape=${signalShape ? "OK" : "no"}, failure=${solidGreen ? "solid green" : solidRed ? "solid red" : "neither"}, trend=${priceAbove200 ? "up" : priceBelow200 ? "down" : "flat"}`,
      pass: false,
      core: true,
      weight: 100,
    });
    return { results, allPass: false, direction: null };
  }

  console.log(
    `  Direction: ${direction} — ${direction === "LONG" ? "Hanging Man → Solid Green" : "Hammer → Solid Red"}\n`,
  );

  // CORE — all must pass or no trade
  check(
    direction === "LONG" ? "Trend up (price > EMA200)" : "Trend down (price < EMA200)",
    direction === "LONG" ? `> ${ema200.toFixed(2)}` : `< ${ema200.toFixed(2)}`,
    failureCandle.close.toFixed(2),
    direction === "LONG" ? priceAbove200 : priceBelow200,
    true,
    20,
  );

  const longZones = [ema21, ...recentSwingHighs];
  const shortZones = [ema21, ...recentSwingLows];
  const signalAtZone = touchesZone(
    signalCandle,
    direction === "LONG" ? longZones : shortZones,
  );
  check(
    "Signal candle at key zone (EMA21 or recent swing)",
    "wick touches zone within 0.3%",
    signalAtZone ? "touched" : "not at zone",
    signalAtZone,
    true,
    15,
  );

  check(
    `Signal candle shape (${direction === "LONG" ? "Hanging Man" : "Hammer"})`,
    "lower wick ≥ 2× body, tiny upper wick, small body",
    signalShape ? "valid" : "invalid",
    signalShape,
    true,
    15,
  );

  check(
    `Failure candle is solid ${direction === "LONG" ? "GREEN" : "RED"} against signal`,
    "body ≥ 60% of range, opposite to signal's wick direction",
    direction === "LONG"
      ? solidGreen ? "solid green" : "not solid green"
      : solidRed ? "solid red" : "not solid red",
    direction === "LONG" ? solidGreen : solidRed,
    true,
    20,
  );

  // Secondary — scored, not blocking
  const bodyPct = candleRange(failureCandle) > 0
    ? (candleBody(failureCandle) / candleRange(failureCandle)) * 100
    : 0;
  check(
    "Failure candle body > 60% of range",
    "> 60%",
    `${bodyPct.toFixed(1)}%`,
    bodyPct > 60,
    false,
    5,
  );

  const wickRatio = wickToBodyRatio(signalCandle, "lower");
  check(
    "Signal candle wick ≥ 2× body",
    "≥ 2",
    Number.isFinite(wickRatio) ? wickRatio.toFixed(2) : "∞",
    wickRatio >= 2,
    false,
    5,
  );

  // Entry, stop, target, R:R
  const entry = failureCandle.close;
  const stopBuffer = candleRange(signalCandle) * 0.05;
  const stop = direction === "LONG"
    ? signalCandle.low - stopBuffer
    : signalCandle.high + stopBuffer;
  const target = direction === "LONG"
    ? (recentSwingHighs.filter((p) => p > entry).sort((a, b) => a - b)[0] ||
      entry + (entry - stop) * 2)
    : (recentSwingLows.filter((p) => p < entry).sort((a, b) => b - a)[0] ||
      entry - (stop - entry) * 2);
  const rr = calcRR(entry, stop, target);
  check(
    "Risk:Reward ≥ 1:2 to next zone",
    "≥ 2",
    rr.toFixed(2),
    rr >= 2,
    false,
    5,
  );

  const avgVol = historical.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
  const volRatio = avgVol > 0 ? failureCandle.volume / avgVol : 0;
  check(
    "Failure candle volume above average",
    "> 1×",
    `${volRatio.toFixed(2)}×`,
    volRatio > 1,
    false,
    2,
  );

  // Always-true discipline reminders (stop placement is computed above).
  check(
    "Stop placed beyond signal candle wick (clear invalidation)",
    "stop outside wick",
    `entry=${entry.toFixed(2)}, stop=${stop.toFixed(2)}`,
    true,
    false,
    5,
  );

  // Manual-only scoring items (bot cannot verify; logged for transparency).
  results.push({
    label: "Higher timeframe structure agrees",
    required: "manual verification",
    actual: "not checked by bot",
    pass: null,
    core: false,
    weight: 5,
    manual: true,
  });
  results.push({
    label: "No major news in next 4 hours",
    required: "manual verification",
    actual: "not checked by bot",
    pass: null,
    core: false,
    weight: 3,
    manual: true,
  });

  const coreResults = results.filter((r) => r.core);
  const corePass = coreResults.every((r) => r.pass);
  const score = results
    .filter((r) => r.pass === true)
    .reduce((s, r) => s + (r.weight || 0), 0);
  const autoMax = results
    .filter((r) => !r.manual)
    .reduce((s, r) => s + (r.weight || 0), 0);

  console.log(
    `\n  CORE: ${coreResults.filter((r) => r.pass).length}/${coreResults.length} pass`,
  );
  console.log(`  Auto score: ${score}/${autoMax}`);
  console.log(
    `  Manual items to check: HTF structure, news — not enforced by bot.`,
  );

  return {
    results,
    allPass: corePass,
    direction,
    entry,
    stop,
    target,
    rr,
    score,
    autoMax,
  };
}

// ─── Multi-TF Pullback (numeric gate) ────────────────────────────────────

// Fetches Monthly/Weekly/Daily/entryTF candles, checks EMA9/EMA15 alignment
// on each, and returns whether all agree + if current bar is in the pullback
// zone on the entry TF.
export async function runMtfNumericGate(symbol, entryTimeframe) {
  const results = [];
  const check = (label, required, actual, pass, core = true) => {
    results.push({ label, required, actual, pass, core });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── MTF Numeric Gate ──────────────────────────────────\n");

  const [monthly, weekly, daily, entry] = await Promise.all([
    fetchCandlesHT(symbol, "1M", 60),
    fetchCandlesHT(symbol, "1W", 80),
    fetchCandlesHT(symbol, "1D", 120),
    fetchCandlesHT(symbol, entryTimeframe, 200),
  ]);

  const alignMonthly = emaAlignment(monthly);
  const alignWeekly = emaAlignment(weekly);
  const alignDaily = emaAlignment(daily);
  const alignEntry = emaAlignment(entry);

  const htfDirection = agree(alignMonthly, alignWeekly, alignDaily);

  console.log(
    `  Monthly: ${alignMonthly.direction ?? "flat"}  ` +
      `Weekly: ${alignWeekly.direction ?? "flat"}  ` +
      `Daily: ${alignDaily.direction ?? "flat"}  ` +
      `Entry(${entryTimeframe}): ${alignEntry.direction ?? "flat"}\n`,
  );

  check(
    "Monthly / Weekly / Daily all agree",
    "single direction",
    htfDirection ?? "mixed",
    htfDirection !== null,
    true,
  );

  check(
    `Entry TF (${entryTimeframe}) agrees with HTF bias`,
    htfDirection ?? "—",
    alignEntry.direction ?? "flat",
    alignEntry.direction === htfDirection,
    true,
  );

  const lastEntry = entry[entry.length - 1];
  const inZone = priceInZone(
    lastEntry,
    alignEntry.ema9,
    alignEntry.ema15,
    CONFIG.pullbackTolerancePct,
  );
  check(
    `Price touching EMA9-EMA15 zone on ${entryTimeframe} (±${CONFIG.pullbackTolerancePct}%)`,
    "candle range overlaps band",
    inZone ? "touched" : "outside",
    inZone,
    true,
  );

  const allPass = results.every((r) => r.pass);
  return {
    results,
    allPass,
    direction: htfDirection,
    entryAlignment: alignEntry,
    lastEntryCandle: lastEntry,
    entryCandles: entry,
  };
}

// ─── Visual (LLM) gate ────────────────────────────────────────────────────

export async function runVisualGate({
  symbol,
  timeframe,
  direction,
  rubricTemplate,
}) {
  const today = new Date().toISOString().slice(0, 10);
  const spentToday = getTodaysCost();
  if (spentToday >= CONFIG.maxLlmSpendUsdPerDay) {
    console.log(
      `🚫 LLM budget exhausted for ${today}: $${spentToday.toFixed(2)} / $${CONFIG.maxLlmSpendUsdPerDay}`,
    );
    return {
      skipped: true,
      reason: "daily_budget_exhausted",
      result: null,
      costUSD: 0,
    };
  }

  console.log("\n── Visual Gate (Gemini) ──────────────────────────────\n");

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const imagePath = await captureChart(`setup-${symbol}-${timeframe}-${ts}.png`);
  console.log(`  Screenshot: ${imagePath}`);

  const prompt = fillRubric(rubricTemplate, {
    SYMBOL: symbol,
    TIMEFRAME: timeframe,
    DIRECTION: direction?.toUpperCase() ?? "UNKNOWN",
  });

  const { result, inputTokens, outputTokens, costUSD, model } =
    await askGeminiVision({
      imagePath,
      prompt,
      model: CONFIG.visualModel,
    });

  const todayTotal = recordCost(costUSD);

  const confirm =
    result.angle_ok === true &&
    result.coc_present === true &&
    result.confirm_candle != null &&
    (result.red_flags?.length ?? 0) === 0 &&
    (result.score ?? 0) >= CONFIG.minLlmScore;

  console.log(
    `  angle_ok=${result.angle_ok}  coc_present=${result.coc_present}  ` +
      `confirm_candle=${result.confirm_candle}  score=${result.score}`,
  );
  if (result.red_flags?.length) {
    console.log(`  red_flags: ${result.red_flags.join(", ")}`);
  }
  console.log(`  reasoning: ${result.reasoning ?? "(none)"}`);
  console.log(
    `  cost: $${costUSD.toFixed(4)} (in=${inputTokens}, out=${outputTokens})  ` +
      `today total: $${todayTotal.toFixed(4)}`,
  );

  const icon = confirm ? "✅" : "🚫";
  console.log(`  ${icon} Visual confirmation: ${confirm ? "PASS" : "REJECT"}`);

  return {
    skipped: false,
    result,
    confirm,
    costUSD,
    inputTokens,
    outputTokens,
    model,
    imagePath,
  };
}

// Append reasoning for audit / tuning later.
function appendVisualLog(entry) {
  const path = "visual-check-log.json";
  const existing = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : [];
  existing.push(entry);
  writeFileSync(path, JSON.stringify(existing, null, 2));
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── BitGet Execution ────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(message)
    .digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/placeOrder"
      : "/api/v2/mix/order/placeOrder";

  const body = JSON.stringify({
    symbol,
    side,
    orderType: "market",
    quantity,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
    }),
  });

  const signature = signBitGet(timestamp, "POST", path, body);

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") {
    throw new Error(`BitGet order failed: ${data.msg}`);
  }

  return data.data;
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => c.pass === false && (c.core || !c.manual))
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = logEntry.direction === "SHORT" ? "SELL" : "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = `CORE met (${logEntry.direction}); score ${logEntry.score}/${logEntry.autoMax}`;
  } else {
    side = logEntry.direction === "SHORT" ? "SELL" : "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error
      ? `Error: ${logEntry.error}`
      : `CORE met (${logEntry.direction}); score ${logEntry.score}/${logEntry.autoMax}`;
  }

  const row = [
    date,
    time,
    "BitGet",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // ─── Gate 1: numeric multi-timeframe ─────────────────────────────────
  const gate1 = await runMtfNumericGate(CONFIG.symbol, CONFIG.timeframe);
  const price = gate1.lastEntryCandle.close;
  const direction = gate1.direction;

  let visual = { skipped: true, reason: "numeric_gate_failed" };
  let results = [...gate1.results];
  let allPass = gate1.allPass;

  // ─── Gate 2: LLM visual confirmation (only if numeric passed) ────────
  if (gate1.allPass && CONFIG.useVisualConfirmation) {
    try {
      const rubricTemplate = readFileSync("prompts/visual-rubric.md", "utf8");
      visual = await runVisualGate({
        symbol: CONFIG.symbol,
        timeframe: CONFIG.timeframe,
        direction,
        rubricTemplate,
      });

      appendVisualLog({
        timestamp: new Date().toISOString(),
        symbol: CONFIG.symbol,
        timeframe: CONFIG.timeframe,
        direction,
        price,
        ...visual,
      });

      if (!visual.skipped) {
        results.push({
          label: "Gemini visual confirmation",
          required: `all: angle_ok, coc_present, confirm_candle, no red flags, score ≥ ${CONFIG.minLlmScore}`,
          actual: JSON.stringify({
            angle_ok: visual.result.angle_ok,
            coc_present: visual.result.coc_present,
            confirm_candle: visual.result.confirm_candle,
            red_flags: visual.result.red_flags,
            score: visual.result.score,
          }),
          pass: visual.confirm,
          core: true,
        });
        allPass = allPass && visual.confirm;
      } else {
        results.push({
          label: "Gemini visual confirmation",
          required: "runnable",
          actual: `skipped: ${visual.reason}`,
          pass: false,
          core: true,
        });
        allPass = false;
      }
    } catch (err) {
      console.log(`  ⚠️  Visual gate error: ${err.message}`);
      results.push({
        label: "Gemini visual confirmation",
        required: "runnable",
        actual: `error: ${err.message}`,
        pass: false,
        core: true,
      });
      allPass = false;
      visual = { skipped: true, reason: err.message };
    }
  } else if (gate1.allPass && !CONFIG.useVisualConfirmation) {
    console.log(
      "\n⚠️  Visual confirmation disabled (USE_VISUAL_CONFIRMATION=false)",
    );
  }

  // Stop/target not auto-computed for MTF strategy — trader/LLM decides live.
  const entry = price;
  const stop = null;
  const target = null;
  const rr = null;
  const score = visual.result?.score ?? 0;
  const autoMax = 10;

  // Calculate position size
  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  // Decision
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: {
      ema9: gate1.entryAlignment?.ema9 ?? null,
      ema15: gate1.entryAlignment?.ema15 ?? null,
    },
    direction,
    setup: direction ? { entry, stop, target, rr } : null,
    score,
    autoMax,
    conditions: results,
    allPass,
    visual: visual.result
      ? {
          ...visual.result,
          costUSD: visual.costUSD,
          model: visual.model,
          imagePath: visual.imagePath,
        }
      : null,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  const normalisedDirection =
    direction === "bullish" ? "LONG" : direction === "bearish" ? "SHORT" : null;
  logEntry.direction = normalisedDirection;

  if (!allPass) {
    const failed = results
      .filter((r) => r.pass === false)
      .map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    const side = normalisedDirection === "LONG" ? "buy" : "sell";
    console.log(`✅ BOTH GATES PASSED — ${normalisedDirection}`);
    console.log(`   Entry: $${entry.toFixed(2)}  (stop/target set manually)`);

    if (CONFIG.paperTrading) {
      console.log(
        `\n📋 PAPER TRADE — would ${side.toUpperCase()} ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market`,
      );
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(
        `\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} ${side.toUpperCase()} ${CONFIG.symbol}`,
      );
      try {
        const order = await placeBitGetOrder(
          CONFIG.symbol,
          side,
          tradeSize,
          price,
        );
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  // Save decision log
  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  // Write tax CSV row for every run (executed, paper, or blocked)
  writeTradeCsv(logEntry);

  console.log("═══════════════════════════════════════════════════════════\n");
}

// Runs just the visual gate on whatever is currently on the TradingView chart.
// Use this to validate the Gemini path works end-to-end without waiting for a
// real setup. Direction is taken from --direction=long|short, defaults to long.
async function runVisualOnly() {
  const directionArg =
    process.argv.find((a) => a.startsWith("--direction="))?.split("=")[1] ??
    "long";
  const direction = directionArg === "short" ? "bearish" : "bullish";
  console.log(
    `\n🧪 Visual-only test: assuming direction=${direction.toUpperCase()}. ` +
      `Make sure TradingView shows ${CONFIG.symbol} ${CONFIG.timeframe}.\n`,
  );
  const rubricTemplate = readFileSync("prompts/visual-rubric.md", "utf8");
  const visual = await runVisualGate({
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    direction,
    rubricTemplate,
  });
  if (visual.skipped) {
    console.log(`\nSkipped: ${visual.reason}`);
    return;
  }
  console.log("\n── Full Gemini JSON ─────────────────────────────────────\n");
  console.log(JSON.stringify(visual.result, null, 2));
  console.log("\n── Verdict ──────────────────────────────────────────────\n");
  console.log(
    visual.confirm
      ? `✅ PASS — score=${visual.result.score}`
      : `🚫 REJECT — score=${visual.result.score}; see reasoning above`,
  );
}

// Only run when invoked directly (node bot.js), not when imported by tests.
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  if (process.argv.includes("--tax-summary")) {
    generateTaxSummary();
  } else if (process.argv.includes("--test-visual")) {
    runVisualOnly().catch((err) => {
      console.error("Visual test error:", err);
      process.exit(1);
    });
  } else if (process.argv.includes("--scan")) {
    const htfOnly = process.argv.includes("--htf-only");
    import("./src/scanner.js")
      .then(({ runScan, runScanV2 }) =>
        htfOnly ? runScanV2() : runScan({ htfOnly: false }),
      )
      .catch((err) => {
        console.error("Scan error:", err);
        process.exit(1);
      });
  } else if (process.argv.includes("--deep")) {
    // Usage: node bot.js --deep EURUSD [--tv=OANDA:EURUSD]
    const labelIdx = process.argv.indexOf("--deep");
    const label = process.argv[labelIdx + 1];
    if (!label || label.startsWith("--")) {
      console.error(
        "Usage: node bot.js --deep <LABEL> [--tv=EXCHANGE:SYMBOL]\n" +
          "       Example: node bot.js --deep EURUSD --tv=OANDA:EURUSD",
      );
      process.exit(1);
    }
    let tvSymbol =
      process.argv.find((a) => a.startsWith("--tv="))?.split("=")[1] ?? null;
    // Fall back to watchlist.json if --tv not given
    if (!tvSymbol) {
      try {
        const list = JSON.parse(readFileSync("watchlist.json", "utf8"));
        const found = list.find(
          (x) => x.label.toUpperCase() === label.toUpperCase(),
        );
        if (found) tvSymbol = found.tv_symbol;
      } catch {}
    }
    if (!tvSymbol) {
      console.error(
        `Could not resolve a TradingView symbol for "${label}". ` +
          `Add it to watchlist.json or pass --tv=EXCHANGE:SYMBOL.`,
      );
      process.exit(1);
    }
    import("./src/scanner.js")
      .then(({ runDeepScan }) => runDeepScan(label, tvSymbol))
      .catch((err) => {
        console.error("Deep scan error:", err);
        process.exit(1);
      });
  } else {
    run().catch((err) => {
      console.error("Bot error:", err);
      process.exit(1);
    });
  }
}
