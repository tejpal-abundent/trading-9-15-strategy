# V2 Scanner Strategy — How Candidates Are Decided

This document describes the strategy implemented by `runScanV2()` in
`src/scanner.js` (pipeline tag: `v2-mtf-candle-verdict`). It is a faithful
write-up of the code and prompts as they exist today, not an aspirational
design.

The bot scans every symbol in `watchlist.json` and decides one of three
verdicts per symbol:

- **ENTER** — bias-aligned setup with a confirmed trigger candle on the daily.
- **WATCH** — bias-aligned setup, prep is ready, but the daily trigger candle
  has not closed in bias yet.
- **STOP** — symbol is rejected at one of the cascade gates (with a named
  `stop_reason` so we can audit later).

Only ENTER and WATCH receive a confluence grade (A+ / A / B / C); the report
sorts them by grade.

---

## 1. Guiding principles

These are the principles the prompts and gates are built around. Every
verdict the model returns must hold up against these rules — anything that
doesn't is rejected by the cell-state validator.

1. **Reactive, not predictive.** Grade what HAS happened on the most recent
   closed candle. Never enter on prediction. ENTER fires only when a
   confirmation candle has actually closed in the bias direction.
2. **Measurement-first.** Each timeframe prompt runs in two passes:
   - **Pass 1** — the model extracts raw chart measurements (candle body %,
     wicks, close position, EMA stack, slope, 5-bar overlap) with no
     interpretation.
   - **Pass 2** — every qualitative verdict (`direction`, `red_flags`,
     `liquidity_swept`, `in_bias`, `score`) is gated against those Pass-1
     numbers.
   This was added specifically to stop the AUDUSD-style failure where the
   model returned overstated red flags despite the underlying candle being
   small / pulling back inside structure.
3. **Internal consistency over second opinions.** No external API calls,
   no expensive cross-validators. The scanner runs a local
   `validateCellConsistency()` pass that drops any verdict the model's own
   numbers contradict.
4. **Bias cascades downstream.** Higher timeframe direction is committed
   first; lower timeframes are evaluated AS that direction's setup. The
   daily can override only by setting `direction_conflict = true`.
5. **Honest disagreement beats forced agreement.** Each lower TF can flag
   `direction_conflict = true` if the chart clearly shows the opposite of
   the higher TF — that ends the cascade with a clear stop reason rather
   than a fabricated setup.

---

## 2. Chart setup

Every screenshot the scanner sends to the model is rendered with the same
two indicators visible:

- **EMA9** (orange) — short-term EMA
- **EMA15** (purple) — slightly slower EMA, used as the "value zone" pair

The `pine/mtf-helper.pine` script in this repo ships these EMAs plus an
MTF bias table (1M / 1W / 1D) so you can match the bot's read on a chart
manually.

Captured frames are saved per-symbol under `screenshots/{date}/{symbol}/{tf}.png`.

---

## 3. The cascade — Monthly → Weekly → Daily

For each symbol the scanner runs three timeframe evaluations in order. Any
gate that fails ends the cascade with a named `stop_reason`.

```
            ┌────────────────────┐
            │  Monthly (1M)      │   direction filter
            │  prompt:           │
            │  monthly-direction │
            └─────────┬──────────┘
                      │ direction in {long, short}
                      ▼
            ┌────────────────────┐
            │  Weekly (1W)       │   structural quality gate
            │  prompt:           │
            │  weekly-structure  │
            └─────────┬──────────┘
                      │ direction matches monthly
                      │ red_flags == []
                      │ score ≥ 7
                      ▼
            ┌────────────────────┐
            │  Daily (1D)        │   reactive trigger
            │  prompt:           │
            │  daily-trigger     │
            └─────────┬──────────┘
                      │ state ∈ {ENTER, WATCH}
                      ▼
                  Candidate
```

Stops can fire at any cell. The named reasons are:

| `stop_reason`               | Meaning                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `monthly_no_trend`          | Monthly EMAs tangled / direction = none.                                |
| `monthly_weekly_disagree`   | Weekly self-reported `direction_conflict = true` against monthly bias.  |
| `weekly_no_setup`           | Weekly direction came back as `none` (ambiguous structure).             |
| `weekly_red_flag_fatal`     | Weekly returned a fatal flag (`exhaustion`, `direction_conflict`, or unknown). |
| `weekly_red_flag_warning_no_compensation` | Weekly returned only warning flags but the closing candle wasn't strongly in-bias. |
| `weekly_quality_low`        | Weekly direction OK and no red flags, but `score < 7`.                  |
| `weekly_daily_disagree`     | Daily self-reported `direction_conflict = true` against weekly bias.    |
| `daily_no_trigger`          | All three TFs ran cleanly but the daily state computed to `NONE`.       |
| `llm_parse_error`           | Model returned malformed JSON twice in a row at this TF.                |

