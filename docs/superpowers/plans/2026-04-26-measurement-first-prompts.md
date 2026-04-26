# Measurement-first prompts + cell-consistency check — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut V2 false negatives (e.g. the AUDUSD `weekly_red_flag: exhaustion` cascade) by reshaping the 3 V2 prompts into a strict two-pass flow (measurements first, gated verdicts second) and adding a `validateCellConsistency()` function that drops self-contradicting flags using the model's own reported numbers.

**Architecture:** Each V2 prompt asks the model to first emit a `measurements` object (raw observable facts about the chart — bar colors, body %, wick %, EMA slope, prior-bar relationships) and only then emit qualitative verdicts (direction, red_flags, score, in_bias, liquidity_swept). Each verdict has a single-line gate written into the prompt that references Pass-1 fields. After parsing the LLM response, a pure code-side function checks the model's verdicts against its own measurements; flags whose gates aren't satisfied are dropped before STOP/WATCH/ENTER is computed.

**Tech Stack:** Node 18+ ES modules, `node:test` for unit tests, no new deps.

**Spec:** `docs/superpowers/specs/2026-04-26-reduce-false-negatives-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/scanner.js` | modify | Add `gateSatisfied()`, `sweepGateSatisfied()`, `validateCellConsistency()`. Wire into the 3 V2 evaluators after LLM parse. |
| `prompts/monthly-direction.md` | modify | Add Pass-1 `measurements` block; tighten `direction = "none"` gate; declare `measurements` in output schema. |
| `prompts/weekly-structure.md` | modify | Full 2-pass rewrite — Pass 1 measurements + Pass 2 gated verdicts (direction, score, red_flags, candle_verdict). |
| `prompts/daily-trigger.md` | modify | Add Pass-1 measurements; gate `liquidity_swept`, `in_bias`, `winner_strength` to Pass-1 fields. State machine + trigger_type unchanged. |
| `tests/cell-consistency.test.mjs` | create | Unit tests for `gateSatisfied`, `sweepGateSatisfied`, `validateCellConsistency`. ~15 cases covering each gate + passthrough behavior. |

---

## Prerequisites

Before Task 1, decide branching strategy. The current branch `feat/htf-ltf-prompt-split` has uncommitted changes from earlier session work (history feature, timestamps, watchlist USOIL addition). Either:
- Stay on the same branch (simplest), OR
- Stash/commit the existing dirty changes first, then branch off as `feat/measurement-first-prompts`

User preference. Default: stay on `feat/htf-ltf-prompt-split`.

---

## Task 1: Add `gateSatisfied()` helper

Validates a single red_flag claim against the cell's `measurements`. Pure function — no I/O, no mutation. Unknown flags pass through (return `true`) so we never silently drop flags we haven't written rules for.

**Files:**
- Modify: `src/scanner.js` (add export near the V2 helpers, around line 500)
- Create: `tests/cell-consistency.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `tests/cell-consistency.test.mjs` with the following content. The full file will accumulate tests across Tasks 1-3; we start with `gateSatisfied`.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateSatisfied } from "../src/scanner.js";

// Helper to build a measurements skeleton with overrides.
function mkMeasurements(over = {}) {
  return {
    prior_bar: {
      color: "green",
      body_pct_of_range: 65,
      high_relative_to_ema_band: "above",
    },
    current_closed_bar: {
      color: "red",
      body_pct_of_range: 50,
      upper_wick_pct: 30,
      lower_wick_pct: 5,
      close_position: "lower_third",
      high_vs_prior_bar_high: "above",
      low_vs_prior_bar_low: "above",
    },
    forming_bar: { color: "green", progress_pct: 30 },
    ema_state: {
      ema9_above_ema15: true,
      ema9_ema15_distance: "normal",
      slope_direction: "up",
      slope_steepness: "medium",
    },
    recent_5_bars: { direction: "up", overlap_pct: 20 },
    ...over,
  };
}

// ─── exhaustion ──────────────────────────────────────────────────────────

test("gateSatisfied: exhaustion long with valid measurements → true", () => {
  // long bias, current bar is red, upper wick 30%, swept above prior high
  const m = mkMeasurements();
  assert.equal(gateSatisfied("exhaustion", m, "long"), true);
});

test("gateSatisfied: exhaustion long with low upper wick (12%) → false", () => {
  const m = mkMeasurements({
    current_closed_bar: {
      color: "red",
      body_pct_of_range: 50,
      upper_wick_pct: 12,
      lower_wick_pct: 5,
      close_position: "lower_third",
      high_vs_prior_bar_high: "above",
      low_vs_prior_bar_low: "above",
    },
  });
  assert.equal(gateSatisfied("exhaustion", m, "long"), false);
});

test("gateSatisfied: exhaustion long with no sweep above prior high → false", () => {
  const m = mkMeasurements({
    current_closed_bar: {
      color: "red",
      body_pct_of_range: 50,
      upper_wick_pct: 35,
      lower_wick_pct: 5,
      close_position: "lower_third",
      high_vs_prior_bar_high: "below",
      low_vs_prior_bar_low: "above",
    },
  });
  assert.equal(gateSatisfied("exhaustion", m, "long"), false);
});

test("gateSatisfied: exhaustion long with green bar (does not contradict bias) → false", () => {
  const m = mkMeasurements({
    current_closed_bar: {
      color: "green",
      body_pct_of_range: 50,
      upper_wick_pct: 35,
      lower_wick_pct: 5,
      close_position: "lower_third",
      high_vs_prior_bar_high: "above",
      low_vs_prior_bar_low: "above",
    },
  });
  assert.equal(gateSatisfied("exhaustion", m, "long"), false);
});

test("gateSatisfied: exhaustion short with valid (lower wick 32, swept below prior low, green bar) → true", () => {
  const m = mkMeasurements({
    current_closed_bar: {
      color: "green",
      body_pct_of_range: 50,
      upper_wick_pct: 5,
      lower_wick_pct: 32,
      close_position: "upper_third",
      high_vs_prior_bar_high: "below",
      low_vs_prior_bar_low: "below",
    },
  });
  assert.equal(gateSatisfied("exhaustion", m, "short"), true);
});

// ─── choppy_structure ────────────────────────────────────────────────────

test("gateSatisfied: choppy_structure with overlap=70 mixed → true", () => {
  const m = mkMeasurements({
    recent_5_bars: { direction: "mixed", overlap_pct: 70 },
  });
  assert.equal(gateSatisfied("choppy_structure", m, "long"), true);
});

test("gateSatisfied: choppy_structure with overlap=40 → false", () => {
  const m = mkMeasurements({
    recent_5_bars: { direction: "mixed", overlap_pct: 40 },
  });
  assert.equal(gateSatisfied("choppy_structure", m, "long"), false);
});

test("gateSatisfied: choppy_structure with high overlap but direction=up → false", () => {
  const m = mkMeasurements({
    recent_5_bars: { direction: "up", overlap_pct: 80 },
  });
  assert.equal(gateSatisfied("choppy_structure", m, "long"), false);
});

// ─── tangled_emas ────────────────────────────────────────────────────────

test("gateSatisfied: tangled_emas with tight distance → true", () => {
  const m = mkMeasurements({
    ema_state: {
      ema9_above_ema15: true,
      ema9_ema15_distance: "tight",
      slope_direction: "up",
      slope_steepness: "medium",
    },
  });
  assert.equal(gateSatisfied("tangled_emas", m, "long"), true);
});

test("gateSatisfied: tangled_emas with wide distance → false", () => {
  const m = mkMeasurements({
    ema_state: {
      ema9_above_ema15: true,
      ema9_ema15_distance: "wide",
      slope_direction: "up",
      slope_steepness: "medium",
    },
  });
  assert.equal(gateSatisfied("tangled_emas", m, "long"), false);
});

// ─── passthrough cases ───────────────────────────────────────────────────

test("gateSatisfied: unknown flag → true (preserve unknown flags)", () => {
  const m = mkMeasurements();
  assert.equal(gateSatisfied("custom_flag_we_do_not_know", m, "long"), true);
});

test("gateSatisfied: missing measurements → true (older cell shape)", () => {
  assert.equal(gateSatisfied("exhaustion", null, "long"), true);
  assert.equal(gateSatisfied("exhaustion", undefined, "long"), true);
});

test("gateSatisfied: exhaustion with direction=none → true (no bias to contradict)", () => {
  const m = mkMeasurements();
  assert.equal(gateSatisfied("exhaustion", m, "none"), true);
});
```

