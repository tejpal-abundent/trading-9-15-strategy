// Scanner — iterates a watchlist × timeframes, evaluates each chart with
// (optional) numeric MTF gate + Gemini visual gate, prints a report card,
// and saves results to scan-results/.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import {
  openTvClient,
  closeTvClient,
  setSymbol,
  setTimeframe,
  captureSymbolTf,
  getChartState,
  dismissPopups,
} from "./tv-navigate.js";
import { askGeminiVision, getTodaysCost, recordCost, fillRubric } from "./visual.js";
import { fetchCandles, emaAlignment, agree } from "./higher-tf.js";

const HTF_TIMEFRAMES = ["1M", "1W", "1D"];
const LTF_TIMEFRAMES = ["4H", "2H", "1H"];
const RESULT_DIR = "scan-results";

// Filesystem-safe slug from a watchlist entry's TV symbol.
export function slugify(label) {
  return label.replace(/[^A-Za-z0-9_-]/g, "_");
}

// Whether an LTF cell passes the entry filter. Two doors:
//   Door A — Structural: at least 2 of 5 signals AND score >= 8
//     (signals: angle_ok, zone_rejection, coc_present, strong_candle_in_bias, solid_continuation)
//   Door B — Probabilistic: probability_next_candle_in_bias >= 75
// Either door is sufficient. red_flags must be empty for either door to fire.
export function ltfCellPass(cell) {
  if (!cell || typeof cell !== "object") return false;
  const noFlags = !cell.red_flags || cell.red_flags.length === 0;
  if (!noFlags) return false;
  const signals =
    (cell.angle_ok ? 1 : 0) +
    (cell.zone_rejection ? 1 : 0) +
    (cell.coc_present ? 1 : 0) +
    (cell.strong_candle_in_bias ? 1 : 0) +
    (cell.solid_continuation ? 1 : 0);
  const structuralPass = signals >= 2 && (cell.score ?? 0) >= 8;
  const probabilityPass =
    (cell.probability_next_candle_in_bias ?? 0) >= 75;
  return structuralPass || probabilityPass;
}

// HTF_TIMEFRAMES order is fixed: index 0 = 1M, 1 = 1W, 2 = 1D.
// Cells passed in must be in that order; result.stopAt names the TF that failed.
const HTF_LABELS = ["1M", "1W", "1D"];

// Whether one HTF cell passes its individual quality gate. Two doors:
//   Door A — Structural: score >= minPerScore (default 7)
//   Door B — Probabilistic: probability_next_candle_in_bias >= minPerProb (default 75)
// red_flags must be empty for either door to fire.
function htfCellPass(cell, opts = {}) {
  const minPerScore = opts.minPerScore ?? 7;
  const minPerProb = opts.minPerProb ?? 75;
  const noFlags = !cell?.red_flags || cell.red_flags.length === 0;
  if (!noFlags) return false;
  return (
    (cell.score ?? 0) >= minPerScore ||
    (cell.probability_next_candle_in_bias ?? 0) >= minPerProb
  );
}

export function evaluateHtfChain(cells, opts = {}) {
  let firstDir = null;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const tf = HTF_LABELS[i] ?? `htf_${i}`;
    const dir = cell?.direction;

    if (!dir || dir === "none") {
      return { stopped: true, stopAt: tf, stopReason: "no_trend", htfBias: null, avgScore: null };
    }
    if (!htfCellPass(cell, opts)) {
      return { stopped: true, stopAt: tf, stopReason: "htf_quality_low", htfBias: null, avgScore: null };
    }
    if (firstDir == null) {
      firstDir = dir;
    } else if (dir !== firstDir) {
      return { stopped: true, stopAt: tf, stopReason: "htf_disagree", htfBias: null, avgScore: null };
    }
  }

  const avgScore = cells.reduce((s, c) => s + (c.score ?? 0), 0) / cells.length;
  return { stopped: false, stopAt: null, stopReason: null, htfBias: firstDir, avgScore };
}

