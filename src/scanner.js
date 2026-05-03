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
  formatCapturedAtForPrompt,
  getChartState,
  dismissPopups,
} from "./tv-navigate.js";
import { askGeminiVision, getTodaysCost, recordCost, fillRubric } from "./visual.js";
import { fetchCandles, emaAlignment, agree } from "./higher-tf.js";
import { loadPriorRunsForWatchlist, derivePriorContext } from "./history.js";

const HTF_TIMEFRAMES = ["1M", "1W", "1D"];
const LTF_TIMEFRAMES = ["4H", "2H", "1H"];
const RESULT_DIR = "scan-results";

// P5: ENTER requires a decisive in-bias close. Threshold set at 6 to admit
// "body ≥ 60% closing in upper/lower third" candles (which the daily prompt
// rubric grades 5-7). Was 7 previously, which forced the model to overshoot.
const ENTER_WINNER_STRENGTH_THRESHOLD = 6;

// P6: Red-flag classification.
// Fatal flags always stop the cascade. Warning flags allow a score-7 cell
// to pass IF the candle is strongly in-bias (see isCandleStrongInBias).
// Unknown flags are treated as fatal (conservative default — surfaces a
// new flag that hasn't been classified yet).
const FATAL_RED_FLAGS = new Set(["exhaustion", "direction_conflict"]);
const WARNING_RED_FLAGS = new Set(["choppy_structure", "tangled_emas"]);

export function classifyRedFlags(flags) {
  const out = { fatal: [], warning: [], unknown: [] };
  if (!Array.isArray(flags)) return out;
  for (const f of flags) {
    if (FATAL_RED_FLAGS.has(f)) out.fatal.push(f);
    else if (WARNING_RED_FLAGS.has(f)) out.warning.push(f);
    else out.unknown.push(f);
  }
  return out;
}

// P6: Compensation rule for warning-class red flags. A weekly cell with only
// warning flags can pass score 7 IF its current closed bar is decisively in
// bias — body ≥ 60%, close at extreme/upper-third (long) or extreme/lower-third
// (short), and color matches direction.
export function isCandleStrongInBias(weeklyCell) {
  const v = weeklyCell?.candle_verdict;
  const m = weeklyCell?.measurements?.current_closed_bar;
  const dir = weeklyCell?.direction;
  if (!v || !m || !dir) return false;
  if (v.in_bias !== true) return false;
  if ((m.body_pct_of_range ?? 0) < 60) return false;

  if (dir === "long") {
    return (
      m.color === "green" &&
      (m.close_position === "at_high" || m.close_position === "upper_third")
    );
  }
  if (dir === "short") {
    return (
      m.color === "red" &&
      (m.close_position === "at_low" || m.close_position === "lower_third")
    );
  }
  return false;
}

// P6: Decides whether a weekly cell should stop the cascade. Returns null
// when the cascade should continue, or { stop_reason, flags } when it stops.
// Pure function — no side effects, just reads the cell.
export function weeklyStopDecision(weekly) {
  if (!weekly) return null;

  const { fatal, warning, unknown } = classifyRedFlags(weekly.red_flags || []);
  const blocking = [...fatal, ...unknown];

  if (blocking.length > 0) {
    return { stop_reason: "weekly_red_flag_fatal", flags: blocking };
  }

  const score = weekly.score ?? 0;

  if (warning.length > 0) {
    if (!isCandleStrongInBias(weekly)) {
      return { stop_reason: "weekly_red_flag_warning_no_compensation", flags: warning };
    }
    // warning + strong candle: warnings tolerated, fall through to score check.
  }

  if (score < 7) {
    return { stop_reason: "weekly_quality_low", flags: [] };
  }

  return null;
}

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
//           (candle_verdict.in_bias === false OR winner_strength < ENTER_WINNER_STRENGTH_THRESHOLD)
//   ENTER — prep ready AND candle_verdict.in_bias === true
//           AND winner_strength >= ENTER_WINNER_STRENGTH_THRESHOLD (decisive close in bias direction)
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
  if ((v.winner_strength ?? 0) < ENTER_WINNER_STRENGTH_THRESHOLD) return "WATCH";
  return "ENTER";
}

