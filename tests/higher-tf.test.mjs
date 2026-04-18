import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emaSeries,
  emaAlignment,
  agree,
  priceInZone,
} from "../src/higher-tf.js";

// ─── emaSeries ────────────────────────────────────────────────────────────

test("emaSeries returns null-padded array with length == input", () => {
  const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  const out = emaSeries(closes, 5);
  assert.equal(out.length, closes.length);
  assert.equal(out[0], null);
  assert.equal(out[3], null);
  assert.notEqual(out[4], null);
});

test("emaSeries converges toward steady-state closes", () => {
  const closes = Array(30).fill(100);
  const out = emaSeries(closes, 10);
  assert.ok(Math.abs(out.at(-1) - 100) < 0.0001);
});

// ─── emaAlignment ─────────────────────────────────────────────────────────

function mkCandles(closes) {
  return closes.map((c, i) => ({
    time: i,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1,
  }));
}

test("emaAlignment returns bullish when price ramps up steadily", () => {
  // 40 candles with steadily increasing closes — EMA9 > EMA15, both rising
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
  const alignment = emaAlignment(mkCandles(closes));
  assert.equal(alignment.direction, "bullish");
  assert.ok(alignment.ema9 > alignment.ema15);
  assert.ok(alignment.slope9 > 0);
  assert.ok(alignment.slope15 > 0);
});

test("emaAlignment returns bearish when price ramps down steadily", () => {
  const closes = Array.from({ length: 40 }, (_, i) => 200 - i);
  const alignment = emaAlignment(mkCandles(closes));
  assert.equal(alignment.direction, "bearish");
  assert.ok(alignment.ema9 < alignment.ema15);
});

test("emaAlignment returns null on flat / choppy series", () => {
  const closes = Array(40).fill(100);
  const alignment = emaAlignment(mkCandles(closes));
  assert.equal(alignment.direction, null);
});

test("emaAlignment returns null when EMA9 > EMA15 but slopes conflict", () => {
  // Long uptrend then reversal — EMAs still ordered bullishly but slopes flip
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 10 }, (_, i) => 130 - i);
  const alignment = emaAlignment(mkCandles([...up, ...down]));
  assert.equal(alignment.direction, null);
});

// ─── agree ─────────────────────────────────────────────────────────────────

test("agree: all bullish → bullish", () => {
  assert.equal(
    agree(
      { direction: "bullish" },
      { direction: "bullish" },
      { direction: "bullish" },
    ),
    "bullish",
  );
});

test("agree: mixed → null", () => {
  assert.equal(
    agree(
      { direction: "bullish" },
      { direction: "bearish" },
      { direction: "bullish" },
    ),
    null,
  );
});

test("agree: any null → null", () => {
  assert.equal(
    agree({ direction: "bullish" }, { direction: null }),
    null,
  );
});

// ─── priceInZone ───────────────────────────────────────────────────────────

test("priceInZone: candle range overlaps EMA band", () => {
  const candle = { open: 100, high: 102, low: 98, close: 101 };
  assert.equal(priceInZone(candle, 100, 99, 0.5), true);
});

test("priceInZone: candle entirely above EMA band", () => {
  const candle = { open: 110, high: 112, low: 109, close: 111 };
  assert.equal(priceInZone(candle, 100, 99, 0.5), false);
});

test("priceInZone: tolerance allows near-misses", () => {
  const candle = { open: 100.3, high: 100.5, low: 100.1, close: 100.4 };
  // EMA9=99, EMA15=99.5 — candle sits just above, 0.5% tolerance pulls it in
  assert.equal(priceInZone(candle, 99, 99.5, 1.0), true);
});

test("priceInZone: missing EMA returns false safely", () => {
  const candle = { open: 100, high: 102, low: 98, close: 101 };
  assert.equal(priceInZone(candle, null, 99), false);
});
