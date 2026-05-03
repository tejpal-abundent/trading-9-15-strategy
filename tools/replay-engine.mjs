import {
  validateCellConsistency,
  dailyCellState,
  dailyTriggerType,
  deriveConfluence,
  weeklyStopDecision,
  computeSetupMatchCount,
} from "../src/scanner.js";

// replayResult: takes raw cells (as they appear inside scan-results JSON) and runs
// the full evaluation pipeline against the CURRENT validator + state-derivation code.
// Returns { stopped_at, stop_reason, monthly, weekly, daily, confluence_grade } shaped
// like an evaluateSymbolV2() result so the caller can diff it against the stored result.
export function replayResult(rawCells) {
  // Deep-clone before validating: validateCellConsistency mutates nested fields
  // (candle_verdict.liquidity_swept, candle_verdict.in_bias). A shallow spread
  // would let those writes leak back into the caller's input on repeated calls.
  const monthly = rawCells.monthly ? validateCellConsistency(structuredClone(rawCells.monthly)) : null;
  const weekly = rawCells.weekly ? validateCellConsistency(structuredClone(rawCells.weekly)) : null;
  // Daily cells inherit bias from weekly — pass weekly?.direction as the
  // fallback so red-flag gates can actually evaluate against measurements.
  // Order matters: weekly must be validated first so its direction is final.
  const daily = rawCells.daily
    ? validateCellConsistency(structuredClone(rawCells.daily), weekly?.direction)
    : null;

  const out = {
    stopped_at: null,
    stop_reason: null,
    monthly,
    weekly,
    daily,
    confluence_grade: "—",
  };

  // Step 1: monthly
  if (!monthly) return out;
  if (monthly.parse_failed) {
    out.stopped_at = "1M";
    out.stop_reason = "llm_parse_error";
    return out;
  }
  if (monthly.direction === "none") {
    out.stopped_at = "1M";
    out.stop_reason = "monthly_no_trend";
    return out;
  }

  // Step 2: weekly
  if (!weekly) return out;
  if (weekly.parse_failed) {
    out.stopped_at = "1W";
    out.stop_reason = "llm_parse_error";
    return out;
  }
  if (weekly.direction_conflict === true) {
    out.stopped_at = "1W";
    out.stop_reason = "monthly_weekly_disagree";
    return out;
  }
  if (weekly.direction === "none") {
    out.stopped_at = "1W";
    out.stop_reason = "weekly_no_setup";
    return out;
  }
  // P6: fatal/warning split + isCandleStrongInBias compensation. Must use the
  // same decision function as evaluateSymbolV2 so replay stop_reasons match
  // the live scanner's exactly.
  const weeklyStop = weeklyStopDecision(weekly);
  if (weeklyStop) {
    out.stopped_at = "1W";
    out.stop_reason = weeklyStop.stop_reason;
    return out;
  }

  // Step 3: daily
  if (!daily) return out;
  if (daily.parse_failed) {
    out.stopped_at = "1D";
    out.stop_reason = "llm_parse_error";
    return out;
  }
  if (daily.direction_conflict === true) {
    out.stopped_at = "1D";
    out.stop_reason = "weekly_daily_disagree";
    return out;
  }

  daily.setup_match = computeSetupMatchCount(daily);
  daily.state = dailyCellState(daily, monthly, weekly);
  daily.trigger_type = dailyTriggerType(daily, weekly.direction);
  out.confluence_grade = deriveConfluence(monthly, weekly, daily);

  if (daily.state === "NONE") {
    out.stopped_at = "1D";
    out.stop_reason = "daily_no_trigger";
  }
  return out;
}