// Classifies the ENTER reason. Priority: sweep (highest conviction) > pattern
// > momentum. Returns "none" when state !== "ENTER" or bias is invalid.
export function dailyTriggerType(cell, weeklyBias) {
  if (!cell || dailyCellState(cell) !== "ENTER") return "none";
  if (weeklyBias !== "long" && weeklyBias !== "short") return "none";
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
  let { path: imagePath, capturedAt } = await captureSymbolTf(
    client,
    slug,
    tf,
    item.tv_symbol,
  );

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
      // / TV had focus issues on the first capture. Reassign capturedAt so the
      // prompt + persisted cell reflect the actual timestamp the LLM saw.
      ({ path: imagePath, capturedAt } = await captureSymbolTf(
        client,
        slug,
        tf,
        item.tv_symbol,
      ));
      modelToUse = fallbackModel;
      usedFallback = true;
    }
    const prompt = fillRubric(rubric, {
      SYMBOL: item.label,
      TIMEFRAME: tf,
      CAPTURED_AT: formatCapturedAtForPrompt(capturedAt),
    });
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
    captured_at: capturedAt.toISOString(),
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
  const { path: imagePath, capturedAt } = await captureSymbolTf(
    client,
    slug,
    tf,
    item.tv_symbol,
  );

  const prompt = fillRubric(rubric, {
    SYMBOL: item.label,
    TIMEFRAME: tf,
    HTF_BIAS: htfBias,
    CAPTURED_AT: formatCapturedAtForPrompt(capturedAt),
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
    captured_at: capturedAt.toISOString(),
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

// ═══════════════════════════════════════════════════════════════════════
//  V2 pipeline — monthly direction filter → weekly quality gate → daily
//  reactive trigger. Each cell gets richer context from the prior TF.
// ═══════════════════════════════════════════════════════════════════════

// ─── Cell consistency gates ─────────────────────────────────────────────
//
// Internal-consistency check: given a red_flag and the cell's own reported
// `measurements`, does the model's claim hold up against its own numbers?
//
// Returns true when the gate is satisfied (claim is internally consistent)
// or when we don't have a rule for the flag (passthrough). Returns false
// only when the model's own measurements directly contradict the flag.
//
// This is a soft-validation layer — no external data, no extra LLM calls.
// It exists to catch the AUDUSD-style failure where the model fires
// `exhaustion` despite a tiny upper wick.
export function gateSatisfied(flag, measurements, direction) {
  if (!measurements) return true; // older cells without Pass-1 measurements
  const c = measurements.current_closed_bar;
  if (!c) return true;

  switch (flag) {
    case "exhaustion": {
      const isLong = direction === "long";
      const isShort = direction === "short";
      if (!isLong && !isShort) return true; // no bias = nothing to contradict
      const wickOk = isLong
        ? (c.upper_wick_pct ?? 0) >= 30
        : (c.lower_wick_pct ?? 0) >= 30;
      const sweepOk = isLong
        ? c.high_vs_prior_bar_high === "above"
        : c.low_vs_prior_bar_low === "below";
      const colorOk = isLong ? c.color === "red" : c.color === "green";
      return wickOk && sweepOk && colorOk;
    }
    case "choppy_structure": {
      const r = measurements.recent_5_bars;
      const e = measurements.ema_state;
      if (!r || !e) return true;  // missing data → keep flag (legacy passthrough)
      return (
        (r.overlap_pct ?? 0) >= 75 &&
        r.direction === "mixed" &&
        (e.slope_steepness === "flat" || e.slope_steepness === "shallow")
      );
    }
    case "tangled_emas": {
      const e = measurements.ema_state;
      if (!e) return true;
      return (
        e.ema9_ema15_distance === "tight" &&
        (e.slope_steepness === "flat" || e.slope_steepness === "shallow")
      );
    }
    default:
      return true; // unknown flag — preserve, don't silently drop
  }
}

// Validates a `liquidity_swept` claim from candle_verdict against the cell's
// `measurements.current_closed_bar`. Returns false only if the model's claim
// directly contradicts its own reported relationship to the prior bar.
export function sweepGateSatisfied(claim, measurements) {
  if (!claim || claim === "none") return true;
  const c = measurements?.current_closed_bar;
  if (!c) return true;

  if (claim === "above_prior_high") {
    const lowerCloses = ["lower_third", "at_low"];
    return (
      c.high_vs_prior_bar_high === "above" &&
      lowerCloses.includes(c.close_position) &&
      c.color === "red"
    );
  }
  if (claim === "below_prior_low") {
    const upperCloses = ["upper_third", "at_high"];
    return (
      c.low_vs_prior_bar_low === "below" &&
      upperCloses.includes(c.close_position) &&
      c.color === "green"
    );
  }
  return true;
}

// Per-cell validator. Drops self-contradicting red_flags, resets unsupported
// liquidity_swept claims to "none", and forces in_bias=false when the body is
// too small to call. Mutates and returns the cell. Each rejection appends a
// human-readable line to `cell.consistency_log` for later inspection.
//
// Cells with no `measurements` (legacy shape) or `parse_failed=true` pass
// through unchanged — we only validate cells that have committed to numbers.
export function validateCellConsistency(cell) {
  if (!cell || cell.parse_failed) return cell;
  if (!cell.measurements) return cell;

  const log = [];

  // 1. Drop self-contradicting red flags
  if (Array.isArray(cell.red_flags) && cell.red_flags.length > 0) {
    const direction = cell.direction;
    const kept = [];
    for (const flag of cell.red_flags) {
      if (gateSatisfied(flag, cell.measurements, direction)) {
        kept.push(flag);
      } else {
        log.push(`rejected red_flag '${flag}' — gate violated`);
      }
    }
    cell.red_flags = kept;
  }

  // 2. Validate liquidity_swept on candle_verdict
  const swept = cell.candle_verdict?.liquidity_swept;
  if (swept && swept !== "none") {
    if (!sweepGateSatisfied(swept, cell.measurements)) {
      log.push(`rejected liquidity_swept '${swept}' — gate violated`);
      cell.candle_verdict.liquidity_swept = "none";
    }
  }

  // 3. in_bias requires body_pct_of_range >= 40
  if (cell.candle_verdict?.in_bias === true) {
    const body = cell.measurements.current_closed_bar?.body_pct_of_range;
    if (typeof body === "number" && body < 40) {
      log.push(`rejected in_bias=true — body_pct ${body} < 40`);
      cell.candle_verdict.in_bias = false;
    }
  }

  if (log.length > 0) {
    cell.consistency_log = (cell.consistency_log || []).concat(log);
  }
  return cell;
}

// ─── Prior-run context formatters ──────────────────────────────────────
//
// formatPriorContext{Monthly,Weekly,Daily}() turn the structured object from
// `derivePriorContext()` into a single markdown block injected into the
// corresponding prompt as `{PRIOR_CONTEXT}`. The block surfaces the last 2
// runs side-by-side so the LLM can compare its own prior verdicts against
// the chart it's about to grade — confirm continuity, flag a flip, or detect
// a failed trigger.

const COLD_MONTHLY = "_No prior monthly evaluation on file — this is a cold scan._";
const COLD_WEEKLY = "_No prior weekly evaluation on file — this is a cold scan._";
const COLD_DAILY = "_No prior daily evaluation on file — this is a cold scan._";

function fmtCapturedAt(ts) {
  if (!ts) return "unknown";
  return ts.slice(0, 19).replace("T", " ") + " UTC";
}

function fmtCandleVerdict(v) {
  if (!v) return "no candle verdict on file";
  const parts = [];
  if (v.pattern && v.pattern !== "none") parts.push(`pattern=${v.pattern}`);
  if (v.winner) parts.push(`winner=${v.winner}`);
  if (typeof v.winner_strength === "number") parts.push(`strength=${v.winner_strength}`);
  if (v.liquidity_swept && v.liquidity_swept !== "none")
    parts.push(`swept=${v.liquidity_swept}`);
  const verdict = v.verdict ? ` — "${v.verdict}"` : "";
  return parts.join(", ") + verdict;
}

// Monthly prior context block — only shows the monthly slice of each prior run.
export function formatPriorContextMonthly(priorContext) {
  const runs = priorContext?.runs ?? [];
  if (runs.length === 0) return COLD_MONTHLY;
  const lines = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const label = i === 0 ? "T-1 (most recent prior run)" : `T-${i + 1}`;
    const stamp = fmtCapturedAt(r.monthly?.captured_at || r.started_at);
    if (!r.monthly) {
      lines.push(
        `**${label}** — ${stamp}: monthly cell unavailable (stop=${r.stop_reason ?? "?"}).`,
      );
      continue;
    }
    const m = r.monthly;
    lines.push(
      `**${label}** — ${stamp}\n` +
        `  - direction: **${m.direction}**, in_9_15_zone: ${m.in_9_15_zone}\n` +
        `  - candle: ${fmtCandleVerdict(m.candle_verdict)}`,
    );
  }
  return lines.join("\n\n");
}

// Weekly prior context block — full slice (monthly + weekly) of each prior run
// so the model can see whether the bias was already aligned across TFs.
export function formatPriorContextWeekly(priorContext) {
  const runs = priorContext?.runs ?? [];
  if (runs.length === 0) return COLD_WEEKLY;
  const lines = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const label = i === 0 ? "T-1 (most recent prior run)" : `T-${i + 1}`;
    const stamp = fmtCapturedAt(r.weekly?.captured_at || r.started_at);
    const monthlyDir = r.monthly?.direction ?? "—";
    if (!r.weekly) {
      lines.push(
        `**${label}** — ${stamp}: weekly cell unavailable (monthly=${monthlyDir}, stop=${r.stop_reason ?? "?"}).`,
      );
      continue;
    }
    const w = r.weekly;
    lines.push(
      `**${label}** — ${stamp}\n` +
        `  - monthly→weekly: ${monthlyDir} → **${w.direction}** ` +
        `(score ${w.score}/10, setup=${w.setup_type}` +
        (w.direction_conflict ? `, direction_conflict` : "") + `)\n` +
        `  - candle: ${fmtCandleVerdict(w.candle_verdict)}`,
    );
  }
  return lines.join("\n\n");
}

