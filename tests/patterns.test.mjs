import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isHammerShape,
  isSolidGreen,
  isSolidRed,
  wickToBodyRatio,
  findSwings,
  touchesZone,
  calcRR,
} from "../bot.js";

// ─── Hammer / Hanging Man shape ────────────────────────────────────────────

test("textbook hammer is detected", () => {
  const c = { open: 100, high: 101, low: 95, close: 100.5 };
  assert.equal(isHammerShape(c), true);
});

test("textbook hanging man (same shape, context-independent) is detected", () => {
  const c = { open: 100.5, high: 101, low: 95, close: 100 };
  assert.equal(isHammerShape(c), true);
});

test("normal indecision candle is NOT a hammer", () => {
  const c = { open: 100, high: 102, low: 98, close: 101 };
  assert.equal(isHammerShape(c), false);
});

test("solid bullish candle is NOT a hammer", () => {
  const c = { open: 100, high: 105, low: 99.5, close: 104.5 };
  assert.equal(isHammerShape(c), false);
});

test("inverted hammer (upper wick) is NOT a hammer", () => {
  const c = { open: 100, high: 106, low: 99.5, close: 100.3 };
  assert.equal(isHammerShape(c), false);
});

test("doji with no range is rejected safely", () => {
  const c = { open: 100, high: 100, low: 100, close: 100 };
  assert.equal(isHammerShape(c), false);
});

// ─── Solid green / red ──────────────────────────────────────────────────────

test("solid green: body ≥ 60% of range", () => {
  const c = { open: 100, high: 104.2, low: 99.8, close: 104 };
  assert.equal(isSolidGreen(c), true);
  assert.equal(isSolidRed(c), false);
});

test("solid red: body ≥ 60% of range", () => {
  const c = { open: 104, high: 104.2, low: 99.8, close: 100 };
  assert.equal(isSolidRed(c), true);
  assert.equal(isSolidGreen(c), false);
});

test("small-body green with long wicks is NOT solid green", () => {
  const c = { open: 100, high: 103, low: 97, close: 100.5 };
  assert.equal(isSolidGreen(c), false);
});

test("bearish doji is neither solid green nor solid red", () => {
  const c = { open: 100, high: 102, low: 98, close: 99.9 };
  assert.equal(isSolidGreen(c), false);
  assert.equal(isSolidRed(c), false);
});

// ─── Wick/body ratio ────────────────────────────────────────────────────────

test("wickToBodyRatio returns ∞ for zero-body doji", () => {
  const c = { open: 100, high: 105, low: 95, close: 100 };
  assert.equal(wickToBodyRatio(c, "lower"), Infinity);
});

test("hammer has lower-wick ratio ≥ 2", () => {
  const c = { open: 100, high: 101, low: 95, close: 100.5 };
  const r = wickToBodyRatio(c, "lower");
  assert.equal(r >= 2, true);
});

// ─── Swing detection ────────────────────────────────────────────────────────

test("findSwings identifies a pivot high in the middle", () => {
  const candles = [
    { open: 1, high: 10, low: 0, close: 5 },
    { open: 1, high: 11, low: 0, close: 5 },
    { open: 1, high: 15, low: 0, close: 5 }, // pivot high
    { open: 1, high: 12, low: 0, close: 5 },
    { open: 1, high: 10, low: 0, close: 5 },
  ];
  const { highs } = findSwings(candles, 2);
  assert.equal(highs.length, 1);
  assert.equal(highs[0].price, 15);
  assert.equal(highs[0].index, 2);
});

// ─── Zone touching ──────────────────────────────────────────────────────────

test("touchesZone: wick overlaps EMA level", () => {
  const c = { open: 100, high: 101, low: 95, close: 100.5 };
  assert.equal(touchesZone(c, [97], 0.3), true);
});

test("touchesZone: zone far from candle range", () => {
  const c = { open: 100, high: 101, low: 99, close: 100.5 };
  assert.equal(touchesZone(c, [50], 0.3), false);
});

test("touchesZone: handles non-numeric zone gracefully", () => {
  const c = { open: 100, high: 101, low: 99, close: 100.5 };
  assert.equal(touchesZone(c, [null, undefined, NaN], 0.3), false);
});

// ─── R:R ────────────────────────────────────────────────────────────────────

test("calcRR for 1:2 setup", () => {
  assert.equal(calcRR(100, 95, 110), 2); // risk 5, reward 10
});

test("calcRR with zero risk returns 0 (guard)", () => {
  assert.equal(calcRR(100, 100, 110), 0);
});
