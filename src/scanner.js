// Scanner — iterates a watchlist × timeframes, evaluates each chart with
// (optional) numeric MTF gate + Gemini visual gate, prints a report card,
// and saves results to scan-results/.

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "fs";
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

// Reactive two-phase state machine for LTF cells.
//
//   prep_signals = angle_ok + zone_rejection + coc_present + solid_continuation  (4 signals)
//
//   NONE  — red_flags present OR prep_signals < 2
//   WATCH — HTF bias is set + prep_signals >= 2 + no red_flags
//             AND strong_candle_in_bias = FALSE  (confirmation NOT yet closed)
//   ENTER — same as WATCH, but strong_candle_in_bias = TRUE
//             (the most recent CLOSED candle is the confirmation — react now)
//
// strong_candle_in_bias is the TRIGGER, not a counted signal. We never enter
// on a prediction; we enter only when the confirmation candle has actually
// closed in the bias direction.
//
// probability_next_candle_in_bias does NOT gate state — it is used only to
// rank multiple ENTER triggers when several fire at once.
export function ltfCellState(cell) {
  if (!cell || typeof cell !== "object") return "NONE";
  const noFlags = !cell.red_flags || cell.red_flags.length === 0;
  if (!noFlags) return "NONE";
  const prepSignals =
    (cell.angle_ok ? 1 : 0) +
    (cell.zone_rejection ? 1 : 0) +
    (cell.coc_present ? 1 : 0) +
    (cell.solid_continuation ? 1 : 0);
  if (prepSignals < 2) return "NONE";
  return cell.strong_candle_in_bias ? "ENTER" : "WATCH";
}

// Daily-level reactive state machine used by the V2 pipeline. Richer than
// ltfCellState because the trigger is no longer a single boolean but a full
// candle_verdict sub-object:
//
//   NONE  — direction_conflict OR red_flags present OR prep_signals_count < 2
//           OR missing candle_verdict
//   WATCH — prep ready but the trigger candle doesn't confirm yet
//           (candle_verdict.in_bias === false OR winner_strength < 7)
//   ENTER — prep ready AND candle_verdict.in_bias === true
//           AND winner_strength >= 7 (decisive close in bias direction)
//
// Authoritative in code — if the prompt's self-reported state disagrees, the
// scanner trusts this computation.
export function dailyCellState(cell) {
  if (!cell || typeof cell !== "object") return "NONE";
  if (cell.direction_conflict === true) return "NONE";
  const flags = cell.red_flags || [];
  if (flags.length > 0) return "NONE";
  if ((cell.prep_signals_count ?? 0) < 2) return "NONE";
  const v = cell.candle_verdict;
  if (!v || typeof v !== "object") return "NONE";
  if (v.in_bias !== true) return "WATCH";
  if ((v.winner_strength ?? 0) < 7) return "WATCH";
  return "ENTER";
}

