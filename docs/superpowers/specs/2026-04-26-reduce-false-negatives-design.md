# Reduce false negatives in V2 scanner — measurement-first prompts + consistency check

**Status:** Design approved by user 2026-04-26. Ready for implementation plan.
**Owner:** Tejpal
**Pipeline affected:** V2 (Monthly direction → Weekly quality → Daily trigger)

## Problem

Today's V2 weekly cell stops the pipeline whenever `red_flags.length > 0`, regardless of how strong the rest of the cell is. The model sets red flags from a holistic, qualitative read of the chart — not from measurable visual evidence.

In the 2026-04-25 scan, **9 of the 12 weekly stops** were in the suspicious bucket: 5× `weekly_no_setup` (model called `direction = "none"` despite stacked EMAs) + 4× `weekly_red_flag` (exhaustion / choppy / tangled). The remaining 3 were legitimate `monthly_weekly_disagree` bias conflicts and we want to keep stopping on those.

**Case study — AUDUSD weekly** had `score: 7`, EMAs stacked & angled up, pullback present, but the model:
- Reported `winner_strength: 60`, `liquidity_swept: above_prior_high`, and `red_flags: ["exhaustion"]`
- The actual chart showed a small bearish pullback bar with no significant upper wick and no clear sweep above the prior bar's high
- Pipeline stopped at 1W → daily never ran → candidate lost

This pattern (qualitative claim → red_flag → STOP) is the false-negative cascade we're targeting.

## Goal

Reduce false negatives caused by overstated qualitative claims, without weakening the legitimate stops (bias conflicts, low-score setups, genuine choppy structure).

## Non-goals

- External data verification against TradingView/Binance/OANDA APIs (deferred to a possible Approach 2 follow-up if false negatives persist)
- Adversarial second-opinion or self-critique LLM passes (rejected — LLMs rarely retract their own claims)
- Test fixtures or labeled regression sets (skipped per "trust the architecture, course-correct in production")

## Approach: 2-pass measurement-first prompts + code-side consistency check

The structural shift: every prompt enforces a strict 2-pass flow.

**Pass 1 — Quantitative measurements** (no verdicts allowed). The model reports raw, observable facts about the chart in a fixed `measurements` schema.

**Pass 2 — Gated verdicts** (every claim must cite a Pass-1 number). Each qualitative output (`direction`, `red_flags`, `score`, `setup_type`, `liquidity_swept`, `in_bias`) has an explicit gate condition written into the prompt that references specific Pass-1 fields. The model can only fire the verdict if its own reported numbers satisfy the gate.

This inverts the failure mode: today the model can flag "exhaustion" on vibes; under the new design, flagging exhaustion *requires* the model to first claim `upper_wick_pct ≥ 30%` and `high_vs_prior_bar_high = "above"`. Hallucinations become directly visible in the structured output and easy to catch.

A small code-side `validateCellConsistency()` function in `scanner.js` enforces the gates as a backstop — if the model contradicts itself (claims `upper_wick: 12` then sets `exhaustion`), the flag is dropped before the STOP/WATCH/ENTER decision runs.

## Pass-1 measurement schema

Same shape across monthly/weekly/daily prompts so the model has one mental model.

```jsonc
"measurements": {
  "prior_bar": {
    "color": "green" | "red",
    "body_pct_of_range": 0,                                 // body / (high - low) × 100
    "high_relative_to_ema_band": "above" | "inside" | "below"
  },
  "current_closed_bar": {                                    // bar to LEFT of forming bar
    "color": "green" | "red",
    "body_pct_of_range": 0,
    "upper_wick_pct": 0,
    "lower_wick_pct": 0,
    "close_position": "at_high" | "upper_third" | "mid" | "lower_third" | "at_low",
    "high_vs_prior_bar_high": "above" | "equal" | "below",   // sweep detection ground truth
    "low_vs_prior_bar_low": "above" | "equal" | "below"
  },
  "forming_bar": {                                           // rightmost bar (incomplete)
    "color": "green" | "red" | "doji",
    "progress_pct": 0
  },
  "ema_state": {
    "ema9_above_ema15": false,
    "ema9_ema15_distance": "tight" | "normal" | "wide",
    "slope_direction": "up" | "down" | "flat",
    "slope_steepness": "shallow" | "medium" | "steep"        // ~< 20° / 20-45° / > 45°
  },
  "recent_5_bars": {
    "direction": "up" | "down" | "mixed",
    "overlap_pct": 0                                          // visible range overlap, 0-100
  }
}
```

