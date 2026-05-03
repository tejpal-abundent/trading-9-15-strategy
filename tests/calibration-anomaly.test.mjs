import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCalibrationAnomaly } from "../src/scanner.js";

function mkResult(symbol, stop_reason, grade = "—") {
  return { symbol, stop_reason, confluence_grade: grade };
}

test("detectCalibrationAnomaly: 25/25 same reason → fires", () => {
  const results = Array.from({ length: 25 }, (_, i) => mkResult(`S${i}`, "weekly_red_flag_fatal"));
  const a = detectCalibrationAnomaly(results);
  assert.ok(a, "expected anomaly object");
  assert.equal(a.topReason, "weekly_red_flag_fatal");
  assert.equal(a.topCount, 25);
  assert.equal(a.dominance, 1.0);
});

test("detectCalibrationAnomaly: 19/20 same reason → fires (>= 0.9)", () => {
  const results = [
    ...Array.from({ length: 19 }, (_, i) => mkResult(`S${i}`, "weekly_red_flag_fatal")),
    mkResult("X", "monthly_no_trend"),
  ];
  const a = detectCalibrationAnomaly(results);
  assert.ok(a);
  assert.ok(a.dominance >= 0.9);
});

test("detectCalibrationAnomaly: 50/50 split → silent (no dominance)", () => {
  const results = [
    ...Array.from({ length: 10 }, (_, i) => mkResult(`A${i}`, "weekly_red_flag_fatal")),
    ...Array.from({ length: 10 }, (_, i) => mkResult(`B${i}`, "monthly_no_trend")),
  ];
  assert.equal(detectCalibrationAnomaly(results), null);
});

test("detectCalibrationAnomaly: had a candidate → silent", () => {
  const results = [
    ...Array.from({ length: 24 }, (_, i) => mkResult(`S${i}`, "weekly_red_flag_fatal")),
    mkResult("WIN", null, "B"),
  ];
  assert.equal(detectCalibrationAnomaly(results), null);
});

test("detectCalibrationAnomaly: small watchlist (4) → silent", () => {
  const results = Array.from({ length: 4 }, (_, i) => mkResult(`S${i}`, "weekly_red_flag_fatal"));
  assert.equal(detectCalibrationAnomaly(results), null);
});

test("detectCalibrationAnomaly: empty results → silent", () => {
  assert.equal(detectCalibrationAnomaly([]), null);
});

test("detectCalibrationAnomaly: results with no stop_reasons → silent", () => {
  const results = Array.from({ length: 5 }, (_, i) => mkResult(`S${i}`, null, "B"));
  assert.equal(detectCalibrationAnomaly(results), null);
});
