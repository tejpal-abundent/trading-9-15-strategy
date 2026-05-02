import { test } from "node:test";
import assert from "node:assert/strict";
import { gateSatisfied } from "../src/scanner.js";

// Helper to build a measurements skeleton with overrides.
function mkMeasurements(over = {}) {
  return {
    prior_bar: {
      color: "green",
      body_pct_of_range: 65,
      high_relative_to_ema_band: "above",
    },
    current_closed_bar: {
      color: "red",
      body_pct_of_range: 50,
      upper_wick_pct: 30,
      lower_wick_pct: 5,
      close_position: "lower_third",
      high_vs_prior_bar_high: "above",
      low_vs_prior_bar_low: "above",
    },
    forming_bar: { color: "green", progress_pct: 30 },
    ema_state: {
      ema9_above_ema15: true,
      ema9_ema15_distance: "normal",
      slope_direction: "up",
      slope_steepness: "medium",
    },
    recent_5_bars: { direction: "up", overlap_pct: 20 },
    ...over,
  };
}

// ─── exhaustion ──────────────────────────────────────────────────────────

test("gateSatisfied: exhaustion long with valid measurements → true", () => {
  // long bias, current bar is red, upper wick 30%, swept above prior high
  const m = mkMeasurements();
  assert.equal(gateSatisfied("exhaustion", m, "long"), true);
});

test("gateSatisfied: exhaustion long with low upper wick (12%) → false", () => {
  const m = mkMeasurements({
    current_closed_bar: {
      color: "red",
      body_pct_of_range: 50,
      upper_wick_pct: 12,
      lower_wick_pct: 5,
      close_position: "lower_third",
      high_vs_prior_bar_high: "above",
      low_vs_prior_bar_low: "above",
    },
  });
  assert.equal(gateSatisfied("exhaustion", m, "long"), false);
});

test("gateSatisfied: exhaustion long with no sweep above prior high → false", () => {
  const m = mkMeasurements({
    current_closed_bar: {
      color: "red",
      body_pct_of_range: 50,
      upper_wick_pct: 35,
      lower_wick_pct: 5,
      close_position: "lower_third",
      high_vs_prior_bar_high: "below",
      low_vs_prior_bar_low: "above",
    },
  });
  assert.equal(gateSatisfied("exhaustion", m, "long"), false);
});

test("gateSatisfied: exhaustion long with green bar (does not contradict bias) → false", () => {
  const m = mkMeasurements({
    current_closed_bar: {
      color: "green",
      body_pct_of_range: 50,
      upper_wick_pct: 35,
      lower_wick_pct: 5,
      close_position: "lower_third",
      high_vs_prior_bar_high: "above",
      low_vs_prior_bar_low: "above",
    },
  });
  assert.equal(gateSatisfied("exhaustion", m, "long"), false);
});

test("gateSatisfied: exhaustion short with valid (lower wick 32, swept below prior low, green bar) → true", () => {
  const m = mkMeasurements({
    current_closed_bar: {
      color: "green",
      body_pct_of_range: 50,
      upper_wick_pct: 5,
      lower_wick_pct: 32,
      close_position: "upper_third",
      high_vs_prior_bar_high: "below",
      low_vs_prior_bar_low: "below",
    },
  });
  assert.equal(gateSatisfied("exhaustion", m, "short"), true);
});

// ─── choppy_structure ────────────────────────────────────────────────────

test("gateSatisfied: choppy_structure with overlap=80 mixed slope=flat → true", () => {
  const m = mkMeasurements({
    recent_5_bars: { direction: "mixed", overlap_pct: 80 },
    ema_state: {
      ema9_above_ema15: true,
      ema9_ema15_distance: "normal",
      slope_direction: "flat",
      slope_steepness: "flat",
    },
  });
  assert.equal(gateSatisfied("choppy_structure", m, "long"), true);
});

test("gateSatisfied: choppy_structure with overlap=40 → false", () => {
  const m = mkMeasurements({
    recent_5_bars: { direction: "mixed", overlap_pct: 40 },
  });
  assert.equal(gateSatisfied("choppy_structure", m, "long"), false);
});

test("gateSatisfied: choppy_structure with high overlap but direction=up → false", () => {
  const m = mkMeasurements({
    recent_5_bars: { direction: "up", overlap_pct: 80 },
  });
  assert.equal(gateSatisfied("choppy_structure", m, "long"), false);
});

