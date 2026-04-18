# HTF + LTF Prompt Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `scan-rubric.md` with two purpose-built prompts (HTF bias + LTF entry) and rewrite `src/scanner.js` around a sequential, fail-fast HTF→LTF pipeline that injects HTF bias into the LTF prompt.

**Architecture:** Two new prompts under `prompts/`, two pure-logic helpers (`evaluateHtfChain`, `ltfCellPass`) extracted for unit testing, and a rewritten flow in `src/scanner.js` that drives `runScan` (over the watchlist) and `runDeepScan` (single symbol) through the same `evaluateSymbol` function. Numeric EMA cross-check is reused for Binance symbols only. Console + JSON output match the schema in the spec.

**Tech Stack:** Node.js (ES modules), `chrome-remote-interface` (CDP), `@google/genai` (Gemini 2.5 Flash), `node:test` for unit tests.

---

## File Structure

| Path | Action | Responsibility |
|------|--------|----------------|
| `prompts/htf-bias.md` | NEW | Gemini rubric for grading 1M/1W/1D charts (direction + slope + pullback + stack + score) |
| `prompts/ltf-entry.md` | NEW | Gemini rubric for grading 4H/2H/1H entries given a known HTF bias (zone rejection + CoC + strong candle + score) |
| `prompts/scan-rubric.md` | DELETE | Replaced by the two above |
| `src/scanner.js` | REWRITE | Drives the per-symbol HTF→LTF flow. Exposes pure helpers `ltfCellPass` and `evaluateHtfChain` for tests. Exports `runScan`, `runDeepScan`, `slugify`. |
| `tests/scanner-flow.test.mjs` | NEW | Unit tests for `ltfCellPass` and `evaluateHtfChain` (all stop reasons + success path) |
| `tests/scanner.test.mjs` | KEEP | Existing `slugify` tests (no changes) |
| `bot.js` | KEEP | No flag changes; existing dispatch still works since `runScan`/`runDeepScan` keep the same signatures |
| `src/visual.js` | KEEP | `askGeminiVision`, `fillRubric`, cost tracking unchanged |
| `src/tv-navigate.js` | KEEP | Chart navigation already correct |
| `src/higher-tf.js` | KEEP | Reused for the Binance numeric cross-check |

---

## Task 1: Create the HTF bias prompt

**Files:**
- Create: `prompts/htf-bias.md`

- [ ] **Step 1: Write the prompt file**

Create `prompts/htf-bias.md` with this exact content:

```markdown
You are reviewing a {SYMBOL} {TIMEFRAME} chart for **trend bias** (not entry).
This is a HIGHER timeframe — your job is to decide whether a tradeable trend exists, not to time an entry.

The chart has two key indicators visible:
- **EMA9** (orange line)
- **EMA15** (purple line)

Return **pure JSON only** (no prose, no markdown fences).

### Step 1 — Decide the direction yourself

Look at the slope of EMA9 and EMA15 over the last several bars:

- Both EMAs sloping UP at a visibly steep angle (>~40°) **AND** EMA9 above EMA15 → `"long"`
- Both EMAs sloping DOWN steeply (>~40°) **AND** EMA9 below EMA15 → `"short"`
- Slope shallow, EMAs flat/crossed/tangled, or unclear → `"none"`

If `direction === "none"`, set every other field to false/null/empty and `score = 0`. Do not grade further.

### Step 2 — Grade the bias structure

3. **slope_ok** *(boolean)* — EMA9 and EMA15 slopes confirmed >40° in the chosen direction.

4. **pullback_present** *(boolean)* — Has price recently pulled INTO the EMA9–EMA15 band (a healthy retracement, not an extended run away from it)? True if the last several candles touched or closed within the band.

5. **ema_stack_ok** *(boolean)* — EMA9 cleanly above EMA15 for long, below for short. False if they are crossing back and forth.

6. **red_flags** *(array of strings)* — Any of:
   - `"choppy_structure"` — last several HTF candles overlap with no clear direction
   - `"tangled_emas"` — EMA9/EMA15 cross back and forth recently
   - `"news_spike"` — abnormal candle ~3×+ average HTF range
   - `"extended"` — price is far from EMAs with no pullback

7. **score** *(integer 0–10)* — Quality of this HTF as the basis for a trend trade. 10 = textbook. 7 = acceptable. <6 = reject.

8. **reasoning** *(string ≤200 chars)* — One sentence explaining the score.

### Output format

```json
{
  "direction": "long" | "short" | "none",
  "slope_ok": bool,
  "pullback_present": bool,
  "ema_stack_ok": bool,
  "red_flags": [],
  "score": 0,
  "reasoning": "..."
}
```
```

