# V2 Scanner Gate Recalibration Design

**Date:** 2026-05-02
**Status:** Approved (design phase) — pending implementation plan
**Branch:** to be created when writing-plans completes
**Prior context:**
- `docs/superpowers/specs/2026-04-26-reduce-false-negatives-design.md` (the prior pass that introduced Pass-1 measurements + `validateCellConsistency`)
- `docs/STRATEGY.md` (current strategy reference)
- `scan-results/latest-scan-v2.json` (the 2026-05-02 audit data motivating this rework)

---

## 1. Goal & non-goals

### Goal
Reduce the V2 scanner's false-negative rate from current ~100% (0/25 candidates on the 2026-05-02 scan, despite at least two legitimate setups visible in the data — AUDUSD steep pullback flagged as chop, USOIL clean pullback with soft daily trigger) to a calibrated rate where:

- Real swing setups (clean trend + pullback + decisive trigger) reach `WATCH` or `ENTER`.
- Genuine chop / TF disagreement / counter-bias bars still `STOP`.
- Calibration is verified against both the existing scan data AND a hand-curated golden set.

### Non-goals (out of scope for this spec)
- Adding new technical indicators (volume, RSI, MACD).
- Adding new timeframes (4H, 1H).
- Replacing `recent_5_bars.direction` with a net-direction measurement (interesting, but a separate spec).
- Re-scanning historical periods to backtest performance (no historical price API integration).
- Changing the cascade order (Monthly → Weekly → Daily stays).

### Motivating evidence (from 2026-05-02 audit)
A subagent audit of `latest-scan-v2.json` found:

- **0 of 23** weekly cells had any flag dropped by `validateCellConsistency()`. The Pass-2 validator found nothing to reject — every flag the model fired had measurements that satisfied the published gate.
- **20 of 23** weekly cells (87%) hit `choppy_structure` (`overlap_pct ≥ 60` AND `direction = "mixed"`). Median `overlap_pct` was **70**, not an outlier.
- **22 of 23** had `recent_5_bars.direction = "mixed"`. Only AUDNZD didn't.
- **AUDUSD weekly:** score 6, pullback setup, EMA slope **steep up**, current closed bar body 86%, close upper-third, breaks above prior bar's high. Stopped because `overlap_pct=70` triggered `choppy_structure`. A swing trader would trade this.
- **USOIL daily:** weekly score 7 long pullback, daily `prep_signals_count = 3/4`, daily candle is `solid_bull`, `in_bias=true`, `winner_strength=6`, body 67%, close upper-third, EMAs **wide, steep up**. Didn't reach ENTER (`winner_strength<7`) and didn't reach WATCH (daily picked up `choppy_structure` on `overlap_pct=89` despite the wide steep EMAs).

**Conclusion:** the model isn't over-claiming. The gates are over-tuned. Specifically: gate thresholds don't distinguish chop from pullback, the score-7 floor blocks score-7 cells with one warning flag, and the daily prep floor punishes legitimate continuation setups.

---

## 2. Architecture

### Files touched

