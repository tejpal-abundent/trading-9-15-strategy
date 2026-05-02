import {
  validateCellConsistency,
  dailyCellState,
  dailyTriggerType,
  deriveConfluence,
} from "../src/scanner.js";

// replayResult: takes raw cells (as they appear inside scan-results JSON) and runs
// the full evaluation pipeline against the CURRENT validator + state-derivation code.
// Returns { stopped_at, stop_reason, monthly, weekly, daily, confluence_grade } shaped
// like an evaluateSymbolV2() result so the caller can diff it against the stored result.
export function replayResult(rawCells) {
  const monthly = rawCells.monthly ? validateCellConsistency({ ...rawCells.monthly }) : null;
  const weekly = rawCells.weekly ? validateCellConsistency({ ...rawCells.weekly }) : null;
  const daily = rawCells.daily ? validateCellConsistency({ ...rawCells.daily }) : null;

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
  if ((weekly.red_flags || []).length > 0) {
    out.stopped_at = "1W";
    out.stop_reason = "weekly_red_flag";
    return out;
  }
  if ((weekly.score ?? 0) < 7) {
    out.stopped_at = "1W";
    out.stop_reason = "weekly_quality_low";
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

  daily.state = dailyCellState(daily, monthly, weekly);
  daily.trigger_type = dailyTriggerType(daily, weekly.direction);
  out.confluence_grade = deriveConfluence(monthly, weekly, daily);

  if (daily.state === "NONE") {
    out.stopped_at = "1D";
    out.stop_reason = "daily_no_trigger";
  }
  return out;
}