- [ ] **Step 2: Commit**

```bash
git add prompts/htf-bias.md
git commit -m "feat(prompts): add HTF bias rubric for 1M/1W/1D"
```

---

## Task 2: Create the LTF entry prompt

**Files:**
- Create: `prompts/ltf-entry.md`

- [ ] **Step 1: Write the prompt file**

Create `prompts/ltf-entry.md` with this exact content:

```markdown
You are reviewing a {SYMBOL} {TIMEFRAME} chart to confirm an **entry** in the already-decided direction.

**HTF bias is {HTF_BIAS}.** Look ONLY for entry confirmation in this direction. Do NOT re-grade the trend or vote on direction — that decision is final.

The chart has two key indicators visible:
- **EMA9** (orange line)
- **EMA15** (purple line)

Return **pure JSON only** (no prose, no markdown fences).

### Grade the entry confirmation

1. **zone_rejection** *(boolean)* — Has price just touched the EMA9–EMA15 band and started rejecting AWAY from it in the bias direction? True if the most recent 1–3 candles wick into the band and close back outside it in the bias direction. False if price never touched, blew straight through, or is trending away.

2. **coc_present** *(boolean)* — Change of Character: has a recent swing high (for `long`) or swing low (for `short`) just been broken in the bias direction? False if structure is undecided.

3. **strong_candle_in_bias** *(boolean)* — Is the most recent CLOSED candle a strong move in the bias direction? True if it is engulfing (body engulfs prior body in bias direction) OR solid (body ≥60% of range, in bias direction). False otherwise.

4. **red_flags** *(array of strings)* — Any of:
   - `"choppy_structure"` — last 5–10 candles overlap with no clear direction
   - `"doji_cluster"` — multiple small-body candles nearby
   - `"zone_pierced_decisively"` — price blew through the EMA band instead of rejecting
   - `"news_spike"` — abnormal candle ~3×+ average range
   - `"counter_trend_pressure"` — visible recent move against the bias direction

5. **score** *(integer 0–10)* — Quality of this moment as an entry into the {HTF_BIAS} bias. 10 = textbook entry; 8 = take it; <8 = wait.

6. **reasoning** *(string ≤200 chars)* — One sentence explaining the score.

### Output format

```json
{
  "zone_rejection": bool,
  "coc_present": bool,
  "strong_candle_in_bias": bool,
  "red_flags": [],
  "score": 0,
  "reasoning": "..."
}
```

Downstream computes:
`pass = (zone_rejection + coc_present + strong_candle_in_bias) >= 2 AND red_flags.length === 0 AND score >= 8`
```

- [ ] **Step 2: Commit**

```bash
git add prompts/ltf-entry.md
git commit -m "feat(prompts): add LTF entry rubric with HTF_BIAS injection"
```

---

## Task 3: Pure helper `ltfCellPass` (TDD)

**Files:**
- Create test: `tests/scanner-flow.test.mjs`
- Modify: `src/scanner.js` (add export at top of file, near `slugify`)

- [ ] **Step 1: Write the failing tests**

Create `tests/scanner-flow.test.mjs` with this content:

```javascript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test tests/scanner-flow.test.mjs
```
Expected: FAIL with "ltfCellPass is not a function" or similar import error.

- [ ] **Step 3: Add the helper to `src/scanner.js`**

Open `src/scanner.js`. Just below the `slugify` export near the top, add:

