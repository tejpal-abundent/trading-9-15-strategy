import { test } from "node:test";
import assert from "node:assert/strict";
import { isTrendDominant } from "../src/scanner.js";

function mkM(over = {}) {
  return {
    direction: "long",
    measurements: {
      ema_state: {
        ema9_above_ema15: true,
        ema9_ema15_distance: "wide",
        slope_direction: "up",
        slope_steepness: "medium",
      },
    },
    ...over,
  };
}

function mkW(over = {}) {
  return {
    direction: "long",
    red_flags: [],
    measurements: {
      ema_state: {
        ema9_above_ema15: true,
        ema9_ema15_distance: "wide",
        slope_direction: "up",
        slope_steepness: "steep",
      },
    },
    ...over,
  };
}

test("isTrendDominant: aligned + wide weekly + steep slopes → true", () => {
  assert.equal(isTrendDominant(mkM(), mkW()), true);
});

test("isTrendDominant: TF disagreement → false", () => {
  assert.equal(isTrendDominant(mkM({ direction: "long" }), mkW({ direction: "short" })), false);
});

test("isTrendDominant: monthly direction=none → false", () => {
  assert.equal(isTrendDominant(mkM({ direction: "none" }), mkW()), false);
});

test("isTrendDominant: weekly red_flag present → false", () => {
  assert.equal(isTrendDominant(mkM(), mkW({ red_flags: ["choppy_structure"] })), false);
});

test("isTrendDominant: weekly EMAs tight → false (need normal/wide)", () => {
  const w = mkW();
  w.measurements.ema_state.ema9_ema15_distance = "tight";
  assert.equal(isTrendDominant(mkM(), w), false);
});

test("isTrendDominant: weekly slope shallow → false", () => {
  const w = mkW();
  w.measurements.ema_state.slope_steepness = "shallow";
  assert.equal(isTrendDominant(mkM(), w), false);
});

test("isTrendDominant: monthly slope flat → false", () => {
  const m = mkM();
  m.measurements.ema_state.slope_steepness = "flat";
  assert.equal(isTrendDominant(m, mkW()), false);
});

test("isTrendDominant: missing inputs → false", () => {
  assert.equal(isTrendDominant(null, mkW()), false);
  assert.equal(isTrendDominant(mkM(), null), false);
  assert.equal(isTrendDominant(null, null), false);
});

test("isTrendDominant: weekly EMAs normal (not wide) but other conditions met → true", () => {
  const w = mkW();
  w.measurements.ema_state.ema9_ema15_distance = "normal";
  assert.equal(isTrendDominant(mkM(), w), true);
});