// ─── tangled_emas ────────────────────────────────────────────────────────

test("gateSatisfied: tangled_emas with tight distance slope=flat → true", () => {
  const m = mkMeasurements({
    ema_state: {
      ema9_above_ema15: true,
      ema9_ema15_distance: "tight",
      slope_direction: "flat",
      slope_steepness: "flat",
    },
  });
  assert.equal(gateSatisfied("tangled_emas", m, "long"), true);
});

test("gateSatisfied: tangled_emas with wide distance → false", () => {
  const m = mkMeasurements({
    ema_state: {
      ema9_above_ema15: true,
      ema9_ema15_distance: "wide",
      slope_direction: "up",
      slope_steepness: "medium",
    },
  });
  assert.equal(gateSatisfied("tangled_emas", m, "long"), false);
});

// ─── passthrough cases ───────────────────────────────────────────────────

test("gateSatisfied: unknown flag → true (preserve unknown flags)", () => {
  const m = mkMeasurements();
  assert.equal(gateSatisfied("custom_flag_we_do_not_know", m, "long"), true);
});

test("gateSatisfied: missing measurements → true (older cell shape)", () => {
  assert.equal(gateSatisfied("exhaustion", null, "long"), true);
  assert.equal(gateSatisfied("exhaustion", undefined, "long"), true);
});

test("gateSatisfied: exhaustion with direction=none → true (no bias to contradict)", () => {
  const m = mkMeasurements();
  assert.equal(gateSatisfied("exhaustion", m, "none"), true);
});

// ─── sweepGateSatisfied ──────────────────────────────────────────────────

import { sweepGateSatisfied } from "../src/scanner.js";

test("sweepGateSatisfied: above_prior_high with valid (red bar, lower_third, swept above) → true", () => {
  const m = mkMeasurements({
    current_closed_bar: {
      color: "red",
      body_pct_of_range: 60,
      upper_wick_pct: 20,
      lower_wick_pct: 10,
      close_position: "lower_third",
      high_vs_prior_bar_high: "above",
      low_vs_prior_bar_low: "above",
    },
  });
  assert.equal(sweepGateSatisfied("above_prior_high", m), true);
});

test("sweepGateSatisfied: above_prior_high but high not above prior → false", () => {
  const m = mkMeasurements({
    current_closed_bar: {
      color: "red",
      body_pct_of_range: 60,
      upper_wick_pct: 20,
      lower_wick_pct: 10,
      close_position: "lower_third",
      high_vs_prior_bar_high: "below",
      low_vs_prior_bar_low: "above",
    },
  });
  assert.equal(sweepGateSatisfied("above_prior_high", m), false);
});

test("sweepGateSatisfied: above_prior_high but close in mid (not lower_third/at_low) → false", () => {
  const m = mkMeasurements({
    current_closed_bar: {
      color: "red",
      body_pct_of_range: 30,
      upper_wick_pct: 30,
      lower_wick_pct: 30,
      close_position: "mid",
      high_vs_prior_bar_high: "above",
      low_vs_prior_bar_low: "above",
    },
  });
  assert.equal(sweepGateSatisfied("above_prior_high", m), false);
});

test("sweepGateSatisfied: above_prior_high but green bar (no sell rejection) → false", () => {
  const m = mkMeasurements({
    current_closed_bar: {
      color: "green",
      body_pct_of_range: 60,
      upper_wick_pct: 20,
      lower_wick_pct: 10,
      close_position: "lower_third",
      high_vs_prior_bar_high: "above",
      low_vs_prior_bar_low: "above",
    },
  });
  assert.equal(sweepGateSatisfied("above_prior_high", m), false);
});

test("sweepGateSatisfied: below_prior_low symmetric (green bar, upper_third, swept below) → true", () => {
  const m = mkMeasurements({
    current_closed_bar: {
      color: "green",
      body_pct_of_range: 60,
      upper_wick_pct: 10,
      lower_wick_pct: 20,
      close_position: "upper_third",
      high_vs_prior_bar_high: "below",
      low_vs_prior_bar_low: "below",
    },
  });
  assert.equal(sweepGateSatisfied("below_prior_low", m), true);
});

test("sweepGateSatisfied: 'none' claim → true (vacuously)", () => {
  const m = mkMeasurements();
  assert.equal(sweepGateSatisfied("none", m), true);
});