```javascript
// Whether an LTF cell passes the entry filter:
// at least 2 of {zone_rejection, coc_present, strong_candle_in_bias},
// no red flags, and score >= 8.
export function ltfCellPass(cell) {
  if (!cell || typeof cell !== "object") return false;
  const signals =
    (cell.zone_rejection ? 1 : 0) +
    (cell.coc_present ? 1 : 0) +
    (cell.strong_candle_in_bias ? 1 : 0);
  const noFlags = !cell.red_flags || cell.red_flags.length === 0;
  return signals >= 2 && noFlags && (cell.score ?? 0) >= 8;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test tests/scanner-flow.test.mjs
```
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/scanner-flow.test.mjs src/scanner.js
git commit -m "feat(scanner): add ltfCellPass helper with tests"
```

---

## Task 4: Pure helper `evaluateHtfChain` (TDD)

**Files:**
- Modify test: `tests/scanner-flow.test.mjs`
- Modify: `src/scanner.js`

- [ ] **Step 1: Add failing tests to `tests/scanner-flow.test.mjs`**

Append this to the bottom of `tests/scanner-flow.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test tests/scanner-flow.test.mjs
```
Expected: 6 new tests fail with "evaluateHtfChain is not a function" or similar.

- [ ] **Step 3: Implement `evaluateHtfChain` in `src/scanner.js`**

Add this just below `ltfCellPass`:

```javascript
// HTF_TIMEFRAMES order is fixed: index 0 = 1M, 1 = 1W, 2 = 1D.
// Cells passed in must be in that order; result.stopAt names the TF that failed.
const HTF_LABELS = ["1M", "1W", "1D"];

export function evaluateHtfChain(cells, opts = {}) {
  const minPerScore = opts.minPerScore ?? 6;
  const minAvgScore = opts.minAvgScore ?? 7;

  let firstDir = null;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const tf = HTF_LABELS[i] ?? `htf_${i}`;
    const dir = cell?.direction;
    const score = cell?.score ?? 0;

    if (!dir || dir === "none") {
      return { stopped: true, stopAt: tf, stopReason: "no_trend", htfBias: null, avgScore: null };
    }
    if (score < minPerScore) {
      return { stopped: true, stopAt: tf, stopReason: "htf_quality_low", htfBias: null, avgScore: null };
    }
    if (firstDir == null) {
      firstDir = dir;
    } else if (dir !== firstDir) {
      return { stopped: true, stopAt: tf, stopReason: "htf_disagree", htfBias: null, avgScore: null };
    }
  }

  const avgScore = cells.reduce((s, c) => s + (c.score ?? 0), 0) / cells.length;
  if (avgScore < minAvgScore) {
    return { stopped: true, stopAt: null, stopReason: "htf_avg_low", htfBias: null, avgScore };
  }
  return { stopped: false, stopAt: null, stopReason: null, htfBias: firstDir, avgScore };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test tests/scanner-flow.test.mjs