// Daily prior context block — surfaces the full chain (monthly→weekly→daily)
// for each prior run so the model can answer "did yesterday's trigger
// confirm or fade today?"
export function formatPriorContextDaily(priorContext) {
  const runs = priorContext?.runs ?? [];
  if (runs.length === 0) return COLD_DAILY;
  const lines = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const label = i === 0 ? "T-1 (most recent prior run)" : `T-${i + 1}`;
    const stamp = fmtCapturedAt(r.daily?.captured_at || r.started_at);
    const monthlyDir = r.monthly?.direction ?? "—";
    const weeklyDir = r.weekly?.direction ?? "—";
    if (!r.daily) {
      lines.push(
        `**${label}** — ${stamp}: daily cell unavailable (chain ${monthlyDir} → ${weeklyDir} → stopped: ${r.stop_reason ?? "?"}).`,
      );
      continue;
    }
    const d = r.daily;
    lines.push(
      `**${label}** — ${stamp}\n` +
        `  - chain: ${monthlyDir} → ${weeklyDir} → **state=${d.state}** ` +
        `(trigger=${d.trigger_type}, prep ${d.prep_signals_count}/4, grade=${r.confluence_grade})\n` +
        `  - candle: ${fmtCandleVerdict(d.candle_verdict)}`,
    );
  }
  return lines.join("\n\n");
}

