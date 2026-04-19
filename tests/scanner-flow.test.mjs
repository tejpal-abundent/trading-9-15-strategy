import { test } from "node:test";
import assert from "node:assert/strict";
import { ltfCellState, evaluateHtfChain, dailyCellState, dailyTriggerType } from "../src/scanner.js";

// ─── ltfCellState — NONE: insufficient prep or red flags ─────────────────

test("ltfCellState: 0 prep signals → NONE", () => {
  const cell = {
    angle_ok: false,
    zone_rejection: false,
    coc_present: false,
    solid_continuation: false,
    strong_candle_in_bias: true,
    probability_next_candle_in_bias: 90,
    red_flags: [],
  };
  assert.equal(ltfCellState(cell), "NONE");
});

test("ltfCellState: 1 prep signal → NONE (below threshold)", () => {
  const cell = {
    angle_ok: true,
    zone_rejection: false,
    coc_present: false,
    solid_continuation: false,
    strong_candle_in_bias: true,
    probability_next_candle_in_bias: 95,
    red_flags: [],
  };
  assert.equal(ltfCellState(cell), "NONE");
});

test("ltfCellState: high probability alone does NOT pass (no probability door)", () => {
  const cell = {
    angle_ok: false,
    zone_rejection: false,
    coc_present: false,
    solid_continuation: false,
    strong_candle_in_bias: true,
    probability_next_candle_in_bias: 95,
    red_flags: [],
  };
  assert.equal(ltfCellState(cell), "NONE");
});

test("ltfCellState: strong_candle_in_bias alone (no prep) → NONE (trigger is not a prep signal)", () => {
  const cell = {
    angle_ok: false,
    zone_rejection: false,
    coc_present: false,
    solid_continuation: false,
    strong_candle_in_bias: true,
    red_flags: [],
  };
  assert.equal(ltfCellState(cell), "NONE");
});

// ─── ltfCellState — WATCH: prep ready, confirmation not closed ───────────

test("ltfCellState: 2 prep signals + trigger false → WATCH", () => {
  const cell = {
    angle_ok: true,
    zone_rejection: true,
    coc_present: false,
    solid_continuation: false,
    strong_candle_in_bias: false,
    probability_next_candle_in_bias: 50,
    red_flags: [],
  };
  assert.equal(ltfCellState(cell), "WATCH");
});

test("ltfCellState: 4 prep signals + trigger false → WATCH (still needs close)", () => {
  const cell = {
    angle_ok: true,
    zone_rejection: true,
    coc_present: true,
    solid_continuation: true,
    strong_candle_in_bias: false,
    probability_next_candle_in_bias: 90,
    red_flags: [],
  };
  assert.equal(ltfCellState(cell), "WATCH");
});

// ─── ltfCellState — ENTER: prep ready AND trigger closed ─────────────────

test("ltfCellState: 2 prep signals + trigger true → ENTER", () => {
  const cell = {
    angle_ok: true,
    zone_rejection: true,
    coc_present: false,
    solid_continuation: false,
    strong_candle_in_bias: true,
    probability_next_candle_in_bias: 50,
    red_flags: [],
  };
  assert.equal(ltfCellState(cell), "ENTER");
});

test("ltfCellState: all 4 prep + trigger true → ENTER", () => {
  const cell = {
    angle_ok: true,
    zone_rejection: true,
    coc_present: true,
    solid_continuation: true,
    strong_candle_in_bias: true,
    probability_next_candle_in_bias: 80,
    red_flags: [],
  };
  assert.equal(ltfCellState(cell), "ENTER");
});

// ─── ltfCellState — red flags veto every state ───────────────────────────

test("ltfCellState: full prep + trigger + red flag → NONE (red flags veto)", () => {
  const cell = {
    angle_ok: true,
    zone_rejection: true,
    coc_present: true,
    solid_continuation: true,
    strong_candle_in_bias: true,
    probability_next_candle_in_bias: 95,
    red_flags: ["choppy_structure"],
  };
  assert.equal(ltfCellState(cell), "NONE");
});

