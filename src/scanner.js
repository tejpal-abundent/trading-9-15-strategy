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
  readRenderedSymbol,
  verifyRenderedMatchesExpected,
  ChartSymbolSwitchFailedError,
} from "./tv-navigate.js";
import { askGeminiVision, getTodaysCost, recordCost, fillRubric } from "./visual.js";
import { fetchCandles, emaAlignment, agree } from "./higher-tf.js";
import { loadPriorRunsForWatchlist, derivePriorContext } from "./history.js";
import { clusterDedupe } from "./clusters.js";

const HTF_TIMEFRAMES = ["1M", "1W", "1D"];
const LTF_TIMEFRAMES = ["4H", "2H", "1H"];
const RESULT_DIR = "scan-results";

// V2.1 (high win-rate upgrade) — minimum reward:risk for daily ENTER. Daily
// cells whose `trade_plan.rr_ratio` is below this floor are downgraded to
// WATCH even if every other gate passes. Win rate is meaningless without R:R:
// 60% at 1:1 loses to 40% at 1:3.
const MIN_ENTER_RR = 2.0;
// Stricter floors at the grade boundaries (used by deriveConfluence). Earned
// by raising the bar on what counts as a top-tier setup.
const MIN_RR_FOR_A_PLUS = 3.0;
const MIN_RR_FOR_A = 2.5;

// V2.1 — ATR-normalised body strength. A candle counts as an "expansion" /
// solid bar only when its body is at least this multiple of recent ATR(14).
// `body_pct_of_range ≥ 60` alone allows a tiny inside-bar to pose as a solid
// candle; the ATR clamp filters those out.
const SOLID_BODY_ATR_MIN = 0.6;
const STRONG_WINNER_BODY_ATR_MIN = 0.8;

// P5: ENTER requires a decisive in-bias close. Threshold set at 6 to admit
// "body ≥ 60% closing in upper/lower third" candles (which the daily prompt
// rubric grades 5-7). Was 7 previously, which forced the model to overshoot.
const ENTER_WINNER_STRENGTH_THRESHOLD = 6;

// P3: WATCH override threshold. The trend-dominant prep=1 path admits a daily
// cell with a slightly weaker close (winner_strength ≥ 5) than the standard
// ENTER threshold (6) — the HTF context already provides bias confidence.
const WATCH_DOMINANT_WINNER_STRENGTH_THRESHOLD = 5;

// Weekly quality score floors. STANDARD_WEEKLY_SCORE_FLOOR is the default
// minimum for the cascade to continue past weekly. STRONG_CANDLE_WEEKLY_SCORE_FLOOR
// applies when the most recent closed weekly candle is decisively in-bias
// (body ≥ 60%, color matches direction, close at extreme/upper-third for long
// or extreme/lower-third for short) — the strong close is dominant evidence
// of conviction, and offsets one missing rubric item.
const STANDARD_WEEKLY_SCORE_FLOOR = 7;
const STRONG_CANDLE_WEEKLY_SCORE_FLOOR = 6;

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

// P3: Trend-dominance precondition. When monthly + weekly are unambiguously
// trending in the same direction (wide/normal weekly EMAs, steep/medium slopes
// on both TFs, no weekly flags), the daily can reach WATCH on prep ≥ 1 instead
// of the standard prep ≥ 2 floor. Used by dailyCellState.
export function isTrendDominant(monthly, weekly) {
  if (!monthly || !weekly) return false;
  if (monthly.direction !== weekly.direction) return false;
  if (monthly.direction === "none" || weekly.direction === "none") return false;
  if ((weekly.red_flags || []).length > 0) return false;

  const me = monthly.measurements?.ema_state;
  const we = weekly.measurements?.ema_state;
  if (!me || !we) return false;

  const wideEnough = (d) => d === "wide" || d === "normal";
  const steepEnough = (s) => s === "steep" || s === "medium";

  return (
    wideEnough(we.ema9_ema15_distance) &&
    steepEnough(we.slope_steepness) &&
    steepEnough(me.slope_steepness)
  );
}