// Monthly cell parse check — requires direction + candle_verdict.
function isMonthlyParseFailure(result) {
  return (
    !result ||
    typeof result.direction !== "string" ||
    result.direction.length === 0 ||
    !result.candle_verdict
  );
}

// Monthly direction-filter cell. Uses monthly-direction.md prompt.
// Cheap — small prompt, just asks direction + 9-15 zone + candle verdict.
async function evaluateMonthlyCell(client, item, rubric, dateDir = null, priorBlock = COLD_MONTHLY) {
  const slug = slugify(item.label);
  await setTimeframe(client, "1M");
  await dismissPopups(client);
  let { path: imagePath, capturedAt } = await captureSymbolTf(
    client,
    slug,
    "1M",
    item.tv_symbol,
    dateDir,
  );

  const primaryModel =
    process.env.MONTHLY_MODEL ||
    process.env.VISUAL_MODEL ||
    "gemini-3.1-pro-preview";
  const fallbackModel = pickFallbackModel(primaryModel);

  const maxAttempts = 2;
  let result, model;
  let totalCost = 0;
  let attempts = 0;
  let parseFailed = false;
  let usedFallback = false;
  const rawTrace = [];

  while (attempts < maxAttempts) {
    attempts++;
    const isRetry = attempts > 1;
    let modelToUse = primaryModel;
    if (isRetry) {
      ({ path: imagePath, capturedAt } = await captureSymbolTf(
        client,
        slug,
        "1M",
        item.tv_symbol,
        dateDir,
      ));
      modelToUse = fallbackModel;
      usedFallback = true;
    }
    const prompt = fillRubric(rubric, {
      SYMBOL: item.label,
      CAPTURED_AT: formatCapturedAtForPrompt(capturedAt),
      PRIOR_CONTEXT: priorBlock,
    });
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
    if (!isMonthlyParseFailure(result)) {
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
      tf: "1M",
      attempts,
      image: imagePath,
      attempts_detail: rawTrace,
    });
  }

  const cell = {
    tf: "1M",
    direction: result?.direction,
    in_9_15_zone: !!result?.in_9_15_zone,
    candle_verdict: result?.candle_verdict ?? null,
    measurements: result?.measurements ?? null,
    reasoning: result?.reasoning ?? "",
    image: imagePath,
    captured_at: capturedAt.toISOString(),
    cost_usd: totalCost,
    model,
    parse_failed: parseFailed,
    attempts,
    used_fallback: usedFallback && !parseFailed,
  };
  return validateCellConsistency(cell);
}

// Weekly cell parse check.
function isWeeklyParseFailure(result) {
  return (
    !result ||
    typeof result.direction !== "string" ||
    result.direction.length === 0 ||
    !result.candle_verdict
  );
}