| File | Change |
|------|--------|
| `src/scanner.js` | Modify `gateSatisfied()` (P1, P2). Modify `dailyCellState()` (P5, trend-dominance). Add `computeSetupMatchCount()` (P4). Add `classifyRedFlags()`, `isCandleStrongInBias()`, `isTrendDominant()`, `detectCalibrationAnomaly()`. Modify `evaluateSymbolV2()` weekly stop logic (P6). Modify `runScanV2()` (P7 calibration warning). |
| `prompts/weekly-structure.md` | Update `red_flags` gate definitions (P1, P2). Update score-7 rule to reflect warning-flag downgrade (P6). |
| `prompts/daily-trigger.md` | Update `red_flags` gate definitions (P1, P2). Add note about `setup_match_count` being computed in code (P4). |
| `tests/scanner-flow.test.mjs` | Add tests for new gate thresholds, P3 trend-dominance, P4 setup-match logic, P6 fatal/warning split, P7 calibration warning. Update existing tests for new measurement fields. |
| `tests/backtest-harness.test.mjs` | **NEW.** Unit tests for the backtest replay utility. |
| `tools/backtest.mjs` | **NEW.** CLI tool: replays new gate code against a stored scan-results JSON, diffs verdicts, asserts golden-set rows match expected verdicts, exits non-zero on golden-set regression. |
| `docs/golden-set/charts.csv` | **NEW.** 10 reference charts with annotated expected verdicts (6 from today's scan + 4 user-curated). |
| `docs/golden-set/snapshots/` | **NEW directory.** Pass-1 measurements for the 4 fresh charts (captured during golden-set assembly). |
| `docs/STRATEGY.md` | Update to describe new gate definitions, fatal/warning split, trend-dominance override. |

### New units (per "design for isolation" principle)

1. **`computeSetupMatchCount(cell)`** — pure function. Takes a daily cell, returns `{count, required_satisfied, bonus_satisfied, missing_required}` based on `setup_type`. Used by `dailyCellState()`. P4.
2. **`isTrendDominant(monthly, weekly)`** — pure function. Returns true when M+W are clearly aligned with no flags, weekly EMA distance normal/wide, and both slopes medium/steep. Used by `dailyCellState()`. P3.
3. **`classifyRedFlags(flags)`** — pure function. Returns `{fatal, warning, unknown}` partition. Used by weekly stop logic. P6.
4. **`isCandleStrongInBias(weeklyCell)`** — pure function. Returns true when weekly closed bar is decisively in bias (body ≥ 60%, close at extreme/upper-third or symmetric, color matches bias). Used to compensate for warning flags at score 7. P6.
5. **`detectCalibrationAnomaly(results)`** — pure function. Returns `{topReason, topCount, total, dominance}` when ≥ 90% of stops collapse to one reason on a watchlist of ≥ 5 symbols with no candidates. Used by `runScanV2()` for an end-of-scan calibration banner. P7.
6. **`tools/backtest.mjs`** — CLI. Two layers: replay (diff old vs new verdicts on a stored scan) + golden assertion (verify CSV rows match). Exits 0 on green, 1 on golden-set regression, 2 on `--strict` replay diff.
7. **`docs/golden-set/charts.csv`** — 10 reference rows. Schema documented in §5.

### Architecture diagram

```
┌────────────────────────────────────────────────────────────────────┐
│ runScanV2  (live path)                                             │
│   └── evaluateSymbolV2  → evaluateMonthly/Weekly/Daily Cell        │
│        └── validateCellConsistency  ← uses gateSatisfied (P1/P2)   │
│        └── dailyCellState           ← uses computeSetupMatchCount  │
│                                          (P4) + isTrendDominant    │
│                                          (P3) + winner_strength=6  │
│                                          (P5)                      │
│   └── stop logic (weekly_red_flag_fatal vs warning) (P6)           │
│   └── detectCalibrationAnomaly (P7)                                │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│ tools/backtest.mjs  (offline validation path)                      │
│   ├── load scan-results JSON                                       │
│   ├── for each cell, replay validateCellConsistency + state derive │
│   ├── diff old verdict vs new                                      │
│   ├── load docs/golden-set/charts.csv                              │
│   ├── verify each golden symbol matches expected_*                 │
│   └── exit 0 (green) or 1 (regression)                             │
└────────────────────────────────────────────────────────────────────┘
```

### Single-source-of-truth invariant

The validator code (`gateSatisfied`, `sweepGateSatisfied`, `validateCellConsistency`) is the authoritative source for gates. Prompt language describes the same gates in natural language for the LLM. After every gate change in `src/scanner.js`, the corresponding prompt section must be updated in lockstep. Failure mode: prompt and validator drift, the LLM is asked to use thresholds the validator no longer enforces, and `consistency_log` fills with rejection lines.

---

## 3. The seven calibration changes (P1–P7)

### P1 — `choppy_structure` recalibration

**Current rule** (in `gateSatisfied()` line 532-535, weekly + daily prompts):

```
fires IF recent_5_bars.overlap_pct ≥ 60 AND recent_5_bars.direction = "mixed"
```

**New rule:**

```
fires IF recent_5_bars.overlap_pct ≥ 75
   AND recent_5_bars.direction = "mixed"
   AND ema_state.slope_steepness ∈ {"flat", "shallow"}
```

**Rationale:**
- Clause 1 (overlap_pct ≥ 75): raises the threshold from "above median" to "genuinely range-bound." Today's data: only 7 of 23 weekly cells have overlap ≥ 75.
- Clause 2 (direction = "mixed"): preserved. A monotonically-trending 5 bars cannot be chop by definition.
- Clause 3 (slope ∈ flat/shallow): the discriminator. Steep/medium slope + overlap = pullback in trend (the setup we want). Flat/shallow + overlap = real chop.

**Validator code:**

```javascript
case "choppy_structure": {
  const r = measurements.recent_5_bars;
  const e = measurements.ema_state;
  if (!r || !e) return true;  // missing data → keep flag (legacy passthrough)
  return (
    (r.overlap_pct ?? 0) >= 75 &&
    r.direction === "mixed" &&
    (e.slope_steepness === "flat" || e.slope_steepness === "shallow")
  );
}
```

**Prompt update** (both `weekly-structure.md` and `daily-trigger.md`):

```
- "choppy_structure" ONLY IF recent_5_bars.overlap_pct ≥ 75
  AND recent_5_bars.direction = "mixed"
  AND ema_state.slope_steepness ∈ {"flat", "shallow"}
```

**Predicted effect on today's audit:** `choppy_structure` count drops from 19 to ≤ 5. Symbols where it stops firing: AUDUSD (slope steep), GBPJPY (slope steep), EURUSD (overlap 70 < 75), US30 (overlap 70 < 75).

### P2 — `tangled_emas` recalibration

**Current rule:**

```
fires IF ema_state.ema9_ema15_distance = "tight"
```

**New rule:**

```
fires IF ema_state.ema9_ema15_distance = "tight"
   AND ema_state.slope_steepness ∈ {"flat", "shallow"}
```

**Rationale:** "tight" is overloaded. It can mean tangled (no trend) OR coiled-and-ready-to-expand (consolidation before breakout). Slope adds the missing context. Tight + flat = genuinely tangled. Tight + steep = momentum pause inside trend.

**Validator code:**

```javascript
case "tangled_emas": {
  const e = measurements.ema_state;
  if (!e) return true;
  return (
    e.ema9_ema15_distance === "tight" &&
    (e.slope_steepness === "flat" || e.slope_steepness === "shallow")
  );
}
```

**Prompt update** (both prompts):

```
- "tangled_emas" ONLY IF ema_state.ema9_ema15_distance = "tight"
  AND ema_state.slope_steepness ∈ {"flat", "shallow"}
```

**Predicted effect on today's audit:** `tangled_emas` count drops from 9 to ~6.

### P3 — Trend-dominance daily WATCH override

**Goal:** when M+W are unambiguously trending in the same direction (wide EMAs, steep slope, both aligned with no flags), the daily can reach `WATCH` with prep ≥ 1 (instead of the standard prep ≥ 2) plus an in-bias decisive candle.

**New helper `isTrendDominant(monthly, weekly)`:**

```javascript
export function isTrendDominant(monthly, weekly) {
  if (!monthly || !weekly) return false;
  if (monthly.direction !== weekly.direction) return false;
  if (monthly.direction === "none" || weekly.direction === "none") return false;
  if ((weekly.red_flags || []).length > 0) return false;

  const me = monthly.measurements?.ema_state;
  const we = weekly.measurements?.ema_state;
  if (!me || !we) return false;

  const wideEnough = (d) => d === "wide" || d === "normal";
  const steepEnough = (s) => s === "steep" || s === "medium";

  return (
    wideEnough(we.ema9_ema15_distance) &&
    steepEnough(we.slope_steepness) &&
    steepEnough(me.slope_steepness)
  );
}
```

**Rationale for each clause:**
- TF direction match: trend-dominance is undefined if M and W disagree.
- weekly.red_flags == []: even one flag (warning OR fatal after P6) means the trend isn't dominant.
- weekly EMA distance normal/wide: "tight" doesn't qualify even with steep slope (we'd be promoting a coiled chart, not a trending one).
- Both M and W slopes medium/steep: monthly slope shallow but weekly steep suggests a counter-trend bounce on monthly — not actual dominance.