- [ ] **Step 2: Run tests, expect failure (function not exported yet)**

Run: `node --test tests/cell-consistency.test.mjs`
Expected: ALL FAIL with `SyntaxError: The requested module '../src/scanner.js' does not provide an export named 'gateSatisfied'`

- [ ] **Step 3: Implement `gateSatisfied()` in `src/scanner.js`**

Find the V2 section header `// ═══...V2 pipeline...` (around line 495). Insert the following BEFORE the existing V2 helpers, i.e. immediately after the section comment block:

```js
// ─── Cell consistency gates ─────────────────────────────────────────────
//
// Internal-consistency check: given a red_flag and the cell's own reported
// `measurements`, does the model's claim hold up against its own numbers?
//
// Returns true when the gate is satisfied (claim is internally consistent)
// or when we don't have a rule for the flag (passthrough). Returns false
// only when the model's own measurements directly contradict the flag.
//
// This is a soft-validation layer — no external data, no extra LLM calls.
// It exists to catch the AUDUSD-style failure where the model fires
// `exhaustion` despite a tiny upper wick.
export function gateSatisfied(flag, measurements, direction) {
  if (!measurements) return true; // older cells without Pass-1 measurements
  const c = measurements.current_closed_bar;
  if (!c) return true;

  switch (flag) {
    case "exhaustion": {
      const isLong = direction === "long";
      const isShort = direction === "short";
      if (!isLong && !isShort) return true; // no bias = nothing to contradict
      const wickOk = isLong
        ? (c.upper_wick_pct ?? 0) >= 30
        : (c.lower_wick_pct ?? 0) >= 30;
      const sweepOk = isLong
        ? c.high_vs_prior_bar_high === "above"
        : c.low_vs_prior_bar_low === "below";
      const colorOk = isLong ? c.color === "red" : c.color === "green";
      return wickOk && sweepOk && colorOk;
    }
    case "choppy_structure": {
      const r = measurements.recent_5_bars;
      if (!r) return true;
      return (r.overlap_pct ?? 0) >= 60 && r.direction === "mixed";
    }
    case "tangled_emas": {
      const e = measurements.ema_state;
      if (!e) return true;
      return e.ema9_ema15_distance === "tight";
    }
    default:
      return true; // unknown flag — preserve, don't silently drop
  }
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `node --test tests/cell-consistency.test.mjs`
Expected: 13 tests, 13 pass.

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test tests/*.test.mjs`
Expected: All previous tests still pass + 13 new.

- [ ] **Step 6: Commit**

```bash
git add src/scanner.js tests/cell-consistency.test.mjs
git commit -m "feat(scanner): add gateSatisfied helper for red-flag self-consistency check

Pure function that checks a model-reported red_flag against the cell's own
measurements. Drops the AUDUSD-style false-positive 'exhaustion' flag when
the bar's upper_wick_pct / sweep claims don't actually support it.

Unknown flags pass through (return true) so we never silently drop a flag
we don't have a rule for."
```

---

## Task 2: Add `sweepGateSatisfied()` helper

Same idea as Task 1 but for the `liquidity_swept` claim on `candle_verdict`. The model says "swept above prior high" → does its own `current_closed_bar.high_vs_prior_bar_high` say so, and is the close in the lower third with a red body? If not, drop the claim.

**Files:**
- Modify: `src/scanner.js` (add export immediately after `gateSatisfied`)
- Modify: `tests/cell-consistency.test.mjs` (append tests)

- [ ] **Step 1: Append the failing tests to `tests/cell-consistency.test.mjs`**

Append the following at the END of the file:

