You are reviewing a {SYMBOL} {TIMEFRAME} chart for **trend bias** (not entry).
This is a HIGHER timeframe — your job is to decide whether a tradeable trend exists, not to time an entry.

## Reactive principle

Grade what HAS happened on the visible chart. Do not predict what the next candle will do — describe what the EMAs and price are *currently showing*. A clean recent pullback that has already bounced + a valid stack are observed evidence, not forecasts.

The chart has two key indicators visible:
- **EMA9** (orange line)
- **EMA15** (purple line)

Return **pure JSON only** (no prose, no markdown fences).

### Step 0 — Identify the CURRENT candle FIRST

Before grading anything, locate the **rightmost candle** on the chart — this is the current/forming bar. The OHLC values at the top of the chart (e.g., "O 1.17xx H 1.17xx L 1.17xx C 1.17xx") refer to THIS candle, not any earlier one.

Compute and remember:
- `latest_candle.color` — green if Close > Open, red if Close < Open
- `latest_candle.position_vs_emas` — "above" / "between" / "below" the EMA9–EMA15 band
- `latest_candle.direction_vs_prior` — "up" / "down" / "flat" relative to the previous closed candle

This step is mandatory. All downstream grading must be consistent with the actual rightmost candle, NOT with a more dramatic candle further to the left.

### Step 1 — Decide the direction yourself

Look at how the EMAs have been moving over the **most recent 10–20 bars** (the rightmost portion of the chart):

- EMA9 above EMA15 **AND** both rising over the last ~10 bars → `"long"`
- EMA9 below EMA15 **AND** both falling over the last ~10 bars → `"short"`
- EMAs flat, tangled, or just changed direction with no commitment → `"none"`

If `direction === "none"`, set every other field to false/null/0/empty. Do not grade further.

### Step 2 — Identify the setup type

The chart can present a tradeable bias in **two distinct ways**:

- **`"pullback"`** — price has recently retraced INTO the EMA9–EMA15 band and just rejected away from it in the bias direction. This is the textbook entry setup: structure is clean, the bounce point is fresh.
- **`"continuation"`** — the pullback already happened earlier (visible to the left), and we're now seeing solid candles continuing in the bias direction with strong follow-through. Price may be extended from the EMAs but the momentum is alive. The next candle has elevated probability of going further in the bias direction.
- **`"none"`** — neither: price is choppy, EMAs are flattening, no clear pullback or follow-through.

Set `setup_type` to one of `"pullback"` | `"continuation"` | `"none"`. If `"none"`, set probability to ≤30 and skip the remaining grading work where reasonable.

### Step 3 — Grade the bias structure

3. **angle_ok** *(boolean)* — Measure the steepness of the EMA9/EMA15 line at the **most recent pullback turning point** (the swing low for longs, swing high for shorts). Mentally draw a horizontal line at that turning point and a tangent along the EMA forward from there. The angle must be **≥ 30–40°**. Don't measure the slope at the rightmost edge — measure where the EMA bounced off the pullback.

4. **pullback_present** *(boolean)* — True if a clean pullback into the EMA9–EMA15 band is visible *in recent history* (whether or not it's at the rightmost edge). Continuation setups still get `true` here if the pullback is visible; only `false` if there is no identifiable pullback at all in the recent visible chart.

5. **ema_stack_ok** *(boolean)* — EMA9 cleanly above EMA15 for long, below for short.

6. **solid_continuation** *(boolean)* — In the most recent 3–5 candles, are there visibly solid candles (large bodies, ≥60% body-to-range) closing in the bias direction with little upper/lower wick rejection against the trend? True for healthy momentum, false for weak/dragging price action.

7. **probability_next_candle_in_bias** *(integer 0–100)* — Your estimate of the probability that the **next candle** on this timeframe will close in the bias direction. Consider:
   - Strong trend + recent pullback bounce → 70–85
   - Strong trend + solid continuation candles → 70–80
   - Strong trend but no pullback and no recent solid candles (just extended) → 50–60
   - Trend exhaustion signals (doji at extreme, exhaustion gap) → 40–55
   - Choppy / no clear bias → ≤45

8. **red_flags** *(array of strings)* — Any of:
   - `"choppy_structure"` — last several HTF candles overlap with no clear direction
   - `"tangled_emas"` — EMA9/EMA15 cross back and forth recently
   - `"exhaustion"` — multiple long upper wicks (longs) or lower wicks (shorts), failure to follow through
   
   **Do NOT add a "news_spike" or "abnormal candle" flag at this timeframe.**
   Monthly and weekly candles aggregate many news events — a single large
   bullish month is normal trend behavior, not an anomaly. Big HTF candles
   in the trend direction are typically bullish/bearish *signal*, not noise.

9. **score** *(integer 0–10)* — Quality of this HTF as the basis for a trend trade, factoring in BOTH structure AND momentum. 10 = textbook. 7 = acceptable. <6 = reject.

10. **reasoning** *(string ≤200 chars)* — One sentence naming the setup type and the strongest 1–2 supporting signals.

### Output format

```json
{
  "latest_candle": {
    "color": "green" | "red",
    "position_vs_emas": "above" | "between" | "below",
    "direction_vs_prior": "up" | "down" | "flat"
  },
  "direction": "long" | "short" | "none",
  "setup_type": "pullback" | "continuation" | "none",
  "angle_ok": bool,
  "pullback_present": bool,
  "ema_stack_ok": bool,
  "solid_continuation": bool,
  "probability_next_candle_in_bias": 0,
  "red_flags": [],
  "score": 0,
  "reasoning": "..."
}
```

Downstream computes:
`pass = direction != "none" AND red_flags.length === 0 AND (score >= 7 OR probability_next_candle_in_bias >= 75)`