test("ltfCellState: WATCH-eligible + red flag → NONE", () => {
  const cell = {
    angle_ok: true,
    zone_rejection: true,
    strong_candle_in_bias: false,
    red_flags: ["doji_cluster"],
  };
  assert.equal(ltfCellState(cell), "NONE");
});

// ─── ltfCellState — safety on missing/invalid input ──────────────────────

test("ltfCellState: missing fields → NONE", () => {
  assert.equal(ltfCellState({}), "NONE");
  assert.equal(ltfCellState(null), "NONE");
  assert.equal(ltfCellState(undefined), "NONE");
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

// ─── evaluateHtfChain — parse failure is distinct from no_trend ──────────

test("evaluateHtfChain: cell.parse_failed → STOP llm_parse_error (not no_trend)", () => {
  const r = evaluateHtfChain([
    goodCell({ score: 8 }),
    { parse_failed: true, direction: undefined, score: 0, red_flags: [] },
    goodCell(),
  ]);
  assert.equal(r.stopped, true);
  assert.equal(r.stopAt, "1W");
  assert.equal(r.stopReason, "llm_parse_error");
});

test("evaluateHtfChain: parse_failed on first cell → stop at 1M with llm_parse_error", () => {
  const r = evaluateHtfChain([
    { parse_failed: true, direction: undefined, score: 0, red_flags: [] },
    goodCell(),
    goodCell(),
  ]);
  assert.equal(r.stopped, true);
  assert.equal(r.stopAt, "1M");
  assert.equal(r.stopReason, "llm_parse_error");
});

test("evaluateHtfChain: direction='none' without parse_failed → STOP no_trend", () => {
  // Regression — the existing no_trend path must still fire when the model
  // explicitly returns "none" rather than failing to parse.
  const r = evaluateHtfChain([
    goodCell({ direction: "none", score: 0, parse_failed: false }),
    goodCell(),
    goodCell(),
  ]);
  assert.equal(r.stopped, true);
  assert.equal(r.stopReason, "no_trend");
});

// ─── dailyCellState — NONE: direction_conflict, red_flags, insufficient prep ────

test("dailyCellState: direction_conflict=true → NONE", () => {
  const cell = {
    direction_conflict: true,
    prep_signals_count: 4,
    red_flags: [],
    candle_verdict: { in_bias: true, winner_strength: 10, pattern: "solid_bull", liquidity_swept: "none" },
  };
  assert.equal(dailyCellState(cell), "NONE");
});

test("dailyCellState: red_flags present → NONE", () => {
  const cell = {
    direction_conflict: false,
    prep_signals_count: 4,
    red_flags: ["choppy_structure"],
    candle_verdict: { in_bias: true, winner_strength: 10, pattern: "solid_bull", liquidity_swept: "none" },
  };
  assert.equal(dailyCellState(cell), "NONE");
});

test("dailyCellState: prep_signals_count < 2 → NONE", () => {
  const cell = {
    direction_conflict: false,
    prep_signals_count: 1,
    red_flags: [],
    candle_verdict: { in_bias: true, winner_strength: 10, pattern: "solid_bull", liquidity_swept: "none" },
  };
  assert.equal(dailyCellState(cell), "NONE");
});

// ─── dailyCellState — WATCH: prep ready, trigger not confirmed ─────────────────

test("dailyCellState: prep ready but candle_verdict.in_bias=false → WATCH", () => {
  const cell = {
    direction_conflict: false,
    prep_signals_count: 2,
    red_flags: [],
    candle_verdict: { in_bias: false, winner_strength: 8, pattern: "solid_bull", liquidity_swept: "none" },
  };
  assert.equal(dailyCellState(cell), "WATCH");
});

test("dailyCellState: prep ready, in_bias=true but winner_strength < 7 → WATCH", () => {
  const cell = {
    direction_conflict: false,
    prep_signals_count: 3,
    red_flags: [],
    candle_verdict: { in_bias: true, winner_strength: 5, pattern: "doji", liquidity_swept: "none" },
  };
  assert.equal(dailyCellState(cell), "WATCH");
});

// ─── dailyCellState — ENTER: prep ready AND candle confirms ────────────────────

test("dailyCellState: prep 2, in_bias=true, winner_strength 7 → ENTER", () => {
  const cell = {
    direction_conflict: false,
    prep_signals_count: 2,
    red_flags: [],
    candle_verdict: { in_bias: true, winner_strength: 7, pattern: "solid_bull", liquidity_swept: "none" },
  };
  assert.equal(dailyCellState(cell), "ENTER");
});

test("dailyCellState: full prep + hammer with sweep → ENTER", () => {
  const cell = {
    direction_conflict: false,
    prep_signals_count: 4,
    red_flags: [],
    candle_verdict: {
      in_bias: true,
      winner_strength: 9,
      pattern: "hammer",
      liquidity_swept: "below_prior_low",
    },
  };
  assert.equal(dailyCellState(cell), "ENTER");
});

// ─── dailyCellState — safety on missing/invalid input ──────────────────────────

test("dailyCellState: missing candle_verdict → NONE", () => {
  assert.equal(
    dailyCellState({ prep_signals_count: 4, red_flags: [], direction_conflict: false }),
    "NONE",
  );
});

test("dailyCellState: null or missing cell → NONE", () => {
  assert.equal(dailyCellState(null), "NONE");
  assert.equal(dailyCellState(undefined), "NONE");
  assert.equal(dailyCellState({}), "NONE");
});

// ─── dailyTriggerType — classifies the ENTER reason ─────────────────────────────

test("dailyTriggerType: sweep trigger for long (below_prior_low)", () => {
  const cell = {
    direction_conflict: false,
    prep_signals_count: 3,
    red_flags: [],
    candle_verdict: {
      in_bias: true,
      winner_strength: 9,
      pattern: "hammer",
      liquidity_swept: "below_prior_low",
    },
  };
  assert.equal(dailyTriggerType(cell, "long"), "sweep");
});

test("dailyTriggerType: pattern trigger for long (engulfing_bull, no sweep)", () => {
  const cell = {
    direction_conflict: false,
    prep_signals_count: 3,
    red_flags: [],
    candle_verdict: {
      in_bias: true,
      winner_strength: 8,
      pattern: "engulfing_bull",
      liquidity_swept: "none",
    },
  };
  assert.equal(dailyTriggerType(cell, "long"), "pattern");
});

test("dailyTriggerType: momentum trigger for short (solid_bear, no sweep)", () => {
  const cell = {
    direction_conflict: false,
    prep_signals_count: 3,
    red_flags: [],
    candle_verdict: {
      in_bias: true,
      winner_strength: 8,
      pattern: "solid_bear",
      liquidity_swept: "none",
    },
  };
  assert.equal(dailyTriggerType(cell, "short"), "momentum");
});

test("dailyTriggerType: sweep trigger for short (above_prior_high)", () => {
  const cell = {
    direction_conflict: false,
    prep_signals_count: 3,
    red_flags: [],
    candle_verdict: {
      in_bias: true,
      winner_strength: 9,
      pattern: "shooting_star",
      liquidity_swept: "above_prior_high",
    },
  };
  assert.equal(dailyTriggerType(cell, "short"), "sweep");
});

test("dailyTriggerType: returns 'none' for invalid weeklyBias", () => {
  const cell = {
    direction_conflict: false,
    prep_signals_count: 3,
    red_flags: [],
    candle_verdict: {
      in_bias: true,
      winner_strength: 9,
      pattern: "solid_bull",
      liquidity_swept: "none",
    },
  };
  assert.equal(dailyTriggerType(cell, null), "none");
  assert.equal(dailyTriggerType(cell, undefined), "none");
  assert.equal(dailyTriggerType(cell, "flat"), "none");
});

test("dailyTriggerType: returns 'none' when state !== ENTER", () => {
  const cell = {
    direction_conflict: false,
    prep_signals_count: 1, // < 2 → NONE
    red_flags: [],
    candle_verdict: {
      in_bias: true,
      winner_strength: 9,
      pattern: "solid_bull",
      liquidity_swept: "below_prior_low",
    },
  };
  assert.equal(dailyTriggerType(cell, "long"), "none");
});
