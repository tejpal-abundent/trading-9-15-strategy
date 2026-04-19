# Multi-Timeframe Candle-Verdict Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the HTF-only scanner into a 3-TF conditional pipeline (monthly direction filter → weekly quality gate → daily reactive trigger) with bias cascade, per-candle verdict analysis, and new distinct stop reasons.

**Architecture:** Each timeframe has a dedicated prompt that receives context from the prior timeframe (bias, score, zone flag). Every cell computes a `candle_verdict` sub-object (body type, wick profile, winner, liquidity sweep, pattern). The daily state machine replaces binary `strong_candle_in_bias` with three trigger types (momentum / sweep / pattern). A+ confluence detection flags setups where all three timeframes align.

**Tech Stack:** Node 18+, JavaScript ES modules, Gemini Vision API (via `@google/genai`), Chrome DevTools Protocol (TradingView Desktop), `node:test` for unit tests.

---

## File Structure

### Files to create

| Path | Purpose |
|---|---|
| `prompts/monthly-direction.md` | Monthly direction filter — 3 questions, outputs direction + zone flag + candle_verdict |
| `prompts/weekly-structure.md` | Weekly quality gate — receives monthly bias, outputs structural grade + candle_verdict + direction_conflict |
| `prompts/daily-trigger.md` | Daily reactive trigger — receives monthly+weekly, outputs state (NONE/WATCH/ENTER) + candle_verdict + direction_conflict |

### Files to modify

| Path | Change |
|---|---|
| `src/scanner.js` | Add `evaluateMonthlyCell`, `evaluateWeeklyCell`, `evaluateDailyCell`, new `dailyCellState`, new `evaluateSymbolV2` that replaces the HTF-only path, A+ confluence derivation |
| `tests/scanner-flow.test.mjs` | Tests for new `dailyCellState` (3 trigger types), bias cascade, direction_conflict handling, candle_verdict schema |

### Files unchanged

- `prompts/htf-bias.md` — kept for backward compat (old pipeline still works)
- `prompts/ltf-entry.md` — kept for backward compat
- `src/visual.js` — no changes needed (rawText already exposed, PRICING already includes pro models)
- `bot.js` — no changes (the `--htf-only` flag automatically uses the new pipeline when scanner routes to v2)

### Design boundaries

- **Prompts own all LLM instructions** — the scanner passes only context variables, never hard-coded heuristics.
- **Scanner owns orchestration + state machine** — prompts are pure judges; scanner decides what to do with their output.
- **No retroactive invalidation** — if daily says `direction_conflict`, we surface it; we do NOT overwrite the weekly/monthly verdicts.

---

## Task 1: Create monthly direction prompt

**Files:**
- Create: `prompts/monthly-direction.md`

- [ ] **Step 1: Write the prompt file**

Contents of `prompts/monthly-direction.md`:

````markdown
You are reviewing a {SYMBOL} MONTHLY chart — the highest-timeframe regime filter.

Your only job: decide which direction the market is allowed to be traded, and grade the most recent candle's story.

This is NOT a setup scan. Do not grade pullback quality. Do not rate structural score.

Indicators visible:
- **EMA9** (orange line)
- **EMA15** (purple line)

Return **pure JSON only** (no prose, no markdown fences).

### Step 1 — Direction

Look at the EMA stack and slope over the last 10-20 monthly candles:
- EMA9 above EMA15 AND both rising → `"long"`
- EMA9 below EMA15 AND both falling → `"short"`
- EMAs tangled, flat, or freshly crossed → `"none"`

If `direction === "none"`, still fill the candle_verdict but set `in_9_15_zone = false`.

### Step 2 — A+ zone flag

Is the rightmost candle currently touching or inside the EMA9-EMA15 band?
- `in_9_15_zone: true` if candle range overlaps the EMA band
- `in_9_15_zone: false` otherwise

This is a BONUS A+ flag — not a requirement.

### Step 3 — Candle Verdict (MANDATORY — read the most recent CLOSED monthly candle)

Examine the rightmost CLOSED candle (not the forming one if still incomplete):

1. **body_type** — "solid" (body ≥ 60% of range), "normal" (30-60%), "doji" (< 10%), "highwave" (small body + huge wicks both sides)
2. **body_pct_of_range** (0-100) — integer
3. **upper_wick_pct** (0-100) — integer
4. **lower_wick_pct** (0-100) — integer
5. **close_position** — "at_high", "upper_third", "mid", "lower_third", "at_low"
6. **winner** — "buyers", "sellers", or "mixed" (based on body direction + close position)
7. **winner_strength** (0-10) — 10 = decisive (solid body, close at extreme, clear direction); 5 = mixed; 0 = doji
8. **liquidity_swept** — "below_prior_low" if this candle wicked below the previous candle's low then closed above it; "above_prior_high" if symmetric; "none" otherwise
9. **pattern** — "solid_bull", "solid_bear", "hammer", "shooting_star", "engulfing_bull", "engulfing_bear", "inside_bar", "pinbar_bull", "pinbar_bear", "doji", or "none"
10. **in_bias** — true if `winner` matches `direction`; false otherwise (always false when direction === "none")
11. **verdict** — one sentence: who won this bar and how

### Output format

```json
{
  "direction": "long" | "short" | "none",
  "in_9_15_zone": bool,
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
  "reasoning": "one sentence naming the direction and strongest supporting evidence"
}
```
````

