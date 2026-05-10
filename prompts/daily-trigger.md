You are reviewing a {SYMBOL} DAILY chart for **entry trigger** within an established higher-timeframe bias.

## Capture context

**Screenshot timestamp: {CAPTURED_AT}.** This chart was captured at that exact moment. The rightmost candle is the bar that was forming / had just closed at that time, and the "most recent CLOSED candle" referenced below is the bar to its immediate left if the rightmost is still incomplete. Ground the trigger evaluation to THIS moment — do not infer what the next bar will do.

## Prior run context (last 2 runs)

{PRIOR_CONTEXT}

Use the prior context to answer these questions explicitly in `reasoning`:
- **If T-1 was WATCH:** does today's closed candle deliver the confirmation that was awaited? If yes → ENTER (with the matching trigger_type). If the trigger window has passed without confirmation → still WATCH or NONE.
- **If T-1 was ENTER:** did the candle that closed AFTER it follow through (continuation in bias direction) or fade (close against bias / wick rejection / flip)? A faded prior trigger lowers conviction — be conservative on a fresh ENTER today.
- **If T-1 and T-2 both said NONE:** chart has been quiet — only call ENTER on a clearly decisive trigger candle.
- **If today contradicts prior bias:** set `direction_conflict = true` if the daily structure is clearly broken; otherwise downgrade to WATCH and explain in `reasoning`.

## Reactive trading principle

Grade what HAS happened on the most recent CLOSED candle. Never enter on prediction — only when a confirmation candle has actually closed in the bias direction. This system trades reactively.

## Bias context

- Monthly bias: **{MONTHLY_BIAS}**
- Monthly move maturity: **{MONTHLY_MOVE_MATURITY}**
- Weekly bias: **{WEEKLY_BIAS}** (score {WEEKLY_SCORE}/10)
- Weekly pullback present: {WEEKLY_PULLBACK_PRESENT}
- Weekly POI levels (V2.1): {WEEKLY_POI_LIST}

You are ONLY looking for a **{WEEKLY_BIAS}** entry trigger on the daily chart.

If the chart clearly shows the opposite direction (daily structure has broken against weekly bias, momentum clearly against, clear trend flip), return `direction_conflict = true`. The scanner recomputes `state` from `direction_conflict`, so you do not need to set state explicitly — your honest self-report below is for diagnostics.

The chart has two indicators visible:
- **EMA9** (orange line)
- **EMA15** (purple line)

Return **pure JSON only**.

## Pass 1 — Measurements (extract these BEFORE forming any verdict)

Locate the rightmost candle on the chart. If it is still forming, the "most recent CLOSED candle" is the bar IMMEDIATELY TO ITS LEFT. Otherwise the rightmost solid candle IS the current closed bar.

{OHLC_GROUND_TRUTH}

{SMC_GROUND_TRUTH}

The SMC summary above is computed deterministically from the last 100 bars' OHLC. Use it to inform `coc_present`, `liquidity_swept`, and `competition.sweep_then_displacement` — when SMC says "Last CHoCH: bearish (3 bars ago)" and bias is short, `coc_present` should be true regardless of what the chart "looks like". Do NOT contradict SMC ground truth. (The scanner also overrides `coc_present` deterministically post-parse, so honesty here just helps the diagnostic logs.)

Compute body/wick/close_position from the chosen bar's exact OHLC. The four formulas are the same as the weekly prompt's Anchor section.

