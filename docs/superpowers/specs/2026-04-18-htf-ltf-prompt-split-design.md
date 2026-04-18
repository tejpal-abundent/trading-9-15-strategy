# HTF + LTF Prompt Split — Multi-Timeframe Trading Bot

**Date:** 2026-04-18
**Status:** Approved design
**Owner:** tejpal@buildfactory.io

## Problem

Today the trading bot uses a single rubric (`prompts/scan-rubric.md`) for every timeframe (1M, 1W, 1D, 4H, 2H, 1H). The rubric asks Gemini to *both* derive direction *and* grade an entry on every chart, regardless of whether the timeframe is for trend identification (high) or entry timing (low). This conflates two different jobs:

- **Higher timeframes** answer "is there a tradeable trend here, and which direction?"
- **Lower timeframes** answer "given a known trend direction, is *this moment* a clean entry?"

Using the same rubric for both wastes signal: the LTF call independently grades direction (often disagreeing with HTF) instead of focusing on entry confirmation. It also wastes spend: every HTF disagreement still triggers full 6-TF Gemini calls.

## Goal

Split the rubric into two purpose-built prompts and run them through a sequential, fail-fast pipeline that:

1. Establishes trend bias from HTFs (1M, 1W, 1D) using a dedicated *bias rubric*
2. Stops immediately if the HTFs disagree or fail quality bars (saving LLM spend)
3. For Binance symbols, cross-checks HTF bias against a numeric EMA9/15 alignment from real candles
4. Looks for entry confirmation on LTFs (4H, 2H, 1H) using a dedicated *entry rubric* that is **told the HTF bias** and only checks for confirmation in that direction
5. Reports every LTF that triggers, leaving the final entry choice to the trader

## Design

### Two prompts

#### `prompts/htf-bias.md`
Used for 1M, 1W, 1D. Inputs: `{SYMBOL}`, `{TIMEFRAME}`, chart screenshot.

Returns JSON:
```json
{
  "direction": "long" | "short" | "none",
  "slope_ok": bool,            // EMA9 + EMA15 slope > 40°
  "pullback_present": bool,    // price has pulled into EMA9-EMA15 band
  "ema_stack_ok": bool,        // EMA9 above EMA15 for long, below for short
  "score": 0..10,
  "red_flags": [],
  "reasoning": "..."
}
```

#### `prompts/ltf-entry.md`
Used for 4H, 2H, 1H. Inputs: `{SYMBOL}`, `{TIMEFRAME}`, `{HTF_BIAS}` (long|short), chart screenshot.

The prompt tells Gemini explicitly: "HTF bias is **{HTF_BIAS}**. Look only for entry confirmation in that direction. Do not grade the trend itself."

Returns JSON:
```json
{
  "zone_rejection": bool,         // price touched and rejected EMA9-15 band
  "coc_present": bool,            // change-of-character break in HTF direction
  "strong_candle_in_bias": bool,  // last closed candle is engulfing/solid in HTF direction
  "score": 0..10,
  "red_flags": [],
  "reasoning": "..."
}
```

Entry passes when: `(zone_rejection + coc_present + strong_candle_in_bias) >= 2 AND score >= 8`.

### Per-symbol flow

```
1. setSymbol(SYMBOL)
2. For each HTF in [1M, 1W, 1D]:
     setTimeframe + screenshot + askGeminiVision(htf-bias)
     if cell.direction == "none"             → STOP (no_trend)
     if cell.score < 6                       → STOP (htf_quality_low)
     if previous HTFs exist and dir != prev  → STOP (htf_disagree)
3. avg_score = mean(htf_cells.score)
   if avg_score < 7                          → STOP (htf_avg_low)
   htfBias = htf_cells[0].direction
4. If symbol.binance_symbol is set:
     fetch 1M/1W/1D candles via existing higher-tf.js
     compute numericDir = agree(emaAlignment(M), emaAlignment(W), emaAlignment(D))
     // numericDir is "bullish" | "bearish" | null (using existing helpers)
     map "bullish" → "long", "bearish" → "short"
     if numericDir is null OR != htfBias     → STOP (numeric_disagree)
5. For each LTF in [4H, 2H, 1H]:
     setTimeframe + screenshot
     askGeminiVision(ltf-entry, HTF_BIAS=htfBias)
     pass = (signals_count >= 2) AND (score >= 8)
6. triggers = [ltf for ltf in ltf_cells if ltf.pass]
   Report ALL triggering LTFs (0..3 per symbol).
```

### Modes

- `--scan` — loops the per-symbol flow over `watchlist.json`. Replaces the old 1H/2H/4H-only scan.
- `--deep <SYMBOL>` — same flow on one symbol with verbose console output.
- `--tax-summary`, `--test-visual` — unchanged.