- [ ] **Step 2: Commit**

```bash
git add prompts/monthly-direction.md
git commit -m "feat(prompts): add monthly direction-filter prompt with candle_verdict"
```

---

## Task 2: Create weekly structure prompt

**Files:**
- Create: `prompts/weekly-structure.md`

- [ ] **Step 1: Write the prompt file**

Contents of `prompts/weekly-structure.md`:

````markdown
You are reviewing a {SYMBOL} WEEKLY chart for **structural quality** within a higher-timeframe bias.

## Reactive principle

Grade what HAS happened on the visible chart. Do not predict what the next candle will do — describe what the EMAs and price are *currently showing*.

## Bias context

The MONTHLY bias has been established: **{MONTHLY_BIAS}**.
{MONTHLY_IN_9_15_ZONE_NOTE}

Grade this weekly chart AS A {MONTHLY_BIAS} setup.

- Look for a clean {MONTHLY_BIAS} pullback into the EMA9-EMA15 band with rejection back in the bias direction,
  OR a {MONTHLY_BIAS} continuation with solid follow-through candles.
- If the chart clearly shows the OPPOSITE direction (EMAs stacked against monthly, momentum against it, no recoverable structure), DO NOT force-fit. Set `direction_conflict = true` and `direction = "none"`. Honest disagreement is more valuable than forced agreement.

The chart has two indicators visible:
- **EMA9** (orange line)
- **EMA15** (purple line)

Return **pure JSON only**.

### Step 0 — Identify the CURRENT candle FIRST

Before grading anything, locate the **rightmost candle** on the chart — this is the current/forming bar. Use the OHLC values at the top of the chart which refer to THIS candle.

### Step 1 — Confirm or refute direction

Given the monthly bias ({MONTHLY_BIAS}), does the weekly chart support it?

- Supports → set `direction = "{MONTHLY_BIAS}"`, `direction_conflict = false`
- Chart shows clear opposite → set `direction = "none"`, `direction_conflict = true`, skip remaining grading
- EMAs tangled / just flipped / ambiguous → set `direction = "none"`, `direction_conflict = false`, skip remaining grading

### Step 2 — Identify setup type

- **"pullback"** — price recently retraced INTO the EMA9-EMA15 band and just rejected away from it in the bias direction
- **"continuation"** — pullback already happened; now seeing solid follow-through candles
- **"none"** — neither; choppy or flat

### Step 3 — Structural grading

1. **angle_ok** *(bool)* — EMA9/EMA15 slope at the most recent pullback turning point ≥ 30-40°
2. **pullback_present** *(bool)* — clean pullback into the 9-15 band visible in recent history
3. **ema_stack_ok** *(bool)* — EMA9 cleanly above EMA15 for long, below for short
4. **solid_continuation** *(bool)* — recent 3-5 candles show solid bodies (≥60%) closing in bias direction
5. **probability_next_candle_in_bias** *(int 0-100)*
6. **red_flags** *(array)* — "choppy_structure", "tangled_emas", "exhaustion"
7. **score** *(int 0-10)* — 10 textbook, 7 acceptable, < 6 reject

### Step 4 — Candle Verdict (MANDATORY)

Read the rightmost CLOSED weekly candle. Use the same 11 fields as defined in the output schema below. The `in_bias` field checks against `direction` (or the monthly bias if direction resolved to "none" but conflict = false).

### Output format