The scanner does **not** keep going past a stop — there's no point grading
a daily setup if the weekly already has tangled EMAs.

---

## 4. Per-timeframe rubric

Every prompt follows the same two-pass structure. Pass 1 is the same JSON
shape across all three TFs (`measurements.{prior_bar, current_closed_bar,
forming_bar, ema_state, recent_5_bars}`), so the validator can apply the
same gates regardless of timeframe.

### 4.1 Monthly (`prompts/monthly-direction.md`)

The monthly is a direction filter. It is NOT a setup grade — we don't grade
pullback quality at this TF.

**Pass 1 — measurements.** Same shape as below.

**Pass 2 — gated verdicts.**

- `direction = "long"` ONLY IF `ema_state.ema9_above_ema15 = true` AND
  `slope_direction = "up"` AND `slope_steepness ≠ "shallow"`.
- `direction = "short"` is symmetric.
- `direction = "none"` is reserved for genuinely tangled / freshly-flipped
  EMAs only.
- `in_9_15_zone = true` if the rightmost candle range overlaps the EMA9-15
  band. Bonus A+ flag — not a requirement.
- `candle_verdict` — body %, wicks, close position, winner, winner_strength
  (0-10), `liquidity_swept` (above_prior_high / below_prior_low / none),
  pattern, in_bias, one-line verdict.

**Stop conditions.** `direction === "none"` → `monthly_no_trend`.

### 4.2 Weekly (`prompts/weekly-structure.md`)

The weekly is the structural quality gate. It receives the monthly bias as
context (`{MONTHLY_BIAS}`) and grades the chart AS that direction's setup.

**Pass 2 — gated verdicts.**

1. **Direction confirmation** — same EMA-stack-and-slope test as monthly,
   plus an explicit escape hatch: if the weekly chart clearly shows the
   opposite of monthly, set `direction_conflict = true`.
2. **`setup_type`** — `pullback` (price retraced into EMA9-15 band and just
   rejected), `continuation` (pullback already happened, now seeing solid
   follow-through), or `none`.
3. **Structural gates (booleans):**
   - `angle_ok` — slope steepness ∈ {medium, steep} AND slope direction
     matches bias.
   - `pullback_present` — visible pullback into the band in the last 5
     bars.
   - `ema_stack_ok` — EMA9/15 stack matches bias.
   - `solid_continuation` — at least 3 of the last 5 closed bars have
     `body_pct_of_range ≥ 60` AND closed in bias direction.
4. **`red_flags`** — only emitted when the underlying measurement actually
   supports them:
   - `choppy_structure` ONLY IF `recent_5_bars.overlap_pct ≥ 75` AND
     `recent_5_bars.direction = "mixed"` AND
     `ema_state.slope_steepness ∈ {"flat", "shallow"}`.
   - `tangled_emas` ONLY IF `ema_state.ema9_ema15_distance = "tight"` AND
     `ema_state.slope_steepness ∈ {"flat", "shallow"}`.
   - `exhaustion` ONLY IF (long bias: upper_wick ≥ 30% AND high above prior
     bar high AND closed red), or short symmetric.
5. **`score` (0-10):**
   - `score ≥ 8` requires ALL of: `angle_ok`, `ema_stack_ok`,
     `pullback_present`, current closed bar color matches bias,
     `red_flags = []`.
   - `score = 7` allows exactly one of those four to be false; `red_flags`
     contains no fatal flags. Warning flags require the closed candle to
     be strongly in bias.
   - `score = 6` is allowed when the closed weekly candle is strongly in
     bias (see §5.4) — the strong close compensates for one missing
     rubric item, regardless of whether warning flags are present.
   - `score < 6` = reject.

**Stop conditions (in order):** `direction_conflict` →
`monthly_weekly_disagree`; `direction === "none"` → `weekly_no_setup`;
fatal red flags → `weekly_red_flag_fatal`; warning red flags without a
strongly in-bias close → `weekly_red_flag_warning_no_compensation`;
`score < scoreFloor` → `weekly_quality_low` (where `scoreFloor` is 7 by
default and 6 when the closed weekly candle is strongly in-bias —
regardless of whether warning flags are present).
(See §5.4 for the fatal vs. warning classification.)

### 4.3 Daily (`prompts/daily-trigger.md`)