```
Expected: all tests pass (6 from Task 3 + 6 from Task 4 = 12 total).

- [ ] **Step 5: Commit**

```bash
git add tests/scanner-flow.test.mjs src/scanner.js
git commit -m "feat(scanner): add evaluateHtfChain helper with tests for all stop reasons"
```

---

## Task 5: Numeric cross-check helper for Binance symbols

**Files:**
- Modify: `src/scanner.js`

- [ ] **Step 1: Update the existing `higher-tf.js` import in `src/scanner.js`**

The current file imports `fetchCandles as fetchHT`. Drop the alias so the new function below can use the canonical name. At the top of `src/scanner.js`, replace:

```javascript
import {
  fetchCandles as fetchHT,
  emaAlignment,
  agree,
  priceInZone,
} from "./higher-tf.js";
```

with:

```javascript
import { fetchCandles, emaAlignment, agree } from "./higher-tf.js";
```

(`priceInZone` will not be needed by the new flow.)

- [ ] **Step 2: Add `runNumericCrossCheck` to `src/scanner.js`**

Below `evaluateHtfChain`, add:

```javascript
// For Binance symbols only — verifies that the visual HTF bias agrees with
// the numeric EMA9/15 alignment computed from real 1M/1W/1D candles.
// Returns { ran, direction, agreed, error? }.
//   ran = false  → no Binance symbol available (skip cross-check entirely)
//   agreed = false when numeric direction is null OR != htfBias
async function runNumericCrossCheck(binanceSymbol, htfBias) {
  if (!binanceSymbol) return { ran: false, direction: null, agreed: null };
  try {
    const [m, w, d] = await Promise.all([
      fetchCandles(binanceSymbol, "1M", 60),
      fetchCandles(binanceSymbol, "1W", 80),
      fetchCandles(binanceSymbol, "1D", 120),
    ]);
    const dir = agree(emaAlignment(m), emaAlignment(w), emaAlignment(d));
    // higher-tf returns "bullish" / "bearish" / null
    const mapped = dir === "bullish" ? "long" : dir === "bearish" ? "short" : null;
    return { ran: true, direction: mapped, agreed: mapped !== null && mapped === htfBias };
  } catch (err) {
    return { ran: true, direction: null, agreed: false, error: err.message };
  }
}
```

- [ ] **Step 3: Run unit tests to confirm nothing broke**

```bash
node --test 'tests/*.test.mjs'
```
Expected: all tests still pass (no test exercises the new function yet — it's covered by the integration test in Task 9).

- [ ] **Step 4: Commit**

```bash
git add src/scanner.js
git commit -m "feat(scanner): add runNumericCrossCheck for Binance HTF agreement"
```

---

## Task 6: Rewrite `runDeepScan` and `runScan` around the new flow

**Files:**
- Modify: `src/scanner.js` (large rewrite — replaces `evaluateCell`, `evaluateVisualCell`, `runScan`, `runDeepScan`, `printReportCard`, `printDeepReport`, `htfAgree`, `dirOf`)

- [ ] **Step 1: Read the current `src/scanner.js` to understand what is being replaced**

```bash
wc -l src/scanner.js
```

You should see ~580 lines. The functions you are REMOVING: `evaluateCell`, `evaluateVisualCell`, `runScan` (old), `runDeepScan` (old), `printReportCard`, `printDeepReport`, `htfAgree`, `dirOf`, `runNumericGate`. Keep: `slugify`, `loadWatchlist`, `ltfCellPass` and `evaluateHtfChain` (added in Tasks 3–4), `runNumericCrossCheck` (added in Task 5).

- [ ] **Step 2: Replace the file body**

Open `src/scanner.js`. Above `slugify`, ensure the imports look exactly like this (replacing the existing import block at the top):

```javascript
// Scanner — drives the per-symbol HTF→LTF flow. For each watchlist item it:
//   1. runs the HTF rubric on 1M/1W/1D (sequential, fail-fast)
//   2. for Binance symbols, cross-checks HTF bias against numeric EMA alignment
//   3. runs the LTF rubric on 4H/2H/1H with HTF_BIAS injected
//   4. reports every LTF that passes the entry filter

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import {
  openTvClient,
  closeTvClient,
  setSymbol,
  setTimeframe,
  captureSymbolTf,
  getChartState,
  dismissPopups,
} from "./tv-navigate.js";
import { askGeminiVision, getTodaysCost, recordCost, fillRubric } from "./visual.js";
import { fetchCandles, emaAlignment, agree } from "./higher-tf.js";

