You are grading a {SYMBOL} {TIMEFRAME} chart for a trade setup.

**Higher-timeframe bias (from numeric analysis):** {DIRECTION}
(meaning Monthly + Weekly + Daily EMA9/EMA15 all aligned this way)

The chart shows:
- Orange line = EMA(9)
- Purple line = EMA(15)
- Blue line = EMA(200)

A numeric filter has already confirmed price is currently inside the EMA9-EMA15 zone on this timeframe. Your job is to grade the quality of the potential entry.

Grade each of the following and return **pure JSON only** (no prose, no markdown fences):

1. **angle_ok** *(boolean)* — After touching the EMA9-15 zone, is price rejecting it at a visibly steep angle (greater than ~40° to your eye) in the direction of `{DIRECTION}`? If it's drifting sideways or the slope is shallow, answer false.

2. **coc_present** *(boolean)* — Is there a Change of Character on this timeframe in favour of `{DIRECTION}`?
   - Bullish CoC = a recent swing high has just been broken (price pushing up after a downtrend)
   - Bearish CoC = a recent swing low has just been broken
   Answer false if structure is undecided or the break hasn't happened yet.

3. **confirm_candle** *(one of "engulfing" | "solid" | "rejection" | null)* — Is the most recent closed candle one of:
   - `"engulfing"` — body fully engulfs the prior candle's body in direction of `{DIRECTION}`
   - `"solid"` — body is ≥60% of total range, in direction of `{DIRECTION}`
   - `"rejection"` — hammer (for longs) or shooting-star (for shorts) with long wick against the trade
   If none of the above cleanly match, return `null`.

4. **red_flags** *(array of strings)* — List any of the following that apply:
   - `"choppy_structure"` — last 5-10 candles are overlapping with no clear direction
   - `"doji_cluster"` — multiple small-body candles nearby
   - `"against_htf"` — the visible price action contradicts the stated `{DIRECTION}`
   - `"zone_pierced_decisively"` — price blew through the EMA9-15 zone instead of rejecting it
   - `"news_spike"` — an obvious abnormal candle (e.g., 3×+ the average range)
   Empty array `[]` if none apply.

5. **score** *(integer, 0-10)* — Overall, would a skilled discretionary trader take this setup right now? 10 = textbook; 7 = acceptable; <7 = skip.

6. **reasoning** *(string, ≤200 chars)* — One sentence summary explaining your score.

**Decision rule (computed downstream — don't include in your output):**
`confirm = angle_ok AND coc_present AND confirm_candle !== null AND red_flags.length === 0 AND score >= 7`

Return only the raw JSON object with fields: `angle_ok`, `coc_present`, `confirm_candle`, `red_flags`, `score`, `reasoning`.
