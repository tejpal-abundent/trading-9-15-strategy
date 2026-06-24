// V2.6 — SMC primitives tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findSwings,
  detectFVGs,
  detectBosChoCH,
  detectLiquiditySweeps,
  computeSmcContext,
  formatSmcContextForPrompt,
} from "../src/smc.js";

// Helper: build bar with defaults so tests stay readable.
const bar = (o, h, l, c, t = 0) => ({ time: t, open: o, high: h, low: l, close: c });

// ─── findSwings ──────────────────────────────────────────────────────────

test("findSwings: simple peak in middle of 5 bars → swing high at index 2", () => {
  // index:    0    1    2    3    4
  // high:    10   12   15   13   11
  const bars = [bar(9, 10, 9, 10), bar(10, 12, 10, 11), bar(11, 15, 11, 14), bar(14, 13, 12, 13), bar(13, 11, 10, 11)];
  const swings = findSwings(bars, 2);
  const highs = swings.filter((s) => s.type === "high");
  assert.equal(highs.length, 1);
  assert.equal(highs[0].index, 2);
  assert.equal(highs[0].level, 15);
});

test("findSwings: simple trough in middle → swing low at index 2", () => {
  const bars = [bar(11, 12, 10, 11), bar(10, 11, 9, 10), bar(9, 10, 5, 6), bar(6, 9, 7, 8), bar(8, 11, 8, 10)];
  const swings = findSwings(bars, 2);
  const lows = swings.filter((s) => s.type === "low");
  assert.equal(lows.length, 1);
  assert.equal(lows[0].level, 5);
});

test("findSwings: too few bars → empty", () => {
  assert.deepEqual(findSwings([bar(1, 2, 1, 2), bar(2, 3, 1, 2)], 2), []);
});

test("findSwings: equal-high neighbor disqualifies as swing", () => {
  // index 2 high 15, index 3 high also 15 → neither is a strict pivot.
  const bars = [bar(9, 10, 9, 10), bar(10, 12, 10, 11), bar(11, 15, 11, 14), bar(14, 15, 12, 13), bar(13, 11, 10, 11)];
  const swings = findSwings(bars, 2).filter((s) => s.type === "high");
  assert.equal(swings.length, 0);
});

// ─── detectFVGs ──────────────────────────────────────────────────────────

test("detectFVGs: bullish FVG when bar i.low > bar i-2.high", () => {
  // bar 0: high 10, low 9
  // bar 1: bridge
  // bar 2: low 12 > bar 0 high 10 → bullish FVG (gap 10..12)
  const bars = [bar(9, 10, 9, 10), bar(10, 11.5, 10, 11), bar(11.5, 14, 12, 13)];
  const fvgs = detectFVGs(bars);
  assert.equal(fvgs.length, 1);
  assert.equal(fvgs[0].type, "bullish");
  assert.equal(fvgs[0].bottom, 10);
  assert.equal(fvgs[0].top, 12);
  assert.equal(fvgs[0].mitigated_at, null);
});

test("detectFVGs: bearish FVG when bar i.high < bar i-2.low", () => {
  const bars = [bar(15, 16, 14, 15), bar(14, 14, 13, 13), bar(13, 12, 10, 11)];
  const fvgs = detectFVGs(bars);
  assert.equal(fvgs.length, 1);
  assert.equal(fvgs[0].type, "bearish");
  assert.equal(fvgs[0].top, 14);
  assert.equal(fvgs[0].bottom, 12);
});

test("detectFVGs: bullish FVG mitigated when later bar wicks back to top", () => {
  // bridge bar (i=1) high=13 prevents a SECOND FVG from forming at i=3.
  // bar 4 wicks down to 11.5 (≤ top=12) → mitigated.
  const bars = [
    bar(9, 10, 9, 10),
    bar(10, 13, 10, 11),       // bridge: high=13 (so bars[3].low<13 → no FVG at 3)
    bar(11, 14, 12, 13),       // bullish FVG (10..12) at i=2
    bar(13, 14, 12.5, 13),     // low=12.5 > top=12 — no mitigation yet
    bar(12.5, 13, 11.5, 12),   // low=11.5 ≤ top=12 → mitigation at i=4
  ];
  const fvgs = detectFVGs(bars);
  assert.equal(fvgs.length, 1);
  assert.equal(fvgs[0].mitigated_at, 4);
});