The daily is the reactive trigger. It receives both the monthly and weekly
biases as context (`{MONTHLY_BIAS}`, `{WEEKLY_BIAS}`, `{WEEKLY_SCORE}`,
`{WEEKLY_PULLBACK_PRESENT}`).

**Pass 2 — gated verdicts.**

1. **Prep signals (each is a precondition, not a trigger).**
   - `angle_ok` — slope steepness + direction match weekly bias.
   - `zone_rejection` — visible price retest of EMA9-15 band followed by
     rejection in weekly bias direction.
   - `coc_present` — change of character (structural shift back into
     weekly bias after a counter-trend move).
   - `solid_continuation` — same definition as weekly.

   `prep_signals_count` = sum of the four booleans (0-4).

2. **Trigger candle (`candle_verdict`).** Each subfield is gated to
   Pass-1 measurements — the same numbers, just exposed twice for clarity:
   - `winner = "buyers"` ONLY IF green AND body ≥ 40%.
   - `winner_strength` 8-10 only when body ≥ 60% AND close at extreme;
     5-7 when body ≥ 40% AND close in upper/lower third (or extreme).
   - `liquidity_swept = "above_prior_high"` ONLY IF
     `high_vs_prior_bar_high = "above"` AND close in lower third / at low
     AND color red. (Symmetric for `below_prior_low`.)
   - `in_bias = true` ONLY IF current closed bar color matches weekly
     bias AND body ≥ 40%.
   - `pattern` is gated to specific shape rules (e.g. `solid_bull` requires
     green AND body ≥ 60% AND close in upper third / at high; `engulfing`
     patterns require the prior bar to be the opposite color and the
     current bar's high/low to engulf prior bar's high/low).

3. **Red flags.** Same three flags as weekly, with the same gates.

4. **`direction_conflict`.** If daily structure is clearly broken against
   weekly, set true.

**State (`dailyCellState()` in `src/scanner.js:71`)** — this is computed in
code, not trusted from the model:

| `state`  | Conditions                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------- |
| `NONE`   | `direction_conflict` OR `red_flags ≠ []` OR `prep_signals_count < 2` OR missing `candle_verdict`.       |
| `WATCH`  | Prep is ready (≥ 2 signals) but `candle_verdict.in_bias = false` OR `winner_strength < 7`.              |
| `ENTER`  | Prep ≥ 2 signals AND `in_bias = true` AND `winner_strength ≥ 7`.                                        |

**Trigger type (`dailyTriggerType()`)** — only set when state = ENTER, in
priority order:

1. **`sweep`** — `liquidity_swept` matches weekly bias (sweep then close
   against the swept side). Highest conviction.
2. **`pattern`** — named reversal/continuation pattern in bias direction
   (`hammer` / `pinbar_bull` / `engulfing_bull` for long, mirror set for
   short).
3. **`momentum`** — solid directional body (`solid_bull` / `solid_bear`).

**Stop conditions.** `direction_conflict` → `weekly_daily_disagree`;
`state === "NONE"` after a clean run → `daily_no_trigger`.

---

## 5. Cell-state validator (internal consistency layer)

After each cell returns, the scanner runs `validateCellConsistency()` (in
`src/scanner.js:581`) before passing the cell downstream. This is a soft
validation layer — no external data, no extra LLM calls — that drops any
verdict the model's own measurements contradict.

It does three things:

### 5.1 Drop self-contradicting red flags (`gateSatisfied()`)

| Flag                | Gate (must be satisfied to keep the flag)                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `exhaustion`        | Long bias: upper_wick ≥ 30% AND high above prior bar high AND color red. Short bias symmetric. (No bias → skip — nothing to test.) |
| `choppy_structure`  | `recent_5_bars.overlap_pct ≥ 75` AND `recent_5_bars.direction = "mixed"` AND `ema_state.slope_steepness ∈ {"flat", "shallow"}`.    |
| `tangled_emas`      | `ema_state.ema9_ema15_distance = "tight"` AND `ema_state.slope_steepness ∈ {"flat", "shallow"}`.                                   |
| (other flags)       | Pass through unchanged.                                                                                                            |

If a flag's gate fails, the flag is dropped and a line is appended to
`cell.consistency_log` for audit.

### 5.2 Validate `liquidity_swept` (`sweepGateSatisfied()`)

| Claim                | Required measurements                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `above_prior_high`   | `high_vs_prior_bar_high = "above"` AND close in lower third / at low AND color red.              |
| `below_prior_low`    | `low_vs_prior_bar_low = "below"` AND close in upper third / at high AND color green.             |

If the claim isn't backed by the numbers, it's reset to `"none"`.

### 5.3 Reject `in_bias = true` on a small body

