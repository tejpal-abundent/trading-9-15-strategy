import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRedFlags, isCandleStrongInBias } from "../src/scanner.js";

test("classifyRedFlags: exhaustion → fatal", () => {
  const r = classifyRedFlags(["exhaustion"]);
  assert.deepEqual(r.fatal, ["exhaustion"]);
  assert.deepEqual(r.warning, []);
  assert.deepEqual(r.unknown, []);
});

test("classifyRedFlags: choppy_structure → warning", () => {
  const r = classifyRedFlags(["choppy_structure"]);
  assert.deepEqual(r.fatal, []);
  assert.deepEqual(r.warning, ["choppy_structure"]);
});

test("classifyRedFlags: tangled_emas → warning", () => {
  const r = classifyRedFlags(["tangled_emas"]);
  assert.deepEqual(r.warning, ["tangled_emas"]);
});

test("classifyRedFlags: direction_conflict → fatal", () => {
  const r = classifyRedFlags(["direction_conflict"]);
  assert.deepEqual(r.fatal, ["direction_conflict"]);
});

test("classifyRedFlags: unknown flag → unknown bucket", () => {
  const r = classifyRedFlags(["xyz"]);
  assert.deepEqual(r.unknown, ["xyz"]);
});

test("classifyRedFlags: mixed list partitions correctly", () => {
  const r = classifyRedFlags(["choppy_structure", "exhaustion", "tangled_emas"]);
  assert.deepEqual(r.fatal, ["exhaustion"]);
  assert.deepEqual(r.warning.sort(), ["choppy_structure", "tangled_emas"]);
});

test("classifyRedFlags: empty/null safe", () => {
  assert.deepEqual(classifyRedFlags([]), { fatal: [], warning: [], unknown: [] });
  assert.deepEqual(classifyRedFlags(null), { fatal: [], warning: [], unknown: [] });
  assert.deepEqual(classifyRedFlags(undefined), { fatal: [], warning: [], unknown: [] });
});

// ─── isCandleStrongInBias ─────────────────────────────────────────────────

function mkWeeklyCell(over = {}) {
  return {
    direction: "long",
    candle_verdict: { in_bias: true },
    measurements: {
      current_closed_bar: {
        color: "green",
        body_pct_of_range: 70,
        close_position: "upper_third",
      },
    },
    ...over,
  };
}

test("isCandleStrongInBias: long body 70% close upper green → true", () => {
  assert.equal(isCandleStrongInBias(mkWeeklyCell()), true);
});

test("isCandleStrongInBias: long body 50% close upper green → false (body too small)", () => {
  const c = mkWeeklyCell({
    measurements: { current_closed_bar: { color: "green", body_pct_of_range: 50, close_position: "upper_third" } },
  });
  assert.equal(isCandleStrongInBias(c), false);
});

test("isCandleStrongInBias: long body 70% close mid green → false (close not upper)", () => {
  const c = mkWeeklyCell({
    measurements: { current_closed_bar: { color: "green", body_pct_of_range: 70, close_position: "mid" } },
  });
  assert.equal(isCandleStrongInBias(c), false);
});

test("isCandleStrongInBias: long body 70% close upper red → false (color mismatch)", () => {
  const c = mkWeeklyCell({
    measurements: { current_closed_bar: { color: "red", body_pct_of_range: 70, close_position: "upper_third" } },
  });
  assert.equal(isCandleStrongInBias(c), false);
});

test("isCandleStrongInBias: short body 70% close lower red → true", () => {
  const c = mkWeeklyCell({
    direction: "short",
    measurements: { current_closed_bar: { color: "red", body_pct_of_range: 70, close_position: "lower_third" } },
  });
  assert.equal(isCandleStrongInBias(c), true);
});

test("isCandleStrongInBias: in_bias=false → false regardless of measurements", () => {
  const c = mkWeeklyCell({ candle_verdict: { in_bias: false } });
  assert.equal(isCandleStrongInBias(c), false);
});

test("isCandleStrongInBias: missing measurements → false", () => {
  assert.equal(isCandleStrongInBias({ direction: "long", candle_verdict: { in_bias: true } }), false);
});