```json
"measurements": {
  "prior_bar": {
    "color": "green" | "red",
    "body_pct_of_range": 0,
    "high_relative_to_ema_band": "above" | "inside" | "below",
    "bars_from_right": 2
  },
  "current_closed_bar": {
    "open": 0.0,
    "high": 0.0,
    "low": 0.0,
    "close": 0.0,
    "bars_from_right": 1,
    "color": "green" | "red",
    "body_pct_of_range": 0,
    "upper_wick_pct": 0,
    "lower_wick_pct": 0,
    "close_position": "at_high" | "upper_third" | "mid" | "lower_third" | "at_low",
    "high_vs_prior_bar_high": "above" | "equal" | "below",
    "low_vs_prior_bar_low": "above" | "equal" | "below",
    "body_atr_mult": 0.0,
    "range_atr_mult": 0.0
  },
  "forming_bar": {
    "color": "green" | "red" | "doji",
    "progress_pct": 0
  },
  "ema_state": {
    "ema9_above_ema15": bool,
    "ema9_ema15_distance": "tight" | "normal" | "wide",
    "slope_direction": "up" | "down" | "flat",
    "slope_steepness": "shallow" | "medium" | "steep",
    "atr14_visible": 0.0
  },
  "recent_5_bars": {
    "direction": "up" | "down" | "mixed",
    "overlap_pct": 0
  },
  "last_5_candles": [
    {
      "index": -4,
      "color": "green" | "red",
      "body_pct_of_range": 0,
      "upper_wick_pct": 0,
      "lower_wick_pct": 0,
      "close_position": "at_high" | "upper_third" | "mid" | "lower_third" | "at_low",
      "high_vs_prior_bar_high": "above" | "equal" | "below",
      "low_vs_prior_bar_low": "above" | "equal" | "below",
      "body_atr_mult": 0.0,
      "role": "driver" | "pause" | "pullback" | "sweep" | "rejection" | "absorption" | "continuation" | "reversal" | "inside",
      "pattern": "solid_bull" | "solid_bear" | "hammer" | "shooting_star" | "engulfing_bull" | "engulfing_bear" | "inside_bar" | "pinbar_bull" | "pinbar_bear" | "doji" | "none",
      "in_bias": bool
    }
    /* exactly 5 entries, indices -4 → 0, where 0 is the most recent CLOSED candle */
  ]
}
```

**ATR + last_5_candles notes (V2.1):**
- `body_atr_mult` = body height / `atr14_visible` (your eye-estimate of an average true-range bar over the last ~14 daily bars). `range_atr_mult` = total candle range / `atr14_visible`.
- `last_5_candles` is the explicit 5-bar narrative. `index = 0` is the same bar as `current_closed_bar` (numbers must agree). `index = -1` is the same bar as `prior_bar` for color/body. Each bar's `role` MUST be backed by its own measurements (a "sweep" bar must have wicked beyond the prior bar's high/low; a "driver" bar must have body ≥ 50% AND `body_atr_mult ≥ 0.6`; an "inside" bar must satisfy high < prior high AND low > prior low). The downstream validator drops unbacked roles.

## Pass 2 — Gated verdicts

### Step 0 — Setup type (pullback vs continuation)

Look at the last 3 closed bars (`last_5_candles[-2]`, `last_5_candles[-1]`, `last_5_candles[0]`) and pick ONE:

