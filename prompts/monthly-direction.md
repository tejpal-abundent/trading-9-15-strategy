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
