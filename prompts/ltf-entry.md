You are reviewing a {SYMBOL} {TIMEFRAME} chart to confirm an **entry** in the already-decided direction.

**HTF bias is {HTF_BIAS}.** Look ONLY for entry confirmation in this direction. Do NOT re-grade the trend or vote on direction — that decision is final.

The chart has two key indicators visible:
- **EMA9** (orange line)
- **EMA15** (purple line)

All grading happens on the **most recent few candles** at the right edge of the chart — these are the candles forming the entry. Older history is just context.

Two valid setup types:
- **`"pullback"`** — price just touched the EMA9–EMA15 band and rejected away in the bias direction; you're entering on the bounce.
- **`"continuation"`** — pullback already happened earlier; you're now seeing solid follow-through candles in the bias direction and entering the momentum.

Return **pure JSON only** (no prose, no markdown fences).

### Step 0 — Identify the CURRENT candle FIRST

Before grading anything, locate the **rightmost candle** on the chart — this is the current/forming bar. The OHLC values at the top of the chart refer to THIS candle, not any earlier one.

Compute and remember:
- `latest_candle.color` — green if Close > Open, red if Close < Open
- `latest_candle.position_vs_emas` — "above" / "between" / "below" the EMA9–EMA15 band
- `latest_candle.direction_vs_prior` — "up" / "down" / "flat" relative to the previous closed candle

All downstream grading must be consistent with the actual rightmost candle, NOT with a more dramatic candle further to the left.

### Grade the entry

1. **setup_type** *(string)* — `"pullback"` | `"continuation"` | `"none"`. Pick the one that best matches what the most recent 3–10 candles are showing.

2. **angle_ok** *(boolean)* — Is the EMA9/EMA15 currently angled steeply in the bias direction at the **rejection point** (recent low for longs, recent high for shorts)? Mentally draw a horizontal at that turning point and a tangent along the EMA forward. Angle must be **≥ 30–40°**. A flat/gentle EMA at the rejection → `false`.

3. **zone_rejection** *(boolean)* — Has price just touched the EMA9–EMA15 band and started rejecting AWAY from it in the bias direction? True if the most recent 1–3 candles wick into the band and close back outside it in the bias direction. For continuation setups where price never returned to the zone, this is `false`.

4. **coc_present** *(boolean)* — Change of Character: has a recent swing high (for `long`) or swing low (for `short`) just been broken in the bias direction? False if structure is undecided.

5. **strong_candle_in_bias** *(boolean)* — Is the most recent CLOSED candle a strong move in the bias direction? True if it is engulfing (body engulfs prior body in bias direction) OR solid (body ≥60% of range, in bias direction). False otherwise.

6. **solid_continuation** *(boolean)* — Are the last 3–5 candles showing visibly solid bodies in the bias direction with little against-trend wick rejection? True for momentum, false for choppy / dragging price.

7. **probability_next_candle_in_bias** *(integer 0–100)* — Your estimate of the probability that the **next candle** will close in the {HTF_BIAS} direction. Consider:
   - Fresh zone rejection + strong candle + CoC → 75–90
   - Solid continuation candles in known trend → 70–85
   - Mixed signals or hesitation → 50–65
   - Counter-trend pressure or exhaustion → ≤50

8. **red_flags** *(array of strings)* — Any of:
   - `"choppy_structure"` — last 5–10 candles overlap with no clear direction
   - `"doji_cluster"` — multiple small-body candles nearby
   - `"zone_pierced_decisively"` — price blew through the EMA band instead of rejecting
   - `"news_spike"` — abnormal candle ~3×+ average range
   - `"counter_trend_pressure"` — visible recent move against the bias direction

9. **score** *(integer 0–10)* — Quality of this moment as an entry into the {HTF_BIAS} bias. 10 = textbook entry; 8 = take it; <8 = wait.

10. **reasoning** *(string ≤200 chars)* — One sentence naming the setup type and the strongest 1–2 supporting signals.

### Output format

```json
{
  "latest_candle": {
    "color": "green" | "red",
    "position_vs_emas": "above" | "between" | "below",
    "direction_vs_prior": "up" | "down" | "flat"
  },
  "setup_type": "pullback" | "continuation" | "none",
  "angle_ok": bool,
  "zone_rejection": bool,
  "coc_present": bool,
  "strong_candle_in_bias": bool,
  "solid_continuation": bool,
  "probability_next_candle_in_bias": 0,
  "red_flags": [],
  "score": 0,
  "reasoning": "..."
}
```

Downstream computes:
`signals = angle_ok + zone_rejection + coc_present + strong_candle_in_bias + solid_continuation`
`pass = red_flags.length === 0 AND ((signals >= 2 AND score >= 8) OR probability_next_candle_in_bias >= 75)`