### Output schema

Per symbol, saved to `scan-results/{scan|deep}-{label}-{ts}.json`:

```json
{
  "symbol": "EURUSD",
  "tv_symbol": "OANDA:EURUSD",
  "started_at": "2026-04-18T...",
  "stopped_at": "1W",                    // null if reached LTF stage
  "stop_reason": "htf_disagree",         // null if completed
  "htf_cells": [
    {
      "tf": "1M",
      "direction": "long",
      "slope_ok": true,
      "pullback_present": true,
      "ema_stack_ok": true,
      "score": 8,
      "red_flags": [],
      "reasoning": "...",
      "image": "screenshots/EURUSD/1M.png"
    },
    { "tf": "1W", "direction": "short", "..." : "..." }
  ],
  "htf_avg_score": 7.33,
  "htf_bias": "long",                    // null if HTF gate failed
  "numeric_check": { "ran": true, "direction": "long", "agreed": true },
  "ltf_cells": [
    {
      "tf": "4H",
      "zone_rejection": true,
      "coc_present": true,
      "strong_candle_in_bias": false,
      "score": 8,
      "signals_count": 2,
      "pass": true,
      "red_flags": [],
      "reasoning": "...",
      "image": "screenshots/EURUSD/4H.png"
    }
  ],
  "triggers": ["4H"],                    // empty array = no entry
  "cost_usd": 0.0042
}
```

A `latest-{scan|deep}.json` is always overwritten alongside the timestamped file.

### Console summary (per symbol)

```
EURUSD  HTF: long (avg 7.3)  →  numeric: agree  →  triggers: [4H, 1H]
```

When a symbol stops early:
```
EURUSD  STOP @ 1W (htf_disagree)
```

### Stop reasons (single source of truth in `scanner.js`)

- `no_trend` — an HTF returned `direction: "none"`
- `htf_quality_low` — an HTF returned `score < 6`
- `htf_disagree` — an HTF direction differs from the previous HTF
- `htf_avg_low` — three HTFs agreed, but `avg(score) < 7`
- `numeric_disagree` — Binance numeric EMA direction != HTF bias
- `no_entry` — HTF passed, LTFs all failed entry conditions (this is "completed but no triggers", not a hard stop)

### File changes

**New:**
- `prompts/htf-bias.md`
- `prompts/ltf-entry.md`
- `tests/scanner-flow.test.mjs` — fixture-based unit tests for new flow logic (HTF gate decisions, fail-fast, LTF aggregation)

**Modified:**
- `src/scanner.js` — rewrite `runScan()` and `runDeepScan()` around new flow. New helpers: `evaluateHtfCell()`, `evaluateLtfCell(htfBias)`, `runNumericCrossCheck()`. Old `evaluateCell()` deleted.
- `bot.js` — no flag changes; just dispatches to new scanner functions.

**Deleted:**
- `prompts/scan-rubric.md` — replaced by the two new rubrics.

**Untouched:**
- `src/visual.js` — `askGeminiVision`, `fillRubric`, cost tracking unchanged.
- `src/tv-navigate.js` — chart navigation unchanged.
- `src/higher-tf.js` — Binance candle/EMA helpers reused for the numeric cross-check.
- `watchlist.json`, `rules.json`, `pine/mtf-helper.pine` — unchanged.

### Cost expectations

| Scenario | Gemini calls per symbol | Approx cost |
|----------|-------------------------|-------------|
| HTF disagrees on first pair (1M vs 1W) | 2 | ~$0.001 |
| HTF disagrees on 1D | 3 | ~$0.0015 |
| HTF passes, all 3 LTFs run | 6 | ~$0.003 |

For a 4-symbol watchlist where HTFs disagree on most symbols, expected cost is well under $0.01 per scan.

### Testing strategy

- **Unit tests** (`tests/scanner-flow.test.mjs`) — fixture inputs for `evaluateHtfCell` outputs, assert correct `stop_reason` and `htf_bias` decisions across all stop conditions plus the success path.
- **Integration test** — manual: run `node bot.js --deep EURUSD`, verify console output matches expected stop reason or trigger list, verify `scan-results/latest-deep.json` shape matches the schema above.
- **Live validation** — run `node bot.js --scan` against the 4-symbol watchlist; spot-check that screenshots saved for each cell match the timeframe label in the legend.

### Out of scope

- Adding a non-Binance numeric data source (OANDA, Yahoo, AlphaVantage) for forex/gold — visual gate remains the only check for those symbols.
- Changing the HTF/LTF timeframe sets (1M/1W/1D and 4H/2H/1H stay fixed).
- Order placement logic (BitGet integration is unchanged; this design only changes signal generation).
- Backtesting — Pine strategy in `pine/` is independent of this flow.
