import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSetupMatchCount } from "../src/scanner.js";

test("computeSetupMatchCount: pullback all signals true → count 3, required and bonus satisfied", () => {
  const cell = {
    setup_type: "pullback",
    angle_ok: true,
    zone_rejection: true,
    coc_present: true,
    solid_continuation: true,
    prep_signals_count: 4,
  };
  const r = computeSetupMatchCount(cell);
  assert.equal(r.count, 3);
  assert.equal(r.required_satisfied, true);
  assert.equal(r.bonus_satisfied, true);
  assert.deepEqual(r.missing_required, []);
});

test("computeSetupMatchCount: pullback missing zone_rejection → required NOT satisfied", () => {
  const cell = {
    setup_type: "pullback",
    angle_ok: true,
    zone_rejection: false,
    coc_present: false,
    solid_continuation: true,
    prep_signals_count: 2,
  };
  const r = computeSetupMatchCount(cell);
  assert.equal(r.count, 2);
  assert.equal(r.required_satisfied, false);
  assert.deepEqual(r.missing_required, ["zone_rejection"]);
});

test("computeSetupMatchCount: continuation required only → count 2, required satisfied, bonus not", () => {
  const cell = {
    setup_type: "continuation",
    angle_ok: true,
    zone_rejection: false,
    coc_present: false,
    solid_continuation: true,
    prep_signals_count: 2,
  };
  const r = computeSetupMatchCount(cell);
  assert.equal(r.count, 2);
  assert.equal(r.required_satisfied, true);
  assert.equal(r.bonus_satisfied, false);
});

test("computeSetupMatchCount: continuation missing solid_continuation → required NOT satisfied", () => {
  const cell = {
    setup_type: "continuation",
    angle_ok: true,
    zone_rejection: true,
    coc_present: false,
    solid_continuation: false,
    prep_signals_count: 2,
  };
  const r = computeSetupMatchCount(cell);
  assert.equal(r.required_satisfied, false);
  assert.deepEqual(r.missing_required, ["solid_continuation"]);
});

test("computeSetupMatchCount: setup_type=none falls back to legacy prep_signals_count", () => {
  const cell = {
    setup_type: "none",
    angle_ok: true,
    zone_rejection: true,
    coc_present: false,
    solid_continuation: false,
    prep_signals_count: 2,
  };
  const r = computeSetupMatchCount(cell);
  assert.equal(r.count, 2);
  assert.equal(r.required_satisfied, true);
});

test("computeSetupMatchCount: missing setup_type uses legacy", () => {
  const cell = {
    angle_ok: true,
    prep_signals_count: 1,
  };
  const r = computeSetupMatchCount(cell);
  assert.equal(r.count, 1);
  assert.equal(r.required_satisfied, false);
});

test("computeSetupMatchCount: null/undefined cell → safe defaults", () => {
  const r = computeSetupMatchCount(null);
  assert.equal(r.count, 0);
  assert.equal(r.required_satisfied, false);
});