`monthly.in_9_15_zone` is intentionally NOT required (that's the A+ flag, separate concern).

**Modified `dailyCellState`:**

```javascript
function dailyCellState(cell, monthly = null, weekly = null) {
  if (!cell || typeof cell !== "object") return "NONE";
  if (cell.direction_conflict === true) return "NONE";

  const flags = cell.red_flags || [];
  if (flags.length > 0) return "NONE";

  const matchInfo = computeSetupMatchCount(cell);
  const matchCount = matchInfo.count;
  const requiredSatisfied = matchInfo.required_satisfied;

  const dominant = isTrendDominant(monthly, weekly);
  const watchFloor = dominant ? 1 : 2;

  if (matchCount < watchFloor) return "NONE";

  const v = cell.candle_verdict;
  if (!v) return "NONE";

  // Trend-dominant prep=1 path: only WATCH, never ENTER.
  if (dominant && matchCount === 1) {
    if (v.in_bias === true && (v.winner_strength ?? 0) >= 5) return "WATCH";
    return "NONE";
  }

  // Standard ENTER path:
  if (v.in_bias === true && (v.winner_strength ?? 0) >= ENTER_WINNER_STRENGTH_THRESHOLD) {
    const isTypedSetup = cell.setup_type === "pullback" || cell.setup_type === "continuation";
    if (isTypedSetup && !requiredSatisfied) return "WATCH";
    return "ENTER";
  }
  return "WATCH";
}
```

**Risk mitigations:**
- weekly.red_flags must be empty (exhaustion is still fatal under P6).
- in_bias still required for trend-dominant WATCH.
- Trend-dominance lowers the WATCH floor from `prep ≥ 2` to `prep ≥ 1`. Dominant cells with `matchCount = 1` max out at WATCH. Dominant cells with `matchCount ≥ 2` follow the standard ENTER path — the override does not by itself unlock ENTER.
- Golden-set rows 6 (AUDNZD), 9 (user fake-out), 10 (user chop) verify trend-dominance doesn't promote bad trades.

### P4 — Setup-type-specific prep_signals

**Goal:** count only the prep signals that are relevant for the cell's `setup_type`. Today's flat `prep_signals_count ≥ 2` floor unfairly penalizes continuation setups (which naturally have `coc_present = false`).

**Schema decision:** no prompt schema change. The model still reports all 4 booleans + setup_type. We add a code-side derived field.

**`computeSetupMatchCount(cell)` — exact spec:**

```javascript
export function computeSetupMatchCount(cell) {
  if (!cell || typeof cell !== "object") {
    return { count: 0, required_satisfied: false, bonus_satisfied: false, missing_required: [] };
  }

  const t = cell.setup_type;
  const flag = (name) => cell[name] === true;

  // Legacy fallback for "none" or missing setup_type
  if (t !== "pullback" && t !== "continuation") {
    const legacy = cell.prep_signals_count ?? 0;
    return {
      count: legacy,
      required_satisfied: legacy >= 2,
      bonus_satisfied: false,
      missing_required: [],
    };
  }

  const RULES = {
    pullback:     { required: ["zone_rejection", "angle_ok"],     bonus: ["solid_continuation"] },
    continuation: { required: ["solid_continuation", "angle_ok"], bonus: ["zone_rejection"] },
  };

  const rule = RULES[t];
  const requiredTrue = rule.required.filter(flag);
  const bonusTrue = rule.bonus.filter(flag);
  const missing = rule.required.filter((s) => !flag(s));

  return {
    count: requiredTrue.length + bonusTrue.length,
    required_satisfied: requiredTrue.length === rule.required.length,
    bonus_satisfied: bonusTrue.length === rule.bonus.length,
    missing_required: missing,
  };
}
```

**Why these RULES:**
- **pullback** required = `zone_rejection` AND `angle_ok`. Without zone-rejection there is no pullback setup, just hopium. Without angle_ok the trend isn't valid.
- **continuation** required = `solid_continuation` AND `angle_ok`. Continuation IS solid follow-through after a prior pullback; without angle_ok the trend has died.
- `coc_present` is intentionally unused. Change-of-character is reversal logic, not pullback or continuation.
- Missing/`none` setup_type → legacy fallback (most conservative — uses flat `prep_signals_count`).

**Risk:** model misclassifies setup_type. Mitigation: legacy fallback exists for `setup_type = "none"`; the prompt's setup_type definitions are clear; the audit found 23/23 setup_type assignments matched the underlying booleans. Golden-set assertions verify the per-setup behavior.

**Stored in result JSON for diagnostics:**

```javascript
// inside evaluateDailyCell, after validateCellConsistency:
cell.setup_match = computeSetupMatchCount(cell);
cell.state = dailyCellState(cell, monthlyCell, weeklyCell);
cell.trigger_type = dailyTriggerType(cell, weeklyCell.direction);
```

Console summary:

```
state=ENTER prep=3/4 match=3 trigger=momentum
```

### P5 — Lower `winner_strength` ENTER threshold from 7 to 6

**Constant introduction at top of `scanner.js`:**

```javascript
const ENTER_WINNER_STRENGTH_THRESHOLD = 6;  // P5: was 7, lowered to admit body ≥ 60% with close in upper/lower third
```

**Rationale:**
- The daily prompt's own scoring rubric grants 5–7 for `body_pct_of_range ≥ 40 AND close_position ∈ {upper_third, lower_third, at_high, at_low}`.
- Raising to 7 forced the model to reserve 7+ for bars at the very top of the body-and-close envelope. A solid_bull body 67% closing upper_third (USOIL daily today) is correctly graded 6 — the bar IS decisive; the threshold was over-tuned.
- Lower bound 6 (not 5) preserves the line between "decisive" (≥ 60% body OR close at extreme) and "ambiguous" (< 40% body, mid close → strength 0–4).

**Why a constant, not a config:** referenced in exactly two places (`dailyCellState`, tests). Configurability is YAGNI.

### P6 — Fatal vs. warning red flags

**Decision:**

| Flag | Class |
|------|-------|
| `exhaustion` | **Fatal** |
| `direction_conflict` | **Fatal** |
| `choppy_structure` | **Warning** |
| `tangled_emas` | **Warning** |
| Unknown flags | **Treated as fatal** (conservative default) |

**New helpers:**

```javascript
const FATAL_RED_FLAGS = new Set(["exhaustion", "direction_conflict"]);
const WARNING_RED_FLAGS = new Set(["choppy_structure", "tangled_emas"]);

export function classifyRedFlags(flags) {
  const fatal = [];
  const warning = [];
  const unknown = [];
  for (const f of flags || []) {
    if (FATAL_RED_FLAGS.has(f)) fatal.push(f);
    else if (WARNING_RED_FLAGS.has(f)) warning.push(f);
    else unknown.push(f);
  }
  return { fatal, warning, unknown };
}

export function isCandleStrongInBias(weeklyCell) {
  const v = weeklyCell.candle_verdict;
  const m = weeklyCell.measurements?.current_closed_bar;
  const dir = weeklyCell.direction;
  if (!v || !m || !dir) return false;
  if (v.in_bias !== true) return false;
  if ((m.body_pct_of_range ?? 0) < 60) return false;

  const isLong = dir === "long";
  if (isLong) {
    return m.color === "green" && (m.close_position === "at_high" || m.close_position === "upper_third");
  }
  return m.color === "red" && (m.close_position === "at_low" || m.close_position === "lower_third");
}
```

**Updated weekly stop logic in `evaluateSymbolV2()`:**

```javascript
const { fatal, warning, unknown } = classifyRedFlags(result.weekly.red_flags || []);
const blockingFlags = [...fatal, ...unknown];

if (blockingFlags.length > 0) {
  result.stopped_at = "1W";
  result.stop_reason = "weekly_red_flag_fatal";
  log(`    🚫 STOP @ 1W: weekly_red_flag_fatal (${blockingFlags.join(", ")})`);
  return result;
}

const score = result.weekly.score ?? 0;
const candleStrong = isCandleStrongInBias(result.weekly);

if (warning.length > 0 && !candleStrong) {
  result.stopped_at = "1W";
  result.stop_reason = "weekly_red_flag_warning_no_compensation";
  log(`    🚫 STOP @ 1W: weekly_red_flag_warning_no_compensation (${warning.join(", ")})`);
  return result;
}

if (score < 7) {
  result.stopped_at = "1W";
  result.stop_reason = "weekly_quality_low";
  log(`    🚫 STOP @ 1W: weekly_quality_low (score ${score})`);
  return result;
}
```

**New stop reasons:**

| `stop_reason` | When |
|---|---|
| `weekly_red_flag_fatal` | exhaustion, direction_conflict, or unknown on weekly. |
| `weekly_red_flag_warning_no_compensation` | only warning flags but candle isn't strongly in-bias. |

The original `weekly_red_flag` is removed. The replay layer in `tools/backtest.mjs` reports the substitution explicitly in its diff narrative.

**Prompt update** (`weekly-structure.md` Step 3 score rule):

```
- score = 7 allows exactly ONE of {angle_ok, ema_stack_ok, pullback_present,
  candle color matches bias} to be false. Red flags are evaluated as follows:
  - Fatal red flags (exhaustion, direction_conflict): score MUST drop below 7.
  - Warning red flags (choppy_structure, tangled_emas): score 7 is allowed
    IF the candle is strongly in bias — body ≥ 60% AND close at extreme/upper-third
    (long) or extreme/lower-third (short) AND color matches bias.
    Otherwise score MUST drop to 6 or below.
- score < 6 = reject
```

### P7 — Calibration warning when 100% stops

**Spec:** after `runScanV2()` builds the candidates list, if `candidates.length === 0` AND watchlist had ≥ 5 symbols AND ≥ 90% of stops collapsed to one reason, log a banner.

```javascript
export function detectCalibrationAnomaly(results) {
  if (results.length < 5) return null;
  if (results.some((r) => r.confluence_grade !== "—")) return null;

  const stopCounts = {};
  for (const r of results) {
    if (!r.stop_reason) continue;
    stopCounts[r.stop_reason] = (stopCounts[r.stop_reason] || 0) + 1;
  }
  const total = Object.values(stopCounts).reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  const [topReason, topCount] = Object.entries(stopCounts).sort((a, b) => b[1] - a[1])[0];
  const dominance = topCount / total;
  if (dominance < 0.9) return null;
  return { topReason, topCount, total, dominance };
}

// at end of runScanV2, just before saving payload:
const anomaly = detectCalibrationAnomaly(results);
if (anomaly) {
  console.log("\n  ⚠️  CALIBRATION WARNING");
  console.log(`     ${anomaly.topCount}/${anomaly.total} symbols stopped at "${anomaly.topReason}" (${(anomaly.dominance * 100).toFixed(0)}%).`);
  console.log("     This is unusual — consider reviewing gate thresholds in src/scanner.js.");
}
```

**Why 90%, not 100%:** a quiet market might produce 1–2 candidates with 90%+ same-reason stops. We want to flag that too.
**Why threshold 5 symbols:** smaller watchlists aren't statistically meaningful.
**Why log to console only:** informational, not a build break.

---

## 4. Validation harness

### Two-layer harness

1. **Replay diff** — replays new gate code against `scan-results/latest-scan-v2.json`. Diffs stored verdicts vs. recomputed verdicts. Informational.
2. **Golden assertion** — runs same code against `docs/golden-set/charts.csv` rows. Asserts every row's verdict matches the user's annotation. Ship gate.

Both run from `node tools/backtest.mjs`.

### CLI contract

```
node tools/backtest.mjs [options]
  --scan <path>     Scan-results JSON to replay (default: scan-results/latest-scan-v2.json)
  --golden <path>   Golden set CSV (default: docs/golden-set/charts.csv)
  --quiet           Suppress per-symbol diff lines
  --strict          Exit 1 on any verdict change in --scan replay
```

**Exit codes:** `0` golden green; `1` golden regression; `2` `--strict` and replay diff non-empty.

### Replay layer — Option β

The stored JSON has cells AFTER the old `validateCellConsistency` ran. We replay the new validator on top of the (already-validated) cells. This is best-effort: flags the old validator already dropped won't be re-tested. Acceptable because:

- The old validator only DROPS flags, never adds them.
- The new validator's job is to drop more flags, not fewer.
- The golden set catches the "previously-dropped flag should have been kept" case via fresh annotations.

**Going forward:** add `red_flags_raw` and `candle_verdict_raw` snapshots to the stored cell shape so future replays are perfect. Implementation detail of the runScanV2 modification.

### Golden assertion layer

**CSV schema:**

| Column | Type | Description |
|---|---|---|
| `symbol` | string | e.g. `AUDUSD` |
| `capture_date` | YYYY-MM-DD | when measurements were captured |
| `scenario` | string | human label |
| `source` | enum: `scan` / `fresh` | which Pass-1 source to load |
| `expected_monthly_dir` | enum: `long`/`short`/`none` | |
| `expected_weekly_dir` | enum: `long`/`short`/`none` | |
| `expected_weekly_score_min` | int 0–10 | floor (≥) |
| `expected_weekly_red_flags_max` | int | max acceptable count of fatal flags (typically 0; use 99 for don't-care on stops) |
| `expected_daily_state` | enum: `NONE`/`WATCH`/`ENTER` | |
| `expected_grade` | enum: `A+`/`A`/`B`/`C`/`—` | |
| `expected_stop_reason` | string or empty | empty if not a stop |
| `note` | freeform | trader's reasoning |

**Process:**
- For `source=scan` rows, load measurements from `latest-scan-v2.json`.
- For `source=fresh` rows, load `docs/golden-set/snapshots/{symbol}-{date}.json`.
- Run the full pipeline offline (validateCellConsistency → dailyCellState → deriveConfluence → recomputeStopChain).
- Assert every expected_* column matches.
- Print PASS/FAIL per row; exit 1 if any FAIL.

### Snapshot format for fresh charts

`docs/golden-set/snapshots/{symbol}-{YYYY-MM-DD}.json`:

```json
{
  "symbol": "EURUSD",
  "captured_at": "2026-04-15T18:00:00Z",
  "monthly": { "direction": "long", "in_9_15_zone": false, "measurements": {...}, "candle_verdict": {...}, "red_flags": [] },
  "weekly":  { "direction": "long", "score": 8, "measurements": {...}, "candle_verdict": {...}, "red_flags": [] },
  "daily":   { "direction_conflict": false, "prep_signals_count": 3, "angle_ok": true, "zone_rejection": true, "coc_present": false, "solid_continuation": true, "measurements": {...}, "candle_verdict": {...}, "red_flags": [] }
}
```

Captured once during golden-set assembly: open chart at specified date, run `evaluateSymbolV2()`, save the raw cell JSONs. User verifies snapshot matches their reading; after sign-off, frozen.

### Where the harness runs

- **Per-task in subagent-driven-development:** the implementer subagent runs the harness as part of self-review.
- **Pre-commit:** `node tools/backtest.mjs --quiet` must pass before commit.
- **CI** (if present): run on every PR; fail PR on golden-set regression.

### What the harness does NOT do

- Does not call the LLM — purely re-applies validator + state derivation against stored measurements.
- Does not capture new screenshots.
- Does not re-validate the LLM's Pass-1 measurements (we trust stored numbers).

---

## 5. Golden set composition

### 6 today's-scan rows (pre-filled, user reviews)

| # | symbol | scenario | exp_monthly_dir | exp_weekly_dir | exp_weekly_score_min | exp_daily_state | exp_grade | exp_stop_reason | rationale |
|---|--------|----------|------|------|------|------|------|------|-----------|
| 1 | AUDUSD | steep-pullback-flagged-as-chop | long | long | 7 | NONE | — | daily_no_trigger | weekly score 6 currently; with P1 (slope steep) this passes. Daily prep low so NONE. |
| 2 | GBPJPY | long-pullback-flagged-as-chop | long | long | 7 | NONE | — | daily_no_trigger | similar to AUDUSD; passes weekly with P1. |
| 3 | XAUUSD | weekly-slope-rolled-down | long | long | 0 | — | — | monthly_weekly_disagree | direction_conflict correctly raised. **Must remain a stop.** |
| 4 | GER40 | weekly-emas-flipped | long | none | 0 | — | — | monthly_weekly_disagree OR weekly_no_setup | weekly EMAs crossed, slope flat. **Must remain a stop.** |
| 5 | USOIL | weekly-clean-daily-soft-trigger | long | long | 7 | WATCH | C | (none — should pass) | weekly clean score 7 + daily 3/4 prep + in_bias solid_bull. Should reach WATCH after P3+P5. |
| 6 | AUDNZD | weekly-clean-daily-counter-bias | long | long | 8 | NONE | — | daily_no_trigger | weekly strong but daily candle counter-bias seller, 0/4 prep. **Must remain a stop.** |

### 4 user-curated rows (slots 7–10 — TO BE FILLED)

User to provide `{symbol, date, scenario, why}` × 4 covering:

| Slot | Scenario | What user picks |
|------|----------|-----------------|
| 7 | **Conviction A+** | Trade taken without hesitation: clean monthly + weekly pullback + daily decisive trigger. |
| 8 | **Conviction B/C** | Real but lower-conviction setup: daily trigger softer, weekly score ~7. |
| 9 | **Fake-out** | Setup that looked tradeable but failed: pullback broke down, "trigger" that faded. |
| 10 | **Textbook chop** | Chart user would never trade: sideways, EMAs flat, no bias. |

### Field semantics

- `expected_weekly_score_min` is a **floor**, not exact match. Score 8 satisfies `≥ 7`.
- `expected_weekly_red_flags_max=99` is the don't-care sentinel for direction_conflict cases.
- Stops have `expected_grade = "—"` and a non-empty `expected_stop_reason`.

---

## 6. Test plan

### Test pyramid

```
                Golden set (10 charts) — ship gate
              Backtest replay vs latest scan — informational
           Integration tests in scanner-flow.test.mjs (~10 new)
      Unit tests for each pure function (~25 new)
```

### New tests (per pure function)

**P1 + P2 — gateSatisfied:**
- choppy_structure: gate satisfied (overlap 80, mixed, slope flat) → true
- choppy_structure: gate fails on slope steep
- choppy_structure: gate fails on overlap 70
- choppy_structure: gate fails on direction up
- tangled_emas: gate satisfied (tight + shallow)
- tangled_emas: gate fails on slope steep
- tangled_emas: gate fails on distance normal

**P3 — isTrendDominant:**
- returns true on wide weekly + steep both
- returns false on TF disagreement
- returns false on tight weekly EMAs
- returns false on weekly red_flag present
- returns false when monthly.direction = none

**P4 — computeSetupMatchCount:**
- pullback all required + bonus → count 3, required_satisfied true
- pullback missing zone_rejection → count 1, required_satisfied false, missing=["zone_rejection"]
- continuation required only → count 2, required true, bonus false
- setup_type=none falls back to legacy
- missing setup_type uses legacy

**P5 + P3 — dailyCellState:**
- trend-dominant WATCH on prep=1 + in_bias + strength=5
- trend-dominant NONE on prep=1 + counter-bias
- ENTER on winner_strength=6 (was 7)
- WATCH on winner_strength=5
- pullback ENTER requires zone_rejection AND angle_ok
- pullback ENTER passes when both required true

**P6 — classifyRedFlags + isCandleStrongInBias:**
- exhaustion → fatal
- choppy → warning
- unknown → unknown bucket (treated as fatal in stop logic)
- mixed (exhaustion + choppy) → fatal=["exhaustion"], warning=["choppy_structure"]
- isCandleStrongInBias: long body 70% close upper green → true
- isCandleStrongInBias: long body 50% → false (body too small)
- isCandleStrongInBias: long body 70% close mid → false
- isCandleStrongInBias: long body 70% close upper red → false (color)

**P6 integration in evaluateSymbolV2:**
- fatal flag stops at weekly_red_flag_fatal
- warning + strong candle passes to score check
- warning + weak candle stops at weekly_red_flag_warning_no_compensation

**P7 — detectCalibrationAnomaly:**
- 100% same reason → fires
- 95% same reason → fires
- 50% same reason → silent
- had a candidate → silent
- small watchlist (3 results) → silent

### Existing-test impact

The 28 current tests:
- **Pass unchanged:** sweepGateSatisfied tests, validateCellConsistency tests for in_bias/sweep.
- **Need modification:** ~4–6 gateSatisfied tests for choppy_structure / tangled_emas (must add `slope_steepness` to inputs).
- **Must NOT break:** evaluateSymbolV2 path tests — if they break, fix the mock fixtures (don't change the gate logic).

### Total

**New tests:** ~42. **Total suite:** ~70 tests.

---

## 7. Implementation order (single PR)

Each numbered task is a separate dispatch in subagent-driven-development. Pause-after means user reviews diff before next task; batch means runs through to end without pause.

| Task | What | Mode | Why this order |
|---|---|---|---|
| T1 | `tools/backtest.mjs` replay layer + tests. Replay current code → diff = 0 (sanity). | Pause | Validation infrastructure must exist before any gate moves. |
| T2 | Golden set CSV + assertion layer + tests. 6 today's-scan rows pre-filled; 4 fresh slots stubbed. | Pause | Same — infrastructure first. |
| T3 | User adds 4 fresh annotations + we capture snapshots. Run harness — must pass on baseline. | Pause | Locks in "what right looks like." |
| T4 | P1 + P2 (gate retuning + prompt edits + tests). Run harness. | Pause | Smallest blast radius first. |
| T5 | P5 (winner_strength constant 7→6 + tests). Run harness. | Pause | Independent quick verification. |
| T6 | P6 (fatal/warning split + helpers + tests + prompt edit). Run harness. | Batch | Combines with P1+P2 so score-7 cells with one warning flag start passing. |
| T7 | P3 (isTrendDominant + dailyCellState refactor + tests). Run harness. | Batch | Daily-side override; needs M and W cells passed in. |
| T8 | P4 (computeSetupMatchCount + dailyCellState integration + tests). Run harness. | Batch | Builds on T7's daily-state changes. |
| T9 | P7 (detectCalibrationAnomaly + tests). Run harness. | Batch | Diagnostic only; pairs naturally with the rest. |
| T10 | Update `docs/STRATEGY.md`. | Batch | Documentation last, after behavior locked. |
| T11 | Re-run live scan against 25-symbol watchlist. Verify candidate count > 0 OR calibration warning fires. | Pause | Final smoke test. |

---

## 8. Rollout, risk, observability

### Backward compatibility
- Old scan-results JSONs still readable. New fields (`setup_match`, `red_flag_classification`, etc.) are additive.
- Two new stop reasons (`weekly_red_flag_fatal`, `weekly_red_flag_warning_no_compensation`) replace `weekly_red_flag` in new runs. Old runs in `scan-results/` retain old reason — fine for diagnostics.
- Existing 28 tests must continue to pass.

### Roll-back
Revert the merge commit. Self-contained PR, no migrations.

### Cell decision-trail in result JSON

Every cell now stores its decision trail:

```json
{
  "weekly": {
    ...,
    "red_flags": ["choppy_structure"],
    "consistency_log": [],
    "red_flag_classification": { "fatal": [], "warning": ["choppy_structure"], "unknown": [] },
    "candle_strong_in_bias": false,
    "score_path": "warning_no_compensation"
  },
  "daily": {
    ...,
    "setup_match": { "count": 3, "required_satisfied": true, "bonus_satisfied": true, "missing_required": [] },
    "trend_dominant": true,
    "state": "ENTER",
    "trigger_type": "momentum"
  }
}
```

The `score_path` and `setup_match` fields drive the backtest harness's diff narratives.

### Risks summary

| Risk | Mitigation |
|------|-----------|
| Trend-dominance promotes mature trends about to reverse | weekly red_flags must be empty (exhaustion still fatal); in_bias still required; only WATCH not ENTER; golden-set rows 6/9/10 verify. |
| Model misclassifies setup_type | legacy fallback for "none"; setup_type definitions are clear; audit shows reliable classifications. |
| New gate thresholds let bad trades through | golden set asserts every row; replay diff surfaces unexpected verdict changes. |
| Prompt and validator drift | prompt updates are paired with validator updates in the same task; consistency_log surfaces drift in production. |
| 28 existing tests break | implementer subagent's self-review runs the full suite; pause-per-change gate catches regressions early. |

---

## 9. Done criteria

After all 11 tasks land:

1. `tools/backtest.mjs` exists; exits 0 against `latest-scan-v2.json` replay AND golden-set assertion.
2. Re-running `node bot.js --scan --htf-only` against the 25-symbol watchlist produces ≥ 1 candidate, OR calibration warning fires.
3. `docs/STRATEGY.md` reflects new behavior.
4. All 70+ tests pass.
5. The 10-row golden CSV is committed and locked in.
6. PR description includes the audit-replay summary (old vs new stop reasons across the 25 symbols).

---

## 10. Open items

- **The 4 user-curated golden-set rows.** User to provide `{symbol, date, scenario, why}` × 4 before T3 in the implementation plan. This is captured as a Pause-mode task; implementation is blocked until provided.
- **Branch name** — to be set when writing-plans creates the branch.
