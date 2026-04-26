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

test("gateSatisfied: choppy_structure with overlap=70 mixed → true", () => {
  const m = mkMeasurements({
    recent_5_bars: { direction: "mixed", overlap_pct: 70 },
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

test("gateSatisfied: tangled_emas with tight distance → true", () => {
  const m = mkMeasurements({
    ema_state: {
      ema9_above_ema15: true,
      ema9_ema15_distance: "tight",
      slope_direction: "up",
      slope_steepness: "medium",
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
