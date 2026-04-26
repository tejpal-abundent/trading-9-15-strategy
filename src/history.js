// Prior-run history — gives the V2 pipeline cross-run memory.
//
// Today's pipeline is otherwise stateless: every scan reads charts cold and
// the LLM has no idea what we said yesterday. This module reads the saved
// scan-v2-watchlist-*.json files, groups them by symbol, and exposes the
// most recent prior monthly/weekly/daily verdict + a "streak" count of
// consecutive prior runs that agreed on direction.
//
// The result is fed into prompts as a "Prior run context" block so the LLM
// can confirm continuity, flag flips, and judge whether yesterday's trigger
// confirmed or faded today.

import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve } from "path";

const DEFAULT_RESULTS_DIR = "scan-results";
const DEFAULT_MAX_PRIOR_RUNS = 2;

// Reads all scan-v2-watchlist-*.json files in `resultsDir`, returns a Map
// from symbol-label → array of prior entries (newest first, capped at
// `maxPriorRuns`).
//
//   beforeIso (string)    — only include runs strictly before this timestamp.
//                            Lets the current run filter out its own future-self.
//   maxPriorRuns (int)    — keep at most this many prior runs per symbol
//                            (default 2 — yesterday + day-before).
//
// Each entry in the returned per-symbol list is shaped:
//   {
//     started_at: "2026-04-24T06:00:01.000Z",
//     monthly: <cell> | null,
//     weekly:  <cell> | null,
//     daily:   <cell> | null,
//     stop_reason: <string> | null,
//     confluence_grade: "A+" | "A" | "B" | "C" | "—",
//   }
//
// Files that fail to parse are skipped silently (diagnostics-only).
export function loadPriorRunsForWatchlist({
  resultsDir = DEFAULT_RESULTS_DIR,
  beforeIso,
  maxPriorRuns = DEFAULT_MAX_PRIOR_RUNS,
} = {}) {
  const map = new Map();
  if (!existsSync(resultsDir)) return map;

  const cutoffMs = beforeIso ? Date.parse(beforeIso) : Date.now();

  const files = readdirSync(resultsDir).filter(
    (f) => f.startsWith("scan-v2-watchlist-") && f.endsWith(".json"),
  );

  for (const f of files) {
    let payload;
    try {
      payload = JSON.parse(readFileSync(resolve(resultsDir, f), "utf8"));
    } catch {
      continue; // malformed or partially-written file
    }
    const startedAt = payload?.started_at;
    if (!startedAt) continue;
    const ts = Date.parse(startedAt);
    if (Number.isNaN(ts)) continue;
    if (ts >= cutoffMs) continue; // not strictly before

    const results = Array.isArray(payload.results) ? payload.results : [];
    for (const r of results) {
      const sym = r?.symbol;
      if (!sym) continue;
      const entry = {
        started_at: startedAt,
        monthly: r.monthly ?? null,
        weekly: r.weekly ?? null,
        daily: r.daily ?? null,
        stop_reason: r.stop_reason ?? null,
        confluence_grade: r.confluence_grade ?? "—",
      };
      if (!map.has(sym)) map.set(sym, []);
      map.get(sym).push(entry);
    }
  }

  // Newest first per symbol, then cap to maxPriorRuns.
  for (const [sym, list] of map.entries()) {
    list.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
    if (list.length > maxPriorRuns) {
      map.set(sym, list.slice(0, maxPriorRuns));
    }
  }
  return map;
}

// Trims a monthly cell to the fields the prompt formatter actually shows.
function trimMonthly(cell) {
  if (!cell || cell.parse_failed) return null;
  return {
    direction: cell.direction ?? "none",
    in_9_15_zone: !!cell.in_9_15_zone,
    candle_verdict: cell.candle_verdict ?? null,
    captured_at: cell.captured_at ?? null,
  };
}

function trimWeekly(cell) {
  if (!cell || cell.parse_failed) return null;
  return {
    direction: cell.direction ?? "none",
    direction_conflict: !!cell.direction_conflict,
    score: cell.score ?? 0,
    setup_type: cell.setup_type ?? "none",
    candle_verdict: cell.candle_verdict ?? null,
    captured_at: cell.captured_at ?? null,
  };
}

function trimDaily(cell) {
  if (!cell || cell.parse_failed) return null;
  return {
    state: cell.state ?? "NONE",
    trigger_type: cell.trigger_type ?? "none",
    direction_conflict: !!cell.direction_conflict,
    prep_signals_count: cell.prep_signals_count ?? 0,
    candle_verdict: cell.candle_verdict ?? null,
    captured_at: cell.captured_at ?? null,
  };
}

// Derives a structured prior-context object for one symbol — surfaces the
// last N (default 2) prior runs side-by-side so the prompt can show "what we
// said yesterday + day-before" and let the LLM judge continuity vs flip.
//
//   {
//     runs: [
//       { started_at, stop_reason, confluence_grade, monthly, weekly, daily },
//       ...   // newest first, length 0..N
//     ],
//     priorRunsCount: int,
//   }
//
// Empty runs[] = cold scan (no priors on file).
export function derivePriorContext(history) {
  const safeHistory = Array.isArray(history) ? history : [];

  const runs = safeHistory.map((e) => ({
    started_at: e.started_at,
    stop_reason: e.stop_reason ?? null,
    confluence_grade: e.confluence_grade ?? "—",
    monthly: trimMonthly(e.monthly),
    weekly: trimWeekly(e.weekly),
    daily: trimDaily(e.daily),
  }));

  return {
    runs,
    priorRunsCount: safeHistory.length,
  };
}