// Classifies the ENTER reason. Priority: sweep (highest conviction) > pattern
// > momentum. Returns "none" when state !== "ENTER".
export function dailyTriggerType(cell, weeklyBias) {
  if (!cell || dailyCellState(cell) !== "ENTER") return "none";
  const v = cell.candle_verdict;
  const isLong = weeklyBias === "long";

  // Sweep trigger — liquidity grabbed then rejected in bias direction
  const sweepMatch = isLong
    ? v.liquidity_swept === "below_prior_low"
    : v.liquidity_swept === "above_prior_high";
  if (sweepMatch) return "sweep";

  // Pattern trigger — named reversal/continuation pattern in bias direction
  const patternSet = isLong
    ? new Set(["hammer", "pinbar_bull", "engulfing_bull"])
    : new Set(["shooting_star", "pinbar_bear", "engulfing_bear"]);
  if (patternSet.has(v.pattern)) return "pattern";

  // Momentum trigger — solid directional body
  const momentumMatch = isLong
    ? v.pattern === "solid_bull"
    : v.pattern === "solid_bear";
  if (momentumMatch) return "momentum";

  // Fallback — cell satisfies ENTER thresholds but pattern didn't classify
  return "momentum";
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

    // LLM returned malformed output even after retry — surface it distinctly
    // so we can tell "model failed" apart from "model judged flat."
    if (cell?.parse_failed) {
      return { stopped: true, stopAt: tf, stopReason: "llm_parse_error", htfBias: null, avgScore: null };
    }
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

// The vision model occasionally returns an empty/malformed JSON object
// (no direction string, null latest_candle, empty reasoning). Treat that
// as a parse failure — NOT as a real "no trend" verdict — so we can retry.
function isHtfParseFailure(result) {
  return (
    !result ||
    typeof result.direction !== "string" ||
    result.direction.length === 0
  );
}

// Primary → fallback model. If primary already looks like "flash", we promote
// to "pro" on retry; otherwise we demote pro → flash. Swapping models on
// retry catches the class of failure where one model chokes on an image the
// other handles cleanly.
function pickFallbackModel(primary) {
  if (/flash/i.test(primary)) return "gemini-3.1-pro-preview";
  return "gemini-2.5-flash";
}

// Appends each irrecoverable parse failure to parse-failures.jsonl with raw
// LLM responses from every attempt, so we can inspect what Gemini actually
// said and spot patterns (image issue, truncation, refusal, etc.).
function logParseFailure(entry) {
  try {
    appendFileSync("parse-failures.jsonl", JSON.stringify(entry) + "\n");
  } catch {
    // Non-fatal — diagnostics only.
  }
}

// Drives one HTF cell: switch chart, screenshot, ask Gemini with the htf-bias rubric.
// Retries once on a parse failure with (a) a fresh screenshot and (b) a fallback
// model. If both attempts fail, the cell is marked parse_failed so the chain can
// distinguish it from a genuine no_trend verdict.
async function evaluateHtfCell(client, item, tf, rubric) {
  const slug = slugify(item.label);
  await setTimeframe(client, tf);
  await dismissPopups(client);
  let imagePath = await captureSymbolTf(client, slug, tf, item.tv_symbol);

  const prompt = fillRubric(rubric, { SYMBOL: item.label, TIMEFRAME: tf });
  const primaryModel =
    process.env.HTF_MODEL ||
    process.env.VISUAL_MODEL ||
    "gemini-3.1-pro-preview";
  const fallbackModel = pickFallbackModel(primaryModel);

  const maxAttempts = 2;
  let result, model;
  let totalCost = 0;
  let attempts = 0;
  let parseFailed = false;
  let usedFallback = false;
  const rawTrace = []; // raw text + model for each attempt, for diagnostics

  while (attempts < maxAttempts) {
    attempts++;
    const isRetry = attempts > 1;
    let modelToUse = primaryModel;
    if (isRetry) {
      // Fresh screenshot — in case the chart was mid-draw / a popup was overlaid
      // / TV had focus issues on the first capture.
      imagePath = await captureSymbolTf(client, slug, tf, item.tv_symbol);
      modelToUse = fallbackModel;
      usedFallback = true;
    }
    const resp = await askGeminiVision({ imagePath, prompt, model: modelToUse });
    recordCost(resp.costUSD);
    totalCost += resp.costUSD;
    result = resp.result;
    model = resp.model;
    rawTrace.push({
      attempt: attempts,
      model: resp.model,
      raw_text: (resp.rawText ?? "").slice(0, 2000),
    });
    if (!isHtfParseFailure(result)) {
      parseFailed = false;
      break;
    }
    parseFailed = true;
  }

  if (parseFailed) {
    logParseFailure({
      timestamp: new Date().toISOString(),
      symbol: item.label,
      tv_symbol: item.tv_symbol,
      tf,
      attempts,
      image: imagePath,
      attempts_detail: rawTrace,
    });
  }

  return {
    tf,
    direction: result?.direction,
    setup_type: result?.setup_type ?? "none",
    latest_candle: result?.latest_candle ?? null,
    angle_ok: !!result?.angle_ok,
    pullback_present: !!result?.pullback_present,
    ema_stack_ok: !!result?.ema_stack_ok,
    solid_continuation: !!result?.solid_continuation,
    probability_next_candle_in_bias:
      result?.probability_next_candle_in_bias ?? 0,
    score: result?.score ?? 0,
    red_flags: result?.red_flags ?? [],
    reasoning: result?.reasoning ?? "",
    image: imagePath,
    cost_usd: totalCost,
    model,
    parse_failed: parseFailed,
    attempts,
    used_fallback: usedFallback && !parseFailed,
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
  // prep_signals does NOT include strong_candle_in_bias — that's the trigger
  cell.prep_signals_count =
    (cell.angle_ok ? 1 : 0) +
    (cell.zone_rejection ? 1 : 0) +
    (cell.coc_present ? 1 : 0) +
    (cell.solid_continuation ? 1 : 0);
  cell.state = ltfCellState(cell);
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
    watching: [], // WATCH state — setup forming, confirmation candle pending
    triggers: [], // ENTER state — confirmation candle just CLOSED, react now
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
    if (cell.parse_failed) {
      log(`      ⚠️  parse_failed (tried ${cell.attempts}x, last=${cell.model}) → see parse-failures.jsonl`);
    } else if (cell.used_fallback) {
      log(`      dir=${cell.direction} score=${cell.score}  (recovered via ${cell.model} on retry)`);
    } else {
      log(`      dir=${cell.direction} score=${cell.score}`);
    }

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

  // HTF-only mode: skip numeric cross-check and LTF scan. Human decides entry.
  if (opts.htfOnly) {
    result.htf_only = true;
    return result;
  }

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
      `      prep=${cell.prep_signals_count}/4  trigger=${cell.strong_candle_in_bias}  ` +
        `prob=${cell.probability_next_candle_in_bias}  state=${cell.state}`,
    );
    if (cell.state === "ENTER") result.triggers.push(cell);
    else if (cell.state === "WATCH") result.watching.push(cell);
  }

  // Sort by probability_next_candle_in_bias desc — for ranking when multiple fire
  const byProbDesc = (a, b) =>
    (b.probability_next_candle_in_bias ?? 0) - (a.probability_next_candle_in_bias ?? 0);
  result.triggers.sort(byProbDesc);
  result.watching.sort(byProbDesc);

  if (result.triggers.length === 0 && result.watching.length === 0) {
    result.stop_reason = "no_setup";
  } else if (result.triggers.length === 0) {
    result.stop_reason = "watching_no_trigger";
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

function fmtCellList(cells) {
  if (!cells || cells.length === 0) return "—";
  return cells
    .map((c) => `${c.tf}(${c.probability_next_candle_in_bias ?? "?"}%)`)
    .join(", ");
}

function summaryLine(r) {
  if (r.stop_reason && !r.htf_bias) {
    return `  ${r.symbol.padEnd(12)} STOP @ ${r.stopped_at ?? "—"} (${r.stop_reason})`;
  }
  if (r.htf_only) {
    const dirTag = r.htf_bias === "long" ? "📈 LONG" : "📉 SHORT";
    return `  ${r.symbol.padEnd(12)} ${dirTag}  HTF avg ${r.htf_avg_score.toFixed(1)}  (manual-entry candidate)`;
  }
  if (r.stop_reason === "numeric_disagree") {
    return `  ${r.symbol.padEnd(12)} STOP numeric_disagree (HTF said ${r.htf_bias})`;
  }
  const numTxt = r.numeric_check.ran
    ? r.numeric_check.agreed
      ? "agree"
      : "disagree"
    : "n/a";
  const enter = fmtCellList(r.triggers);
  const watch = fmtCellList(r.watching);
  return (
    `  ${r.symbol.padEnd(12)} HTF: ${r.htf_bias} ` +
    `(avg ${r.htf_avg_score.toFixed(1)})  →  numeric: ${numTxt}  ` +
    `→  WATCH: ${watch}   ENTER: ${enter}`
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
  const htfOnly = options.htfOnly === true;

  const startedAt = new Date().toISOString();
  const flowDesc = htfOnly
    ? "HTF [1M→1W→1D] only — manual entry"
    : "HTF [1M→1W→1D] → numeric → LTF [4H→2H→1H]";
  console.log(
    `\n═══════════════════════════════════════════════════════════\n` +
      `  Scan started: ${startedAt}\n` +
      `  Watchlist: ${watchlist.length} symbols\n` +
      `  Flow per symbol: ${flowDesc}\n` +
      `═══════════════════════════════════════════════════════════\n`,
  );

  const results = [];
  let client;
  try {
    client = await openTvClient();
    for (const [i, item] of watchlist.entries()) {
      console.log(`\n[${i + 1}/${watchlist.length}] ▶ ${item.label} (${item.tv_symbol})`);
      try {
        const r = await evaluateSymbol(client, item, htfRubric, ltfRubric, { verbose: true, htfOnly });
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
          watching: [],
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

  // Aggregate ENTER triggers across all symbols, sorted by probability desc
  const allEnters = [];
  const allWatches = [];
  for (const r of results) {
    for (const c of r.triggers ?? []) {
      allEnters.push({ symbol: r.symbol, htfBias: r.htf_bias, ...c });
    }
    for (const c of r.watching ?? []) {
      allWatches.push({ symbol: r.symbol, htfBias: r.htf_bias, ...c });
    }
  }
  const byProb = (a, b) =>
    (b.probability_next_candle_in_bias ?? 0) - (a.probability_next_candle_in_bias ?? 0);
  allEnters.sort(byProb);
  allWatches.sort(byProb);

  console.log("");
  if (allEnters.length === 0 && allWatches.length === 0) {
    console.log("  No setups forming this scan.");
  } else {
    if (allEnters.length > 0) {
      console.log(`  🚨 ENTER (${allEnters.length}) — confirmation candle just closed, ranked by probability:`);
      for (const e of allEnters) {
        console.log(
          `     - ${e.symbol} ${e.tf} (${e.htfBias}) prob=${e.probability_next_candle_in_bias}% setup=${e.setup_type}`,
        );
      }
    } else {
      console.log("  ENTER: none.");
    }
    if (allWatches.length > 0) {
      console.log(`  👀 WATCH (${allWatches.length}) — setup forming, awaiting confirmation:`);
      for (const w of allWatches) {
        console.log(
          `     - ${w.symbol} ${w.tf} (${w.htfBias}) prob=${w.probability_next_candle_in_bias}% setup=${w.setup_type}`,
        );
      }
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