```js
// ─── sweepGateSatisfied ──────────────────────────────────────────────────

import { sweepGateSatisfied } from "../src/scanner.js";

test("sweepGateSatisfied: above_prior_high with valid (red bar, lower_third, swept above) → true", () => {
  const m = mkMeasurements({
    current_closed_bar: {
      color: "red",
      body_pct_of_range: 60,
      upper_wick_pct: 20,
      lower_wick_pct: 10,
      close_position: "lower_third",
      high_vs_prior_bar_high: "above",
      low_vs_prior_bar_low: "above",
    },
  });
  assert.equal(sweepGateSatisfied("above_prior_high", m), true);
});

test("sweepGateSatisfied: above_prior_high but high not above prior → false", () => {
  const m = mkMeasurements({
    current_closed_bar: {
      color: "red",
      body_pct_of_range: 60,
      upper_wick_pct: 20,
      lower_wick_pct: 10,
      close_position: "lower_third",
      high_vs_prior_bar_high: "below",
      low_vs_prior_bar_low: "above",
    },
  });
  assert.equal(sweepGateSatisfied("above_prior_high", m), false);
});

test("sweepGateSatisfied: above_prior_high but close in mid (not lower_third/at_low) → false", () => {
  const m = mkMeasurements({
    current_closed_bar: {
      color: "red",
      body_pct_of_range: 30,
      upper_wick_pct: 30,
      lower_wick_pct: 30,
      close_position: "mid",
      high_vs_prior_bar_high: "above",
      low_vs_prior_bar_low: "above",
    },
  });
  assert.equal(sweepGateSatisfied("above_prior_high", m), false);
});

test("sweepGateSatisfied: above_prior_high but green bar (no sell rejection) → false", () => {
  const m = mkMeasurements({
    current_closed_bar: {
      color: "green",
      body_pct_of_range: 60,
      upper_wick_pct: 20,
      lower_wick_pct: 10,
      close_position: "lower_third",
      high_vs_prior_bar_high: "above",
      low_vs_prior_bar_low: "above",
    },
  });
  assert.equal(sweepGateSatisfied("above_prior_high", m), false);
});

test("sweepGateSatisfied: below_prior_low symmetric (green bar, upper_third, swept below) → true", () => {
  const m = mkMeasurements({
    current_closed_bar: {
      color: "green",
      body_pct_of_range: 60,
      upper_wick_pct: 10,
      lower_wick_pct: 20,
      close_position: "upper_third",
      high_vs_prior_bar_high: "below",
      low_vs_prior_bar_low: "below",
    },
  });
  assert.equal(sweepGateSatisfied("below_prior_low", m), true);
});

test("sweepGateSatisfied: 'none' claim → true (vacuously)", () => {
  const m = mkMeasurements();
  assert.equal(sweepGateSatisfied("none", m), true);
});

test("sweepGateSatisfied: missing measurements → true (older cell)", () => {
  assert.equal(sweepGateSatisfied("above_prior_high", null), true);
  assert.equal(sweepGateSatisfied("above_prior_high", { current_closed_bar: null }), true);
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `node --test tests/cell-consistency.test.mjs`
Expected: New `sweepGateSatisfied` tests fail with `does not provide an export named 'sweepGateSatisfied'`. The 13 from Task 1 still pass (until the import error breaks them — node will fail the whole file).

- [ ] **Step 3: Implement `sweepGateSatisfied()` in `src/scanner.js`**

Insert the following IMMEDIATELY AFTER the `gateSatisfied` function (still inside the `// ─── Cell consistency gates ───` block):

```js
// Validates a `liquidity_swept` claim from candle_verdict against the cell's
// `measurements.current_closed_bar`. Returns false only if the model's claim
// directly contradicts its own reported relationship to the prior bar.
export function sweepGateSatisfied(claim, measurements) {
  if (!claim || claim === "none") return true;
  const c = measurements?.current_closed_bar;
  if (!c) return true;

  if (claim === "above_prior_high") {
    const lowerCloses = ["lower_third", "at_low"];
    return (
      c.high_vs_prior_bar_high === "above" &&
      lowerCloses.includes(c.close_position) &&
      c.color === "red"
    );
  }
  if (claim === "below_prior_low") {
    const upperCloses = ["upper_third", "at_high"];
    return (
      c.low_vs_prior_bar_low === "below" &&
      upperCloses.includes(c.close_position) &&
      c.color === "green"
    );
  }
  return true;
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `node --test tests/cell-consistency.test.mjs`
Expected: 20 tests, 20 pass (13 from Task 1 + 7 from Task 2).

- [ ] **Step 5: Commit**

```bash
git add src/scanner.js tests/cell-consistency.test.mjs
git commit -m "feat(scanner): add sweepGateSatisfied for liquidity_swept claims

Same pattern as gateSatisfied — uses the cell's own measurements
(high_vs_prior_bar_high / low_vs_prior_bar_low / close_position / color)
to verify the model didn't fabricate a sweep claim."
```

---

## Task 3: Add `validateCellConsistency()` orchestrator

Wraps the two helpers into a single per-cell validator. Mutates and returns the cell with self-contradicting flags removed and consistency rejections logged on `cell.consistency_log`.

**Files:**
- Modify: `src/scanner.js`
- Modify: `tests/cell-consistency.test.mjs`

- [ ] **Step 1: Append failing tests to `tests/cell-consistency.test.mjs`**

```js
// ─── validateCellConsistency ─────────────────────────────────────────────

import { validateCellConsistency } from "../src/scanner.js";

test("validateCellConsistency: cell with no measurements → returns unchanged", () => {
  const cell = {
    direction: "long",
    red_flags: ["exhaustion"],
    candle_verdict: { liquidity_swept: "above_prior_high", in_bias: true },
  };
  const out = validateCellConsistency(cell);
  assert.deepEqual(out.red_flags, ["exhaustion"]);
  assert.equal(out.candle_verdict.liquidity_swept, "above_prior_high");
});

test("validateCellConsistency: parse_failed cell → returns unchanged", () => {
  const cell = { parse_failed: true, red_flags: ["exhaustion"], measurements: null };
  const out = validateCellConsistency(cell);
  assert.deepEqual(out.red_flags, ["exhaustion"]);
});

test("validateCellConsistency: valid red_flag preserved", () => {
  const cell = {
    direction: "long",
    red_flags: ["exhaustion"],
    measurements: mkMeasurements(), // valid exhaustion: red bar, 30% upper wick, swept above
    candle_verdict: { liquidity_swept: "none", in_bias: false },
  };
  const out = validateCellConsistency(cell);
  assert.deepEqual(out.red_flags, ["exhaustion"]);
  assert.equal(out.consistency_log, undefined);
});

test("validateCellConsistency: invalid red_flag dropped + logged", () => {
  const cell = {
    direction: "long",
    red_flags: ["exhaustion"],
    measurements: mkMeasurements({
      current_closed_bar: {
        color: "red",
        body_pct_of_range: 30,
        upper_wick_pct: 12, // tiny — fails the 30% gate
        lower_wick_pct: 5,
        close_position: "lower_third",
        high_vs_prior_bar_high: "above",
        low_vs_prior_bar_low: "above",
      },
    }),
    candle_verdict: { liquidity_swept: "none", in_bias: false },
  };
  const out = validateCellConsistency(cell);
  assert.deepEqual(out.red_flags, []);
  assert.equal(out.consistency_log.length, 1);
  assert.match(out.consistency_log[0], /exhaustion/);
});

test("validateCellConsistency: mixed flags — invalid dropped, valid kept", () => {
  const cell = {
    direction: "long",
    red_flags: ["exhaustion", "tangled_emas"],
    measurements: mkMeasurements({
      current_closed_bar: {
        color: "red",
        body_pct_of_range: 30,
        upper_wick_pct: 10, // fails exhaustion
        lower_wick_pct: 5,
        close_position: "lower_third",
        high_vs_prior_bar_high: "above",
        low_vs_prior_bar_low: "above",
      },
      ema_state: {
        ema9_above_ema15: true,
        ema9_ema15_distance: "tight", // satisfies tangled_emas
        slope_direction: "up",
        slope_steepness: "medium",
      },
    }),
    candle_verdict: { liquidity_swept: "none", in_bias: false },
  };
  const out = validateCellConsistency(cell);
  assert.deepEqual(out.red_flags, ["tangled_emas"]);
});