// Weekly structural-gate cell. Receives monthly bias as context.
async function evaluateWeeklyCell(client, item, monthlyCell, rubric, dateDir = null, priorBlock = COLD_WEEKLY) {
  const slug = slugify(item.label);
  await setTimeframe(client, "1W");
  await dismissPopups(client);
  let { path: imagePath, capturedAt } = await captureSymbolTf(
    client,
    slug,
    "1W",
    item.tv_symbol,
    dateDir,
  );

  const monthlyBias = monthlyCell.direction || "none";
  const in9_15Note = monthlyCell.in_9_15_zone
    ? "Monthly price is currently in the 9-15 zone — this is an A+ setup context."
    : "";

  const primaryModel =
    process.env.WEEKLY_MODEL ||
    process.env.VISUAL_MODEL ||
    "gemini-3.1-pro-preview";
  const fallbackModel = pickFallbackModel(primaryModel);

  const maxAttempts = 2;
  let result, model;
  let totalCost = 0;
  let attempts = 0;
  let parseFailed = false;
  let usedFallback = false;
  const rawTrace = [];

  while (attempts < maxAttempts) {
    attempts++;
    const isRetry = attempts > 1;
    let modelToUse = primaryModel;
    if (isRetry) {
      ({ path: imagePath, capturedAt } = await captureSymbolTf(
        client,
        slug,
        "1W",
        item.tv_symbol,
        dateDir,
      ));
      modelToUse = fallbackModel;
      usedFallback = true;
    }
    const prompt = fillRubric(rubric, {
      SYMBOL: item.label,
      MONTHLY_BIAS: monthlyBias,
      MONTHLY_IN_9_15_ZONE_NOTE: in9_15Note,
      CAPTURED_AT: formatCapturedAtForPrompt(capturedAt),
      PRIOR_CONTEXT: priorBlock,
    });
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
    if (!isWeeklyParseFailure(result)) {
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
      tf: "1W",
      attempts,
      image: imagePath,
      attempts_detail: rawTrace,
    });
  }

  const cell = {
    tf: "1W",
    direction: result?.direction,
    direction_conflict: !!result?.direction_conflict,
    setup_type: result?.setup_type ?? "none",
    angle_ok: !!result?.angle_ok,
    pullback_present: !!result?.pullback_present,
    ema_stack_ok: !!result?.ema_stack_ok,
    solid_continuation: !!result?.solid_continuation,
    probability_next_candle_in_bias: result?.probability_next_candle_in_bias ?? 0,
    red_flags: result?.red_flags ?? [],
    score: result?.score ?? 0,
    candle_verdict: result?.candle_verdict ?? null,
    measurements: result?.measurements ?? null,
    reasoning: result?.reasoning ?? "",
    image: imagePath,
    captured_at: capturedAt.toISOString(),
    cost_usd: totalCost,
    model,
    parse_failed: parseFailed,
    attempts,
    used_fallback: usedFallback && !parseFailed,
  };
  return validateCellConsistency(cell);
}

// Daily cell parse check — requires candle_verdict + state field.
function isDailyParseFailure(result) {
  return !result || !result.candle_verdict || typeof result.state !== "string";
}

// Daily reactive-trigger cell. Receives monthly + weekly context.
async function evaluateDailyCell(client, item, monthlyCell, weeklyCell, rubric, dateDir = null, priorBlock = COLD_DAILY) {
  const slug = slugify(item.label);
  await setTimeframe(client, "1D");
  await dismissPopups(client);
  let { path: imagePath, capturedAt } = await captureSymbolTf(
    client,
    slug,
    "1D",
    item.tv_symbol,
    dateDir,
  );

  const primaryModel =
    process.env.DAILY_MODEL ||
    process.env.VISUAL_MODEL ||
    "gemini-3.1-pro-preview";
  const fallbackModel = pickFallbackModel(primaryModel);

  const maxAttempts = 2;
  let result, model;
  let totalCost = 0;
  let attempts = 0;
  let parseFailed = false;
  let usedFallback = false;
  const rawTrace = [];

  while (attempts < maxAttempts) {
    attempts++;
    const isRetry = attempts > 1;
    let modelToUse = primaryModel;
    if (isRetry) {
      ({ path: imagePath, capturedAt } = await captureSymbolTf(
        client,
        slug,
        "1D",
        item.tv_symbol,
        dateDir,
      ));
      modelToUse = fallbackModel;
      usedFallback = true;
    }
    const prompt = fillRubric(rubric, {
      SYMBOL: item.label,
      MONTHLY_BIAS: monthlyCell.direction || "none",
      WEEKLY_BIAS: weeklyCell.direction || "none",
      WEEKLY_SCORE: String(weeklyCell.score ?? 0),
      WEEKLY_PULLBACK_PRESENT: String(!!weeklyCell.pullback_present),
      CAPTURED_AT: formatCapturedAtForPrompt(capturedAt),
      PRIOR_CONTEXT: priorBlock,
    });
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
    if (!isDailyParseFailure(result)) {
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
      tf: "1D",
      attempts,
      image: imagePath,
      attempts_detail: rawTrace,
    });
  }

  let cell = {
    tf: "1D",
    direction_conflict: !!result?.direction_conflict,
    setup_type: result?.setup_type ?? "none",
    angle_ok: !!result?.angle_ok,
    zone_rejection: !!result?.zone_rejection,
    coc_present: !!result?.coc_present,
    solid_continuation: !!result?.solid_continuation,
    prep_signals_count: result?.prep_signals_count ?? 0,
    probability_next_candle_in_bias: result?.probability_next_candle_in_bias ?? 0,
    red_flags: result?.red_flags ?? [],
    candle_verdict: result?.candle_verdict ?? null,
    measurements: result?.measurements ?? null,
    reasoning: result?.reasoning ?? "",
    image: imagePath,
    captured_at: capturedAt.toISOString(),
    cost_usd: totalCost,
    model,
    parse_failed: parseFailed,
    attempts,
    used_fallback: usedFallback && !parseFailed,
  };
  // Run consistency check BEFORE state derivation so dropped flags change
  // the NONE/WATCH/ENTER outcome.
  cell = validateCellConsistency(cell);
  // Authoritative state computation — the scanner's code is the source of
  // truth for NONE/WATCH/ENTER, not the prompt's self-reported field.
  cell.state = dailyCellState(cell);
  cell.trigger_type = dailyTriggerType(cell, weeklyCell.direction);
  return cell;
}