### Three deliberate schema choices

1. **No raw OHLC pip values.** Models are unreliable at reading exact prices off charts. The schema asks for relative and visual features (categorical buckets, percentages, "above/below"). Models do those well.

2. **Sweep detection is split.** Today's `liquidity_swept` is a single conclusion field that's easy to fabricate. The new schema requires the model to first commit to the underlying fact (`high_vs_prior_bar_high` and `low_vs_prior_bar_low`) before any sweep verdict can be made.

3. **`recent_5_bars.overlap_pct` is the gate for `choppy_structure`.** Today the flag fires on vibes; this gives it a measurable threshold.

The schema is additive — existing `candle_verdict` fields stay; `measurements` is a new sibling object. No breaking changes for downstream code (history loader, email report, scanner state machine).

## Pass-2 gated verdicts

Every existing verdict field gets an explicit gate that references Pass-1 measurements. The prompt states each gate as one short imperative line.

### Direction

- `direction = "long"` ONLY IF `ema9_above_ema15 = true` AND `slope_direction = "up"` AND `slope_steepness ≠ "shallow"`
- `direction = "short"` symmetric
- `direction = "none"` is reserved for genuinely tangled / freshly-flipped EMAs only — *not* for "EMAs are stacked but the forming bar looks ambiguous." This single change addresses the 5× `weekly_no_setup` stops in today's run.

### Score (weekly only)

- `score ≥ 8` requires ALL of: `ema9_above_ema15 + matching slope`, `slope_steepness ≠ "shallow"`, pullback into EMA band visible in last 5 bars, `current_closed_bar.color = matches bias`, `red_flags = []`
- `score = 7` allows one of those to be soft (e.g., closed bar mixed but the others textbook)
- `score < 6` = reject (unchanged)

### Red flags

- `exhaustion` ONLY IF `current_closed_bar.upper_wick_pct ≥ 30%` (long bias) OR `lower_wick_pct ≥ 30%` (short bias) AND `high_vs_prior_bar_high = "above"` (long bias) / `low_vs_prior_bar_low = "below"` (short bias) AND `current_closed_bar.color contradicts bias`
- `choppy_structure` ONLY IF `recent_5_bars.overlap_pct ≥ 60` AND `recent_5_bars.direction = "mixed"`
- `tangled_emas` ONLY IF `ema_state.ema9_ema15_distance = "tight"` AND a visible cross within last 5 bars

### Liquidity sweep (daily trigger)

- `liquidity_swept = "above_prior_high"` ONLY IF `current_closed_bar.high_vs_prior_bar_high = "above"` AND `close_position ∈ {lower_third, at_low}` AND `color = "red"`
- `liquidity_swept = "below_prior_low"` symmetric

### Trigger candle in_bias

- `in_bias = true` ONLY IF `current_closed_bar.color matches bias` AND `body_pct_of_range ≥ 40%`
- `winner_strength` is re-derived from `body_pct_of_range` and `close_position`, not free-form

### Effect on AUDUSD case (counterfactual)

With small upper wick → `upper_wick_pct ≈ 12%` → fails the ≥30% gate → `exhaustion` flag drops → score-7 cell with no flags → daily evaluation runs.

## Code-side consistency check

A pure-function backstop in `src/scanner.js`, called once per cell after LLM parse, before the STOP/WATCH/ENTER decision.

