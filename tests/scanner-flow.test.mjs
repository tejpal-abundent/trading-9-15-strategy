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