test("sweepGateSatisfied: missing measurements → true (older cell)", () => {
  assert.equal(sweepGateSatisfied("above_prior_high", null), true);
  assert.equal(sweepGateSatisfied("above_prior_high", { current_closed_bar: null }), true);
});

// ─── validateCellConsistency ─────────────────────────────────────────────

import { validateCellConsistency } from "../src/scanner.js";

test("validateCellConsistency: cell with no measurements → returns unchanged", () => {
  const cell = {
    direction: "long",
    red_flags: ["exhaustion"],
    candle_verdict: { liquidity_swept: "above_prior_high", in_bias: true },
  };
  const out = validateCellConsistency(cell);
  assert.deepEqual(out.red_flags, ["exhaustion"]);
  assert.equal(out.candle_verdict.liquidity_swept, "above_prior_high");
});

test("validateCellConsistency: parse_failed cell → returns unchanged", () => {
  const cell = { parse_failed: true, red_flags: ["exhaustion"], measurements: null };
  const out = validateCellConsistency(cell);
  assert.deepEqual(out.red_flags, ["exhaustion"]);
});

test("validateCellConsistency: valid red_flag preserved", () => {
  const cell = {
    direction: "long",
    red_flags: ["exhaustion"],
    measurements: mkMeasurements(), // valid exhaustion: red bar, 30% upper wick, swept above
    candle_verdict: { liquidity_swept: "none", in_bias: false },
  };
  const out = validateCellConsistency(cell);
  assert.deepEqual(out.red_flags, ["exhaustion"]);
  assert.equal(out.consistency_log, undefined);
});

test("validateCellConsistency: invalid red_flag dropped + logged", () => {
  const cell = {
    direction: "long",
    red_flags: ["exhaustion"],
    measurements: mkMeasurements({
      current_closed_bar: {
        color: "red",
        body_pct_of_range: 30,
        upper_wick_pct: 12, // tiny — fails the 30% gate
        lower_wick_pct: 5,
        close_position: "lower_third",
        high_vs_prior_bar_high: "above",
        low_vs_prior_bar_low: "above",
      },
    }),
    candle_verdict: { liquidity_swept: "none", in_bias: false },
  };
  const out = validateCellConsistency(cell);
  assert.deepEqual(out.red_flags, []);
  assert.equal(out.consistency_log.length, 1);
  assert.match(out.consistency_log[0], /exhaustion/);
});

test("validateCellConsistency: mixed flags — invalid dropped, valid kept", () => {
  const cell = {
    direction: "long",
    red_flags: ["exhaustion", "tangled_emas"],
    measurements: mkMeasurements({
      current_closed_bar: {
        color: "red",
        body_pct_of_range: 30,
        upper_wick_pct: 10, // fails exhaustion
        lower_wick_pct: 5,
        close_position: "lower_third",
        high_vs_prior_bar_high: "above",
        low_vs_prior_bar_low: "above",
      },
      ema_state: {
        ema9_above_ema15: true,
        ema9_ema15_distance: "tight", // satisfies tangled_emas
        slope_direction: "flat",
        slope_steepness: "flat",
      },
    }),
    candle_verdict: { liquidity_swept: "none", in_bias: false },
  };
  const out = validateCellConsistency(cell);
  assert.deepEqual(out.red_flags, ["tangled_emas"]);
});

test("validateCellConsistency: invalid liquidity_swept reset to 'none' + logged", () => {
  const cell = {
    direction: "long",
    red_flags: [],
    measurements: mkMeasurements({
      current_closed_bar: {
        color: "green", // contradicts above_prior_high (which needs red)
        body_pct_of_range: 60,
        upper_wick_pct: 20,
        lower_wick_pct: 10,
        close_position: "lower_third",
        high_vs_prior_bar_high: "above",
        low_vs_prior_bar_low: "above",
      },
    }),
    candle_verdict: { liquidity_swept: "above_prior_high", in_bias: false },
  };
  const out = validateCellConsistency(cell);
  assert.equal(out.candle_verdict.liquidity_swept, "none");
  assert.equal(out.consistency_log.length, 1);
  assert.match(out.consistency_log[0], /liquidity_swept/);
});

