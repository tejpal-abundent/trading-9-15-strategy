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