test("validateCellConsistency: invalid liquidity_swept reset to 'none' + logged", () => {
  const cell = {
    direction: "long",
    red_flags: [],
    measurements: mkMeasurements({
      current_closed_bar: {
        color: "green", // contradicts above_prior_high (which needs red)
        body_pct_of_range: 60,
        upper_wick_pct: 20,
        lower_wick_pct: 10,
        close_position: "lower_third",
        high_vs_prior_bar_high: "above",
        low_vs_prior_bar_low: "above",
      },
    }),
    candle_verdict: { liquidity_swept: "above_prior_high", in_bias: false },
  };
  const out = validateCellConsistency(cell);
  assert.equal(out.candle_verdict.liquidity_swept, "none");
  assert.equal(out.consistency_log.length, 1);
  assert.match(out.consistency_log[0], /liquidity_swept/);
});

test("validateCellConsistency: in_bias=true with body 25% → forced to false", () => {
  const cell = {
    direction: "long",
    red_flags: [],
    measurements: mkMeasurements({
      current_closed_bar: {
        color: "green",
        body_pct_of_range: 25, // < 40 → in_bias must be false
        upper_wick_pct: 20,
        lower_wick_pct: 55,
        close_position: "upper_third",
        high_vs_prior_bar_high: "above",
        low_vs_prior_bar_low: "above",
      },
    }),
    candle_verdict: { liquidity_swept: "none", in_bias: true, body_pct_of_range: 25 },
  };
  const out = validateCellConsistency(cell);
  assert.equal(out.candle_verdict.in_bias, false);
  assert.match(out.consistency_log[0], /in_bias/);
});