test("validateCellConsistency: in_bias=true with body 25% → forced to false", () => {
  const cell = {
    direction: "long",
    red_flags: [],
    measurements: mkMeasurements({
      current_closed_bar: {
        color: "green",
        body_pct_of_range: 25, // < 40 → in_bias must be false
        upper_wick_pct: 20,
        lower_wick_pct: 55,
        close_position: "upper_third",
        high_vs_prior_bar_high: "above",
        low_vs_prior_bar_low: "above",
      },
    }),
    candle_verdict: { liquidity_swept: "none", in_bias: true, body_pct_of_range: 25 },
  };
  const out = validateCellConsistency(cell);
  assert.equal(out.candle_verdict.in_bias, false);
  assert.match(out.consistency_log[0], /in_bias/);
});

test("validateCellConsistency: in_bias=true with body 65% → preserved", () => {
  const cell = {
    direction: "long",
    red_flags: [],
    measurements: mkMeasurements({
      current_closed_bar: {
        color: "green",
        body_pct_of_range: 65,
        upper_wick_pct: 10,
        lower_wick_pct: 25,
        close_position: "upper_third",
        high_vs_prior_bar_high: "above",
        low_vs_prior_bar_low: "above",
      },
    }),
    candle_verdict: { liquidity_swept: "none", in_bias: true, body_pct_of_range: 65 },
  };
  const out = validateCellConsistency(cell);
  assert.equal(out.candle_verdict.in_bias, true);
});

// ─── P1: choppy_structure tightened gate ─────────────────────────────────

test("gateSatisfied: choppy_structure overlap=80 mixed slope=flat → true (genuine chop)", () => {
  const m = mkMeasurements({
    recent_5_bars: { direction: "mixed", overlap_pct: 80 },
    ema_state: {
      ema9_above_ema15: true,
      ema9_ema15_distance: "normal",
      slope_direction: "flat",
      slope_steepness: "flat",
    },
  });
  assert.equal(gateSatisfied("choppy_structure", m, "long"), true);
});

test("gateSatisfied: choppy_structure overlap=80 mixed slope=steep → false (pullback in trend)", () => {
  const m = mkMeasurements({
    recent_5_bars: { direction: "mixed", overlap_pct: 80 },
    ema_state: {
      ema9_above_ema15: true,
      ema9_ema15_distance: "wide",
      slope_direction: "up",
      slope_steepness: "steep",
    },
  });
  assert.equal(gateSatisfied("choppy_structure", m, "long"), false);
});

test("gateSatisfied: choppy_structure overlap=70 mixed slope=flat → false (below new threshold)", () => {
  const m = mkMeasurements({
    recent_5_bars: { direction: "mixed", overlap_pct: 70 },
    ema_state: {
      ema9_above_ema15: true,
      ema9_ema15_distance: "normal",
      slope_direction: "flat",
      slope_steepness: "flat",
    },
  });
  assert.equal(gateSatisfied("choppy_structure", m, "long"), false);
});

test("gateSatisfied: choppy_structure overlap=80 direction=up slope=flat → false (not mixed)", () => {
  const m = mkMeasurements({
    recent_5_bars: { direction: "up", overlap_pct: 80 },
    ema_state: {
      ema9_above_ema15: true,
      ema9_ema15_distance: "normal",
      slope_direction: "flat",
      slope_steepness: "flat",
    },
  });
  assert.equal(gateSatisfied("choppy_structure", m, "long"), false);
});

// ─── P2: tangled_emas tightened gate ─────────────────────────────────────

test("gateSatisfied: tangled_emas tight + slope=shallow → true (genuinely tangled)", () => {
  const m = mkMeasurements({
    ema_state: {
      ema9_above_ema15: true,
      ema9_ema15_distance: "tight",
      slope_direction: "up",
      slope_steepness: "shallow",
    },
  });
  assert.equal(gateSatisfied("tangled_emas", m, "long"), true);
});

test("gateSatisfied: tangled_emas tight + slope=steep → false (consolidation before continuation)", () => {
  const m = mkMeasurements({
    ema_state: {
      ema9_above_ema15: true,
      ema9_ema15_distance: "tight",
      slope_direction: "up",
      slope_steepness: "steep",
    },
  });
  assert.equal(gateSatisfied("tangled_emas", m, "long"), false);
});

test("gateSatisfied: tangled_emas distance=normal slope=flat → false (not tight)", () => {
  const m = mkMeasurements({
    ema_state: {
      ema9_above_ema15: true,
      ema9_ema15_distance: "normal",
      slope_direction: "flat",
      slope_steepness: "flat",
    },
  });
  assert.equal(gateSatisfied("tangled_emas", m, "long"), false);
});
