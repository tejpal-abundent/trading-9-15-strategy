You are reviewing a {SYMBOL} WEEKLY chart for **structural quality** within a higher-timeframe bias.

## Capture context

**Screenshot timestamp: {CAPTURED_AT}.** This chart was captured at that exact moment. The rightmost candle is whatever was forming / had just closed at that time. Grade the structure as it stood at this timestamp — do not extrapolate future bars.

## Prior run context (last 2 runs)

{PRIOR_CONTEXT}

Use the prior context to:
- **Confirm continuity** — if today's structural read aligns with the prior weekly call, the setup is maturing.
- **Detect a fade** — if the prior call was high-score (≥8) but today's structure has weakened, the setup is losing strength; reflect that in your `score`.
- **Watch for a flip** — if today's chart shows a direction opposite to the prior, set `direction_conflict = true` if it's clearly broken against the monthly bias.

## Reactive principle

Grade what HAS happened on the visible chart. Do not predict what the next candle will do — describe what the EMAs and price are *currently showing*.

## Bias context

The MONTHLY bias has been established: **{MONTHLY_BIAS}**.
{MONTHLY_IN_9_15_ZONE_NOTE}

Grade this weekly chart AS A {MONTHLY_BIAS} setup.

- Look for a clean {MONTHLY_BIAS} pullback into the EMA9-EMA15 band with rejection back in the bias direction,
  OR a {MONTHLY_BIAS} continuation with solid follow-through candles.
- If the chart clearly shows the OPPOSITE direction (EMAs stacked against monthly, momentum against it, no recoverable structure), DO NOT force-fit. Set `direction_conflict = true` and let `direction` reflect what the EMAs actually show (it may end up the opposite of monthly). Honest disagreement is more valuable than forced agreement.

The chart has two indicators visible:
- **EMA9** (orange line)
- **EMA15** (purple line)

Return **pure JSON only**.

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
  }
}
```

**ATR notes (V2.1):** `body_atr_mult` = body height / `atr14_visible` (your eye-estimate of an average true-range bar over the last ~14 weekly bars). `range_atr_mult` = total candle range / `atr14_visible`. These let downstream code distinguish a real expansion candle from a tight inside bar that happens to be 60% body. If the chart doesn't show enough history to estimate ATR, set `atr14_visible` to your best guess and `body_atr_mult` / `range_atr_mult` accordingly — never null.

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
   - `"choppy_structure"` ONLY IF `recent_5_bars.overlap_pct ≥ 75` AND `recent_5_bars.direction = "mixed"` AND `ema_state.slope_steepness ∈ {"flat", "shallow"}`
   - `"tangled_emas"` ONLY IF `ema_state.ema9_ema15_distance = "tight"` AND `ema_state.slope_steepness ∈ {"flat", "shallow"}`
   - `"exhaustion"` ONLY IF (long bias: `current_closed_bar.upper_wick_pct ≥ 30` AND `current_closed_bar.high_vs_prior_bar_high = "above"` AND `current_closed_bar.color = "red"`) OR (short bias symmetric)
7. **score** *(int 0-10)*:
   - `score ≥ 8` requires ALL of: `angle_ok = true`, `ema_stack_ok = true`, `pullback_present = true`, `current_closed_bar.color = matches bias`, `red_flags = []`
   - `score = 7` allows exactly ONE of {`angle_ok`, `ema_stack_ok`, `pullback_present`, `current_closed_bar.color` matches bias} to be false, AND `red_flags` contains no fatal flags. Warning flags require the closed candle to be strongly in bias.
   - `score = 6` is allowed when the closed weekly candle is **strongly in bias** — `body_pct_of_range ≥ 60` AND `close_position ∈ {"at_high", "upper_third"}` (long) or `{"at_low", "lower_third"}` (short) AND `color` matches `direction`. The strong close compensates for one missing rubric item, regardless of whether warning flags are present. Fatal flags still reject; warning flags still need a strong close.
   - `score < 6` = reject
   - **Fatal red flags** (`exhaustion`, `direction_conflict`): score MUST drop below 6.

### Step 4 — Candle Verdict (read the rightmost CLOSED weekly candle)

Use the same 11 fields as defined in the output schema below. Each numeric field must be consistent with `measurements.current_closed_bar` — `body_pct_of_range`, `upper_wick_pct`, `lower_wick_pct`, `close_position`, and the swept fields are the same.

- `liquidity_swept = "above_prior_high"` ONLY IF `current_closed_bar.high_vs_prior_bar_high = "above"` AND `close_position ∈ {"lower_third", "at_low"}` AND `color = "red"`
- `liquidity_swept = "below_prior_low"` symmetric
- `in_bias = true` ONLY IF `current_closed_bar.color matches direction` AND `body_pct_of_range ≥ 40`
- `pattern = "solid_bull"` / `"solid_bear"` ALSO requires `body_atr_mult ≥ 0.6` (V2.1 — a 60%-body bar that's tiny vs ATR is not a "solid" candle).
- `winner_strength` 8-10 ALSO requires `body_atr_mult ≥ 0.8`.

### Step 5 — Weekly POI (V2.1 — Points of Interest the daily can confluence with)

Identify up to 3 structural levels visible on this weekly chart that the daily evaluator can later test for confluence. Each entry describes a level — the model is reading a chart, so descriptions can be approximate ("most recent visible swing high around 1.0850") but must be grounded in what's actually on screen.

Each item:
- **`kind`** — one of `swing_high`, `swing_low`, `breaker`, `order_block`, `prior_range_extreme`.
- **`level_description`** — ≤ 80 chars, e.g. "swing low from 8 weeks ago, around 1.0750".
- **`distance_to_current_close_atr`** — eye-estimate distance from the rightmost CLOSED candle's close to the level, expressed in multiples of `ema_state.atr14_visible`. Negative = below current close, positive = above.

If no clear POI is visible, return an empty array.

### Step 6 — Reasoning block (V2.1 — replace the 1-sentence reasoning)

Each field ≤ 2 sentences, each grounded in Pass-1 measurements or Pass-2 verdicts above.

- **`context`** — monthly bias + weekly EMA stack/slope + setup_type in one read.
- **`structure_read`** — what the structural gates say (angle_ok, pullback_present, ema_stack_ok, solid_continuation) and which (if any) failed.
- **`poi_read`** — name the dominant POI level (or "no clear POI") and where price sits relative to it now.

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
    }
  },
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
  "weekly_poi": [
    {
      "kind": "swing_high" | "swing_low" | "breaker" | "order_block" | "prior_range_extreme",
      "level_description": "≤ 80 chars",
      "distance_to_current_close_atr": 0.0
    }
  ],
  "reasoning_block": {
    "context": "≤2 sentences",
    "structure_read": "≤2 sentences",
    "poi_read": "≤2 sentences"
  },
  "reasoning": "one sentence ≤ 200 chars (kept for backwards compatibility — derived from reasoning_block.structure_read)"
}
```

Downstream computes:
`pass = direction != "none" AND direction_conflict === false AND red_flags.length === 0 AND score >= 7`