```json
{
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
````

- [ ] **Step 2: Commit**

```bash
git add prompts/weekly-structure.md
git commit -m "feat(prompts): add weekly structure prompt with bias cascade and candle_verdict"
```

---

## Task 3: Create daily trigger prompt

**Files:**
- Create: `prompts/daily-trigger.md`

- [ ] **Step 1: Write the prompt file**

Contents of `prompts/daily-trigger.md`:

````markdown
You are reviewing a {SYMBOL} DAILY chart for **entry trigger** within an established higher-timeframe bias.

## Reactive trading principle

Grade what HAS happened on the most recent CLOSED candle. Never enter on prediction — only when a confirmation candle has actually closed in the bias direction. This system trades reactively.

## Bias context

- Monthly bias: **{MONTHLY_BIAS}**
- Weekly bias: **{WEEKLY_BIAS}** (score {WEEKLY_SCORE}/10)
- Weekly pullback present: {WEEKLY_PULLBACK_PRESENT}

You are ONLY looking for a **{WEEKLY_BIAS}** entry trigger on the daily chart.

If the chart clearly shows the opposite direction (daily structure has broken against weekly bias, momentum clearly against, clear trend flip), return `direction_conflict = true` and `state = "NONE"`.

The chart has two indicators visible:
- **EMA9** (orange line)
- **EMA15** (purple line)

Return **pure JSON only**.

### Step 0 — Identify the CURRENT candle FIRST

Locate the **rightmost candle**. OHLC at top of chart refers to THIS candle. All grading is on the most recent CLOSED candle (the one to the immediate left of the forming bar, if the current bar is incomplete).

### Step 1 — Prep signals (setup forming)

Grade 4 signals. Each is a precondition for a valid trigger — not the trigger itself.

1. **angle_ok** *(bool)* — EMA9/EMA15 slope steep enough (≥ 30-40°) at the most recent pullback turning point
2. **zone_rejection** *(bool)* — price recently touched the EMA9-EMA15 band and rejected back in the {WEEKLY_BIAS} direction
3. **coc_present** *(bool)* — Change of Character: a structural shift (previous counter-trend move has broken, resumed moving in {WEEKLY_BIAS})
4. **solid_continuation** *(bool)* — recent 3-5 candles closing with solid bodies in {WEEKLY_BIAS} direction

`prep_signals_count` = sum of the 4 above.

### Step 2 — Trigger candle (candle_verdict)

Read the rightmost CLOSED candle. This is THE trigger candle — if it confirms the setup, we ENTER; if not, we WATCH.

Full candle_verdict sub-object — all 11 fields as defined in the output schema.

**Key checks on the trigger candle:**
- Is the candle's body closing in {WEEKLY_BIAS} direction with decent body %?
- Did it sweep the prior candle's wick (liquidity grab) and reject?
- Is it a classic bullish/bearish pattern (hammer, pinbar, engulfing)?

### Step 3 — State determination

Compute the state locally in the prompt as the SUM of:

Set `state` based on:

- If `direction_conflict === true` → `"NONE"`
- If `red_flags.length > 0` → `"NONE"`
- If `prep_signals_count < 2` → `"NONE"`
- Else if `candle_verdict.in_bias === false` → `"WATCH"` (setup formed, waiting for confirmation)
- Else if `candle_verdict.winner_strength < 7` → `"WATCH"` (confirmation too weak)
- Else → `"ENTER"`

The `trigger_type` classifies WHY this is an ENTER (only meaningful when state = "ENTER"):
- `"momentum"` — pattern is "solid_bull" / "solid_bear", winner_strength ≥ 7
- `"sweep"` — liquidity_swept is "below_prior_low" (long) or "above_prior_high" (short), plus winner matches bias
- `"pattern"` — pattern is hammer / pinbar_bull (long) or shooting_star / pinbar_bear (short) or engulfing_{bull,bear}
- `"none"` — state != "ENTER"

### Step 4 — Red flags

- `"choppy_structure"` — last several daily candles overlap with no clear direction
- `"tangled_emas"` — EMA9/EMA15 cross back and forth recently
- `"exhaustion"` — multiple long wicks against bias, failure to follow through

### Step 5 — Probability (for ranking only)

**probability_next_candle_in_bias** (0-100) — estimate of next daily closing in {WEEKLY_BIAS}. Ranks multiple ENTER signals across timeframes; does NOT gate state.

### Output format

```json
{
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
````

- [ ] **Step 2: Commit**

```bash
git add prompts/daily-trigger.md
git commit -m "feat(prompts): add daily trigger prompt with 3-type state machine and candle_verdict"
```

---

## Task 4: Add `dailyCellState` with 3 trigger types (TDD)

**Files:**
- Modify: `src/scanner.js` (add new function alongside existing `ltfCellState`)
- Test: `tests/scanner-flow.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/scanner-flow.test.mjs`:

```javascript
import { dailyCellState } from "../src/scanner.js";

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
  assert.equal(dailyCellState({ prep_signals_count: 4, red_flags: [], direction_conflict: false }), "NONE");
});

test("dailyCellState: null or missing cell → NONE", () => {
  assert.equal(dailyCellState(null), "NONE");
  assert.equal(dailyCellState(undefined), "NONE");
  assert.equal(dailyCellState({}), "NONE");
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `node --test tests/scanner-flow.test.mjs`
Expected: FAIL with `dailyCellState is not a function` or similar import error.

- [ ] **Step 3: Add `dailyCellState` to `src/scanner.js`**

Add this near the existing `ltfCellState` function:

```javascript
// Daily-level reactive state machine. Identical spirit to ltfCellState but
// operating on richer candle_verdict fields:
//
//   NONE  — direction_conflict OR red_flags OR prep_signals_count < 2
//           OR missing candle_verdict
//   WATCH — prep ready, but candle_verdict doesn't confirm yet
//             (in_bias === false OR winner_strength < 7)
//   ENTER — prep ready AND candle_verdict.in_bias AND winner_strength >= 7
//
// The prompt also computes this locally; we recompute here as a safety net
// so the code's view of state stays authoritative.
export function dailyCellState(cell) {
  if (!cell || typeof cell !== "object") return "NONE";
  if (cell.direction_conflict === true) return "NONE";
  const flags = cell.red_flags || [];
  if (flags.length > 0) return "NONE";
  if ((cell.prep_signals_count ?? 0) < 2) return "NONE";
  const v = cell.candle_verdict;
  if (!v || typeof v !== "object") return "NONE";
  if (v.in_bias !== true) return "WATCH";
  if ((v.winner_strength ?? 0) < 7) return "WATCH";
  return "ENTER";
}

// Classifies the ENTER trigger type based on candle_verdict. Only meaningful
// when state === "ENTER". Returns "none" otherwise.
export function dailyTriggerType(cell, weeklyBias) {
  if (!cell || dailyCellState(cell) !== "ENTER") return "none";
  const v = cell.candle_verdict;
  const isLong = weeklyBias === "long";

  // Sweep trigger — highest conviction: liquidity grabbed + reversed in bias
  const sweepMatch = isLong
    ? v.liquidity_swept === "below_prior_low"
    : v.liquidity_swept === "above_prior_high";
  if (sweepMatch) return "sweep";

  // Pattern trigger — classic reversal/continuation named pattern in bias
  const patternSet = isLong
    ? new Set(["hammer", "pinbar_bull", "engulfing_bull"])
    : new Set(["shooting_star", "pinbar_bear", "engulfing_bear"]);
  if (patternSet.has(v.pattern)) return "pattern";

  // Momentum trigger — solid directional body
  const momentumMatch = isLong
    ? v.pattern === "solid_bull"
    : v.pattern === "solid_bear";
  if (momentumMatch) return "momentum";

  // Fallback — cell entered but pattern didn't classify; still a valid ENTER
  return "momentum";
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `node --test tests/scanner-flow.test.mjs`
Expected: PASS — 9 new `dailyCellState` tests should now green.

- [ ] **Step 5: Commit**

```bash
git add src/scanner.js tests/scanner-flow.test.mjs
git commit -m "feat(scanner): add dailyCellState with 3-trigger-type classification"
```

---

## Task 5: Add `evaluateMonthlyCell` function

**Files:**
- Modify: `src/scanner.js`

- [ ] **Step 1: Add the function**

Add to `src/scanner.js` below the existing `evaluateLtfCell`:

```javascript
// Parse-failure detector for monthly. The monthly prompt requires a direction
// string and a candle_verdict sub-object.
function isMonthlyParseFailure(result) {
  return (
    !result ||
    typeof result.direction !== "string" ||
    result.direction.length === 0 ||
    !result.candle_verdict
  );
}

// Monthly direction-filter cell. Uses monthly-direction.md prompt.
// Cheap (small prompt) — just asks direction + 9-15 zone + candle verdict.
async function evaluateMonthlyCell(client, item, rubric) {
  const slug = slugify(item.label);
  await setTimeframe(client, "1M");
  await dismissPopups(client);
  let imagePath = await captureSymbolTf(client, slug, "1M", item.tv_symbol);

  const prompt = fillRubric(rubric, { SYMBOL: item.label });
  const primaryModel =
    process.env.MONTHLY_MODEL ||
    process.env.VISUAL_MODEL ||
    "gemini-3.1-pro-preview";
  const fallbackModel = pickFallbackModel(primaryModel);

  const maxAttempts = 2;
  let result, model;
  let totalCost = 0;
  let attempts = 0;
  let parseFailed = false;
  let usedFallback = false;
  const rawTrace = [];

  while (attempts < maxAttempts) {
    attempts++;
    const isRetry = attempts > 1;
    let modelToUse = primaryModel;
    if (isRetry) {
      imagePath = await captureSymbolTf(client, slug, "1M", item.tv_symbol);
      modelToUse = fallbackModel;
      usedFallback = true;
    }
    const resp = await askGeminiVision({ imagePath, prompt, model: modelToUse });
    recordCost(resp.costUSD);
    totalCost += resp.costUSD;
    result = resp.result;
    model = resp.model;
    rawTrace.push({
      attempt: attempts,
      model: resp.model,
      raw_text: (resp.rawText ?? "").slice(0, 2000),
    });
    if (!isMonthlyParseFailure(result)) {
      parseFailed = false;
      break;
    }
    parseFailed = true;
  }

  if (parseFailed) {
    logParseFailure({
      timestamp: new Date().toISOString(),
      symbol: item.label,
      tv_symbol: item.tv_symbol,
      tf: "1M",
      attempts,
      image: imagePath,
      attempts_detail: rawTrace,
    });
  }

  return {
    tf: "1M",
    direction: result?.direction,
    in_9_15_zone: !!result?.in_9_15_zone,
    candle_verdict: result?.candle_verdict ?? null,
    reasoning: result?.reasoning ?? "",
    image: imagePath,
    cost_usd: totalCost,
    model,
    parse_failed: parseFailed,
    attempts,
    used_fallback: usedFallback && !parseFailed,
  };
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check src/scanner.js`
Expected: no output (silent success).

- [ ] **Step 3: Commit**

```bash
git add src/scanner.js
git commit -m "feat(scanner): add evaluateMonthlyCell for direction-filter timeframe"
```

---

## Task 6: Add `evaluateWeeklyCell` with monthly bias cascade

**Files:**
- Modify: `src/scanner.js`

- [ ] **Step 1: Add the function**

Add to `src/scanner.js` below `evaluateMonthlyCell`:

```javascript
// Parse-failure detector for weekly.
function isWeeklyParseFailure(result) {
  return (
    !result ||
    typeof result.direction !== "string" ||
    result.direction.length === 0 ||
    !result.candle_verdict
  );
}

// Weekly structural-gate cell. Receives monthly bias as context.
async function evaluateWeeklyCell(client, item, monthlyCell, rubric) {
  const slug = slugify(item.label);
  await setTimeframe(client, "1W");
  await dismissPopups(client);
  let imagePath = await captureSymbolTf(client, slug, "1W", item.tv_symbol);

  const monthlyBias = monthlyCell.direction || "none";
  const in9_15Note = monthlyCell.in_9_15_zone
    ? "Monthly price is currently in the 9-15 zone — this is an A+ setup context."
    : "";
  const prompt = fillRubric(rubric, {
    SYMBOL: item.label,
    MONTHLY_BIAS: monthlyBias,
    MONTHLY_IN_9_15_ZONE_NOTE: in9_15Note,
  });

  const primaryModel =
    process.env.WEEKLY_MODEL ||
    process.env.VISUAL_MODEL ||
    "gemini-3.1-pro-preview";
  const fallbackModel = pickFallbackModel(primaryModel);

  const maxAttempts = 2;
  let result, model;
  let totalCost = 0;
  let attempts = 0;
  let parseFailed = false;
  let usedFallback = false;
  const rawTrace = [];

  while (attempts < maxAttempts) {
    attempts++;
    const isRetry = attempts > 1;
    let modelToUse = primaryModel;
    if (isRetry) {
      imagePath = await captureSymbolTf(client, slug, "1W", item.tv_symbol);
      modelToUse = fallbackModel;
      usedFallback = true;
    }
    const resp = await askGeminiVision({ imagePath, prompt, model: modelToUse });
    recordCost(resp.costUSD);
    totalCost += resp.costUSD;
    result = resp.result;
    model = resp.model;
    rawTrace.push({
      attempt: attempts,
      model: resp.model,
      raw_text: (resp.rawText ?? "").slice(0, 2000),
    });
    if (!isWeeklyParseFailure(result)) {
      parseFailed = false;
      break;
    }
    parseFailed = true;
  }

  if (parseFailed) {
    logParseFailure({
      timestamp: new Date().toISOString(),
      symbol: item.label,
      tv_symbol: item.tv_symbol,
      tf: "1W",
      attempts,
      image: imagePath,
      attempts_detail: rawTrace,
    });
  }

  return {
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
    reasoning: result?.reasoning ?? "",
    image: imagePath,
    cost_usd: totalCost,
    model,
    parse_failed: parseFailed,
    attempts,
    used_fallback: usedFallback && !parseFailed,
  };
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check src/scanner.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/scanner.js
git commit -m "feat(scanner): add evaluateWeeklyCell with monthly bias cascade"
```

---

## Task 7: Add `evaluateDailyCell` with monthly + weekly cascade

**Files:**
- Modify: `src/scanner.js`

- [ ] **Step 1: Add the function**

Add to `src/scanner.js` below `evaluateWeeklyCell`:

```javascript
// Parse-failure detector for daily. Requires candle_verdict and state.
function isDailyParseFailure(result) {
  return (
    !result ||
    !result.candle_verdict ||
    typeof result.state !== "string"
  );
}

// Daily reactive-trigger cell. Receives monthly + weekly context.
async function evaluateDailyCell(client, item, monthlyCell, weeklyCell, rubric) {
  const slug = slugify(item.label);
  await setTimeframe(client, "1D");
  await dismissPopups(client);
  let imagePath = await captureSymbolTf(client, slug, "1D", item.tv_symbol);

  const prompt = fillRubric(rubric, {
    SYMBOL: item.label,
    MONTHLY_BIAS: monthlyCell.direction || "none",
    WEEKLY_BIAS: weeklyCell.direction || "none",
    WEEKLY_SCORE: String(weeklyCell.score ?? 0),
    WEEKLY_PULLBACK_PRESENT: String(!!weeklyCell.pullback_present),
  });

  const primaryModel =
    process.env.DAILY_MODEL ||
    process.env.VISUAL_MODEL ||
    "gemini-3.1-pro-preview";
  const fallbackModel = pickFallbackModel(primaryModel);

  const maxAttempts = 2;
  let result, model;
  let totalCost = 0;
  let attempts = 0;
  let parseFailed = false;
  let usedFallback = false;
  const rawTrace = [];

  while (attempts < maxAttempts) {
    attempts++;
    const isRetry = attempts > 1;
    let modelToUse = primaryModel;
    if (isRetry) {
      imagePath = await captureSymbolTf(client, slug, "1D", item.tv_symbol);
      modelToUse = fallbackModel;
      usedFallback = true;
    }
    const resp = await askGeminiVision({ imagePath, prompt, model: modelToUse });
    recordCost(resp.costUSD);
    totalCost += resp.costUSD;
    result = resp.result;
    model = resp.model;
    rawTrace.push({
      attempt: attempts,
      model: resp.model,
      raw_text: (resp.rawText ?? "").slice(0, 2000),
    });
    if (!isDailyParseFailure(result)) {
      parseFailed = false;
      break;
    }
    parseFailed = true;
  }

  if (parseFailed) {
    logParseFailure({
      timestamp: new Date().toISOString(),
      symbol: item.label,
      tv_symbol: item.tv_symbol,
      tf: "1D",
      attempts,
      image: imagePath,
      attempts_detail: rawTrace,
    });
  }

  const cell = {
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
    reasoning: result?.reasoning ?? "",
    image: imagePath,
    cost_usd: totalCost,
    model,
    parse_failed: parseFailed,
    attempts,
    used_fallback: usedFallback && !parseFailed,
  };
  // Authoritative state computation from our code — ignores prompt's self-reported
  // state if it disagrees. Keeps scanner logic the source of truth.
  cell.state = dailyCellState(cell);
  cell.trigger_type = dailyTriggerType(cell, weeklyCell.direction);
  return cell;
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check src/scanner.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/scanner.js
git commit -m "feat(scanner): add evaluateDailyCell with monthly+weekly cascade"
```

---

## Task 8: Add `evaluateSymbolV2` — the new 3-TF pipeline

**Files:**
- Modify: `src/scanner.js`

- [ ] **Step 1: Add the new pipeline function**

Add to `src/scanner.js` below `evaluateDailyCell`:

```javascript
function loadV2Rubrics(opts = {}) {
  return {
    monthlyRubric: readFileSync(
      opts.monthlyRubricPath || "prompts/monthly-direction.md",
      "utf8",
    ),
    weeklyRubric: readFileSync(
      opts.weeklyRubricPath || "prompts/weekly-structure.md",
      "utf8",
    ),
    dailyRubric: readFileSync(
      opts.dailyRubricPath || "prompts/daily-trigger.md",
      "utf8",
    ),
  };
}

// Derives the confluence grade by stacking verdicts across 3 TFs.
// A+  — all 3 bias-aligned, monthly in 9-15 zone, weekly score >= 8, daily state = ENTER with sweep/pattern
// A   — all 3 bias-aligned, weekly score >= 8, daily state = ENTER
// B   — all 3 bias-aligned, daily state = ENTER (any trigger_type)
// C   — monthly + weekly aligned, daily state = WATCH
// —   — anything else
function deriveConfluence(monthly, weekly, daily) {
  if (!monthly || !weekly || !daily) return "—";
  if (monthly.direction === "none" || weekly.direction === "none") return "—";
  if (weekly.direction !== monthly.direction) return "—";
  if (daily.direction_conflict) return "—";

  if (daily.state === "ENTER") {
    const sweepOrPattern =
      daily.trigger_type === "sweep" || daily.trigger_type === "pattern";
    if (monthly.in_9_15_zone && weekly.score >= 8 && sweepOrPattern) return "A+";
    if (weekly.score >= 8) return "A";
    return "B";
  }
  if (daily.state === "WATCH") return "C";
  return "—";
}

// New 3-TF pipeline: monthly direction filter → weekly quality gate → daily trigger.
// Bias cascades downstream. Stops early on any failure. Returns a result object
// with distinct stop_reason values.
export async function evaluateSymbolV2(client, item, rubrics, opts = {}) {
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
    monthly: null,
    weekly: null,
    daily: null,
    confluence_grade: "—",
    cost_usd: 0,
    pipeline: "v2-mtf-candle-verdict",
  };

  await setSymbol(client, item.tv_symbol);
  await dismissPopups(client);

  // ─── Step 1: Monthly ───────────────────────────────────────────────────
  log("    Monthly ...");
  result.monthly = await evaluateMonthlyCell(client, item, rubrics.monthlyRubric);
  result.cost_usd += result.monthly.cost_usd;

  if (result.monthly.parse_failed) {
    result.stopped_at = "1M";
    result.stop_reason = "llm_parse_error";
    log(`      ⚠️  parse_failed (tried ${result.monthly.attempts}x)`);
    return result;
  }
  log(`      dir=${result.monthly.direction} in_9_15=${result.monthly.in_9_15_zone}`);

  if (result.monthly.direction === "none") {
    result.stopped_at = "1M";
    result.stop_reason = "monthly_no_trend";
    log(`    🚫 STOP @ 1M: monthly_no_trend`);
    return result;
  }

  // ─── Step 2: Weekly (conditioned on monthly bias) ──────────────────────
  log("    Weekly ...");
  result.weekly = await evaluateWeeklyCell(
    client,
    item,
    result.monthly,
    rubrics.weeklyRubric,
  );
  result.cost_usd += result.weekly.cost_usd;

  if (result.weekly.parse_failed) {
    result.stopped_at = "1W";
    result.stop_reason = "llm_parse_error";
    log(`      ⚠️  parse_failed (tried ${result.weekly.attempts}x)`);
    return result;
  }

  if (result.weekly.direction_conflict) {
    result.stopped_at = "1W";
    result.stop_reason = "monthly_weekly_disagree";
    log(`    🚫 STOP @ 1W: monthly_weekly_disagree (weekly saw opposite of ${result.monthly.direction})`);
    return result;
  }

  if (result.weekly.direction === "none") {
    result.stopped_at = "1W";
    result.stop_reason = "weekly_no_setup";
    log(`    🚫 STOP @ 1W: weekly_no_setup (ambiguous structure)`);
    return result;
  }

  if ((result.weekly.red_flags || []).length > 0) {
    result.stopped_at = "1W";
    result.stop_reason = "weekly_red_flag";
    log(`    🚫 STOP @ 1W: weekly_red_flag (${result.weekly.red_flags.join(", ")})`);
    return result;
  }

  if ((result.weekly.score ?? 0) < 7) {
    result.stopped_at = "1W";
    result.stop_reason = "weekly_quality_low";
    log(`    🚫 STOP @ 1W: weekly_quality_low (score ${result.weekly.score})`);
    return result;
  }

  log(
    `      dir=${result.weekly.direction} score=${result.weekly.score} setup=${result.weekly.setup_type}`,
  );

  // ─── Step 3: Daily (conditioned on monthly + weekly) ───────────────────
  log("    Daily ...");
  result.daily = await evaluateDailyCell(
    client,
    item,
    result.monthly,
    result.weekly,
    rubrics.dailyRubric,
  );
  result.cost_usd += result.daily.cost_usd;

  if (result.daily.parse_failed) {
    result.stopped_at = "1D";
    result.stop_reason = "llm_parse_error";
    log(`      ⚠️  parse_failed (tried ${result.daily.attempts}x)`);
    return result;
  }

  if (result.daily.direction_conflict) {
    result.stopped_at = "1D";
    result.stop_reason = "weekly_daily_disagree";
    log(`    🚫 STOP @ 1D: weekly_daily_disagree (daily broke against ${result.weekly.direction})`);
    return result;
  }

  log(
    `      state=${result.daily.state} prep=${result.daily.prep_signals_count}/4 ` +
      `trigger=${result.daily.trigger_type}`,
  );

  // Completion — derive confluence grade
  result.confluence_grade = deriveConfluence(
    result.monthly,
    result.weekly,
    result.daily,
  );
  return result;
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check src/scanner.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/scanner.js
git commit -m "feat(scanner): add evaluateSymbolV2 — 3-TF conditional pipeline with confluence grade"
```

---

## Task 9: Add `runScanV2` and route `--htf-only` to it

**Files:**
- Modify: `src/scanner.js`

- [ ] **Step 1: Add summary helpers**

Add to `src/scanner.js` below `summaryLine`:

```javascript
function v2SummaryLine(r) {
  if (r.stop_reason) {
    return `  ${r.symbol.padEnd(12)} STOP @ ${r.stopped_at ?? "—"} (${r.stop_reason})`;
  }
  const bias = r.weekly?.direction ?? r.monthly?.direction ?? "?";
  const dirTag = bias === "long" ? "📈 LONG" : bias === "short" ? "📉 SHORT" : "— UNKNOWN";
  const state = r.daily?.state ?? "?";
  const trig = r.daily?.trigger_type ?? "—";
  const zone = r.monthly?.in_9_15_zone ? "  [9-15 zone]" : "";
  const grade = r.confluence_grade;
  return `  ${r.symbol.padEnd(12)} ${dirTag}  ${state}  trigger=${trig}  grade=${grade}${zone}`;
}
```

- [ ] **Step 2: Add runScanV2**

Add to `src/scanner.js` below `runScan`:

```javascript
// New-pipeline scan: monthly-weekly-daily with candle_verdict + bias cascade.
// Used by the --htf-only flag (which now always routes to V2).
export async function runScanV2(options = {}) {
  const watchlist = loadWatchlist(options.watchlistPath || "watchlist.json");
  const rubrics = loadV2Rubrics(options);

  const startedAt = new Date().toISOString();
  console.log(
    `\n═══════════════════════════════════════════════════════════\n` +
      `  Scan started: ${startedAt}   (pipeline: v2 mtf-candle-verdict)\n` +
      `  Watchlist: ${watchlist.length} symbols\n` +
      `  Flow per symbol: Monthly (direction) → Weekly (quality) → Daily (trigger)\n` +
      `═══════════════════════════════════════════════════════════\n`,
  );

  const results = [];
  let client;
  try {
    client = await openTvClient();
    for (const [i, item] of watchlist.entries()) {
      console.log(
        `\n[${i + 1}/${watchlist.length}] ▶ ${item.label} (${item.tv_symbol})`,
      );
      try {
        const r = await evaluateSymbolV2(client, item, rubrics, { verbose: true });
        results.push(r);
      } catch (err) {
        console.log(`    ❌ ${err.message}`);
        results.push({
          symbol: item.label,
          tv_symbol: item.tv_symbol,
          stopped_at: null,
          stop_reason: `error: ${err.message}`,
          monthly: null,
          weekly: null,
          daily: null,
          confluence_grade: "—",
          cost_usd: 0,
          pipeline: "v2-mtf-candle-verdict",
        });
      }
    }
  } finally {
    await closeTvClient(client);
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Report Card");
  console.log("═══════════════════════════════════════════════════════════");
  for (const r of results) console.log(v2SummaryLine(r));

  // Aggregate ENTER and WATCH candidates sorted by confluence grade
  const gradeOrder = { "A+": 0, "A": 1, "B": 2, "C": 3, "—": 4 };
  const candidates = results
    .filter((r) => r.confluence_grade !== "—")
    .sort((a, b) => gradeOrder[a.confluence_grade] - gradeOrder[b.confluence_grade]);

  if (candidates.length === 0) {
    console.log("\n  No candidates this scan.");
  } else {
    console.log("\n  Candidates (ranked by confluence):");
    for (const r of candidates) console.log(`    ${v2SummaryLine(r).trim()}`);
  }

  const totalCost = results.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
  console.log(`\n  Total LLM cost: $${totalCost.toFixed(4)}`);

  const payload = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    pipeline: "v2-mtf-candle-verdict",
    results,
  };
  const path = saveResult("scan-v2", "watchlist", payload);
  console.log(`\nFull results saved → ${path}`);
  return payload;
}
```

- [ ] **Step 3: Route `--htf-only` to runScanV2**

Modify `bot.js` — change the `--htf-only` branch:

Find:
```javascript
  } else if (process.argv.includes("--scan")) {
    const htfOnly = process.argv.includes("--htf-only");
    import("./src/scanner.js")
      .then(({ runScan }) => runScan({ htfOnly }))
      .catch((err) => {
```

Replace with:
```javascript
  } else if (process.argv.includes("--scan")) {
    const htfOnly = process.argv.includes("--htf-only");
    import("./src/scanner.js")
      .then(({ runScan, runScanV2 }) =>
        htfOnly ? runScanV2() : runScan({ htfOnly: false }),
      )
      .catch((err) => {
```

- [ ] **Step 4: Syntax check**

Run: `node --check src/scanner.js && node --check bot.js`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/scanner.js bot.js
git commit -m "feat(scanner): add runScanV2 + route --htf-only to new pipeline"
```

---

## Task 10: Verify tests still pass

**Files:**
- Run: `tests/scanner-flow.test.mjs`

- [ ] **Step 1: Run full test suite**

Run: `node --test tests/*.test.mjs`
Expected: all previously-passing tests plus 9 new `dailyCellState` tests → all green.

- [ ] **Step 2: If any test fails, fix and re-run before moving on**

Common issues:
- Import path typo in new test file
- Missing export of `dailyCellState` from scanner.js (should be `export function dailyCellState`)

- [ ] **Step 3: Commit only if everything green**

No new code commits here — this is a verification task. If any issue surfaces a fix, commit the fix with:

```bash
git commit -m "test: fix ..."
```

---

## Task 11: Smoke-test with a single symbol

**Files:**
- No code changes — live verification only

- [ ] **Step 1: Ensure TradingView Desktop is running with CDP enabled**

Check: open a new terminal and run `curl -s http://localhost:9222/json/version`
Expected: JSON response containing a `Browser` field. If not, the user needs to launch TradingView Desktop with `--remote-debugging-port=9222`.

- [ ] **Step 2: Run deep scan on a single known-good symbol**

For V2 deep scan, we reuse `runDeepScan` path? Actually V2 doesn't expose a single-symbol entry yet. Use the full watchlist scan temporarily — or add a flag. For smoke test simplicity, temporarily trim `watchlist.json` to 1 symbol (`GBPJPY`) and run.

Backup: `cp watchlist.json /tmp/watchlist.backup.json`
Trim: edit `watchlist.json` to only `[{ "label": "GBPJPY", "tv_symbol": "OANDA:GBPJPY", "binance_symbol": null }]`

Run: `node bot.js --scan --htf-only`

Expected: 
- "pipeline: v2 mtf-candle-verdict" header
- Three log lines: Monthly → Weekly → Daily (or an early STOP)
- Confluence grade and summary line

- [ ] **Step 3: Inspect the saved JSON**

Run: `ls -t scan-results/scan-v2-*.json | head -1 | xargs cat | head -80`
Expected: 
- `pipeline: "v2-mtf-candle-verdict"`
- `monthly` object has `direction`, `in_9_15_zone`, `candle_verdict`
- If weekly ran: `weekly` object has `direction`, `direction_conflict`, `score`, `candle_verdict`
- If daily ran: `daily` object has `state`, `trigger_type`, `candle_verdict`
- `confluence_grade` is one of: "A+", "A", "B", "C", "—"

- [ ] **Step 4: Restore full watchlist**

Run: `cp /tmp/watchlist.backup.json watchlist.json`

- [ ] **Step 5: No commit — smoke test only**

---

## Task 12: Full 15-symbol verification scan

**Files:**
- No code changes — live verification only

- [ ] **Step 1: Run the full watchlist**

Run: `node bot.js --scan --htf-only`
Expected: All 15 symbols processed, some candidates surfaced by confluence grade.

- [ ] **Step 2: Verify report card structure**

Expected output includes:
- Per-symbol summary line with state + trigger_type + grade
- Candidates section ranked by confluence
- Total LLM cost line

- [ ] **Step 3: Spot-check one A/B-grade candidate**

Inspect the saved JSON for any candidate with `confluence_grade: "A"` or `"B"` (or better). Verify:
- `monthly.direction === weekly.direction`
- `daily.direction_conflict === false`
- `daily.state === "ENTER"` or `"WATCH"`
- `daily.trigger_type` is meaningful ("sweep", "pattern", "momentum", or "none" for WATCH)

- [ ] **Step 4: Commit any diagnostic files produced**

```bash
git add scan-results/scan-v2-*.json parse-failures.jsonl
git commit -m "test: v2 pipeline verification scan on 15 symbols"
```

---

## Self-Review

### Spec coverage

| Spec requirement | Task |
|---|---|
| Monthly direction-only prompt | Task 1 |
| 9-15 zone flag | Task 1 (in monthly prompt), Task 8 (in confluence logic) |
| Weekly bias cascade (receives monthly) | Task 2, Task 6 |
| Daily cascade (receives monthly + weekly) | Task 3, Task 7 |
| `direction_conflict` escape hatch | Tasks 2, 3, 6, 7, 8 |
| `candle_verdict` on all 3 TFs | Tasks 1, 2, 3 (prompts); Tasks 5, 6, 7 (return shape) |
| 3 trigger types (momentum/sweep/pattern) | Task 3 (prompt), Task 4 (`dailyTriggerType`) |
| NONE/WATCH/ENTER state machine using candle_verdict | Task 4 |
| Parse-failure retry with recapture + fallback model | Tasks 5, 6, 7 |
| New stop reasons | Task 8 |
| A+ confluence detection | Task 8 (`deriveConfluence`) |
| `--htf-only` routes to V2 | Task 9 |

### Placeholder scan

- No "TBD" / "implement later" — all code is concrete.
- No "similar to Task N" — cell functions are repeated with their specific context (monthly, weekly, daily).
- All prompt content is fully written.

### Type consistency

- `candle_verdict` schema identical across all 3 prompts.
- `direction_conflict` only on weekly and daily (monthly doesn't have upstream to conflict with).
- `dailyCellState` signature consistent across test + source + usage.
- `dailyTriggerType(cell, weeklyBias)` signature consistent across usage.