function loadRubrics(opts = {}) {
  const htfPath = opts.htfRubricPath || "prompts/htf-bias.md";
  const ltfPath = opts.ltfRubricPath || "prompts/ltf-entry.md";
  return {
    htfRubric: readFileSync(htfPath, "utf8"),
    ltfRubric: readFileSync(ltfPath, "utf8"),
  };
}

function loadV2Rubrics(opts = {}) {
  return {
    monthlyRubric: readFileSync(
      opts.monthlyRubricPath || "prompts/monthly-direction.md",
      "utf8",
    ),
    weeklyRubric: readFileSync(
      opts.weeklyRubricPath || "prompts/weekly-structure.md",
      "utf8",
    ),
    dailyRubric: readFileSync(
      opts.dailyRubricPath || "prompts/daily-trigger.md",
      "utf8",
    ),
  };
}

// Derives confluence grade by stacking verdicts across 3 TFs.
//   A+  — all 3 bias-aligned, monthly in 9-15 zone, weekly score >= 8,
//         daily state = ENTER with sweep/pattern trigger
//   A   — all 3 bias-aligned, weekly score >= 8, daily state = ENTER
//   B   — all 3 bias-aligned, daily state = ENTER
//   C   — monthly + weekly aligned, daily state = WATCH
//   —   — anything else
export function deriveConfluence(monthly, weekly, daily) {
  if (!monthly || !weekly || !daily) return "—";
  if (monthly.direction === "none" || weekly.direction === "none") return "—";
  if (weekly.direction !== monthly.direction) return "—";
  if (daily.direction_conflict) return "—";

  if (daily.state === "ENTER") {
    const sweepOrPattern =
      daily.trigger_type === "sweep" || daily.trigger_type === "pattern";
    if (monthly.in_9_15_zone && (weekly.score ?? 0) >= 8 && sweepOrPattern)
      return "A+";
    if ((weekly.score ?? 0) >= 8) return "A";
    return "B";
  }
  if (daily.state === "WATCH") return "C";
  return "—";
}