const HTF_TIMEFRAMES = ["1M", "1W", "1D"];
const LTF_TIMEFRAMES = ["4H", "2H", "1H"];
const RESULT_DIR = "scan-results";
```

(If your `Task 5` insertion duplicated the `higher-tf.js` import, remove the duplicate — there should be exactly one such line.)

Keep `slugify`, `loadWatchlist`, `ltfCellPass`, `evaluateHtfChain`, and `runNumericCrossCheck` exactly as they are.

DELETE every other function in the file (the old `evaluateCell`, `evaluateVisualCell`, `runScan`, `runDeepScan`, `printReportCard`, `printDeepReport`, `htfAgree`, `dirOf`, `runNumericGate`).

- [ ] **Step 3: Add the new HTF cell evaluator**

Append to `src/scanner.js`:

```javascript
// Drives one HTF cell: switch chart, screenshot, ask Gemini with the htf-bias rubric.
async function evaluateHtfCell(client, item, tf, rubric) {
  const slug = slugify(item.label);
  await setTimeframe(client, tf);
  await dismissPopups(client);
  const imagePath = await captureSymbolTf(client, slug, tf);

  const prompt = fillRubric(rubric, { SYMBOL: item.label, TIMEFRAME: tf });
  const { result, costUSD, model } = await askGeminiVision({
    imagePath,
    prompt,
    model: process.env.VISUAL_MODEL || "gemini-2.5-flash",
  });
  recordCost(costUSD);

  return {
    tf,
    direction: result.direction,
    slope_ok: !!result.slope_ok,
    pullback_present: !!result.pullback_present,
    ema_stack_ok: !!result.ema_stack_ok,
    score: result.score ?? 0,
    red_flags: result.red_flags ?? [],
    reasoning: result.reasoning ?? "",
    image: imagePath,
    cost_usd: costUSD,
    model,
  };
}
```

- [ ] **Step 4: Add the new LTF cell evaluator**

Append:

```javascript
// Drives one LTF cell: switch chart, screenshot, ask Gemini with the
// ltf-entry rubric and the HTF bias injected.
async function evaluateLtfCell(client, item, tf, htfBias, rubric) {
  const slug = slugify(item.label);
  await setTimeframe(client, tf);
  await dismissPopups(client);
  const imagePath = await captureSymbolTf(client, slug, tf);

  const prompt = fillRubric(rubric, {
    SYMBOL: item.label,
    TIMEFRAME: tf,
    HTF_BIAS: htfBias,
  });
  const { result, costUSD, model } = await askGeminiVision({
    imagePath,
    prompt,
    model: process.env.VISUAL_MODEL || "gemini-2.5-flash",
  });
  recordCost(costUSD);

  const cell = {
    tf,
    zone_rejection: !!result.zone_rejection,
    coc_present: !!result.coc_present,
    strong_candle_in_bias: !!result.strong_candle_in_bias,
    score: result.score ?? 0,
    red_flags: result.red_flags ?? [],
    reasoning: result.reasoning ?? "",
    image: imagePath,
    cost_usd: costUSD,
    model,
  };
  cell.signals_count =
    (cell.zone_rejection ? 1 : 0) +
    (cell.coc_present ? 1 : 0) +
    (cell.strong_candle_in_bias ? 1 : 0);
  cell.pass = ltfCellPass(cell);
  return cell;
}
```

- [ ] **Step 5: Add the per-symbol orchestrator**

Append:

```javascript
// Single-symbol pipeline. Drives HTF chain → numeric cross-check → LTF chain.
// Returns the full result object matching the spec schema.
async function evaluateSymbol(client, item, htfRubric, ltfRubric, opts = {}) {
  const verbose = opts.verbose !== false;
  const log = (msg) => {
    if (verbose) console.log(msg);
  };

  const result = {
    symbol: item.label,
    tv_symbol: item.tv_symbol,
    started_at: new Date().toISOString(),
    stopped_at: null,
    stop_reason: null,
    htf_cells: [],
    htf_avg_score: null,
    htf_bias: null,
    numeric_check: { ran: false, direction: null, agreed: null },
    ltf_cells: [],
    triggers: [],
    cost_usd: 0,
  };

  await setSymbol(client, item.tv_symbol);
  await dismissPopups(client);

  // HTF chain (sequential, fail-fast)
  for (const tf of HTF_TIMEFRAMES) {
    log(`    HTF ${tf} ...`);
    const cell = await evaluateHtfCell(client, item, tf, htfRubric);
    result.htf_cells.push(cell);
    result.cost_usd += cell.cost_usd;
    log(`      dir=${cell.direction} score=${cell.score}`);

    const chain = evaluateHtfChain(result.htf_cells);
    if (chain.stopped) {
      result.stopped_at = chain.stopAt ?? tf;
      result.stop_reason = chain.stopReason;
      log(`    🚫 STOP @ ${result.stopped_at}: ${result.stop_reason}`);
      return result;
    }
  }

  const finalChain = evaluateHtfChain(result.htf_cells);
  result.htf_avg_score = finalChain.avgScore;
  if (finalChain.stopped) {
    result.stop_reason = finalChain.stopReason;
    log(`    🚫 STOP: ${result.stop_reason} (avg ${finalChain.avgScore?.toFixed(2)})`);
    return result;
  }
  result.htf_bias = finalChain.htfBias;
  log(`    ✅ HTF bias: ${result.htf_bias} (avg ${finalChain.avgScore.toFixed(2)})`);

  // Binance numeric cross-check
  if (item.binance_symbol) {
    const num = await runNumericCrossCheck(item.binance_symbol, result.htf_bias);
    result.numeric_check = num;
    log(
      `    numeric: ran=${num.ran} dir=${num.direction} agreed=${num.agreed}`,
    );
    if (!num.agreed) {
      result.stop_reason = "numeric_disagree";
      log(`    🚫 STOP: numeric_disagree`);
      return result;
    }
  }

  // LTF chain
  for (const tf of LTF_TIMEFRAMES) {
    log(`    LTF ${tf} ...`);
    const cell = await evaluateLtfCell(client, item, tf, result.htf_bias, ltfRubric);
    result.ltf_cells.push(cell);
    result.cost_usd += cell.cost_usd;
    log(
      `      signals=${cell.signals_count} score=${cell.score} ` +
        `pass=${cell.pass}`,
    );
    if (cell.pass) result.triggers.push(tf);
  }

  if (result.triggers.length === 0) {
    result.stop_reason = "no_entry";
  }
  return result;
}
```

- [ ] **Step 6: Add `runDeepScan` and `runScan`**

Append:

```javascript
function loadRubrics(opts = {}) {
  const htfPath = opts.htfRubricPath || "prompts/htf-bias.md";
  const ltfPath = opts.ltfRubricPath || "prompts/ltf-entry.md";
  return {
    htfRubric: readFileSync(htfPath, "utf8"),
    ltfRubric: readFileSync(ltfPath, "utf8"),
  };
}

