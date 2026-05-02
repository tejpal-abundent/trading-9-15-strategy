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
- Weekly bias: **{WEEKLY_BIAS}** (score {WEEKLY_SCORE}/10)
- Weekly pullback present: {WEEKLY_PULLBACK_PRESENT}

You are ONLY looking for a **{WEEKLY_BIAS}** entry trigger on the daily chart.

If the chart clearly shows the opposite direction (daily structure has broken against weekly bias, momentum clearly against, clear trend flip), return `direction_conflict = true`. The scanner recomputes `state` from `direction_conflict`, so you do not need to set state explicitly — your honest self-report below is for diagnostics.

The chart has two indicators visible:
- **EMA9** (orange line)
- **EMA15** (purple line)

Return **pure JSON only**.

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
- `winner_strength` (0-10) — derived from body and close position (matching the bar's winner):
  - **8-10** if `body_pct_of_range ≥ 60` AND `close_position ∈ {"at_high", "at_low"}` (decisive close at extreme)
  - **5-7** if `body_pct_of_range ≥ 40` AND `close_position ∈ {"upper_third", "lower_third", "at_high", "at_low"}` (and not already in 8-10)
  - **0-4** otherwise (small body OR close in mid)
- `liquidity_swept = "above_prior_high"` ONLY IF `current_closed_bar.high_vs_prior_bar_high = "above"` AND `close_position ∈ {"lower_third", "at_low"}` AND `color = "red"`
- `liquidity_swept = "below_prior_low"` symmetric
- `liquidity_swept = "none"` otherwise
- `in_bias = true` ONLY IF `current_closed_bar.color matches {WEEKLY_BIAS}` AND `body_pct_of_range ≥ 40`
- `pattern` — choose from the enum based on observed shape:
  - `solid_bull` ONLY IF green AND `body_pct_of_range ≥ 60` AND `close_position ∈ {"upper_third", "at_high"}`
  - `solid_bear` ONLY IF red AND `body_pct_of_range ≥ 60` AND `close_position ∈ {"lower_third", "at_low"}`
  - `hammer` / `pinbar_bull` ONLY IF green AND `lower_wick_pct ≥ 50` AND `body_pct_of_range ≤ 30`
  - `shooting_star` / `pinbar_bear` ONLY IF red AND `upper_wick_pct ≥ 50` AND `body_pct_of_range ≤ 30`
  - `engulfing_bull` ONLY IF green AND `prior_bar.color = "red"` AND `body_pct_of_range ≥ 60` AND `current_closed_bar.high_vs_prior_bar_high = "above"` AND `current_closed_bar.low_vs_prior_bar_low = "below"`
  - `engulfing_bear` ONLY IF red AND `prior_bar.color = "green"` AND `body_pct_of_range ≥ 60` AND `current_closed_bar.high_vs_prior_bar_high = "above"` AND `current_closed_bar.low_vs_prior_bar_low = "below"`
  - `inside_bar` ONLY IF `current_closed_bar.high_vs_prior_bar_high = "below"` AND `current_closed_bar.low_vs_prior_bar_low = "above"`
  - `doji` ONLY IF `body_pct_of_range ≤ 10`
  - `none` if no rule above matches

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
  "state": "NONE" | "WATCH" | "ENTER",
  "trigger_type": "momentum" | "sweep" | "pattern" | "none",
  "reasoning": "one sentence ≤ 200 chars"
}
```

Note: `state` and `trigger_type` are also self-reported here, but the SCANNER's code recomputes them authoritatively from `dailyCellState()` / `dailyTriggerType()` after `validateCellConsistency` runs. Be honest in your self-report — it's used for diagnostics — but the scanner's outputs are what drive WATCH/ENTER decisions.