test("detectFVGs: no gap when bars overlap → empty", () => {
  const bars = [bar(9, 11, 9, 10), bar(10, 12, 10, 11), bar(11, 13, 11, 12)];
  assert.deepEqual(detectFVGs(bars), []);
});

// ─── detectBosChoCH ──────────────────────────────────────────────────────

test("detectBosChoCH: bullish BOS when close breaks last swing high", () => {
  // Mock swings directly so this tests detectBosChoCH in isolation
  // (findSwings is exercised by its own tests above).
  // bar at index 4 closes 16 > swing high level 15 → bullish BOS.
  const bars = [
    bar(9, 10, 9, 10),
    bar(10, 12, 10, 11),
    bar(11, 15, 11, 14),
    bar(14, 14, 12, 13),
    bar(13, 17, 13, 16),
  ];
  const swings = [{ index: 2, type: "high", level: 15 }];
  const r = detectBosChoCH(bars, swings);
  assert.ok(r.last_bos);
  assert.equal(r.last_bos.direction, "bullish");
  assert.equal(r.last_bos.level, 15);
});

test("detectBosChoCH: bearish CHoCH after bullish BOS", () => {
  // Mock swings: high at 15 broken upward (BOS), then low at 13 broken
  // downward (CHoCH bearish — trend was up).
  const bars = [
    bar(9, 10, 9, 10),
    bar(10, 12, 10, 11),
    bar(11, 15, 11, 14),  // swing high 15 (mocked)
    bar(14, 14, 12, 13),
    bar(14, 17, 14, 16),  // close 16 > 15 → BOS bullish, trend=up
    bar(16, 18, 15, 17),
    bar(17, 17, 13, 14),  // swing low 13 (mocked)
    bar(14, 15, 13, 14),
    bar(14, 14, 11, 11),  // close 11 < 13 → CHoCH bearish (trend was up)
  ];
  const swings = [
    { index: 2, type: "high", level: 15 },
    { index: 6, type: "low", level: 13 },
  ];
  const r = detectBosChoCH(bars, swings);
  assert.ok(r.last_bos);
  assert.equal(r.last_bos.direction, "bullish");
  assert.ok(r.last_choch);
  assert.equal(r.last_choch.direction, "bearish");
});

test("detectBosChoCH: empty bars / no swings → null", () => {
  assert.deepEqual(detectBosChoCH([], []), { last_bos: null, last_choch: null });
});

// ─── detectLiquiditySweeps ───────────────────────────────────────────────

test("detectLiquiditySweeps: two equal highs followed by sweep+close-back-below", () => {
  // Two swing highs at the SAME level (15.00), then a bar wicks above and closes below.
  const bars = [
    bar(9, 10, 9, 10),
    bar(10, 12, 10, 11),
    bar(11, 15, 11, 14),  // swing high #1 = 15
    bar(14, 14, 12, 13),
    bar(13, 14, 12, 13),
    bar(13, 15, 13, 14),  // swing high #2 = 15 (equal)
    bar(14, 14, 13, 13),
    bar(13, 13, 12, 12),
    bar(12, 16, 11, 13),  // bar.high=16 > 15, close=13 < 15 → high_sweep
  ];
  const swings = findSwings(bars, 2);
  const sweeps = detectLiquiditySweeps(bars, swings, 0.001);
  assert.ok(sweeps.length >= 1);
  assert.equal(sweeps[0].type, "high_sweep");
  assert.equal(sweeps[0].level, 15);
});

test("detectLiquiditySweeps: equal lows + low_sweep mirror case", () => {
  const bars = [
    bar(11, 12, 10, 11),
    bar(10, 11, 9, 10),
    bar(9, 10, 5, 6),     // swing low #1 = 5
    bar(6, 8, 6, 7),
    bar(7, 8, 6, 7),
    bar(7, 8, 5, 6),      // swing low #2 = 5 (equal)
    bar(6, 7, 6, 7),
    bar(7, 8, 7, 8),
    bar(8, 9, 4, 7),      // bar.low=4 < 5, close=7 > 5 → low_sweep
  ];
  const swings = findSwings(bars, 2);
  const sweeps = detectLiquiditySweeps(bars, swings, 0.001);
  assert.ok(sweeps.length >= 1);
  assert.equal(sweeps[0].type, "low_sweep");
});