If `candle_verdict.in_bias = true` but `body_pct_of_range < 40`, the
validator forces `in_bias = false`. A small body cannot be a decisive
in-bias close.

Cells without `measurements` (legacy shape) or `parse_failed = true` pass
through unchanged — only cells that committed to numbers get validated.

### 5.4 Fatal vs. warning red flags

After the consistency validator runs, weekly red flags are partitioned into **fatal** and **warning** classes:

| Flag | Class |
|------|-------|
| `exhaustion` | Fatal |
| `direction_conflict` | Fatal |
| `choppy_structure` | Warning |
| `tangled_emas` | Warning |
| (any unknown flag) | Treated as fatal (conservative default) |

- **A strongly-in-bias closed weekly candle lowers the score floor from 7 to 6.** "Strongly in bias" means body ≥ 60%, close at extreme or upper-third (long) / lower-third (short), and color matches direction. The strong close is dominant evidence of conviction and offsets one missing rubric item. This applies whether or not warning flags are present.
- **Warning flags still need the strong close.** Warning + weak candle stops at `weekly_red_flag_warning_no_compensation`. Warning + strong + `score < 6` stops at `weekly_quality_low`.
- **Fatal flags always stop the cascade** with `stop_reason = weekly_red_flag_fatal`. The strong close cannot compensate.

Trader rationale: a strongly in-bias close is itself a quality signal — dominant evidence of conviction worth one rubric point — so the score floor relaxes from 7 to 6 whenever it's present. Warnings (chop, tight EMAs) are inherently context-dependent and require that strong close to clear; without it, the warning stops the cascade. Fatal flags (exhaustion candle, TF disagreement) are unambiguous structural breaks that cannot be compensated.

---

## 6. Trend-dominance daily WATCH override

When the higher timeframes are unambiguously aligned, the daily can reach `WATCH` on a softer signal than the standard `prep_signals_count ≥ 2` floor.

A symbol is **trend-dominant** when ALL of:

- `monthly.direction === weekly.direction` (and both are long/short, not none).
- `weekly.red_flags === []` (no flags of any class).
- Weekly EMAs are normal-or-wide distance.
- Both monthly and weekly slope steepness are medium-or-steep.

When trend-dominant, `dailyCellState()` lowers the WATCH floor from `match_count ≥ 2` to `match_count ≥ 1`. With `match_count = 1`, the cell can reach WATCH (never ENTER) provided the daily candle is in-bias with `winner_strength ≥ 5`. With `match_count ≥ 2`, the cell follows the standard ENTER path (no override needed).

Trader rationale: in unambiguous trends, you don't need three confirmation signals to be on watch — one decisive in-bias bar is enough to start tracking. Entry still requires the standard prep + decisive trigger.

---

## 7. Setup-type-specific prep signals

The daily evaluator counts only the prep signals relevant to the cell's `setup_type`:

| `setup_type` | Required signals | Bonus signal | Rationale |
|--------------|------------------|--------------|-----------|
| `pullback` | `zone_rejection` AND `angle_ok` | `solid_continuation` | Pullback IS the rejection from the EMA band; without it there's no setup. |
| `continuation` | `solid_continuation` AND `angle_ok` | `zone_rejection` | Continuation IS the follow-through; pullback is in the rear-view. |
| `none` / unset | (uses legacy `prep_signals_count ≥ 2`) | — | Conservative fallback when the model can't classify. |

The derived field `cell.setup_match = { count, required_satisfied, bonus_satisfied, missing_required }` is attached to every daily cell after evaluation, for diagnostics.

`dailyCellState` uses `setup_match.count` for the WATCH floor, and additionally requires `setup_match.required_satisfied = true` to reach ENTER on typed setups (pullback or continuation). Untyped fallback uses the prior `prep_signals_count ≥ 2` rule.

---

## 8. Confluence grading

Once all three cells pass, `deriveConfluence()` (in `src/scanner.js:1113`)
assigns a grade:

| Grade | Conditions                                                                                                        |
| ----- | ----------------------------------------------------------------------------------------------------------------- |
| **A+** | All 3 TFs bias-aligned, monthly `in_9_15_zone = true`, weekly `score ≥ 8`, daily `state = ENTER` AND `trigger_type ∈ {sweep, pattern}`. |
| **A**  | All 3 TFs bias-aligned, weekly `score ≥ 8`, daily `state = ENTER`.                                                |
| **B**  | All 3 TFs bias-aligned, daily `state = ENTER`.                                                                    |
| **C**  | Monthly + weekly aligned, daily `state = WATCH`.                                                                  |
| **—**  | Anything else (any stop condition, any direction conflict).                                                       |

