You are reviewing a {SYMBOL} {TIMEFRAME} chart for **trend bias** (not entry).
This is a HIGHER timeframe — your job is to decide whether a tradeable trend exists, not to time an entry.

The chart has two key indicators visible:
- **EMA9** (orange line)
- **EMA15** (purple line)

Return **pure JSON only** (no prose, no markdown fences).

### Step 1 — Decide the direction yourself

Look at the slope of EMA9 and EMA15 over the last several bars:

- Both EMAs sloping UP at a visibly steep angle (>~40°) **AND** EMA9 above EMA15 → `"long"`
- Both EMAs sloping DOWN steeply (>~40°) **AND** EMA9 below EMA15 → `"short"`
- Slope shallow, EMAs flat/crossed/tangled, or unclear → `"none"`

If `direction === "none"`, set every other field to false/null/empty and `score = 0`. Do not grade further.

### Step 2 — Grade the bias structure

3. **slope_ok** *(boolean)* — EMA9 and EMA15 slopes confirmed >40° in the chosen direction.

4. **pullback_present** *(boolean)* — Has price recently pulled INTO the EMA9–EMA15 band (a healthy retracement, not an extended run away from it)? True if the last several candles touched or closed within the band.

5. **ema_stack_ok** *(boolean)* — EMA9 cleanly above EMA15 for long, below for short. False if they are crossing back and forth.

6. **red_flags** *(array of strings)* — Any of:
   - `"choppy_structure"` — last several HTF candles overlap with no clear direction
   - `"tangled_emas"` — EMA9/EMA15 cross back and forth recently
   - `"news_spike"` — abnormal candle ~3×+ average HTF range
   - `"extended"` — price is far from EMAs with no pullback

7. **score** *(integer 0–10)* — Quality of this HTF as the basis for a trend trade. 10 = textbook. 7 = acceptable. <6 = reject.

8. **reasoning** *(string ≤200 chars)* — One sentence explaining the score.

### Output format

```json
{
  "direction": "long" | "short" | "none",
  "slope_ok": bool,
  "pullback_present": bool,
  "ema_stack_ok": bool,
  "red_flags": [],
  "score": 0,
  "reasoning": "..."
}
```
