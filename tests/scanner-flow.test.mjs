import { test } from "node:test";
import assert from "node:assert/strict";
import { ltfCellPass } from "../src/scanner.js";

test("ltfCellPass: 2 of 3 signals + score 8 → pass", () => {
  const cell = {
    zone_rejection: true,
    coc_present: true,
    strong_candle_in_bias: false,
    red_flags: [],
    score: 8,
  };
  assert.equal(ltfCellPass(cell), true);
});

test("ltfCellPass: 3 of 3 signals + score 10 → pass", () => {
  const cell = {
    zone_rejection: true,
    coc_present: true,
    strong_candle_in_bias: true,
    red_flags: [],
    score: 10,
  };
  assert.equal(ltfCellPass(cell), true);
});

test("ltfCellPass: 1 of 3 signals + score 10 → fail", () => {
  const cell = {
    zone_rejection: true,
    coc_present: false,
    strong_candle_in_bias: false,
    red_flags: [],
    score: 10,
  };
  assert.equal(ltfCellPass(cell), false);
});

test("ltfCellPass: 2 of 3 signals + score 7 → fail (score too low)", () => {
  const cell = {
    zone_rejection: true,
    coc_present: true,
    strong_candle_in_bias: false,
    red_flags: [],
    score: 7,
  };
  assert.equal(ltfCellPass(cell), false);
});

test("ltfCellPass: 3 of 3 signals + score 8 + red flag → fail", () => {
  const cell = {
    zone_rejection: true,
    coc_present: true,
    strong_candle_in_bias: true,
    red_flags: ["choppy_structure"],
    score: 8,
  };
  assert.equal(ltfCellPass(cell), false);
});

test("ltfCellPass: missing fields → fail safely", () => {
  assert.equal(ltfCellPass({}), false);
  assert.equal(ltfCellPass(null), false);
});

import { evaluateHtfChain } from "../src/scanner.js";

const goodCell = (overrides = {}) => ({
  direction: "long",
  slope_ok: true,
  pullback_present: true,
  ema_stack_ok: true,
  red_flags: [],
  score: 8,
  reasoning: "ok",
  ...overrides,
});

test("evaluateHtfChain: all 3 agree, scores ≥6, avg ≥7 → pass", () => {
  const r = evaluateHtfChain([goodCell({ score: 8 }), goodCell({ score: 7 }), goodCell({ score: 7 })]);
  assert.equal(r.stopped, false);
  assert.equal(r.stopReason, null);
  assert.equal(r.htfBias, "long");
  assert.equal(r.avgScore.toFixed(2), "7.33");
});

test("evaluateHtfChain: first cell direction=none → STOP no_trend", () => {
  const r = evaluateHtfChain([
    goodCell({ direction: "none", score: 0 }),
    goodCell(),
    goodCell(),
  ]);
  assert.equal(r.stopped, true);
  assert.equal(r.stopAt, "1M");
  assert.equal(r.stopReason, "no_trend");
  assert.equal(r.htfBias, null);
});

test("evaluateHtfChain: 1W disagrees with 1M → STOP htf_disagree", () => {
  const r = evaluateHtfChain([
    goodCell({ direction: "long" }),
    goodCell({ direction: "short" }),
    goodCell({ direction: "long" }),
  ]);
  assert.equal(r.stopped, true);
  assert.equal(r.stopAt, "1W");
  assert.equal(r.stopReason, "htf_disagree");
});

test("evaluateHtfChain: cell score < 6 → STOP htf_quality_low", () => {
  const r = evaluateHtfChain([
    goodCell({ score: 8 }),
    goodCell({ score: 5 }),
    goodCell({ score: 8 }),
  ]);
  assert.equal(r.stopped, true);
  assert.equal(r.stopAt, "1W");
  assert.equal(r.stopReason, "htf_quality_low");
});

test("evaluateHtfChain: agreement + scores ≥6 but avg < 7 → STOP htf_avg_low", () => {
  const r = evaluateHtfChain([
    goodCell({ score: 6 }),
    goodCell({ score: 6 }),
    goodCell({ score: 6 }),
  ]);
  assert.equal(r.stopped, true);
  assert.equal(r.stopReason, "htf_avg_low");
  assert.equal(r.avgScore, 6);
  assert.equal(r.htfBias, null);
});

test("evaluateHtfChain: short bias all agree → htfBias=short", () => {
  const r = evaluateHtfChain([
    goodCell({ direction: "short", score: 8 }),
    goodCell({ direction: "short", score: 8 }),
    goodCell({ direction: "short", score: 8 }),
  ]);
  assert.equal(r.stopped, false);
  assert.equal(r.htfBias, "short");
});
