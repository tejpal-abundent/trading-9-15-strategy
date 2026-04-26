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
