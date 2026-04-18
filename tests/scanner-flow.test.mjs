import { test } from "node:test";
import assert from "node:assert/strict";
import { ltfCellPass, evaluateHtfChain } from "../src/scanner.js";

// ─── ltfCellPass — door A: structural (≥2 of 5 signals + score ≥ 8) ──────

test("ltfCellPass: 2 of 5 signals + score 8 → pass (structural door)", () => {
  const cell = {
    angle_ok: false,
    zone_rejection: true,
    coc_present: true,
    strong_candle_in_bias: false,
    solid_continuation: false,
    probability_next_candle_in_bias: 50,
    red_flags: [],
    score: 8,
  };
  assert.equal(ltfCellPass(cell), true);
});

test("ltfCellPass: 5 of 5 signals + score 10 → pass", () => {
  const cell = {
    angle_ok: true,
    zone_rejection: true,
    coc_present: true,
    strong_candle_in_bias: true,
    solid_continuation: true,
    probability_next_candle_in_bias: 90,
    red_flags: [],
    score: 10,
  };
  assert.equal(ltfCellPass(cell), true);
});

test("ltfCellPass: 1 of 5 signals + score 10 + low probability → fail", () => {
  const cell = {
    angle_ok: false,
    zone_rejection: true,
    coc_present: false,
    strong_candle_in_bias: false,
    solid_continuation: false,
    probability_next_candle_in_bias: 60,
    red_flags: [],
    score: 10,
  };
  assert.equal(ltfCellPass(cell), false);
});

test("ltfCellPass: 2 of 5 signals + score 7 + low prob → fail", () => {
  const cell = {
    angle_ok: true,
    zone_rejection: true,
    coc_present: false,
    strong_candle_in_bias: false,
    solid_continuation: false,
    probability_next_candle_in_bias: 60,
    red_flags: [],
    score: 7,
  };
  assert.equal(ltfCellPass(cell), false);
});

// ─── ltfCellPass — door B: probability ≥ 75 ──────────────────────────────

test("ltfCellPass: 0 signals + score 5 + probability 80 → pass (probability door)", () => {
  const cell = {
    angle_ok: false,
    zone_rejection: false,
    coc_present: false,
    strong_candle_in_bias: false,
    solid_continuation: false,
    probability_next_candle_in_bias: 80,
    red_flags: [],
    score: 5,
  };
  assert.equal(ltfCellPass(cell), true);
});

test("ltfCellPass: probability 75 exactly → pass", () => {
  const cell = {
    probability_next_candle_in_bias: 75,
    red_flags: [],
    score: 0,
  };
  assert.equal(ltfCellPass(cell), true);
});

test("ltfCellPass: probability 74 + no signals → fail", () => {
  const cell = {
    probability_next_candle_in_bias: 74,
    red_flags: [],
    score: 0,
  };
  assert.equal(ltfCellPass(cell), false);
});

// ─── ltfCellPass — red flags veto both doors ─────────────────────────────

test("ltfCellPass: probability 95 + red flag → fail (red flags veto)", () => {
  const cell = {
    probability_next_candle_in_bias: 95,
    red_flags: ["choppy_structure"],
    score: 10,
  };
  assert.equal(ltfCellPass(cell), false);
});

test("ltfCellPass: structural pass + red flag → fail", () => {
  const cell = {
    angle_ok: true,
    zone_rejection: true,
    strong_candle_in_bias: true,
    red_flags: ["doji_cluster"],
    score: 9,
  };
  assert.equal(ltfCellPass(cell), false);
});

test("ltfCellPass: missing fields → fail safely", () => {
  assert.equal(ltfCellPass({}), false);
  assert.equal(ltfCellPass(null), false);
});

// ─── evaluateHtfChain — door A: score ≥ 7 ────────────────────────────────

const goodCell = (overrides = {}) => ({
  direction: "long",
  setup_type: "pullback",
  angle_ok: true,
  pullback_present: true,
  ema_stack_ok: true,
  solid_continuation: true,
  probability_next_candle_in_bias: 70,
  red_flags: [],
  score: 8,
  reasoning: "ok",
  ...overrides,
});

test("evaluateHtfChain: all 3 agree, scores ≥7 → pass", () => {
  const r = evaluateHtfChain([
    goodCell({ score: 8 }),
    goodCell({ score: 7 }),
    goodCell({ score: 9 }),
  ]);
  assert.equal(r.stopped, false);
  assert.equal(r.stopReason, null);
  assert.equal(r.htfBias, "long");
  assert.equal(r.avgScore.toFixed(2), "8.00");
});

test("evaluateHtfChain: first cell direction=none → STOP no_trend", () => {
  const r = evaluateHtfChain([
    goodCell({ direction: "none", score: 0, probability_next_candle_in_bias: 0 }),
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

test("evaluateHtfChain: cell score < 7 AND probability < 75 → STOP htf_quality_low", () => {
  const r = evaluateHtfChain([
    goodCell({ score: 8 }),
    goodCell({ score: 5, probability_next_candle_in_bias: 60 }),
    goodCell({ score: 8 }),
  ]);
  assert.equal(r.stopped, true);
  assert.equal(r.stopAt, "1W");
  assert.equal(r.stopReason, "htf_quality_low");
});

// ─── evaluateHtfChain — door B: probability ≥ 75 ─────────────────────────

test("evaluateHtfChain: low score but high probability → pass", () => {
  const r = evaluateHtfChain([
    goodCell({ score: 5, probability_next_candle_in_bias: 80 }),
    goodCell({ score: 4, probability_next_candle_in_bias: 78 }),
    goodCell({ score: 6, probability_next_candle_in_bias: 76 }),
  ]);
  assert.equal(r.stopped, false);
  assert.equal(r.htfBias, "long");
});

test("evaluateHtfChain: red flag on a cell → STOP htf_quality_low", () => {
  const r = evaluateHtfChain([
    goodCell({ score: 9 }),
    goodCell({ score: 9, red_flags: ["choppy_structure"] }),
    goodCell({ score: 9 }),
  ]);
  assert.equal(r.stopped, true);
  assert.equal(r.stopAt, "1W");
  assert.equal(r.stopReason, "htf_quality_low");
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