function saveResult(prefix, label, payload) {
  if (!existsSync(RESULT_DIR)) mkdirSync(RESULT_DIR, { recursive: true });
  const stamp = (payload.started_at || new Date().toISOString()).replace(/[:.]/g, "-");
  const out = `${RESULT_DIR}/${prefix}-${slugify(label)}-${stamp}.json`;
  writeFileSync(out, JSON.stringify(payload, null, 2));
  writeFileSync(`${RESULT_DIR}/latest-${prefix}.json`, JSON.stringify(payload, null, 2));
  return out;
}

function summaryLine(r) {
  if (r.stop_reason && !r.htf_bias) {
    return `  ${r.symbol.padEnd(12)} STOP @ ${r.stopped_at ?? "—"} (${r.stop_reason})`;
  }
  if (r.stop_reason === "numeric_disagree") {
    return `  ${r.symbol.padEnd(12)} STOP numeric_disagree (HTF said ${r.htf_bias})`;
  }
  const numTxt = r.numeric_check.ran
    ? r.numeric_check.agreed
      ? "agree"
      : "disagree"
    : "n/a";
  const triggers = r.triggers.length ? `[${r.triggers.join(", ")}]` : "no entry";
  return (
    `  ${r.symbol.padEnd(12)} HTF: ${r.htf_bias} ` +
    `(avg ${r.htf_avg_score.toFixed(1)})  →  numeric: ${numTxt}  →  triggers: ${triggers}`
  );
}