- **"pullback"** — at least ONE of `last_5_candles[-2]` or `last_5_candles[-1]` closed COUNTER-bias (e.g. green close in a short setup, red close in a long setup), AND `current_closed_bar` (= `last_5_candles[0]`) closed solidly IN-bias and broke the prior bar's extreme. This is the "trapped trader / failed reversal then engulf" pattern — the counter-bias bar(s) attracted longs/shorts who got run over by the bias-direction continuation.
- **"continuation"** — the last 3 bars (`-2`, `-1`, `0`) ALL closed in-bias with no counter-bias attempt visible. Steady drive in the bias direction, no pullback to clear.
- **"none"** — neither (choppy, mixed, or current bar isn't decisively in-bias).

**Bias for "pullback" labeling:** when the recent counter-bias attempt got engulfed/rejected by the current bar, prefer "pullback" over "continuation" — the rejection IS the trigger.

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
- `winner_strength` (0-10) — derived from body and close position (matching the bar's winner). The thresholds are MINIMUMS — meet the body/close criterion, score AT LEAST that floor:
  - **≥ 9** if `body_pct_of_range ≥ 70` AND `close_position ∈ {"at_high", "at_low"}` AND `in_bias = true` AND `body_atr_mult ≥ 0.8` (V2.5 — textbook decisive in-bias close)
  - **≥ 8** if `body_pct_of_range ≥ 70` AND `close_position ∈ {"at_high", "at_low"}` AND `in_bias = true` (decisive close at extreme, body alone is the signal regardless of ATR)
  - **≥ 7** if `body_pct_of_range ≥ 60` AND `close_position ∈ {"upper_third", "lower_third", "at_high", "at_low"}` AND `in_bias = true` (V2.5 — solid in-bias body with close in the bias half is a real trigger; do NOT score this below 7)
  - **≥ 7** if `pattern ∈ {"engulfing_bull", "engulfing_bear", "solid_bull", "solid_bear"}` AND `in_bias = true` (V2.5 — a recognized in-bias engulfing/solid pattern is by definition a strong trigger)
  - **5-6** if `body_pct_of_range ≥ 40` AND `close_position ∈ {"upper_third", "lower_third", "at_high", "at_low"}` (decent body but either against bias or below the ≥60 threshold)
  - **0-4** otherwise (small body OR close in mid)
- `liquidity_swept = "above_prior_high"` ONLY IF `current_closed_bar.high_vs_prior_bar_high = "above"` AND `close_position ∈ {"lower_third", "at_low"}` AND `color = "red"`
- `liquidity_swept = "below_prior_low"` symmetric
- `liquidity_swept = "none"` otherwise
- `in_bias = true` ONLY IF `current_closed_bar.color matches {WEEKLY_BIAS}` AND `body_pct_of_range ≥ 40`
- `pattern` — choose from the enum based on observed shape:
  - `solid_bull` ONLY IF green AND `body_pct_of_range ≥ 60` AND `close_position ∈ {"upper_third", "at_high"}` AND `body_atr_mult ≥ 0.6` (V2.1)
  - `solid_bear` ONLY IF red AND `body_pct_of_range ≥ 60` AND `close_position ∈ {"lower_third", "at_low"}` AND `body_atr_mult ≥ 0.6` (V2.1)
  - `hammer` / `pinbar_bull` ONLY IF green AND `lower_wick_pct ≥ 50` AND `body_pct_of_range ≤ 30`
  - `shooting_star` / `pinbar_bear` ONLY IF red AND `upper_wick_pct ≥ 50` AND `body_pct_of_range ≤ 30`
  - `engulfing_bull` ONLY IF green AND `prior_bar.color = "red"` AND `body_pct_of_range ≥ 60` AND `current_closed_bar.high_vs_prior_bar_high = "above"` AND `current_closed_bar.low_vs_prior_bar_low = "below"`
  - `engulfing_bear` ONLY IF red AND `prior_bar.color = "green"` AND `body_pct_of_range ≥ 60` AND `current_closed_bar.high_vs_prior_bar_high = "above"` AND `current_closed_bar.low_vs_prior_bar_low = "below"`
  - `inside_bar` ONLY IF `current_closed_bar.high_vs_prior_bar_high = "below"` AND `current_closed_bar.low_vs_prior_bar_low = "above"`
  - `doji` ONLY IF `body_pct_of_range ≤ 10`
  - `none` if no rule above matches

### Step 2b — Sequence read (V2.1 — narrative of the last 5 closed daily candles)

Read the `last_5_candles` array as a *story* and grade how the sequence supports the trigger candle. A textbook reversal sequence might be: `pause → sweep → rejection → driver → continuation`. A textbook continuation: `pullback → pullback → pause → driver → continuation`.

```json
"sequence_read": {
  "sequence_quality": 0,             // 0-10: how cleanly the bars line up to support the trigger
  "sequence_label": "≤80 chars naming the pattern, e.g. 'sweep+rejection+driver'",
  "last_5_in_bias_count": 0,         // 0-5, sum of last_5_candles[*].in_bias
  "sequence_supports_trigger": bool, // true ONLY IF the trigger bar (index 0) is the natural conclusion of the prior 4
  "sequence_notes": "≤2 sentences naming each bar's role in order"
}
```

`sequence_supports_trigger` MUST be false if the trigger candle's role contradicts the rest (e.g. an "absorption" trigger after 3 driver bars = no expansion = not a tradeable confirmation).

### Step 2c — POI confluence (V2.1 — points of interest the trigger candle is reacting to)

For each level below, set true ONLY IF the **trigger bar's range overlaps that level** (a wick into the level counts; price merely "near" the level does NOT). The downstream `deriveConfluence` uses the count: A+ requires ≥ 2, A requires ≥ 1.

```json
"poi_confluence": {
  "at_ema9_15_band": bool,           // trigger bar wicked or closed into the EMA9-EMA15 band
  "at_prior_daily_swing": bool,      // wicked into a visible prior daily swing high (short bias) or swing low (long bias)
  "at_prior_day_high_low": bool,     // wicked into yesterday's high or low (PDH / PDL)
  "at_weekly_poi": bool,             // wicked into ANY level listed in {WEEKLY_POI_LIST}
  "count": 0,                        // sum of the 4 booleans above (0-4)
  "primary_poi_description": "≤120 chars naming the strongest level the bar reacted to"
}
```

### Step 2d — Buyer/seller competition at the level (V2.1)

This is the heart of reactive reading. At a real reversal you see **absorption** (multiple bars with long wicks both sides at one level), then a **sweep** of liquidity, then **displacement** (a fully in-bias body that closes back through the swept level). Reading these explicitly stops the system from confusing a lone sweep (which is often a trap) with the actual trade.

```json
"competition": {
  "absorption_at_level": bool,
     // ≥ 3 of last_5_candles share a horizontal level (their highs/lows cluster within ~0.3 ATR)
     // AND each has body_pct_of_range ≤ 40 AND combined upper+lower wick ≥ 50%.
  "sweep_then_displacement": bool,
     // last_5_candles[-2].role === "sweep" (or candle_verdict.liquidity_swept ≠ "none" on bar -1)
     // AND the trigger bar (index 0) is in_bias AND body_atr_mult ≥ 0.6 AND closes back inside the swept range.
  "acceptance": "above" | "below" | "rejected" | "none",
     // "above" / "below": close held on the in-bias side of the swept level for ≥ 2 bars (acceptance).
     // "rejected": wicked through and reverted within 1 bar (rejection — the OPPOSITE of acceptance).
     // "none": nothing was swept.
  "competition_winner": "buyers" | "sellers" | "balance",
  "notes": "≤2 sentences naming the level + who took it"
}
```

### Step 2e — Trade plan (V2.1 — invalidation, target, R:R)

A swing trade is only worth taking if R:R ≥ 2. Read levels off the chart — your eye-estimate is good enough; what matters is consistency between `entry_price_approx`, `invalidation_level`, `target_level`, and the ATR-normalised risk/reward.

```json
"trade_plan": {
  "entry_price_approx": 0.0,
  "invalidation_level": 0.0,
     // long: below trigger candle low, OR below swept low − 0.25 ATR if sweep_then_displacement.
     // short: symmetric (above trigger candle high / swept high + 0.25 ATR).
  "invalidation_basis": "trigger_low" | "trigger_high" | "swept_low" | "swept_high" | "swing_low" | "swing_high" | "ema_band" | "other",
  "target_level": 0.0,
     // V2.5 — target selection priority (use the FIRST that gives RR ≥ 2.0):
     //   1. weekly POI in {WEEKLY_POI_LIST} on the bias side of entry
     //   2. nearest visible prior daily swing high (long) / swing low (short) on the bias side
     //   3. monthly swing on the bias side
     //   4. 1.272 extension of the prior structural leg
     //   5. round number ONLY as a last resort, AND ONLY if no structural target above gives ≥ 2.0 RR
     // Round-number targets that yield RR < 2.0 are USUALLY a red flag that you stopped looking too soon —
     // scan further down the chart (long bias: scan further up) for the next visible structural level.
     // Example: if entry is at 0.7764 and the round number 0.7700 gives RR=1.1, keep scanning down — there is
     // almost always a prior structural low further out (e.g. 0.7600 / 0.7550) that gives RR ≥ 2.5+.
  "target_basis": "prior_swing_high" | "prior_swing_low" | "weekly_poi" | "monthly_swing" | "1.272_ext" | "round_number" | "other",
  "risk_atr": 0.0,    // |entry − invalidation| / atr14_visible
  "reward_atr": 0.0,  // |target − entry|       / atr14_visible
  "rr_ratio": 0.0     // reward_atr / risk_atr  (must be > 0; downstream forces ENTER → WATCH if < 2.0)
}
```

If you genuinely cannot read levels off the chart (e.g. the visible window is too zoomed in), return `null` for the whole `trade_plan` object — the downstream code will treat that as "RR unknown" and fall back to legacy gating, which is safer than a fabricated number.

### Step 3 — Red flags

- `"choppy_structure"` ONLY IF `recent_5_bars.overlap_pct ≥ 75` AND `recent_5_bars.direction = "mixed"` AND `ema_state.slope_steepness ∈ {"flat", "shallow"}`
- `"tangled_emas"` ONLY IF `ema_state.ema9_ema15_distance = "tight"` AND `ema_state.slope_steepness ∈ {"flat", "shallow"}`
- `"exhaustion"` ONLY IF (long bias: `current_closed_bar.upper_wick_pct ≥ 30` AND `high_vs_prior_bar_high = "above"` AND `color = "red"`) OR (short bias symmetric)

### Step 4 — Probability (for ranking only)

`probability_next_candle_in_bias` (0-100) — your estimate of the next daily closing in {WEEKLY_BIAS}. Used to rank multiple ENTER signals; does NOT gate state.

### Step 5 — direction_conflict

If the daily structure is clearly broken against {WEEKLY_BIAS} (EMAs visibly flipped, momentum reversed), set `direction_conflict = true`. Otherwise false.

### Output format

```json
{
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
      "low_vs_prior_bar_low": "above" | "equal" | "below",
      "body_atr_mult": 0.0,
      "range_atr_mult": 0.0
    },
    "forming_bar": {
      "color": "green" | "red" | "doji",
      "progress_pct": 0
    },
    "ema_state": {
      "ema9_above_ema15": bool,
      "ema9_ema15_distance": "tight" | "normal" | "wide",
      "slope_direction": "up" | "down" | "flat",
      "slope_steepness": "shallow" | "medium" | "steep",
      "atr14_visible": 0.0
    },
    "recent_5_bars": {
      "direction": "up" | "down" | "mixed",
      "overlap_pct": 0
    },
    "last_5_candles": [
      {
        "index": -4,
        "color": "green" | "red",
        "body_pct_of_range": 0,
        "upper_wick_pct": 0,
        "lower_wick_pct": 0,
        "close_position": "at_high" | "upper_third" | "mid" | "lower_third" | "at_low",
        "high_vs_prior_bar_high": "above" | "equal" | "below",
        "low_vs_prior_bar_low": "above" | "equal" | "below",
        "body_atr_mult": 0.0,
        "role": "driver" | "pause" | "pullback" | "sweep" | "rejection" | "absorption" | "continuation" | "reversal" | "inside",
        "pattern": "solid_bull" | "solid_bear" | "hammer" | "shooting_star" | "engulfing_bull" | "engulfing_bear" | "inside_bar" | "pinbar_bull" | "pinbar_bear" | "doji" | "none",
        "in_bias": bool
      }
    ]
  },
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
  "sequence_read": {
    "sequence_quality": 0,
    "sequence_label": "≤80 chars",
    "last_5_in_bias_count": 0,
    "sequence_supports_trigger": bool,
    "sequence_notes": "≤2 sentences"
  },
  "poi_confluence": {
    "at_ema9_15_band": bool,
    "at_prior_daily_swing": bool,
    "at_prior_day_high_low": bool,
    "at_weekly_poi": bool,
    "count": 0,
    "primary_poi_description": "≤120 chars"
  },
  "competition": {
    "absorption_at_level": bool,
    "sweep_then_displacement": bool,
    "acceptance": "above" | "below" | "rejected" | "none",
    "competition_winner": "buyers" | "sellers" | "balance",
    "notes": "≤2 sentences"
  },
  "trade_plan": {
    "entry_price_approx": 0.0,
    "invalidation_level": 0.0,
    "invalidation_basis": "trigger_low" | "trigger_high" | "swept_low" | "swept_high" | "swing_low" | "swing_high" | "ema_band" | "other",
    "target_level": 0.0,
    "target_basis": "prior_swing_high" | "prior_swing_low" | "weekly_poi" | "monthly_swing" | "1.272_ext" | "round_number" | "other",
    "risk_atr": 0.0,
    "reward_atr": 0.0,
    "rr_ratio": 0.0
  },
  "state": "NONE" | "WATCH" | "ENTER",
  "trigger_type": "momentum" | "sweep" | "pattern" | "sweep_displacement" | "none",
  "reasoning_block": {
    "htf_context":     "≤2 sentences — monthly + weekly bias and what stage the move is in",
    "sequence_read":   "≤2 sentences — what the last 5 daily bars did, named in order",
    "trigger_anatomy": "≤2 sentences — the trigger candle decomposed: body, wicks, close, pattern",
    "competition":     "≤2 sentences — who won at the POI: absorption / sweep+displacement / acceptance",
    "plan":            "≤2 sentences — entry ~X, invalidation Y (basis), target Z (basis), RR=W"
  },
  "reasoning": "one sentence ≤ 200 chars (kept for backwards compatibility — derived from reasoning_block.plan)"
}
```

Note: `state` and `trigger_type` are also self-reported here, but the SCANNER's code recomputes them authoritatively from `dailyCellState()` / `dailyTriggerType()` after `validateCellConsistency` runs. Be honest in your self-report — it's used for diagnostics — but the scanner's outputs are what drive WATCH/ENTER decisions.
