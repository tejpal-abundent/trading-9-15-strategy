# Reactive Trading State Machine

**Date:** 2026-04-18
**Status:** Approved (user delegated full autonomy after Q&A)

## Problem

The current bot is partially predictive: `probability_next_candle_in_bias` is a forecast, and the OR-door pass logic lets a cell pass purely on Gemini's prediction. The user's trading mantra is **reactive, not predictive** — react to what HAS happened, never bet on what WILL happen.

## Design

Two-phase state machine per LTF cell:

```
NONE   = no setup OR red_flags present OR prep_signals < 2
WATCH  = HTF passed
         AND prep_signals >= 2 of 4 (angle_ok, zone_rejection, coc_present, solid_continuation)
         AND red_flags empty
         AND strong_candle_in_bias = FALSE   ← confirmation NOT yet closed
ENTER  = same as WATCH, but
         strong_candle_in_bias = TRUE         ← confirmation candle JUST closed
```

- **`strong_candle_in_bias`** is the **trigger** (the difference between WATCH and ENTER), not a counted signal.
- **`probability_next_candle_in_bias`** is **kept as a ranker only** — when multiple ENTER triggers fire across symbols/TFs, we sort by probability descending. Never gates a decision.

## Per-symbol output

```json
{
  "symbol": "EURUSD",
  "htf_bias": "long",
  "watching": [{ "tf": "2H", "probability": 70, ...cell }],
  "triggers": [{ "tf": "1H", "probability": 78, ...cell }]
}
```

`triggers` and `watching` are sorted by `probability_next_candle_in_bias` desc.

## Console output

```
EURUSD  HTF: long (avg 7.7)  →  WATCH: [2H]  ENTER: [1H]
```

## Files changed

- `prompts/ltf-entry.md` — add reactive header; reframe `strong_candle_in_bias` as "the trigger"
- `prompts/htf-bias.md` — add reactive header (no behavior change)
- `src/scanner.js`:
  - Replace `ltfCellPass` → `ltfCellState` returning `"NONE" | "WATCH" | "ENTER"`
  - `evaluateLtfCell` computes state
  - `evaluateSymbol` tracks `watching` + `triggers` lists
  - `summaryLine` shows WATCH + ENTER separately
- `tests/scanner-flow.test.mjs` — replace pass tests with state tests
- No changes to `bot.js`, `tv-navigate.js`, `visual.js`, `higher-tf.js`, watchlist

## Stop reasons (HTF chain) — unchanged

`no_trend`, `htf_quality_low`, `htf_disagree` still apply.

## Out of scope

- Continuous polling / cron runner (separate work)
- Notification on WATCH→ENTER transition (separate work)
- Removing `probability_next_candle_in_bias` from the prompt (we keep it for ranking)