export async function runDeepScan(symbolLabel, tvSymbol, options = {}) {
  const { htfRubric, ltfRubric } = loadRubrics(options);
  const item = {
    label: symbolLabel,
    tv_symbol: tvSymbol,
    binance_symbol: options.binanceSymbol ?? null,
  };

  console.log(
    `\n═══════════════════════════════════════════════════════════\n` +
      `  Deep scan: ${symbolLabel} (${tvSymbol})\n` +
      `  Flow: HTF [1M→1W→1D] → numeric → LTF [4H→2H→1H]\n` +
      `═══════════════════════════════════════════════════════════\n`,
  );

  let client;
  let result;
  try {
    client = await openTvClient();
    result = await evaluateSymbol(client, item, htfRubric, ltfRubric, { verbose: true });
  } finally {
    await closeTvClient(client);
  }

  console.log("\n" + summaryLine(result));
  const path = saveResult("deep", symbolLabel, result);
  console.log(`\nFull results saved → ${path}`);
  return result;
}

export async function runScan(options = {}) {
  const watchlist = loadWatchlist(options.watchlistPath || "watchlist.json");
  const { htfRubric, ltfRubric } = loadRubrics(options);

  const startedAt = new Date().toISOString();
  console.log(
    `\n═══════════════════════════════════════════════════════════\n` +
      `  Scan started: ${startedAt}\n` +
      `  Watchlist: ${watchlist.length} symbols\n` +
      `  Flow per symbol: HTF [1M→1W→1D] → numeric → LTF [4H→2H→1H]\n` +
      `═══════════════════════════════════════════════════════════\n`,
  );

  const results = [];
  let client;
  try {
    client = await openTvClient();
    for (const [i, item] of watchlist.entries()) {
      console.log(`\n[${i + 1}/${watchlist.length}] ▶ ${item.label} (${item.tv_symbol})`);
      try {
        const r = await evaluateSymbol(client, item, htfRubric, ltfRubric, { verbose: true });
        results.push(r);
      } catch (err) {
        console.log(`    ❌ ${err.message}`);
        results.push({
          symbol: item.label,
          tv_symbol: item.tv_symbol,
          stopped_at: null,
          stop_reason: `error: ${err.message}`,
          htf_cells: [],
          htf_bias: null,
          ltf_cells: [],
          triggers: [],
          cost_usd: 0,
        });
      }
    }
  } finally {
    await closeTvClient(client);
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Report Card");
  console.log("═══════════════════════════════════════════════════════════");
  for (const r of results) console.log(summaryLine(r));
  const allTriggers = results.filter((r) => r.triggers && r.triggers.length > 0);
  console.log("");
  if (allTriggers.length === 0) {
    console.log("  No entry signals this scan.");
  } else {
    console.log(`  ✅ ${allTriggers.length} symbol(s) with entry signals:`);
    for (const r of allTriggers) {
      console.log(`     - ${r.symbol} (${r.htf_bias}) → ${r.triggers.join(", ")}`);
    }
  }

  const summary = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    results,
  };
  const path = saveResult("scan", "watchlist", summary);
  console.log(`\nFull results saved → ${path}`);
  return summary;
}
```

- [ ] **Step 7: Run unit tests to verify nothing regressed**

```bash
node --test 'tests/*.test.mjs'
```
Expected: all pre-existing tests pass plus the 12 new flow tests.

- [ ] **Step 8: Commit**

```bash
git add src/scanner.js
git commit -m "feat(scanner): rewrite runScan/runDeepScan around HTF→LTF flow"
```

---

## Task 7: Verify `bot.js` still dispatches correctly

**Files:**
- Modify (read-only verification, edit only if needed): `bot.js`

- [ ] **Step 1: Confirm `bot.js` still wires the new functions**

```bash
grep -n "runScan\|runDeepScan" bot.js
```

Both should be imported from `./src/scanner.js` and called with the same signatures:
- `runScan(options?)`
- `runDeepScan(label, tvSymbol, options?)`

If the existing `bot.js` already calls them this way, no edit is needed. If the old `runDeepScan` signature accepted extra positional args (it didn't — verify against your local file), update the call sites accordingly.

- [ ] **Step 2: Run the bot in dry mode to confirm it starts**

```bash
node bot.js --help 2>&1 | head -10
```

Or just import-check:
```bash
node -e "import('./src/scanner.js').then(m => console.log(Object.keys(m)))"
```
Expected: prints `[ 'slugify', 'ltfCellPass', 'evaluateHtfChain', 'runDeepScan', 'runScan' ]` (order may vary).

- [ ] **Step 3: Commit if any edits were needed**

If `bot.js` needed changes:
```bash
git add bot.js
git commit -m "chore(bot): align dispatch with rewritten scanner"
```

---

## Task 8: Delete the old `scan-rubric.md`

**Files:**
- Delete: `prompts/scan-rubric.md`

- [ ] **Step 1: Confirm no code still references it**

```bash
grep -rn "scan-rubric" src/ bot.js tests/ 2>/dev/null
```
Expected: no matches. (If anything is found, it was missed in Task 6 — fix it now.)

- [ ] **Step 2: Delete the file**

```bash
git rm prompts/scan-rubric.md
```

- [ ] **Step 3: Commit**

```bash
git commit -m "chore(prompts): remove obsolete scan-rubric.md (replaced by htf-bias + ltf-entry)"
```

---

## Task 9: Integration test — `--deep EURUSD`

**Files:**
- No code changes. Manual run + screenshot/JSON verification.

- [ ] **Step 1: Clear existing EURUSD screenshots**

```bash
rm -f screenshots/EURUSD/*.png
```

- [ ] **Step 2: Run deep scan**

```bash
node bot.js --deep EURUSD 2>&1 | tee /tmp/eurusd-flow-test.log | tail -40
```

Expected console output (one of these patterns):
- HTF agreement + LTF triggers: `EURUSD  HTF: long (avg 7.X)  →  numeric: n/a  →  triggers: [...]`
- HTF disagreement: `EURUSD  STOP @ 1W (htf_disagree)` (or similar)
- Low quality: `EURUSD  STOP @ 1M (htf_quality_low)`

- [ ] **Step 3: Verify the JSON output**

```bash
cat scan-results/latest-deep.json
```

Confirm the JSON has the keys: `symbol`, `tv_symbol`, `started_at`, `stopped_at`, `stop_reason`, `htf_cells`, `htf_avg_score`, `htf_bias`, `numeric_check`, `ltf_cells`, `triggers`, `cost_usd`.

- [ ] **Step 4: Verify screenshots match the timeframe label**

```bash
ls -la screenshots/EURUSD/
```

If the HTF flow ran fully, expect `1M.png`, `1W.png`, `1D.png` (and `4H.png`, `2H.png`, `1H.png` if HTF passed).
If HTF stopped early, you'll only see screenshots for the cells that ran — that's correct fail-fast behavior.

Open one of the PNGs (e.g., `screenshots/EURUSD/1M.png`) and confirm the chart legend reads `Euro / U.S. Dollar · 1M · OANDA`. Repeat for any other captured TFs.

- [ ] **Step 5: Commit any artifacts (none expected)**

If the run produced any new tracked files (it shouldn't — `screenshots/` and `scan-results/` should be gitignored):

```bash
git status
```
Expected: clean working tree.

---

## Task 10: Run the full unit-test suite once more and update memory

**Files:**
- Read-only: run tests
- Memory file (auto-memory) update if appropriate.

- [ ] **Step 1: Run all tests**

```bash
node --test 'tests/*.test.mjs'
```
Expected: every test passes.

- [ ] **Step 2: Memory update**

Open `/Users/tejpalkumawat/.claude/projects/-Users-tejpalkumawat-Documents-buildfactory-buildfactory-platform/memory/trading_bot_project.md` and append a one-line note that the scanner now uses two prompts (HTF bias + LTF entry) instead of the single `scan-rubric.md`. No frontmatter changes.

- [ ] **Step 3: Final summary commit**

If anything else was modified during integration:
```bash
git status
git add -p
git commit -m "feat: complete HTF/LTF prompt split with integration verification"
```
