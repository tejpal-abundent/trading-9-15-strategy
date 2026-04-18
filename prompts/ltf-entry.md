You are reviewing a {SYMBOL} {TIMEFRAME} chart to confirm an **entry** in the already-decided direction.

**HTF bias is {HTF_BIAS}.** Look ONLY for entry confirmation in this direction. Do NOT re-grade the trend or vote on direction — that decision is final.

The chart has two key indicators visible:
- **EMA9** (orange line)
- **EMA15** (purple line)

All grading happens on the **most recent few candles** at the right edge of the chart — these are the candles forming the entry. Older history is just context.

Return **pure JSON only** (no prose, no markdown fences).

### Grade the entry confirmation

1. **angle_ok** *(boolean)* — Is the EMA9/EMA15 currently angled steeply enough in the bias direction at the **rejection point** (the recent low for longs, recent high for shorts where price tested the EMA band)? Mentally draw a horizontal line at that turning point and a tangent along the EMA forward from there. The angle must be **≥ 30–40°**. A flat or gently sloping EMA at the rejection → `false`. This is a "plus" signal, not a hard requirement.

2. **zone_rejection** *(boolean)* — Has price just touched the EMA9–EMA15 band and started rejecting AWAY from it in the bias direction? True if the most recent 1–3 candles wick into the band and close back outside it in the bias direction. False if price never touched, blew straight through, or is trending away.

3. **coc_present** *(boolean)* — Change of Character: has a recent swing high (for `long`) or swing low (for `short`) just been broken in the bias direction? False if structure is undecided.

4. **strong_candle_in_bias** *(boolean)* — Is the most recent CLOSED candle a strong move in the bias direction? True if it is engulfing (body engulfs prior body in bias direction) OR solid (body ≥60% of range, in bias direction). False otherwise.

5. **red_flags** *(array of strings)* — Any of:
   - `"choppy_structure"` — last 5–10 candles overlap with no clear direction
   - `"doji_cluster"` — multiple small-body candles nearby
   - `"zone_pierced_decisively"` — price blew through the EMA band instead of rejecting
   - `"news_spike"` — abnormal candle ~3×+ average range
   - `"counter_trend_pressure"` — visible recent move against the bias direction

6. **score** *(integer 0–10)* — Quality of this moment as an entry into the {HTF_BIAS} bias. 10 = textbook entry; 8 = take it; <8 = wait.

7. **reasoning** *(string ≤200 chars)* — One sentence explaining the score, naming which signals fired.

### Output format

```json
{
  "angle_ok": bool,
  "zone_rejection": bool,
  "coc_present": bool,
  "strong_candle_in_bias": bool,
  "red_flags": [],
  "score": 0,
  "reasoning": "..."
}
```

Downstream computes:
`pass = (angle_ok + zone_rejection + coc_present + strong_candle_in_bias) >= 2 AND red_flags.length === 0 AND score >= 8`