// V2 pipeline — monthly direction filter → weekly quality gate → daily
// reactive trigger. Bias cascades downstream. Stops early with distinct
// stop_reason on any failure.
//
// opts.dateDir — optional "YYYY-MM-DD" string. When set, screenshots are
// written under `screenshots/{dateDir}/{symbol}/{tf}.png` instead of
// overwriting the legacy path. Used by the daily cron to preserve history.
export async function evaluateSymbolV2(client, item, rubrics, opts = {}) {
  const verbose = opts.verbose !== false;
  const dateDir = opts.dateDir ?? null;
  const log = (msg) => {
    if (verbose) console.log(msg);
  };

  // Derive per-TF prior-context markdown blocks from the optional priorRuns
  // history slice for THIS symbol. Cold scan → cold sentinels.
  const priorContext = derivePriorContext(opts.priorRuns ?? []);
  const priorMonthlyBlock = formatPriorContextMonthly(priorContext);
  const priorWeeklyBlock = formatPriorContextWeekly(priorContext);
  const priorDailyBlock = formatPriorContextDaily(priorContext);

  const result = {
    symbol: item.label,
    tv_symbol: item.tv_symbol,
    started_at: new Date().toISOString(),
    stopped_at: null,
    stop_reason: null,
    monthly: null,
    weekly: null,
    daily: null,
    confluence_grade: "—",
    prior_runs_count: priorContext.priorRunsCount,
    cost_usd: 0,
    pipeline: "v2-mtf-candle-verdict",
  };

  await setSymbol(client, item.tv_symbol);
  await dismissPopups(client);

  // ─── Step 1: Monthly ───────────────────────────────────────────────────
  log("    Monthly ...");
  result.monthly = await evaluateMonthlyCell(
    client,
    item,
    rubrics.monthlyRubric,
    dateDir,
    priorMonthlyBlock,
  );
  result.cost_usd += result.monthly.cost_usd;

  if (result.monthly.parse_failed) {
    result.stopped_at = "1M";
    result.stop_reason = "llm_parse_error";
    log(`      ⚠️  parse_failed (tried ${result.monthly.attempts}x)`);
    return result;
  }
  log(
    `      dir=${result.monthly.direction} in_9_15=${result.monthly.in_9_15_zone}`,
  );

  if (result.monthly.direction === "none") {
    result.stopped_at = "1M";
    result.stop_reason = "monthly_no_trend";
    log(`    🚫 STOP @ 1M: monthly_no_trend`);
    return result;
  }

  // ─── Step 2: Weekly (conditioned on monthly bias) ──────────────────────
  log("    Weekly ...");
  result.weekly = await evaluateWeeklyCell(
    client,
    item,
    result.monthly,
    rubrics.weeklyRubric,
    dateDir,
    priorWeeklyBlock,
  );
  result.cost_usd += result.weekly.cost_usd;

  if (result.weekly.parse_failed) {
    result.stopped_at = "1W";
    result.stop_reason = "llm_parse_error";
    log(`      ⚠️  parse_failed (tried ${result.weekly.attempts}x)`);
    return result;
  }

  if (result.weekly.direction_conflict) {
    result.stopped_at = "1W";
    result.stop_reason = "monthly_weekly_disagree";
    log(
      `    🚫 STOP @ 1W: monthly_weekly_disagree (weekly saw opposite of ${result.monthly.direction})`,
    );
    return result;
  }

  if (result.weekly.direction === "none") {
    result.stopped_at = "1W";
    result.stop_reason = "weekly_no_setup";
    log(`    🚫 STOP @ 1W: weekly_no_setup (ambiguous structure)`);
    return result;
  }

  // P6: fatal/warning split + isCandleStrongInBias compensation.
  const stopDecision = weeklyStopDecision(result.weekly);
  if (stopDecision) {
    result.stopped_at = "1W";
    result.stop_reason = stopDecision.stop_reason;
    if (stopDecision.flags.length > 0) {
      log(`    🚫 STOP @ 1W: ${stopDecision.stop_reason} (${stopDecision.flags.join(", ")})`);
    } else {
      log(`    🚫 STOP @ 1W: ${stopDecision.stop_reason} (score ${result.weekly.score})`);
    }
    return result;
  }

  log(
    `      dir=${result.weekly.direction} score=${result.weekly.score} setup=${result.weekly.setup_type}`,
  );

  // ─── Step 3: Daily (conditioned on monthly + weekly) ───────────────────
  log("    Daily ...");
  result.daily = await evaluateDailyCell(
    client,
    item,
    result.monthly,
    result.weekly,
    rubrics.dailyRubric,
    dateDir,
    priorDailyBlock,
  );
  result.cost_usd += result.daily.cost_usd;

  if (result.daily.parse_failed) {
    result.stopped_at = "1D";
    result.stop_reason = "llm_parse_error";
    log(`      ⚠️  parse_failed (tried ${result.daily.attempts}x)`);
    return result;
  }

  if (result.daily.direction_conflict) {
    result.stopped_at = "1D";
    result.stop_reason = "weekly_daily_disagree";
    log(
      `    🚫 STOP @ 1D: weekly_daily_disagree (daily broke against ${result.weekly.direction})`,
    );
    return result;
  }

  log(
    `      state=${result.daily.state} prep=${result.daily.prep_signals_count}/4 ` +
      `trigger=${result.daily.trigger_type}`,
  );

  result.confluence_grade = deriveConfluence(
    result.monthly,
    result.weekly,
    result.daily,
  );

  // All 3 TFs ran cleanly but the daily has no active setup — mark it as a
  // proper stop so the report card reads honestly ("STOP @ 1D: daily_no_trigger")
  // instead of pretending it was a complete scan with no signal.
  if (result.daily.state === "NONE") {
    result.stopped_at = "1D";
    result.stop_reason = "daily_no_trigger";
  }
  return result;
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

function v2SummaryLine(r) {
  if (r.stop_reason) {
    return `  ${r.symbol.padEnd(12)} STOP @ ${r.stopped_at ?? "—"} (${r.stop_reason})`;
  }
  const bias = r.weekly?.direction ?? r.monthly?.direction ?? "?";
  const dirTag =
    bias === "long" ? "📈 LONG" : bias === "short" ? "📉 SHORT" : "— UNKNOWN";
  const state = r.daily?.state ?? "?";
  const trig = r.daily?.trigger_type ?? "—";
  const zone = r.monthly?.in_9_15_zone ? "  [9-15 zone]" : "";
  return `  ${r.symbol.padEnd(12)} ${dirTag}  ${state}  trigger=${trig}  grade=${r.confluence_grade}${zone}`;
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

// V2 scan: monthly-weekly-daily with candle_verdict + bias cascade.
// Routed via `--htf-only` in bot.js.
//
// Screenshots are written under `screenshots/{YYYY-MM-DD}/...` by default so
// daily cron runs don't overwrite each other. Pass `options.dateDir = null`
// to restore the legacy flat-folder layout.
export async function runScanV2(options = {}) {
  const watchlist = loadWatchlist(options.watchlistPath || "watchlist.json");
  const rubrics = loadV2Rubrics(options);

  const startedAt = new Date().toISOString();
  const dateDir =
    options.dateDir === null ? null : (options.dateDir ?? startedAt.slice(0, 10));

  // Load the last 2 prior runs per symbol so the LLM can see "what we said
  // last time" and judge continuity vs flips. Cold-scan if no priors exist.
  const priorBySymbol = options.priorBySymbol ?? loadPriorRunsForWatchlist({
    beforeIso: startedAt,
    maxPriorRuns: options.maxPriorRuns ?? 2,
  });
  const totalPriors = Array.from(priorBySymbol.values()).reduce(
    (n, list) => n + list.length,
    0,
  );

  console.log(
    `\n═══════════════════════════════════════════════════════════\n` +
      `  Scan started: ${startedAt}   (pipeline: v2 mtf-candle-verdict)\n` +
      `  Watchlist: ${watchlist.length} symbols\n` +
      `  Prior runs loaded: ${totalPriors} entries across ${priorBySymbol.size} symbols\n` +
      `  Flow per symbol: Monthly (direction) → Weekly (quality) → Daily (trigger)\n` +
      `═══════════════════════════════════════════════════════════\n`,
  );

  const results = [];
  let client;
  try {
    client = await openTvClient();
    for (const [i, item] of watchlist.entries()) {
      console.log(
        `\n[${i + 1}/${watchlist.length}] ▶ ${item.label} (${item.tv_symbol})`,
      );
      try {
        const r = await evaluateSymbolV2(client, item, rubrics, {
          verbose: true,
          dateDir,
          priorRuns: priorBySymbol.get(item.label) ?? [],
        });
        results.push(r);
      } catch (err) {
        console.log(`    ❌ ${err.message}`);
        results.push({
          symbol: item.label,
          tv_symbol: item.tv_symbol,
          stopped_at: null,
          stop_reason: `error: ${err.message}`,
          monthly: null,
          weekly: null,
          daily: null,
          confluence_grade: "—",
          cost_usd: 0,
          pipeline: "v2-mtf-candle-verdict",
        });
      }
    }
  } finally {
    await closeTvClient(client);
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Report Card");
  console.log("═══════════════════════════════════════════════════════════");
  for (const r of results) console.log(v2SummaryLine(r));

  // Aggregate ENTER+WATCH candidates ranked by confluence grade
  const gradeOrder = { "A+": 0, A: 1, B: 2, C: 3, "—": 4 };
  const candidates = results
    .filter((r) => r.confluence_grade !== "—")
    .sort(
      (a, b) => gradeOrder[a.confluence_grade] - gradeOrder[b.confluence_grade],
    );

  if (candidates.length === 0) {
    console.log("\n  No candidates this scan.");
  } else {
    console.log("\n  Candidates (ranked by confluence grade):");
    for (const r of candidates) console.log(`    ${v2SummaryLine(r).trim()}`);
  }

  const totalCost = results.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
  console.log(`\n  Total LLM cost: $${totalCost.toFixed(4)}`);

  const payload = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    pipeline: "v2-mtf-candle-verdict",
    results,
  };
  const path = saveResult("scan-v2", "watchlist", payload);
  console.log(`\nFull results saved → ${path}`);
  return payload;
}