// For Binance symbols only — verifies that the visual HTF bias agrees with
// the numeric EMA9/15 alignment computed from real 1M/1W/1D candles.
// Returns { ran, direction, agreed, error? }.
//   ran = false  → no Binance symbol available (skip cross-check entirely)
//   agreed = false when numeric direction is null OR != htfBias
async function runNumericCrossCheck(binanceSymbol, htfBias) {
  if (!binanceSymbol) return { ran: false, direction: null, agreed: null };
  try {
    const [m, w, d] = await Promise.all([
      fetchCandles(binanceSymbol, "1M", 60),
      fetchCandles(binanceSymbol, "1W", 80),
      fetchCandles(binanceSymbol, "1D", 120),
    ]);
    const dir = agree(emaAlignment(m), emaAlignment(w), emaAlignment(d));
    // higher-tf returns "bullish" / "bearish" / null
    const mapped = dir === "bullish" ? "long" : dir === "bearish" ? "short" : null;
    return { ran: true, direction: mapped, agreed: mapped !== null && mapped === htfBias };
  } catch (err) {
    return { ran: true, direction: null, agreed: false, error: err.message };
  }
}

function loadWatchlist(path = "watchlist.json") {
  if (!existsSync(path)) {
    throw new Error(`watchlist.json not found at ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error("watchlist.json must be an array of {label, tv_symbol, binance_symbol}");
  }
  return raw;
}

// Drives one HTF cell: switch chart, screenshot, ask Gemini with the htf-bias rubric.
async function evaluateHtfCell(client, item, tf, rubric) {
  const slug = slugify(item.label);
  await setTimeframe(client, tf);
  await dismissPopups(client);
  const imagePath = await captureSymbolTf(client, slug, tf, item.tv_symbol);

  const prompt = fillRubric(rubric, { SYMBOL: item.label, TIMEFRAME: tf });
  const { result, costUSD, model } = await askGeminiVision({
    imagePath,
    prompt,
    model:
      process.env.HTF_MODEL ||
      process.env.VISUAL_MODEL ||
      "gemini-3.1-pro-preview",
  });
  recordCost(costUSD);

  return {
    tf,
    direction: result.direction,
    setup_type: result.setup_type ?? "none",
    latest_candle: result.latest_candle ?? null,
    angle_ok: !!result.angle_ok,
    pullback_present: !!result.pullback_present,
    ema_stack_ok: !!result.ema_stack_ok,
    solid_continuation: !!result.solid_continuation,
    probability_next_candle_in_bias:
      result.probability_next_candle_in_bias ?? 0,
    score: result.score ?? 0,
    red_flags: result.red_flags ?? [],
    reasoning: result.reasoning ?? "",
    image: imagePath,
    cost_usd: costUSD,
    model,
  };
}

// Drives one LTF cell: switch chart, screenshot, ask Gemini with the
// ltf-entry rubric and the HTF bias injected.
async function evaluateLtfCell(client, item, tf, htfBias, rubric) {
  const slug = slugify(item.label);
  await setTimeframe(client, tf);
  await dismissPopups(client);
  const imagePath = await captureSymbolTf(client, slug, tf, item.tv_symbol);

  const prompt = fillRubric(rubric, {
    SYMBOL: item.label,
    TIMEFRAME: tf,
    HTF_BIAS: htfBias,
  });
  const { result, costUSD, model } = await askGeminiVision({
    imagePath,
    prompt,
    model:
      process.env.LTF_MODEL ||
      process.env.VISUAL_MODEL ||
      "gemini-3-flash-preview",
  });
  recordCost(costUSD);

  const cell = {
    tf,
    setup_type: result.setup_type ?? "none",
    latest_candle: result.latest_candle ?? null,
    angle_ok: !!result.angle_ok,
    zone_rejection: !!result.zone_rejection,
    coc_present: !!result.coc_present,
    strong_candle_in_bias: !!result.strong_candle_in_bias,
    solid_continuation: !!result.solid_continuation,
    probability_next_candle_in_bias:
      result.probability_next_candle_in_bias ?? 0,
    score: result.score ?? 0,
    red_flags: result.red_flags ?? [],
    reasoning: result.reasoning ?? "",
    image: imagePath,
    cost_usd: costUSD,
    model,
  };
  cell.signals_count =
    (cell.angle_ok ? 1 : 0) +
    (cell.zone_rejection ? 1 : 0) +
    (cell.coc_present ? 1 : 0) +
    (cell.strong_candle_in_bias ? 1 : 0) +
    (cell.solid_continuation ? 1 : 0);
  cell.pass = ltfCellPass(cell);
  return cell;
}

// Single-symbol pipeline. Drives HTF chain → numeric cross-check → LTF chain.
// Returns the full result object matching the spec schema.
async function evaluateSymbol(client, item, htfRubric, ltfRubric, opts = {}) {
  const verbose = opts.verbose !== false;
  const log = (msg) => {
    if (verbose) console.log(msg);
  };

  const result = {
    symbol: item.label,
    tv_symbol: item.tv_symbol,
    started_at: new Date().toISOString(),
    stopped_at: null,
    stop_reason: null,
    htf_cells: [],
    htf_avg_score: null,
    htf_bias: null,
    numeric_check: { ran: false, direction: null, agreed: null },
    ltf_cells: [],
    triggers: [],
    cost_usd: 0,
  };

  await setSymbol(client, item.tv_symbol);
  await dismissPopups(client);

  // HTF chain (sequential, fail-fast)
  for (const tf of HTF_TIMEFRAMES) {
    log(`    HTF ${tf} ...`);
    const cell = await evaluateHtfCell(client, item, tf, htfRubric);
    result.htf_cells.push(cell);
    result.cost_usd += cell.cost_usd;
    log(`      dir=${cell.direction} score=${cell.score}`);

    const chain = evaluateHtfChain(result.htf_cells);
    if (chain.stopped) {
      result.stopped_at = chain.stopAt ?? tf;
      result.stop_reason = chain.stopReason;
      log(`    🚫 STOP @ ${result.stopped_at}: ${result.stop_reason}`);
      return result;
    }
  }

  const finalChain = evaluateHtfChain(result.htf_cells);
  result.htf_avg_score = finalChain.avgScore;
  if (finalChain.stopped) {
    result.stop_reason = finalChain.stopReason;
    log(`    🚫 STOP: ${result.stop_reason} (avg ${finalChain.avgScore?.toFixed(2)})`);
    return result;
  }
  result.htf_bias = finalChain.htfBias;
  log(`    ✅ HTF bias: ${result.htf_bias} (avg ${finalChain.avgScore.toFixed(2)})`);

  // Binance numeric cross-check
  if (item.binance_symbol) {
    const num = await runNumericCrossCheck(item.binance_symbol, result.htf_bias);
    result.numeric_check = num;
    log(
      `    numeric: ran=${num.ran} dir=${num.direction} agreed=${num.agreed}`,
    );
    if (!num.agreed) {
      result.stop_reason = "numeric_disagree";
      log(`    🚫 STOP: numeric_disagree`);
      return result;
    }
  }

  // LTF chain
  for (const tf of LTF_TIMEFRAMES) {
    log(`    LTF ${tf} ...`);
    const cell = await evaluateLtfCell(client, item, tf, result.htf_bias, ltfRubric);
    result.ltf_cells.push(cell);
    result.cost_usd += cell.cost_usd;
    log(
      `      signals=${cell.signals_count} score=${cell.score} ` +
        `pass=${cell.pass}`,
    );
    if (cell.pass) result.triggers.push(tf);
  }

  if (result.triggers.length === 0) {
    result.stop_reason = "no_entry";
  }
  return result;
}

function loadRubrics(opts = {}) {
  const htfPath = opts.htfRubricPath || "prompts/htf-bias.md";
  const ltfPath = opts.ltfRubricPath || "prompts/ltf-entry.md";
  return {
    htfRubric: readFileSync(htfPath, "utf8"),
    ltfRubric: readFileSync(ltfPath, "utf8"),
  };
}

function saveResult(prefix, label, payload) {
  if (!existsSync(RESULT_DIR)) mkdirSync(RESULT_DIR, { recursive: true });
  const stamp = (payload.started_at || new Date().toISOString()).replace(/[:.]/g, "-");
  const out = `${RESULT_DIR}/${prefix}-${slugify(label)}-${stamp}.json`;
  writeFileSync(out, JSON.stringify(payload, null, 2));
  writeFileSync(`${RESULT_DIR}/latest-${prefix}.json`, JSON.stringify(payload, null, 2));
  return out;
}

function summaryLine(r) {
  if (r.stop_reason && !r.htf_bias) {
    return `  ${r.symbol.padEnd(12)} STOP @ ${r.stopped_at ?? "—"} (${r.stop_reason})`;
  }
  if (r.stop_reason === "numeric_disagree") {
    return `  ${r.symbol.padEnd(12)} STOP numeric_disagree (HTF said ${r.htf_bias})`;
  }
  const numTxt = r.numeric_check.ran
    ? r.numeric_check.agreed
      ? "agree"
      : "disagree"
    : "n/a";
  const triggers = r.triggers.length ? `[${r.triggers.join(", ")}]` : "no entry";
  return (
    `  ${r.symbol.padEnd(12)} HTF: ${r.htf_bias} ` +
    `(avg ${r.htf_avg_score.toFixed(1)})  →  numeric: ${numTxt}  →  triggers: ${triggers}`
  );
}

export async function runDeepScan(symbolLabel, tvSymbol, options = {}) {
  const { htfRubric, ltfRubric } = loadRubrics(options);
  const item = {
    label: symbolLabel,
    tv_symbol: tvSymbol,
    binance_symbol: options.binanceSymbol ?? null,
  };

  console.log(
    `\n═══════════════════════════════════════════════════════════\n` +
      `  Deep scan: ${symbolLabel} (${tvSymbol})\n` +
      `  Flow: HTF [1M→1W→1D] → numeric → LTF [4H→2H→1H]\n` +
      `═══════════════════════════════════════════════════════════\n`,
  );

  let client;
  let result;
  try {
    client = await openTvClient();
    result = await evaluateSymbol(client, item, htfRubric, ltfRubric, { verbose: true });
  } finally {
    await closeTvClient(client);
  }

  console.log("\n" + summaryLine(result));
  const path = saveResult("deep", symbolLabel, result);
  console.log(`\nFull results saved → ${path}`);
  return result;
}

export async function runScan(options = {}) {
  const watchlist = loadWatchlist(options.watchlistPath || "watchlist.json");
  const { htfRubric, ltfRubric } = loadRubrics(options);

  const startedAt = new Date().toISOString();
  console.log(
    `\n═══════════════════════════════════════════════════════════\n` +
      `  Scan started: ${startedAt}\n` +
      `  Watchlist: ${watchlist.length} symbols\n` +
      `  Flow per symbol: HTF [1M→1W→1D] → numeric → LTF [4H→2H→1H]\n` +
      `═══════════════════════════════════════════════════════════\n`,
  );

  const results = [];
  let client;
  try {
    client = await openTvClient();
    for (const [i, item] of watchlist.entries()) {
      console.log(`\n[${i + 1}/${watchlist.length}] ▶ ${item.label} (${item.tv_symbol})`);
      try {
        const r = await evaluateSymbol(client, item, htfRubric, ltfRubric, { verbose: true });
        results.push(r);
      } catch (err) {
        console.log(`    ❌ ${err.message}`);
        results.push({
          symbol: item.label,
          tv_symbol: item.tv_symbol,
          stopped_at: null,
          stop_reason: `error: ${err.message}`,
          htf_cells: [],
          htf_bias: null,
          ltf_cells: [],
          triggers: [],
          cost_usd: 0,
        });
      }
    }
  } finally {
    await closeTvClient(client);
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Report Card");
  console.log("═══════════════════════════════════════════════════════════");
  for (const r of results) console.log(summaryLine(r));
  const allTriggers = results.filter((r) => r.triggers && r.triggers.length > 0);
  console.log("");
  if (allTriggers.length === 0) {
    console.log("  No entry signals this scan.");
  } else {
    console.log(`  ✅ ${allTriggers.length} symbol(s) with entry signals:`);
    for (const r of allTriggers) {
      console.log(`     - ${r.symbol} (${r.htf_bias}) → ${r.triggers.join(", ")}`);
    }
  }

  const summary = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    results,
  };
  const path = saveResult("scan", "watchlist", summary);
  console.log(`\nFull results saved → ${path}`);
  return summary;
}