The daily report sorts ENTER + WATCH candidates by this grade; STOPs are
listed separately on the report card with their `stop_reason`.

---

## 9. What an A+ candidate actually looks like

Putting all the gates together, an A+ candidate must satisfy ALL of:

1. **Monthly:** EMA9 > EMA15 (or symmetric), slope medium/steep, the most
   recent monthly candle range overlaps the EMA9-15 band, candle verdict is
   in bias.
2. **Weekly:** EMA stack matches monthly, slope medium/steep in bias,
   visible pullback into the band in last 5 bars, current closed bar color
   matches bias, no red flags, score ≥ 8.
3. **Daily:** No direction conflict, no red flags, prep_signals_count ≥ 2,
   most recent closed daily bar has body ≥ 60%, closes at extreme in bias
   direction, AND either swept the prior bar's opposite-side liquidity or
   printed a named reversal/continuation pattern (hammer / pinbar /
   engulfing / solid_bull / solid_bear).

A's drop the monthly zone-touch requirement; B's drop the weekly score-8
requirement and the sweep/pattern requirement; C's are WATCH-not-ENTER
because the daily hasn't confirmed yet.

---

## 10. Prior-run context (continuity vs flip)

Each prompt receives the **last 2 prior runs** for the same symbol as a
markdown block (`{PRIOR_CONTEXT}`). The model uses this for three things:

- **Confirm continuity** — same direction as last time → conviction is
  higher.
- **Flag a flip** — opposite direction from a recent A+ call → mention it
  in `reasoning`. A monthly direction change is significant.
- **Stay reactive** — prior context is informational, not a constraint.
  The model still grades THIS chart.

The daily prompt also uses prior context to check whether a previous
WATCH delivered (today's bar should confirm the awaited trigger), or
whether a prior ENTER followed through or faded.

If no priors exist for a symbol, each prompt's block is a cold-scan
sentinel ("_No prior {tf} evaluation on file — this is a cold scan._").

---

## 11. Costs and how often it runs

The full V2 scan touches the LLM three times per symbol (one per TF, max).
A 25-symbol watchlist with healthy stop-rate at the weekly gate runs in
~20 minutes for ~$0.10 in LLM cost. Each timeframe has up to 2 retry
attempts on JSON parse failure before the cell is marked
`parse_failed = true` and the cascade stops with `llm_parse_error`.

---

## 12. Where this lives in code

| Concern                                | File / function                                       |
| -------------------------------------- | ----------------------------------------------------- |
| Top-level scan loop                    | `src/scanner.js` — `runScanV2()` (line 1494)          |
| Per-symbol cascade                     | `src/scanner.js` — `evaluateSymbolV2()` (line 1138)   |
| Daily state derivation                 | `src/scanner.js` — `dailyCellState()` (line 71)       |
| Daily trigger classification           | `src/scanner.js` — `dailyTriggerType()` (line 86)     |
| Confluence grading                     | `src/scanner.js` — `deriveConfluence()` (line 1113)   |
| Cell-state validator                   | `src/scanner.js` — `validateCellConsistency()` (581)  |
| Red-flag gate                          | `src/scanner.js` — `gateSatisfied()` (line 513)       |
| Sweep gate                             | `src/scanner.js` — `sweepGateSatisfied()` (line 550)  |
| Monthly prompt                         | `prompts/monthly-direction.md`                        |
| Weekly prompt                          | `prompts/weekly-structure.md`                         |
| Daily prompt                           | `prompts/daily-trigger.md`                            |
| Pine companion (chart EMAs + bias)     | `pine/mtf-helper.pine`                                |
| Watchlist                              | `watchlist.json`                                      |
| Run command                            | `node bot.js --scan --htf-only`                       |
| Result files                           | `scan-results/scan-v2-watchlist-<timestamp>.json`     |

---

## 13. How to read a scan result

The console report card has one line per symbol:

```
  AUDNZD       STOP @ 1D (daily_no_trigger)
  USOIL        STOP @ 1D (daily_no_trigger)
  US30         STOP @ 1W (weekly_red_flag_fatal)
  GER40        STOP @ 1W (monthly_weekly_disagree)
```

Read it as `<symbol> STOP @ <last TF reached> (<stop_reason>)`. Anything
that didn't STOP is a candidate and is also listed under "Candidates"
sorted by confluence grade. The full per-cell JSON (Pass-1 measurements,
gated verdicts, consistency log,
red_flag_classification, setup_match, candle_strong_in_bias) is saved to
`scan-results/scan-v2-watchlist-<timestamp>.json` for later auditing.