test("detectLiquiditySweeps: only one swing high → no cluster → no sweep", () => {
  const bars = [
    bar(9, 10, 9, 10),
    bar(10, 12, 10, 11),
    bar(11, 15, 11, 14),
    bar(14, 14, 12, 13),
    bar(13, 16, 13, 15),
  ];
  const swings = findSwings(bars, 2);
  const sweeps = detectLiquiditySweeps(bars, swings, 0.001);
  assert.equal(sweeps.length, 0);
});

// ─── computeSmcContext ───────────────────────────────────────────────────

test("computeSmcContext: short bias + recent bearish CHoCH → recent_choch_in_bias", () => {
  // Build bars with a clean swing high (i=2 lvl 15), bullish BOS at i=5,
  // swing low (i=8 lvl 13), then close < 13 at i=11 → CHoCH bearish.
  // RECENT_LOOKBACK=5 → CHoCH at i=11, last bar i=12, distance=1, in window.
  const bars = [
    bar(9, 10, 9, 10),       // 0
    bar(10, 12, 10, 11),     // 1
    bar(11, 15, 11, 14),     // 2 swing high 15
    bar(14, 14, 13, 13),     // 3
    bar(14, 14, 13, 13),     // 4
    bar(14, 17, 14, 16),     // 5 close 16 > 15 → BOS bullish, trend=up
    bar(16, 17, 16, 17),     // 6
    bar(17, 18, 16, 17),     // 7
    bar(16, 17, 13, 14),     // 8 swing low 13
    bar(14, 15, 14, 15),     // 9
    bar(15, 16, 15, 15),     // 10
    bar(15, 15, 11, 11),     // 11 close 11 < 13 → CHoCH bearish
    bar(11, 12, 10, 11),     // 12 - 1 bar after CHoCH
  ];
  const ctx = computeSmcContext(bars, "short");
  assert.equal(ctx.recent_choch_in_bias, true, `recent_choch_in_bias should be true; got context: ${JSON.stringify({ last_choch: ctx.last_choch, last_idx: bars.length - 1 })}`);
  assert.ok(ctx.bonus_count >= 1);
});

test("computeSmcContext: long bias with bearish CHoCH → no bonus from choch", () => {
  const bars = [
    bar(9, 10, 9, 10), bar(10, 12, 10, 11), bar(11, 15, 11, 14),
    bar(14, 14, 13, 13), bar(14, 14, 13, 13), bar(14, 17, 14, 16),
    bar(16, 17, 16, 17), bar(17, 18, 16, 17), bar(16, 17, 13, 14),
    bar(14, 15, 14, 15), bar(15, 16, 15, 15), bar(15, 15, 11, 11),
    bar(11, 12, 10, 11),
  ];
  const ctx = computeSmcContext(bars, "long");
  assert.equal(ctx.recent_choch_in_bias, false);
});

test("computeSmcContext: empty bars → empty bonus_count=0", () => {
  const ctx = computeSmcContext([], "long");
  assert.equal(ctx.bonus_count, 0);
  assert.deepEqual(ctx.swings, []);
});

test("computeSmcContext: long bias with unmitigated bullish FVG below price → unmitigated_fvg_in_bias", () => {
  // bullish FVG at bars[2] (gap 10..12), price walks up to 13 and never wicks back.
  const bars = [
    bar(9, 10, 9, 10),
    bar(10, 11.5, 10, 11),
    bar(11.5, 14, 12, 13),  // bullish FVG created (10..12)
    bar(13, 14, 12.5, 13),  // does not wick into 12 → unmitigated
    bar(13, 14, 12.5, 13),
    bar(13, 14, 12.5, 13),
  ];
  const ctx = computeSmcContext(bars, "long");
  assert.equal(ctx.unmitigated_fvg_in_bias, true);
});

test("formatSmcContextForPrompt: returns prompt-shaped lines", () => {
  const bars = [
    bar(9, 10, 9, 10),
    bar(10, 12, 10, 11),
    bar(11, 15, 11, 14),
    bar(14, 14, 12, 13),
    bar(13, 17, 13, 16),
  ];
  const ctx = computeSmcContext(bars, "long");
  const out = formatSmcContextForPrompt(ctx);
  assert.match(out, /SMC ground truth/);
  assert.match(out, /BOS|CHoCH|FVG/);
});
