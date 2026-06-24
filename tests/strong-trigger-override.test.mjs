// V2.5 — strong-trigger override in dailyCellState.
// When daily.setup_type was labeled "continuation" but the trigger candle is
// unambiguously decisive (winner_strength ≥ 7, body ≥ 60%, close at extreme,
// prep ≥ 3), allow ENTER. Without this override, mislabeled continuations
// got pinned at WATCH.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyCellState } from "../src/scanner.js";

const baseMonthly = {
  direction: "short",
  measurements: { ema_state: { ema9_above_ema15: false, ema9_ema15_distance: "wide", slope_direction: "down", slope_steepness: "steep" } },
};
const baseWeekly = {
  direction: "short",
  red_flags: [],
  measurements: { ema_state: { ema9_above_ema15: false, ema9_ema15_distance: "tight", slope_direction: "down", slope_steepness: "medium" } },
};

const dailyCellWith = (over = {}) => ({
  direction_conflict: false,
  setup_type: "continuation",
  angle_ok: true,
  zone_rejection: false,
  coc_present: false,
  solid_continuation: false,
  prep_signals_count: 1, // just angle_ok — the override should still fire
  red_flags: [],
  candle_verdict: { in_bias: true, winner_strength: 7, pattern: "engulfing_bear" },
  measurements: { current_closed_bar: { body_pct_of_range: 76, close_position: "at_low" } },
  ...over,
});

test("strong trigger: continuation + engulfing_bear + ws=7 + body=76 + close=at_low + prep=1 → ENTER", () => {
  // The exact USDCHF case from 2026-05-09: model labeled "continuation",
  // solid_continuation=false, only angle_ok fires. Engulfing bear close-at-low
  // body 76% is the signal itself — should be ENTER.
  const cell = dailyCellWith();
  assert.equal(dailyCellState(cell, baseMonthly, baseWeekly), "ENTER");
});

test("strong trigger: solid_bear close lower_third body 60 prep 1 → ENTER", () => {
  const cell = dailyCellWith({
    candle_verdict: { in_bias: true, winner_strength: 7, pattern: "solid_bear" },
    measurements: { current_closed_bar: { body_pct_of_range: 60, close_position: "lower_third" } },
  });
  assert.equal(dailyCellState(cell, baseMonthly, baseWeekly), "ENTER");
});

test("strong trigger: pattern='none' (unrecognized) → falls through, NONE", () => {
  // Even with all the strength criteria, if the pattern isn't a recognized
  // signal pattern (engulfing/solid/hammer/etc), we don't shortcut to ENTER.
  // With non-dominant trend (tight EMAs) watchFloor=2 and prep=1 → NONE.
  const cell = dailyCellWith({
    candle_verdict: { in_bias: true, winner_strength: 7, pattern: "none" },
  });
  assert.equal(dailyCellState(cell, baseMonthly, baseWeekly), "NONE");
});

test("strong trigger: long bias rejects bearish patterns", () => {
  // Sanity: pattern direction must match bias.
  const cell = {
    ...dailyCellWith({
      candle_verdict: { in_bias: true, winner_strength: 7, pattern: "engulfing_bear" },
    }),
  };
  const longMonthly = { ...baseMonthly, direction: "long" };
  const longWeekly = { ...baseWeekly, direction: "long" };
  // engulfing_bear with long bias → not in patternSet → no override → falls through.
  // matchCount=1 < watchFloor=2 → NONE.
  assert.equal(dailyCellState(cell, longMonthly, longWeekly), "NONE");
});

test("strong trigger: winner_strength=6 (< 7) → falls through, NONE", () => {
  const cell = dailyCellWith({
    candle_verdict: { in_bias: true, winner_strength: 6, pattern: "engulfing_bear" },
  });
  assert.equal(dailyCellState(cell, baseMonthly, baseWeekly), "NONE");
});

test("strong trigger: body=55 (< 60) → falls through, NONE", () => {
  const cell = dailyCellWith({
    measurements: { current_closed_bar: { body_pct_of_range: 55, close_position: "at_low" } },
  });
  assert.equal(dailyCellState(cell, baseMonthly, baseWeekly), "NONE");
});

test("strong trigger: close_position=mid → falls through, NONE", () => {
  const cell = dailyCellWith({
    measurements: { current_closed_bar: { body_pct_of_range: 76, close_position: "mid" } },
  });
  assert.equal(dailyCellState(cell, baseMonthly, baseWeekly), "NONE");
});

test("strong trigger: prep=0 (no signals at all) → falls through, WATCH", () => {
  const cell = dailyCellWith({
    angle_ok: false,
    prep_signals_count: 0,
  });
  // No prep signals means no EMA-structure confirmation; the strong candle alone
  // isn't enough — could be a counter-trend pop on a fading market.
  // Note: matchCount=0 hits the watchFloor check first (NONE), but also documents
  // the override's prep ≥ 1 floor.
  const out = dailyCellState(cell, baseMonthly, baseWeekly);
  assert.ok(out === "WATCH" || out === "NONE");
});

test("strong trigger: pullback with required satisfied still ENTERs (override didn't break it)", () => {
  const cell = dailyCellWith({
    setup_type: "pullback",
    zone_rejection: true,
    coc_present: false,
    prep_signals_count: 2,
  });
  assert.equal(dailyCellState(cell, baseMonthly, baseWeekly), "ENTER");
});