test("validateCellConsistency: in_bias=true with body 65% → preserved", () => {
  const cell = {
    direction: "long",
    red_flags: [],
    measurements: mkMeasurements({
      current_closed_bar: {
        color: "green",
        body_pct_of_range: 65,
        upper_wick_pct: 10,
        lower_wick_pct: 25,
        close_position: "upper_third",
        high_vs_prior_bar_high: "above",
        low_vs_prior_bar_low: "above",
      },
    }),
    candle_verdict: { liquidity_swept: "none", in_bias: true, body_pct_of_range: 65 },
  };
  const out = validateCellConsistency(cell);
  assert.equal(out.candle_verdict.in_bias, true);
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `node --test tests/cell-consistency.test.mjs`
Expected: New `validateCellConsistency` tests fail (`does not provide an export named 'validateCellConsistency'`).

- [ ] **Step 3: Implement `validateCellConsistency()` in `src/scanner.js`**

Insert IMMEDIATELY AFTER `sweepGateSatisfied`, still in the `// ─── Cell consistency gates ───` block:

```js
// Per-cell validator. Drops self-contradicting red_flags, resets unsupported
// liquidity_swept claims to "none", and forces in_bias=false when the body is
// too small to call. Mutates and returns the cell. Each rejection appends a
// human-readable line to `cell.consistency_log` for later inspection.
//
// Cells with no `measurements` (legacy shape) or `parse_failed=true` pass
// through unchanged — we only validate cells that have committed to numbers.
export function validateCellConsistency(cell) {
  if (!cell || cell.parse_failed) return cell;
  if (!cell.measurements) return cell;

  const log = [];

  // 1. Drop self-contradicting red flags
  if (Array.isArray(cell.red_flags) && cell.red_flags.length > 0) {
    const direction = cell.direction;
    const kept = [];
    for (const flag of cell.red_flags) {
      if (gateSatisfied(flag, cell.measurements, direction)) {
        kept.push(flag);
      } else {
        log.push(`rejected red_flag '${flag}' — gate violated`);
      }
    }
    cell.red_flags = kept;
  }

  // 2. Validate liquidity_swept on candle_verdict
  const swept = cell.candle_verdict?.liquidity_swept;
  if (swept && swept !== "none") {
    if (!sweepGateSatisfied(swept, cell.measurements)) {
      log.push(`rejected liquidity_swept '${swept}' — gate violated`);
      cell.candle_verdict.liquidity_swept = "none";
    }
  }

  // 3. in_bias requires body_pct_of_range >= 40
  if (cell.candle_verdict?.in_bias === true) {
    const body = cell.measurements.current_closed_bar?.body_pct_of_range;
    if (typeof body === "number" && body < 40) {
      log.push(`rejected in_bias=true — body_pct ${body} < 40`);
      cell.candle_verdict.in_bias = false;
    }
  }

  if (log.length > 0) {
    cell.consistency_log = (cell.consistency_log || []).concat(log);
  }
  return cell;
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `node --test tests/cell-consistency.test.mjs`
Expected: 28 tests pass (13 + 7 + 8).

- [ ] **Step 5: Run full suite to confirm no regressions**

Run: `node --test tests/*.test.mjs`
Expected: 110 tests pass total (existing 82 + new 28).

- [ ] **Step 6: Commit**

```bash
git add src/scanner.js tests/cell-consistency.test.mjs
git commit -m "feat(scanner): add validateCellConsistency orchestrator

Composes gateSatisfied + sweepGateSatisfied into a single per-cell
validator. Drops self-contradicting red_flags, resets unsupported
liquidity_swept to 'none', forces in_bias=false when body_pct < 40.

Each rejection logged on cell.consistency_log so we can spot patterns
of model dishonesty over time. Cells without measurements pass through
unchanged — backward compatible with old scan-results JSON."
```

---

## Task 4: Wire `validateCellConsistency` into the V2 evaluators

Call the validator on each constructed cell after LLM parse but before state computation. The 3 evaluators construct their cell objects inline; we add `cell = validateCellConsistency(cell)` immediately before the state-derivation / return logic.

**Files:**
- Modify: `src/scanner.js` (3 evaluators: `evaluateMonthlyCell`, `evaluateWeeklyCell`, `evaluateDailyCell`)

- [ ] **Step 1: Wire into `evaluateMonthlyCell`**

Find the return statement at the end of `evaluateMonthlyCell` (the function constructs a `return { tf: "1M", direction, ... }` object literal). Replace the bare `return { ... };` with:

```js
  const cell = {
    tf: "1M",
    direction: result?.direction,
    in_9_15_zone: !!result?.in_9_15_zone,
    candle_verdict: result?.candle_verdict ?? null,
    measurements: result?.measurements ?? null,
    reasoning: result?.reasoning ?? "",
    image: imagePath,
    captured_at: capturedAt.toISOString(),
    cost_usd: totalCost,
    model,
    parse_failed: parseFailed,
    attempts,
    used_fallback: usedFallback && !parseFailed,
  };
  return validateCellConsistency(cell);
}
```

(The shape mirrors the existing return; the only adds are `measurements` field + the validator wrapping.)

- [ ] **Step 2: Wire into `evaluateWeeklyCell`**

Same pattern. Find the existing return at end of `evaluateWeeklyCell` and replace with:

```js
  const cell = {
    tf: "1W",
    direction: result?.direction,
    direction_conflict: !!result?.direction_conflict,
    setup_type: result?.setup_type ?? "none",
    angle_ok: !!result?.angle_ok,
    pullback_present: !!result?.pullback_present,
    ema_stack_ok: !!result?.ema_stack_ok,
    solid_continuation: !!result?.solid_continuation,
    probability_next_candle_in_bias: result?.probability_next_candle_in_bias ?? 0,
    red_flags: result?.red_flags ?? [],
    score: result?.score ?? 0,
    candle_verdict: result?.candle_verdict ?? null,
    measurements: result?.measurements ?? null,
    reasoning: result?.reasoning ?? "",
    image: imagePath,
    captured_at: capturedAt.toISOString(),
    cost_usd: totalCost,
    model,
    parse_failed: parseFailed,
    attempts,
    used_fallback: usedFallback && !parseFailed,
  };
  return validateCellConsistency(cell);
}
```

- [ ] **Step 3: Wire into `evaluateDailyCell`**

The daily evaluator already builds a `const cell = { ... }` and then calls `cell.state = dailyCellState(cell); cell.trigger_type = dailyTriggerType(...)` before returning. We must run `validateCellConsistency` BEFORE the state machine so a dropped flag actually changes the state outcome.

Find the block:

```js
  const cell = {
    tf: "1D",
    direction_conflict: !!result?.direction_conflict,
    setup_type: result?.setup_type ?? "none",
    // ... rest of existing fields ...
    used_fallback: usedFallback && !parseFailed,
  };
  // Authoritative state computation — the scanner's code is the source of
  // truth for NONE/WATCH/ENTER, not the prompt's self-reported field.
  cell.state = dailyCellState(cell);
  cell.trigger_type = dailyTriggerType(cell, weeklyCell.direction);
  return cell;
```

Modify it to:
1. Add `measurements: result?.measurements ?? null` into the object literal (alongside `candle_verdict`).
2. Call `validateCellConsistency(cell)` AFTER constructing the object literal but BEFORE `cell.state = dailyCellState(cell)`.

Final shape:

```js
  let cell = {
    tf: "1D",
    direction_conflict: !!result?.direction_conflict,
    setup_type: result?.setup_type ?? "none",
    angle_ok: !!result?.angle_ok,
    zone_rejection: !!result?.zone_rejection,
    coc_present: !!result?.coc_present,
    solid_continuation: !!result?.solid_continuation,
    prep_signals_count: result?.prep_signals_count ?? 0,
    probability_next_candle_in_bias: result?.probability_next_candle_in_bias ?? 0,
    red_flags: result?.red_flags ?? [],
    candle_verdict: result?.candle_verdict ?? null,
    measurements: result?.measurements ?? null,
    reasoning: result?.reasoning ?? "",
    image: imagePath,
    captured_at: capturedAt.toISOString(),
    cost_usd: totalCost,
    model,
    parse_failed: parseFailed,
    attempts,
    used_fallback: usedFallback && !parseFailed,
  };
  // Run consistency check BEFORE state derivation so dropped flags change
  // the NONE/WATCH/ENTER outcome.
  cell = validateCellConsistency(cell);
  // Authoritative state computation — the scanner's code is the source of
  // truth for NONE/WATCH/ENTER, not the prompt's self-reported field.
  cell.state = dailyCellState(cell);
  // Daily-cell direction is derived from weeklyCell since daily prompt no
  // longer self-reports a direction field. Pass weeklyCell.direction below.
  cell.trigger_type = dailyTriggerType(cell, weeklyCell.direction);
  return cell;
```

(Notice the change from `const cell` to `let cell` since `validateCellConsistency` returns the (mutated) cell — this just makes intent explicit and protects against future refactors that might return a new object.)

- [ ] **Step 4: Run full suite to confirm no regressions**

Run: `node --test tests/*.test.mjs`
Expected: 110 tests pass. The dailyCellState tests in `scanner-flow.test.mjs` should still pass — they don't include `measurements` so the validator passes through.

- [ ] **Step 5: Sanity-check syntax**

Run: `node --check src/scanner.js && echo OK`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add src/scanner.js
git commit -m "feat(scanner): wire validateCellConsistency into V2 evaluators

Calls the validator on each monthly/weekly/daily cell after LLM parse,
before STOP/WATCH/ENTER state computation. measurements field threaded
through from LLM response to cell to validator.

For daily, validator runs BEFORE dailyCellState() so a dropped exhaustion
flag actually changes whether the cell promotes to ENTER."
```

---

## Task 5: Update `prompts/monthly-direction.md` with Pass-1 measurements

Smallest of the 3 prompt changes — monthly is direction-only, so we add the Pass-1 measurement extraction block + tighten the `direction = "none"` gate. Existing structure (Step 1 Direction, Step 2 A+ zone flag, Step 3 Candle Verdict) stays; we just prepend Pass 1 and add gate language.

**Files:**
- Modify: `prompts/monthly-direction.md`

- [ ] **Step 1: Edit the file**

Replace the section between `Return **pure JSON only**...` and `### Step 1 — Direction` (i.e., insert a new "Pass 1" section before Step 1 and rename existing steps to make the 2-pass flow explicit). Find this text:

```markdown
Return **pure JSON only** (no prose, no markdown fences).

### Step 1 — Direction
```

Replace with:

```markdown
Return **pure JSON only** (no prose, no markdown fences).

## Pass 1 — Measurements (extract these BEFORE forming any verdict)

Look at the chart and report the following raw observations. No interpretation — just describe what is visibly there. You will use these in Pass 2 to justify every qualitative claim.

```json
"measurements": {
  "prior_bar": {
    "color": "green" | "red",
    "body_pct_of_range": 0,
    "high_relative_to_ema_band": "above" | "inside" | "below"
  },
  "current_closed_bar": {
    "color": "green" | "red",
    "body_pct_of_range": 0,
    "upper_wick_pct": 0,
    "lower_wick_pct": 0,
    "close_position": "at_high" | "upper_third" | "mid" | "lower_third" | "at_low",
    "high_vs_prior_bar_high": "above" | "equal" | "below",
    "low_vs_prior_bar_low": "above" | "equal" | "below"
  },
  "forming_bar": {
    "color": "green" | "red" | "doji",
    "progress_pct": 0
  },
  "ema_state": {
    "ema9_above_ema15": bool,
    "ema9_ema15_distance": "tight" | "normal" | "wide",
    "slope_direction": "up" | "down" | "flat",
    "slope_steepness": "shallow" | "medium" | "steep"
  },
  "recent_5_bars": {
    "direction": "up" | "down" | "mixed",
    "overlap_pct": 0
  }
}
```

## Pass 2 — Gated verdicts (each must be supported by Pass 1)

### Step 1 — Direction

Look at the EMA stack and slope over the last 10-20 monthly candles:
- `direction = "long"` ONLY IF `ema_state.ema9_above_ema15 = true` AND `ema_state.slope_direction = "up"` AND `ema_state.slope_steepness ≠ "shallow"`
- `direction = "short"` symmetric
- `direction = "none"` is reserved for genuinely tangled / freshly-flipped EMAs only — NOT for "EMAs are stacked but the forming bar looks ambiguous."
```

Then find the existing `### Output format` JSON block and add `"measurements": {...}` as the first key:

```markdown
### Output format

```json
{
  "measurements": { ... full Pass-1 schema above ... },
  "direction": "long" | "short" | "none",
  "in_9_15_zone": bool,
  "candle_verdict": {
    ... existing fields ...
  },
  "reasoning": "one sentence naming the direction and strongest supporting evidence"
}
```
```

- [ ] **Step 2: Verify the file parses + scanner still loads**

Run: `node --check src/scanner.js && node -e "import('./src/scanner.js').then(() => console.log('ok'))"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add prompts/monthly-direction.md
git commit -m "feat(prompt): monthly direction — add Pass-1 measurements + tighter direction gate

direction='none' is now reserved for tangled/freshly-flipped EMAs only.
Stacked EMAs with an ambiguous forming bar must commit to long/short."
```

---

## Task 6: Rewrite `prompts/weekly-structure.md` with full 2-pass + gates

The big one. The weekly prompt is where AUDUSD's failure originated, so the rewrite enforces measurement-first and gates every verdict.

**Files:**
- Modify: `prompts/weekly-structure.md`

- [ ] **Step 1: Replace the prompt body**

Open the file. Keep the existing top blocks unchanged (lines 1-20: title, Capture context, Prior run context, Bias context, Reactive principle, indicators visible). Replace EVERYTHING from `### Step 0 — Identify the CURRENT candle FIRST` through the closing `Downstream computes:` line with the following:

```markdown
## Pass 1 — Measurements (extract these BEFORE any verdict)

Locate the rightmost candle on the chart — this is the current/forming bar. The "current closed bar" referenced below is the bar IMMEDIATELY TO ITS LEFT (the most recent CLOSED bar). Report the following raw observations. No interpretation — these numbers will gate every verdict you make in Pass 2.

```json
"measurements": {
  "prior_bar": {
    "color": "green" | "red",
    "body_pct_of_range": 0,
    "high_relative_to_ema_band": "above" | "inside" | "below"
  },
  "current_closed_bar": {
    "color": "green" | "red",
    "body_pct_of_range": 0,
    "upper_wick_pct": 0,
    "lower_wick_pct": 0,
    "close_position": "at_high" | "upper_third" | "mid" | "lower_third" | "at_low",
    "high_vs_prior_bar_high": "above" | "equal" | "below",
    "low_vs_prior_bar_low": "above" | "equal" | "below"
  },
  "forming_bar": {
    "color": "green" | "red" | "doji",
    "progress_pct": 0
  },
  "ema_state": {
    "ema9_above_ema15": bool,
    "ema9_ema15_distance": "tight" | "normal" | "wide",
    "slope_direction": "up" | "down" | "flat",
    "slope_steepness": "shallow" | "medium" | "steep"
  },
  "recent_5_bars": {
    "direction": "up" | "down" | "mixed",
    "overlap_pct": 0
  }
}
```

## Pass 2 — Gated verdicts (each gate references Pass-1 fields)

### Step 1 — Confirm or refute direction

Given the monthly bias ({MONTHLY_BIAS}), does the weekly chart support it?

- `direction = "long"` ONLY IF `ema_state.ema9_above_ema15 = true` AND `ema_state.slope_direction = "up"` AND `ema_state.slope_steepness ≠ "shallow"`
- `direction = "short"` symmetric
- `direction = "none"` is reserved for tangled / freshly-flipped EMAs only — NOT for "EMAs are stacked but I see a mixed bar."
- `direction_conflict = true` ONLY IF the weekly chart shows clearly the OPPOSITE of monthly_bias (EMAs stacked against monthly, momentum against). Honest disagreement is more valuable than forced agreement.

If `direction = "none"` or `direction_conflict = true`, fill the candle_verdict but skip the structural grading.

### Step 2 — Setup type

- **"pullback"** — price recently retraced INTO the EMA9-EMA15 band and just rejected away from it in the bias direction
- **"continuation"** — pullback already happened; now seeing solid follow-through candles
- **"none"** — neither; choppy or flat

### Step 3 — Structural grading (gates use Pass-1 fields)

1. **angle_ok** *(bool)* — `ema_state.slope_steepness ∈ {"medium", "steep"}` AND `ema_state.slope_direction` matches bias
2. **pullback_present** *(bool)* — visible pullback into the EMA band in the last 5 bars (use `prior_bar.high_relative_to_ema_band` and the visible chart history to support)
3. **ema_stack_ok** *(bool)* — `ema_state.ema9_above_ema15` matches bias direction (true for long, false for short)
4. **solid_continuation** *(bool)* — at least 3 of the last 5 closed bars have `body_pct_of_range ≥ 60` AND closed in bias direction
5. **probability_next_candle_in_bias** *(int 0-100)* — your estimate; used only for ranking
6. **red_flags** *(array)* — emit ONLY when the gate below is met:
   - `"choppy_structure"` ONLY IF `recent_5_bars.overlap_pct ≥ 60` AND `recent_5_bars.direction = "mixed"`
   - `"tangled_emas"` ONLY IF `ema_state.ema9_ema15_distance = "tight"`
   - `"exhaustion"` ONLY IF (long bias: `current_closed_bar.upper_wick_pct ≥ 30` AND `current_closed_bar.high_vs_prior_bar_high = "above"` AND `current_closed_bar.color = "red"`) OR (short bias symmetric)
7. **score** *(int 0-10)*:
   - `score ≥ 8` requires ALL of: `angle_ok = true`, `ema_stack_ok = true`, `pullback_present = true`, `current_closed_bar.color = matches bias`, `red_flags = []`
   - `score = 7` allows ONE of those to be soft
   - `score < 6` = reject

### Step 4 — Candle Verdict (read the rightmost CLOSED weekly candle)

Use the same 11 fields as defined in the output schema below. Each numeric field must be consistent with `measurements.current_closed_bar` — `body_pct_of_range`, `upper_wick_pct`, `lower_wick_pct`, `close_position`, and the swept fields are the same.

- `liquidity_swept = "above_prior_high"` ONLY IF `current_closed_bar.high_vs_prior_bar_high = "above"` AND `close_position ∈ {"lower_third", "at_low"}` AND `color = "red"`
- `liquidity_swept = "below_prior_low"` symmetric
- `in_bias = true` ONLY IF `current_closed_bar.color matches direction` AND `body_pct_of_range ≥ 40`

### Output format

```json
{
  "measurements": { ... full Pass-1 schema above ... },
  "direction": "long" | "short" | "none",
  "direction_conflict": bool,
  "setup_type": "pullback" | "continuation" | "none",
  "angle_ok": bool,
  "pullback_present": bool,
  "ema_stack_ok": bool,
  "solid_continuation": bool,
  "probability_next_candle_in_bias": 0,
  "red_flags": [],
  "score": 0,
  "candle_verdict": {
    "body_type": "solid" | "normal" | "doji" | "highwave",
    "body_pct_of_range": 0,
    "upper_wick_pct": 0,
    "lower_wick_pct": 0,
    "close_position": "at_high" | "upper_third" | "mid" | "lower_third" | "at_low",
    "winner": "buyers" | "sellers" | "mixed",
    "winner_strength": 0,
    "liquidity_swept": "below_prior_low" | "above_prior_high" | "none",
    "pattern": "solid_bull" | "solid_bear" | "hammer" | "shooting_star" | "engulfing_bull" | "engulfing_bear" | "inside_bar" | "pinbar_bull" | "pinbar_bear" | "doji" | "none",
    "in_bias": bool,
    "verdict": "one sentence"
  },
  "reasoning": "one sentence ≤ 200 chars"
}
```

Downstream computes:
`pass = direction != "none" AND direction_conflict === false AND red_flags.length === 0 AND score >= 7`
```

- [ ] **Step 2: Confirm the file is well-formed**

Run: `wc -l prompts/weekly-structure.md && head -20 prompts/weekly-structure.md`
Expected: file has ~140 lines, top is unchanged (title, Capture context, Prior run context).

- [ ] **Step 3: Commit**

```bash
git add prompts/weekly-structure.md
git commit -m "feat(prompt): weekly structure — 2-pass measurement-first rewrite

Every verdict (direction, score, red_flags, candle_verdict subfields) now
has an explicit gate referencing Pass-1 measurements. exhaustion requires
upper_wick_pct >= 30 + sweep + contradicting color; choppy_structure
requires overlap_pct >= 60 + mixed direction; tangled_emas requires tight
EMA distance.

Targets the AUDUSD-style false-negative cascade where a small pullback
bar got tagged 'exhaustion' on vibes."
```

---

## Task 7: Update `prompts/daily-trigger.md` with gated candle_verdict

Daily prompt keeps its NONE/WATCH/ENTER state machine and trigger_type logic — both are mechanical and computed authoritatively in scanner code. The change is at the candle_verdict level: gate `liquidity_swept`, `in_bias`, `winner_strength` on Pass-1 measurements.

**Files:**
- Modify: `prompts/daily-trigger.md`

- [ ] **Step 1: Edit the file**

Find the existing `### Step 0 — Identify the CURRENT candle FIRST` section. Replace EVERYTHING from that line through the closing `### Output format` block (i.e., the analysis steps and output schema) with the following:

```markdown
## Pass 1 — Measurements (extract these BEFORE forming any verdict)

Locate the rightmost candle on the chart — that's the current/forming bar. The "most recent CLOSED candle" referenced throughout this prompt is the bar IMMEDIATELY TO ITS LEFT. Report the following raw observations.

```json
"measurements": {
  "prior_bar": {
    "color": "green" | "red",
    "body_pct_of_range": 0,
    "high_relative_to_ema_band": "above" | "inside" | "below"
  },
  "current_closed_bar": {
    "color": "green" | "red",
    "body_pct_of_range": 0,
    "upper_wick_pct": 0,
    "lower_wick_pct": 0,
    "close_position": "at_high" | "upper_third" | "mid" | "lower_third" | "at_low",
    "high_vs_prior_bar_high": "above" | "equal" | "below",
    "low_vs_prior_bar_low": "above" | "equal" | "below"
  },
  "forming_bar": {
    "color": "green" | "red" | "doji",
    "progress_pct": 0
  },
  "ema_state": {
    "ema9_above_ema15": bool,
    "ema9_ema15_distance": "tight" | "normal" | "wide",
    "slope_direction": "up" | "down" | "flat",
    "slope_steepness": "shallow" | "medium" | "steep"
  },
  "recent_5_bars": {
    "direction": "up" | "down" | "mixed",
    "overlap_pct": 0
  }
}
```

## Pass 2 — Gated verdicts

### Step 1 — Prep signals (setup forming)

Each is a precondition for a valid trigger — not the trigger itself.

1. **angle_ok** *(bool)* — `ema_state.slope_steepness ∈ {"medium", "steep"}` AND `ema_state.slope_direction` matches {WEEKLY_BIAS}
2. **zone_rejection** *(bool)* — visible price retest of the EMA9-EMA15 band followed by rejection in {WEEKLY_BIAS} direction
3. **coc_present** *(bool)* — Change of Character: structural shift back into {WEEKLY_BIAS} after a counter-trend move
4. **solid_continuation** *(bool)* — at least 3 of the last 5 closed bars have `body_pct_of_range ≥ 60` AND closed in {WEEKLY_BIAS} direction

`prep_signals_count` = sum of the 4 above.

### Step 2 — Trigger candle (candle_verdict, gated to Pass-1 measurements)

Read the rightmost CLOSED candle. Each candle_verdict subfield is gated:

- `body_pct_of_range`, `upper_wick_pct`, `lower_wick_pct`, `close_position` — must equal `measurements.current_closed_bar.*` (these are the same numbers, just exposed twice for clarity)
- `winner = "buyers"` ONLY IF `current_closed_bar.color = "green"` AND `body_pct_of_range ≥ 40`
- `winner = "sellers"` symmetric
- `winner = "mixed"` for body < 40 OR doji-shape candles
- `winner_strength` (0-10):
  - 8-10: `body_pct_of_range ≥ 60` AND close at_high/at_low (matching winner)
  - 5-7: `body_pct_of_range ≥ 40-59` AND close upper_third/lower_third
  - 0-4: small body OR mixed close
- `liquidity_swept = "above_prior_high"` ONLY IF `current_closed_bar.high_vs_prior_bar_high = "above"` AND `close_position ∈ {"lower_third", "at_low"}` AND `color = "red"`
- `liquidity_swept = "below_prior_low"` symmetric
- `liquidity_swept = "none"` otherwise
- `in_bias = true` ONLY IF `current_closed_bar.color matches {WEEKLY_BIAS}` AND `body_pct_of_range ≥ 40`
- `pattern` — choose from the enum based on observed shape; `solid_bull` requires green AND body_pct ≥ 60 AND close_position upper_third or at_high; `solid_bear` symmetric; `hammer/pinbar_bull` require lower_wick_pct ≥ 50 AND green; `shooting_star/pinbar_bear` symmetric

### Step 3 — Red flags

- `"choppy_structure"` ONLY IF `recent_5_bars.overlap_pct ≥ 60` AND `recent_5_bars.direction = "mixed"`
- `"tangled_emas"` ONLY IF `ema_state.ema9_ema15_distance = "tight"`
- `"exhaustion"` ONLY IF (long bias: `current_closed_bar.upper_wick_pct ≥ 30` AND `high_vs_prior_bar_high = "above"` AND `color = "red"`) OR (short bias symmetric)

### Step 4 — Probability (for ranking only)

`probability_next_candle_in_bias` (0-100) — your estimate of the next daily closing in {WEEKLY_BIAS}. Used to rank multiple ENTER signals; does NOT gate state.

### Step 5 — direction_conflict

If the daily structure is clearly broken against {WEEKLY_BIAS} (EMAs visibly flipped, momentum reversed), set `direction_conflict = true`. Otherwise false.

### Output format

```json
{
  "measurements": { ... full Pass-1 schema above ... },
  "direction_conflict": bool,
  "setup_type": "pullback" | "continuation" | "none",
  "angle_ok": bool,
  "zone_rejection": bool,
  "coc_present": bool,
  "solid_continuation": bool,
  "prep_signals_count": 0,
  "probability_next_candle_in_bias": 0,
  "red_flags": [],
  "candle_verdict": {
    "body_type": "solid" | "normal" | "doji" | "highwave",
    "body_pct_of_range": 0,
    "upper_wick_pct": 0,
    "lower_wick_pct": 0,
    "close_position": "at_high" | "upper_third" | "mid" | "lower_third" | "at_low",
    "winner": "buyers" | "sellers" | "mixed",
    "winner_strength": 0,
    "liquidity_swept": "below_prior_low" | "above_prior_high" | "none",
    "pattern": "solid_bull" | "solid_bear" | "hammer" | "shooting_star" | "engulfing_bull" | "engulfing_bear" | "inside_bar" | "pinbar_bull" | "pinbar_bear" | "doji" | "none",
    "in_bias": bool,
    "verdict": "one sentence"
  },
  "state": "NONE" | "WATCH" | "ENTER",
  "trigger_type": "momentum" | "sweep" | "pattern" | "none",
  "reasoning": "one sentence ≤ 200 chars"
}
```

Note: `state` and `trigger_type` are also self-reported here, but the SCANNER's code recomputes them authoritatively from `dailyCellState()` / `dailyTriggerType()` after `validateCellConsistency` runs. Be honest in your self-report — it's used for diagnostics — but the scanner's outputs are what drive WATCH/ENTER decisions.
```

The block at the very TOP of the file (`Step 3 — State determination` referenced from the prompt) is now removed because the state derivation is exclusively in code. The Pass-1/Pass-2 split renders Step 3 redundant.

- [ ] **Step 2: Confirm well-formed**

Run: `wc -l prompts/daily-trigger.md && head -20 prompts/daily-trigger.md`
Expected: ~140 lines, top of file unchanged (title, Capture context, Prior run context, Bias context).

- [ ] **Step 3: Commit**

```bash
git add prompts/daily-trigger.md
git commit -m "feat(prompt): daily trigger — gate candle_verdict to Pass-1 measurements

liquidity_swept, in_bias, winner_strength, and the red_flag set all now
reference measurements.current_closed_bar fields explicitly. State machine
unchanged — still computed authoritatively in scanner code via
dailyCellState() after validateCellConsistency() runs."
```

---

## Task 8: Live smoke test (manual, non-blocking)

Run a fresh full-watchlist scan and spot-check that AUDUSD-style cases now pass through correctly, the new `measurements` block appears in cell JSON, and the `consistency_log` field shows when flags were dropped.

**Files:** none modified — verification only.

- [ ] **Step 1: Pre-flight check**

Confirm TradingView Desktop is running with `--remote-debugging-port=9222`:

Run: `curl -s -m 2 http://127.0.0.1:9222/json/version | head -3`
Expected: JSON output starting with `{ "Browser": "Chrome..." }`

If not reachable, relaunch TV with the flag (this kills any open layouts):

```bash
osascript -e 'quit app "TradingView"' && sleep 3 && open -a TradingView --args --remote-debugging-port=9222
```

- [ ] **Step 2: Run the scan**

Run: `mkdir -p logs && node bot.js --scan --htf-only 2>&1 | tee "logs/scan-$(date -u +%Y%m%dT%H%M%SZ).log"`
Expected: Scan starts, processes 16 symbols, ends with a Report Card and "Full results saved" line.

- [ ] **Step 3: Inspect AUDUSD specifically**

Run:
```bash
node -e "
const r = JSON.parse(require('fs').readFileSync('scan-results/latest-scan-v2.json','utf8'));
const e = r.results.find(x => x.symbol === 'AUDUSD');
console.log('  STOP REASON:', e.stop_reason);
console.log('  WEEKLY DIRECTION:', e.weekly?.direction);
console.log('  WEEKLY SCORE:', e.weekly?.score);
console.log('  WEEKLY RED FLAGS:', e.weekly?.red_flags);
console.log('  WEEKLY CONSISTENCY LOG:', e.weekly?.consistency_log);
console.log('  WEEKLY MEASUREMENTS:', JSON.stringify(e.weekly?.measurements, null, 2));
"
```
Expected: At minimum, `WEEKLY MEASUREMENTS` is non-null (proves the LLM is following the new prompt). If `WEEKLY RED FLAGS` is empty and the chain continued to daily, the fix worked. If a flag is present but `consistency_log` shows it was a different (truly supported) flag, that's still success.

- [ ] **Step 4: Spot-check 2-3 other symbols for `measurements` presence**

Run:
```bash
node -e "
const r = JSON.parse(require('fs').readFileSync('scan-results/latest-scan-v2.json','utf8'));
for (const sym of r.results) {
  console.log(sym.symbol.padEnd(10),
    'monthly.measurements:', !!sym.monthly?.measurements,
    'weekly.measurements:', !!sym.weekly?.measurements,
    'daily.measurements:', !!sym.daily?.measurements,
    'consistency_log:',
      [sym.monthly?.consistency_log, sym.weekly?.consistency_log, sym.daily?.consistency_log]
        .filter(Boolean).flat().length);
}
"
```
Expected: Every cell that ran has `measurements` populated (true). consistency_log count is 0 or low (mostly 0).

- [ ] **Step 5: If all good, push the branch**

Run: `git push`
Expected: branch is pushed; user can open a PR or merge directly per their workflow.

---

## Self-Review Notes

After writing this plan I checked it against the spec:

- ✅ Spec "Pass-1 measurement schema" → covered in Tasks 5/6/7 prompt edits + Task 4 cell shape change
- ✅ Spec "Pass-2 gated verdicts (direction, score, red_flags, sweep, in_bias)" → covered in Tasks 5/6/7
- ✅ Spec "Code-side consistency check" `validateCellConsistency` → Tasks 1-3 (TDD), Task 4 (wiring)
- ✅ Spec "Per-prompt scope" effort estimates (monthly small, weekly heavy, daily moderate) → matches Tasks 5/6/7
- ✅ Spec "Rollout" — single PR, smoke test → Task 8
- ✅ Spec "Risks: prompts grow longer" — accepted; no mitigation task needed
- ✅ Spec "Reversibility" — each prompt edit + the validator function are independent commits

No placeholders. All test code is concrete. All function signatures, field names, and enum values are consistent across tasks (verified by grep on the plan).

Ready for implementation.