```js
// Pseudocode shape — actual implementation in scanner.js after LLM parse
function validateCellConsistency(cell) {
  const m = cell.measurements;
  if (!m) return cell;  // older cells without measurements pass through unchanged

  // Drop self-contradicting red flags
  cell.red_flags = (cell.red_flags || []).filter((flag) =>
    gateSatisfied(flag, m, cell.candle_verdict, cell.direction)
  );

  // Re-derive sweep claim from measurements
  if (cell.candle_verdict?.liquidity_swept !== "none") {
    if (!sweepGateSatisfied(cell.candle_verdict.liquidity_swept, m)) {
      cell.candle_verdict.liquidity_swept = "none";
      cell.consistency_log = (cell.consistency_log || []).concat([
        "rejected liquidity_swept — gate violated",
      ]);
    }
  }

  // Re-derive in_bias
  if (cell.candle_verdict?.in_bias && (m.current_closed_bar.body_pct_of_range < 40)) {
    cell.candle_verdict.in_bias = false;
  }

  return cell;
}
```

What it gives us:
- Zero LLM cost, zero new infra
- Turns the model's own reported numbers into truth grounding
- Each rejection logs to `consistency_log` on the cell so we can spot patterns of model dishonesty over time
- Older cells (without `measurements`) pass through unchanged → no breaking change

## Per-prompt scope

| File | Change | Effort |
|---|---|---|
| `prompts/monthly-direction.md` | Add Pass-1 measurement block; tighten `direction = "none"` gate. Candle_verdict already has the right fields. | ~30 min |
| `prompts/weekly-structure.md` | Full rewrite to enforce 2-pass + all gates from Section "Pass-2 gated verdicts". This is where AUDUSD failed. | ~1.5 hr |
| `prompts/daily-trigger.md` | Keep state machine + trigger_type unchanged. Gate `liquidity_swept`, `in_bias`, `winner_strength` on new measurements. | ~1 hr |
| `src/scanner.js` | Add `validateCellConsistency()`; call from each evaluator after parse. | ~1 hr (incl. tests) |
| `tests/scanner-flow.test.mjs` | Unit tests for `validateCellConsistency` covering each gate. No prompt-side tests (validated by live runs). | ~30 min |

**Total**: ~5 hours focused work, single PR. No infra, no API, no breaking schema changes.

## Rollout

Single PR, shipped straight to the cron per "trust the architecture, course-correct from production":

1. Update 3 prompts + `validateCellConsistency` + tests on `feat/measurement-first-prompts`
2. Run a full 16-symbol scan against the new branch — sanity-check the candidate list moves in the right direction (AUDUSD shouldn't STOP unless visually it really should)
3. Merge → next 4 AM IST cron pickup uses the new prompts automatically
4. Watch the next ~3-7 daily emails; if a clear false negative still shows up, add Approach 2 (numeric verification against external OHLC) as a follow-on PR

## Risks

| Risk | Mitigation |
|---|---|
| Model fabricates Pass-1 measurements (claims `upper_wick: 30%` when wick is tiny) | `validateCellConsistency` catches *internal* contradictions. External data validation (Approach 2) catches absolute fabrication — deferred. |
| Tighter `direction = "none"` gate over-promotes ambiguous setups → MORE false positives | Weekly score floor (`score < 7` reject) still gates the chain. History-context block (T-1 / T-2) gives the LLM continuity to sanity-check against. |
| Prompts grow longer → more LLM tokens → cost increase | Estimated ~20% token growth per prompt. Current ≈ $0.043 / scan → projected ≈ $0.052. Within budget. |
| Model ignores gates because prompt is too dense | Each gate written as one short imperative line. Code-side consistency check is the backstop. |
| `parse-failures.jsonl` schema breaks on new fields | Schema is additive; existing fields stay. Parse-failure detectors check `direction` + `candle_verdict`, both unchanged. |

## Reversibility

- Each prompt file revert-able independently
- `validateCellConsistency` is feature-flag-able via env var if it ever surprises us
- No data migrations, no scan-results format changes

## Out of scope (explicit non-promises)

- External numeric verification against TV / Binance / OANDA OHLC APIs (Approach 2 — deferred)
- Multi-model ensemble / second-opinion runs
- Test fixtures / labeled regression set
- LTF (4H/2H/1H) prompt — V1 pipeline, not in V2 scope
- Email/report changes — the `measurements` block is internal; reports stay as-is

## Open questions

None. Ready for writing-plans skill.