// P4: Setup-type-specific prep signal accounting. Returns:
//   count               — number of relevant signals (required + bonus) that are true
//   required_satisfied  — all required signals for the setup_type are true
//   bonus_satisfied     — all bonus signals are true
//   missing_required    — list of required signals that are false (for diagnostics)
//
// For setup_type ∉ {"pullback", "continuation"} the function falls back to
// the legacy prep_signals_count + threshold-of-2 — so cells with no
// classified setup_type behave exactly as today.
export function computeSetupMatchCount(cell) {
  if (!cell || typeof cell !== "object") {
    return { count: 0, required_satisfied: false, bonus_satisfied: false, missing_required: [] };
  }

  const t = cell.setup_type;
  const flag = (name) => cell[name] === true;

  if (t !== "pullback" && t !== "continuation") {
    const legacy = cell.prep_signals_count ?? 0;
    return {
      count: legacy,
      required_satisfied: legacy >= 2,
      bonus_satisfied: false,
      missing_required: [],
    };
  }

  const RULES = {
    pullback:     { required: ["zone_rejection", "angle_ok"],     bonus: ["solid_continuation"] },
    continuation: { required: ["solid_continuation", "angle_ok"], bonus: ["zone_rejection"] },
  };

  const rule = RULES[t];
  const requiredTrue = rule.required.filter(flag);
  const bonusTrue = rule.bonus.filter(flag);
  const missing = rule.required.filter((s) => !flag(s));

  return {
    count: requiredTrue.length + bonusTrue.length,
    required_satisfied: requiredTrue.length === rule.required.length,
    bonus_satisfied: bonusTrue.length === rule.bonus.length,
    missing_required: missing,
  };
}

// P7: Calibration anomaly detector. Run at the end of a scan against the
// final results array. Returns { topReason, topCount, total, dominance } when
// ≥ 90% of stops collapsed to one reason on a watchlist of ≥ 5 with no
// candidates. Returns null otherwise. Pure function.
export function detectCalibrationAnomaly(results) {
  if (!Array.isArray(results) || results.length < 5) return null;
  if (results.some((r) => r.confluence_grade && r.confluence_grade !== "—")) return null;

  const stopCounts = {};
  for (const r of results) {
    if (!r.stop_reason) continue;
    stopCounts[r.stop_reason] = (stopCounts[r.stop_reason] || 0) + 1;
  }
  const total = Object.values(stopCounts).reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  const sorted = Object.entries(stopCounts).sort((a, b) => b[1] - a[1]);
  const [topReason, topCount] = sorted[0];
  const dominance = topCount / total;
  if (dominance < 0.9) return null;
  return { topReason, topCount, total, dominance };
}

