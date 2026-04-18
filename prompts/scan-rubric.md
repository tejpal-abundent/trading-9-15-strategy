You are reviewing a {SYMBOL} {TIMEFRAME} chart for a trade setup.

The chart has two key indicators visible:
- **EMA9** (orange line)
- **EMA15** (purple line)

Your job — read the chart and grade it. Return **pure JSON only** (no prose, no markdown fences).

### Step 1 — Decide the direction yourself

Look at the slope of EMA9 and EMA15 over the last several bars on this chart:

- If **both EMAs are sloping UP at a visibly steep angle (greater than ~40°) AND EMA9 is above EMA15** → direction is **"long"**
- If **both EMAs are sloping DOWN steeply (>40°) AND EMA9 is below EMA15** → direction is **"short"**
- If the slope is shallow, the EMAs are flat/crossed/tangled, or you can't tell — direction is **"none"** (no trade)

Set `direction` in the output to one of: `"long"`, `"short"`, or `"none"`.

If `direction === "none"`, set every other field to false/null/empty and `score = 0`. Don't try to grade further.

### Step 2 — If direction is long or short, grade the entry

3. **angle_ok** *(boolean)* — Are the EMA9 and EMA15 slopes confirmed > 40° in the chosen direction? (If you set direction to long/short you've already implicitly answered this — confirm here too.)

4. **price_at_zone** *(boolean)* — Is the most recent price action sitting on or just leaving the EMA9-EMA15 band (a pullback into the zone)? If price is far away or never touched, false.

5. **coc_present** *(boolean)* — Change of Character: has a recent swing high (for longs) or swing low (for shorts) just been broken in the trade direction? False if structure is undecided.

6. **confirm_candle** *(one of "engulfing" | "solid" | "rejection" | null)* — Is the most recent CLOSED candle:
   - `"engulfing"` — body fully engulfs prior candle's body in trade direction
   - `"solid"` — body ≥ 60% of total range in trade direction
   - `"rejection"` — hammer (longs) / shooting-star (shorts) with long wick against the trade
   - `null` if none cleanly match

7. **red_flags** *(array of strings)* — Any of:
   - `"choppy_structure"` — last 5-10 candles overlap with no clear direction
   - `"doji_cluster"` — multiple small-body candles nearby
   - `"zone_pierced_decisively"` — price blew through EMA band instead of rejecting
   - `"news_spike"` — abnormal candle (~3×+ average range)
   - `"tangled_emas"` — EMA9 and EMA15 crossing back-and-forth (no clean trend)

8. **score** *(integer 0–10)* — Would a skilled discretionary trader take this entry now? 10 = textbook; 7 = acceptable; <7 = skip.

9. **reasoning** *(string ≤ 200 chars)* — One sentence explaining your score.

### Output format

```json
{
  "direction": "long" | "short" | "none",
  "angle_ok": bool,
  "price_at_zone": bool,
  "coc_present": bool,
  "confirm_candle": "engulfing" | "solid" | "rejection" | null,
  "red_flags": [],
  "score": 0,
  "reasoning": "..."
}
```

Downstream computes:  
`confirm = direction !== "none" AND angle_ok AND price_at_zone AND coc_present AND confirm_candle !== null AND red_flags.length === 0 AND score >= 7`