// P6/P8': Decides whether a weekly cell should stop the cascade. Returns null
// when the cascade should continue, or { stop_reason, flags } when it stops.
// Pure function — no side effects, just reads the cell.
//
// Decision tree:
//   1. Fatal/unknown flags → stop weekly_red_flag_fatal.
//   2. Warning flags + weak candle → stop weekly_red_flag_warning_no_compensation.
//   3. Score < (6 if strong-candle-in-bias else 7) → stop weekly_quality_low.
//   4. Else → null (pass).
//
// The strong-candle compensation (floor 7 → 6) applies regardless of whether
// warning flags are present — a strongly in-bias close is dominant evidence
// of conviction.
export function weeklyStopDecision(weekly) {
  if (!weekly) return null;

  const { fatal, warning, unknown } = classifyRedFlags(weekly.red_flags || []);
  const blocking = [...fatal, ...unknown];

  if (blocking.length > 0) {
    return { stop_reason: "weekly_red_flag_fatal", flags: blocking };
  }

  if (warning.length > 0 && !isCandleStrongInBias(weekly)) {
    return { stop_reason: "weekly_red_flag_warning_no_compensation", flags: warning };
  }

  const score = weekly.score ?? 0;
  const scoreFloor = isCandleStrongInBias(weekly)
    ? STRONG_CANDLE_WEEKLY_SCORE_FLOOR
    : STANDARD_WEEKLY_SCORE_FLOOR;

  if (score < scoreFloor) {
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
//           AND trade_plan.rr_ratio >= MIN_ENTER_RR (when trade_plan present)
//           AND not a "momentum-only trigger on late/exhausted monthly"
//
// Authoritative in code — if the prompt's self-reported state disagrees, the
// scanner trusts this computation.
export function dailyCellState(cell, monthly = null, weekly = null) {
  if (!cell || typeof cell !== "object") return "NONE";
  if (cell.direction_conflict === true) return "NONE";

  const flags = cell.red_flags || [];
  if (flags.length > 0) return "NONE";

  const matchInfo = computeSetupMatchCount(cell);
  const matchCount = matchInfo.count;
  const requiredSatisfied = matchInfo.required_satisfied;

  const dominant = isTrendDominant(monthly, weekly);
  const watchFloor = dominant ? 1 : 2;

  if (matchCount < watchFloor) return "NONE";

  const v = cell.candle_verdict;
  if (!v || typeof v !== "object") return "NONE";

  // Trend-dominant prep=1 path: WATCH only, requires in_bias + strength ≥ WATCH_DOMINANT_WINNER_STRENGTH_THRESHOLD
  if (dominant && matchCount === 1) {
    if (v.in_bias === true && (v.winner_strength ?? 0) >= WATCH_DOMINANT_WINNER_STRENGTH_THRESHOLD) return "WATCH";
    return "NONE";
  }

  // Standard ENTER path
  if (v.in_bias === true && (v.winner_strength ?? 0) >= ENTER_WINNER_STRENGTH_THRESHOLD) {
    const isTypedSetup = cell.setup_type === "pullback" || cell.setup_type === "continuation";
    if (isTypedSetup && !requiredSatisfied) return "WATCH";

    // V2.1 — RR gate. Below MIN_ENTER_RR the trade is mathematically not worth
    // taking. Downgrade to WATCH so it shows on the report (the human can
    // still decide) but it never auto-routes to a real ENTER signal.
    const tp = cell.trade_plan;
    if (tp && typeof tp.rr_ratio === "number" && tp.rr_ratio < MIN_ENTER_RR) {
      return "WATCH";
    }

    // V2.1 — late/exhausted monthly + momentum-only trigger = trap territory.
    // Sweep / pattern / sweep_displacement are still allowed (those ARE the
    // reversals you want at extension), but pure momentum extension into a
    // mature trend is the highest-loss trade in swing.
    const tt = computeDailyTriggerType(cell, weekly?.direction);
    if (tt === "momentum" && monthly &&
        (monthly.move_maturity === "late" || monthly.move_maturity === "exhausted")) {
      return "WATCH";
    }

    return "ENTER";
  }

  return "WATCH";
}

// Classifies the trigger reason given a candle_verdict + bias. Pure — does NOT
// require state=ENTER (used by dailyCellState itself to make the move-maturity
// decision). Priority order, highest conviction first:
//   sweep_displacement — bar swept liquidity AND the next/same bar fully
//                        displaced back through the level (institutional)
//   sweep              — liquidity grabbed and rejected in bias direction
//   pattern            — named reversal/continuation pattern in bias direction
//   momentum           — solid directional body
//   none               — bias missing or candle_verdict missing
export function computeDailyTriggerType(cell, weeklyBias) {
  if (!cell || !cell.candle_verdict) return "none";
  if (weeklyBias !== "long" && weeklyBias !== "short") return "none";
  const v = cell.candle_verdict;
  const isLong = weeklyBias === "long";

  // V2.1 — sweep + immediate displacement (highest conviction tier).
  if (cell.competition?.sweep_then_displacement === true) return "sweep_displacement";

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

  return "momentum";
}

// State-gated trigger type — same as computeDailyTriggerType but returns "none"
// when the cell is not in ENTER state. This is what callers downstream of
// dailyCellState should use.
export function dailyTriggerType(cell, weeklyBias) {
  if (!cell || dailyCellState(cell) !== "ENTER") return "none";
  return computeDailyTriggerType(cell, weeklyBias);
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

// Belt-to-suspenders check that the chart canvas is actually rendering the
// expected TV symbol after setSymbol() returns. Throws
// ChartSymbolSwitchFailedError if the legend disagrees, after one retry.
// Used by the per-symbol loop callers to surface a clear failure indicator
// in the report card rather than feeding a wrong screenshot to the LLM.
async function assertChartRenderingExpected(client, expectedTvSymbol) {
  const rendered = await readRenderedSymbol(client);
  const v = rendered
    ? verifyRenderedMatchesExpected(rendered, expectedTvSymbol)
    : { ok: false, reason: "no_legend" };
  if (v.ok) return;

  console.log(
    `      [pre-flight: rendered chart does not match expected ${expectedTvSymbol} — ${v.reason}; retrying once]`,
  );
  await setSymbol(client, expectedTvSymbol);
  const rendered2 = await readRenderedSymbol(client);
  const v2 = rendered2
    ? verifyRenderedMatchesExpected(rendered2, expectedTvSymbol)
    : { ok: false, reason: "no_legend" };
  if (v2.ok) return;

  throw new ChartSymbolSwitchFailedError({
    requested: expectedTvSymbol,
    rendered: rendered2
      ? `${rendered2.description || "<none>"} (${rendered2.exchange || "<none>"})`
      : "<no_legend>",
    attempts: 2,
    message: `chart_switch_failed at pre-flight: ${v2.reason}`,
  });
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

  // Pre-flight rendered-symbol check. setSymbol already verifies the chart
  // canvas matches the request, but this is the belt to its suspenders so
  // any drift between symbol-switch and the first TF capture is caught
  // immediately rather than after we've spent LLM tokens on a wrong chart.
  await assertChartRenderingExpected(client, item.tv_symbol);

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

// V2.1 — Validates a per-bar `role` claim in `measurements.last_5_candles[]`
// against that bar's own numeric measurements. Returns true when the role
// is consistent (or no rule for it), false when the bar's numbers directly
// contradict the role. Used by validateCellConsistency to drop unbacked
// sequence-read narratives.
export function roleGateSatisfied(role, bar) {
  if (!role || !bar) return true;
  switch (role) {
    case "sweep": {
      // A "sweep" bar must have wicked beyond the prior bar's high or low.
      const wickedAbove = bar.high_vs_prior_bar_high === "above";
      const wickedBelow = bar.low_vs_prior_bar_low === "below";
      return wickedAbove || wickedBelow;
    }
    case "rejection": {
      // A rejection candle has a dominant wick on at least one side.
      const upper = bar.upper_wick_pct ?? 0;
      const lower = bar.lower_wick_pct ?? 0;
      const body = bar.body_pct_of_range ?? 0;
      return Math.max(upper, lower) >= 40 && body <= 50;
    }
    case "absorption": {
      // Absorption = small body, balanced wicks (a "spinning top"-style bar).
      const body = bar.body_pct_of_range ?? 0;
      const upper = bar.upper_wick_pct ?? 0;
      const lower = bar.lower_wick_pct ?? 0;
      return body <= 40 && upper + lower >= 40;
    }
    case "driver":
    case "continuation": {
      // A driver / continuation bar should be a solid body — body > 50% of
      // range AND, when ATR is reported, body >= 0.6 ATR.
      const body = bar.body_pct_of_range ?? 0;
      if (body < 50) return false;
      const atr = bar.body_atr_mult;
      if (typeof atr === "number" && atr < SOLID_BODY_ATR_MIN) return false;
      return true;
    }
    case "inside": {
      // Inside bar = high below prior high AND low above prior low.
      return (
        bar.high_vs_prior_bar_high === "below" &&
        bar.low_vs_prior_bar_low === "above"
      );
    }
    default:
      // pause, pullback, reversal — softly typed, no measurement gate.
      return true;
  }
}

// V2.1 — Body strength normalised to recent ATR. Returns true when the candle
// either omits body_atr_mult (legacy / not measured) OR reports it at/above
// the threshold. Used to clamp `solid_*` patterns and high `winner_strength`.
export function bodyAtrGateSatisfied(bar, threshold = SOLID_BODY_ATR_MIN) {
  if (!bar) return true;
  const atr = bar.body_atr_mult;
  if (typeof atr !== "number") return true;
  return atr >= threshold;
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
//
// `fallbackDirection` is for daily cells: they don't carry a `direction` field
// of their own (only `direction_conflict`), so they inherit bias from the
// weekly. Callers pass `weekly.direction` so daily red-flag gates can actually
// evaluate against measurements. Without this, every daily flag short-circuits
// to "keep" because `direction` is undefined and `gateSatisfied` returns true
// on its "no bias" branch. Default null preserves the legacy single-arg
// behavior for monthly/weekly callers (they have direction natively).
export function validateCellConsistency(cell, fallbackDirection = null) {
  if (!cell || cell.parse_failed) return cell;
  if (!cell.measurements) return cell;

  const log = [];

  // 1. Drop self-contradicting red flags
  if (Array.isArray(cell.red_flags) && cell.red_flags.length > 0) {
    const direction = cell.direction || fallbackDirection;
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

  // 4. V2.1 — ATR clamp on solid_* patterns + winner_strength. A "solid"
  // candle that's actually sub-ATR is a tight inside bar dressed up; downgrade
  // both the pattern (→ "none") and the winner_strength (→ ≤ 5). This stops
  // dailyCellState from issuing ENTER on a measurement-poor candle.
  const v = cell.candle_verdict;
  const c = cell.measurements.current_closed_bar;
  if (v && c && typeof c.body_atr_mult === "number") {
    const isSolidPattern = v.pattern === "solid_bull" || v.pattern === "solid_bear";
    if (isSolidPattern && c.body_atr_mult < SOLID_BODY_ATR_MIN) {
      log.push(`rejected pattern '${v.pattern}' — body_atr_mult ${c.body_atr_mult} < ${SOLID_BODY_ATR_MIN}`);
      v.pattern = "none";
    }
    if (typeof v.winner_strength === "number" &&
        v.winner_strength >= 8 &&
        c.body_atr_mult < STRONG_WINNER_BODY_ATR_MIN) {
      log.push(`clamped winner_strength ${v.winner_strength} → 5 — body_atr_mult ${c.body_atr_mult} < ${STRONG_WINNER_BODY_ATR_MIN}`);
      v.winner_strength = 5;
    }
  }

  // 5. V2.1 — Per-bar role gate on measurements.last_5_candles[]. Drop any
  // role claim whose own bar measurements directly contradict it (e.g. a
  // "sweep" bar that didn't actually wick beyond the prior high/low). The
  // sequence_read narrative is only as honest as the per-bar roles.
  if (Array.isArray(cell.measurements.last_5_candles)) {
    for (let i = 0; i < cell.measurements.last_5_candles.length; i++) {
      const bar = cell.measurements.last_5_candles[i];
      if (!bar || !bar.role) continue;
      if (!roleGateSatisfied(bar.role, bar)) {
        log.push(`rejected last_5_candles[${i}].role '${bar.role}' — measurements contradict`);
        bar.role = "pause"; // safest neutral fallback
      }
    }
  }

  // 6. V2.1 — competition.sweep_then_displacement requires (a) the prior bar
  // (i.e. measurements.prior_bar) to have wicked beyond ITS prior high/low —
  // we approximate this by requiring last_5_candles[-2].role === "sweep" when
  // the array is present — and (b) the current closed bar to be a strongly
  // in-bias body (body_atr_mult >= 0.6).
  if (cell.competition?.sweep_then_displacement === true) {
    const recent = cell.measurements.last_5_candles;
    const sweepPriorBar =
      Array.isArray(recent) && recent.length >= 2
        ? recent[recent.length - 2]?.role === "sweep"
        : null; // legacy cells without last_5_candles → can't verify, pass through
    const displacementOk = bodyAtrGateSatisfied(c, SOLID_BODY_ATR_MIN);
    if (sweepPriorBar === false || !displacementOk) {
      log.push(
        `rejected competition.sweep_then_displacement — ` +
        `sweep_prior_bar=${sweepPriorBar} displacement_ok=${displacementOk}`,
      );
      cell.competition.sweep_then_displacement = false;
    }
  }

  // 7. V2.1 — trade_plan sanity. If the model returned a non-positive risk_atr
  // OR an rr_ratio that doesn't match (reward_atr / risk_atr) within 10%, the
  // plan is unreliable — strip rr_ratio so deriveConfluence/dailyCellState
  // fall back to the legacy "no RR known" path rather than trust a bad number.
  const tp = cell.trade_plan;
  if (tp && typeof tp.rr_ratio === "number") {
    const risk = tp.risk_atr;
    const reward = tp.reward_atr;
    if (typeof risk === "number" && risk > 0 && typeof reward === "number" && reward >= 0) {
      const computed = reward / risk;
      const drift = Math.abs(computed - tp.rr_ratio) / Math.max(computed, 0.01);
      if (drift > 0.1) {
        log.push(`recomputed trade_plan.rr_ratio ${tp.rr_ratio} → ${computed.toFixed(2)} (drift ${(drift * 100).toFixed(0)}%)`);
        tp.rr_ratio = Number(computed.toFixed(2));
      }
    } else if (!(risk > 0)) {
      log.push(`stripped trade_plan.rr_ratio — risk_atr ${risk} not > 0`);
      delete tp.rr_ratio;
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

// V2.1 — flatten weekly_poi[] into a single-line string for the daily prompt's
// `{WEEKLY_POI_LIST}` placeholder. "none" when absent so the model knows
// there are no levels to confluence with (rather than seeing an empty string
// and guessing).
export function formatWeeklyPoiList(weeklyPoi) {
  if (!Array.isArray(weeklyPoi) || weeklyPoi.length === 0) return "none";
  return weeklyPoi
    .map((p, i) => {
      const dist =
        typeof p?.distance_to_current_close_atr === "number"
          ? ` (${p.distance_to_current_close_atr >= 0 ? "+" : ""}${p.distance_to_current_close_atr.toFixed(2)} ATR)`
          : "";
      const desc = p?.level_description || "(unnamed)";
      const kind = p?.kind || "?";
      return `${i + 1}) ${kind}: ${desc}${dist}`;
    })
    .join("; ");
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
    const rr = d.trade_plan?.rr_ratio;
    const rrTag = typeof rr === "number" ? `, rr=${rr.toFixed(1)}` : "";
    const poi = d.poi_confluence?.count;
    const poiTag = typeof poi === "number" ? `, poi=${poi}/4` : "";
    lines.push(
      `**${label}** — ${stamp}\n` +
        `  - chain: ${monthlyDir} → ${weeklyDir} → **state=${d.state}** ` +
        `(trigger=${d.trigger_type}, prep ${d.prep_signals_count}/4, grade=${r.confluence_grade}${rrTag}${poiTag})\n` +
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

  const mRb = result?.reasoning_block ?? null;
  const mLegacyReasoning =
    result?.reasoning ||
    mRb?.context ||
    mRb?.maturity_read ||
    mRb?.candle_anatomy ||
    "";

  const cell = {
    tf: "1M",
    direction: result?.direction,
    in_9_15_zone: !!result?.in_9_15_zone,
    // V2.1 — move-maturity classification (early|mid|late|exhausted)
    move_maturity: result?.move_maturity ?? null,
    candle_verdict: result?.candle_verdict ?? null,
    measurements: result?.measurements ?? null,
    reasoning_block: mRb,
    reasoning: mLegacyReasoning,
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

  const wRb = result?.reasoning_block ?? null;
  const wLegacyReasoning =
    result?.reasoning ||
    wRb?.structure_read ||
    wRb?.poi_read ||
    wRb?.context ||
    "";

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
    // V2.1
    weekly_poi: result?.weekly_poi ?? [],
    reasoning_block: wRb,
    reasoning: wLegacyReasoning,
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
      MONTHLY_MOVE_MATURITY: monthlyCell.move_maturity || "unknown",
      WEEKLY_BIAS: weeklyCell.direction || "none",
      WEEKLY_SCORE: String(weeklyCell.score ?? 0),
      WEEKLY_PULLBACK_PRESENT: String(!!weeklyCell.pullback_present),
      WEEKLY_POI_LIST: formatWeeklyPoiList(weeklyCell.weekly_poi),
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

  // V2.1 — derive a 1-line legacy `reasoning` from reasoning_block.plan so the
  // existing `report.js` rationale fallback keeps working when only the
  // structured block is populated.
  const rb = result?.reasoning_block ?? null;
  const legacyReasoning =
    result?.reasoning ||
    rb?.plan ||
    rb?.trigger_anatomy ||
    rb?.competition ||
    "";

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
    // V2.1 fields — flow through cleanly even if the model omitted them
    sequence_read: result?.sequence_read ?? null,
    poi_confluence: result?.poi_confluence ?? null,
    competition: result?.competition ?? null,
    trade_plan: result?.trade_plan ?? null,
    reasoning_block: rb,
    reasoning: legacyReasoning,
    image: imagePath,
    captured_at: capturedAt.toISOString(),
    cost_usd: totalCost,
    model,
    parse_failed: parseFailed,
    attempts,
    used_fallback: usedFallback && !parseFailed,
  };
  // Run consistency check BEFORE state derivation so dropped flags change
  // the NONE/WATCH/ENTER outcome. Daily cells have no `direction` of their
  // own — pass weekly.direction as fallback so red-flag gates can evaluate.
  cell = validateCellConsistency(cell, weeklyCell?.direction);
  cell.setup_match = computeSetupMatchCount(cell);
  // Authoritative state computation — the scanner's code is the source of
  // truth for NONE/WATCH/ENTER, not the prompt's self-reported field.
  cell.state = dailyCellState(cell, monthlyCell, weeklyCell);
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

// Derives confluence grade by stacking verdicts across 3 TFs. V2.1 raises the
// bar with POI confluence + RR requirements:
//   A+  — all 3 bias-aligned, monthly in 9-15 zone, weekly score >= 8,
//         daily state = ENTER with sweep_displacement|sweep|pattern trigger,
//         poi_confluence.count >= 2, rr_ratio >= MIN_RR_FOR_A_PLUS
//   A   — all 3 bias-aligned, weekly score >= 8, daily state = ENTER,
//         poi_confluence.count >= 1, rr_ratio >= MIN_RR_FOR_A
//   B   — all 3 bias-aligned, daily state = ENTER, rr_ratio >= MIN_ENTER_RR
//   C   — monthly + weekly aligned, daily state = WATCH
//   —   — anything else
//
// When trade_plan / poi_confluence are absent (legacy cells from scans run
// before V2.1) the gates default to "satisfied" so the legacy grading still
// works — we don't want to silently downgrade old cached results.
export function deriveConfluence(monthly, weekly, daily) {
  if (!monthly || !weekly || !daily) return "—";
  if (monthly.direction === "none" || weekly.direction === "none") return "—";
  if (weekly.direction !== monthly.direction) return "—";
  if (daily.direction_conflict) return "—";

  const rr = daily.trade_plan?.rr_ratio;
  const hasRr = typeof rr === "number";
  const poiCount = daily.poi_confluence?.count;
  const hasPoi = typeof poiCount === "number";

  if (daily.state === "ENTER") {
    const highConvictionTrigger =
      daily.trigger_type === "sweep_displacement" ||
      daily.trigger_type === "sweep" ||
      daily.trigger_type === "pattern";

    const aPlusPoi = !hasPoi || poiCount >= 2;
    const aPlusRr = !hasRr || rr >= MIN_RR_FOR_A_PLUS;
    if (
      monthly.in_9_15_zone &&
      (weekly.score ?? 0) >= 8 &&
      highConvictionTrigger &&
      aPlusPoi &&
      aPlusRr
    ) return "A+";

    const aPoi = !hasPoi || poiCount >= 1;
    const aRr = !hasRr || rr >= MIN_RR_FOR_A;
    if ((weekly.score ?? 0) >= 8 && aPoi && aRr) return "A";

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

  // Pre-flight rendered-symbol check. See evaluateSymbol() for rationale.
  await assertChartRenderingExpected(client, item.tv_symbol);

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
      `match=${result.daily.setup_match?.count ?? "?"} ` +
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
  // V2.1 — surface RR and POI confluence in the one-line report.
  const rr = r.daily?.trade_plan?.rr_ratio;
  const rrTag = typeof rr === "number" ? `  RR=${rr.toFixed(1)}` : "";
  const poiCount = r.daily?.poi_confluence?.count;
  const poiTag = typeof poiCount === "number" ? `  POI=${poiCount}/4` : "";
  return `  ${r.symbol.padEnd(12)} ${dirTag}  ${state}  trigger=${trig}  grade=${r.confluence_grade}${rrTag}${poiTag}${zone}`;
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
        if (err instanceof ChartSymbolSwitchFailedError) {
          console.log(
            `    🚫 SKIP: chart_switch_failed (rendered=${err.rendered}, expected=${err.requested})`,
          );
          results.push({
            symbol: item.label,
            tv_symbol: item.tv_symbol,
            stopped_at: null,
            stop_reason: `chart_switch_failed (rendered=${err.rendered})`,
            htf_cells: [],
            htf_bias: null,
            ltf_cells: [],
            watching: [],
            triggers: [],
            cost_usd: 0,
          });
          continue;
        }
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
        if (err instanceof ChartSymbolSwitchFailedError) {
          console.log(
            `    🚫 SKIP: chart_switch_failed (rendered=${err.rendered}, expected=${err.requested})`,
          );
          results.push({
            symbol: item.label,
            tv_symbol: item.tv_symbol,
            stopped_at: null,
            stop_reason: `chart_switch_failed (rendered=${err.rendered})`,
            monthly: null,
            weekly: null,
            daily: null,
            confluence_grade: "—",
            cost_usd: 0,
            pipeline: "v2-mtf-candle-verdict",
          });
          continue;
        }
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

  // V2.1 — correlation/cluster dedupe: keep top 2 per (cluster, direction).
  // Mutates each result with `cluster_decision`. Pure pass — no I/O.
  const dedupedResults = clusterDedupe(results, { keep: 2 });
  // Re-assign so downstream (results array passed back to caller) sees the
  // annotated copy. Splice-in-place to preserve the array identity.
  results.length = 0;
  results.push(...dedupedResults);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Report Card");
  console.log("═══════════════════════════════════════════════════════════");
  for (const r of results) console.log(v2SummaryLine(r));

  // Aggregate ENTER+WATCH candidates ranked by confluence grade. Cluster-
  // demoted candidates are listed separately so nothing is silently dropped.
  const gradeOrder = { "A+": 0, A: 1, B: 2, C: 3, "—": 4 };
  const allCandidates = results
    .filter((r) => r.confluence_grade !== "—")
    .sort(
      (a, b) => gradeOrder[a.confluence_grade] - gradeOrder[b.confluence_grade],
    );
  const candidates = allCandidates.filter(
    (r) => r.cluster_decision?.kept !== false,
  );
  const clusteredOut = allCandidates.filter(
    (r) => r.cluster_decision?.kept === false,
  );

  if (candidates.length === 0) {
    console.log("\n  No candidates this scan.");
  } else {
    console.log("\n  Candidates (ranked by confluence grade):");
    for (const r of candidates) console.log(`    ${v2SummaryLine(r).trim()}`);
  }
  if (clusteredOut.length > 0) {
    console.log(
      `\n  Cluster-demoted (${clusteredOut.length}) — duplicates of higher-grade candidates in the same cluster + direction:`,
    );
    for (const r of clusteredOut) {
      const cd = r.cluster_decision;
      console.log(
        `    ${v2SummaryLine(r).trim()}   [${cd.dominant_cluster ?? "?"} full]`,
      );
    }
  }

  const totalCost = results.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
  console.log(`\n  Total LLM cost: $${totalCost.toFixed(4)}`);

  // P7: Calibration anomaly check.
  const anomaly = detectCalibrationAnomaly(results);
  if (anomaly) {
    console.log("\n  ⚠️  CALIBRATION WARNING");
    console.log(
      `     ${anomaly.topCount}/${anomaly.total} symbols stopped at "${anomaly.topReason}" ` +
        `(${(anomaly.dominance * 100).toFixed(0)}%).`,
    );
    console.log("     This is unusual — consider reviewing gate thresholds in src/scanner.js.");
  }

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
