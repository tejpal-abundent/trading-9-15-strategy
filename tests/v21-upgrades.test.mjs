import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bodyAtrGateSatisfied,
  roleGateSatisfied,
  validateCellConsistency,
  computeDailyTriggerType,
  dailyCellState,
  dailyTriggerType,
  deriveConfluence,
  formatWeeklyPoiList,
} from "../src/scanner.js";
import {
  clustersForLabel,
  clusterDedupe,
  directionFromResult,
} from "../src/clusters.js";

// ─── helpers ──────────────────────────────────────────────────────────────

function mkBar(over = {}) {
  return {
    color: "green",
    body_pct_of_range: 65,
    upper_wick_pct: 10,
    lower_wick_pct: 10,
    close_position: "upper_third",
    high_vs_prior_bar_high: "above",
    low_vs_prior_bar_low: "above",
    body_atr_mult: 0.9,
    role: "driver",
    pattern: "solid_bull",
    in_bias: true,
    ...over,
  };
}

function mkMeasurements(over = {}) {
  return {
    prior_bar: { color: "red", body_pct_of_range: 50, high_relative_to_ema_band: "inside" },
    current_closed_bar: {
      color: "green",
      body_pct_of_range: 70,
      upper_wick_pct: 10,
      lower_wick_pct: 10,
      close_position: "at_high",
      high_vs_prior_bar_high: "above",
      low_vs_prior_bar_low: "below",
      body_atr_mult: 1.0,
    },
    forming_bar: { color: "green", progress_pct: 30 },
    ema_state: {
      ema9_above_ema15: true,
      ema9_ema15_distance: "normal",
      slope_direction: "up",
      slope_steepness: "medium",
      atr14_visible: 100,
    },
    recent_5_bars: { direction: "up", overlap_pct: 20 },
    last_5_candles: [
      mkBar({ role: "pause", body_pct_of_range: 30, body_atr_mult: 0.4 }),
      mkBar({ role: "pullback", color: "red" }),
      mkBar({ role: "sweep", color: "red", high_vs_prior_bar_high: "above", low_vs_prior_bar_low: "below" }),
      mkBar({ role: "rejection", body_pct_of_range: 40, upper_wick_pct: 50, lower_wick_pct: 5 }),
      mkBar({ role: "driver" }),
    ],
    ...over,
  };
}

function mkDaily(over = {}) {
  return {
    direction_conflict: false,
    setup_type: "pullback",
    angle_ok: true,
    zone_rejection: true,
    coc_present: false,
    solid_continuation: false,
    prep_signals_count: 2,
    red_flags: [],
    candle_verdict: {
      body_pct_of_range: 70,
      upper_wick_pct: 10,
      lower_wick_pct: 10,
      close_position: "at_high",
      winner: "buyers",
      winner_strength: 8,
      liquidity_swept: "none",
      pattern: "solid_bull",
      in_bias: true,
      verdict: "decisive bullish close",
    },
    measurements: mkMeasurements(),
    ...over,
  };
}

function mkWeekly(over = {}) {
  return { direction: "long", score: 8, red_flags: [], pullback_present: true,
    measurements: { ema_state: { ema9_above_ema15: true, ema9_ema15_distance: "wide", slope_direction: "up", slope_steepness: "steep" } },
    ...over };
}

function mkMonthly(over = {}) {
  return { direction: "long", in_9_15_zone: true, move_maturity: "mid",
    measurements: { ema_state: { ema9_above_ema15: true, ema9_ema15_distance: "wide", slope_direction: "up", slope_steepness: "steep" } },
    ...over };
}

// ─── bodyAtrGateSatisfied ────────────────────────────────────────────────

test("bodyAtrGateSatisfied: missing bar → true", () => {
  assert.equal(bodyAtrGateSatisfied(null), true);
});

test("bodyAtrGateSatisfied: missing body_atr_mult → true (legacy passthrough)", () => {
  assert.equal(bodyAtrGateSatisfied({ body_pct_of_range: 70 }), true);
});

test("bodyAtrGateSatisfied: body_atr_mult 0.7 ≥ 0.6 default → true", () => {
  assert.equal(bodyAtrGateSatisfied({ body_atr_mult: 0.7 }), true);
});

test("bodyAtrGateSatisfied: body_atr_mult 0.4 < 0.6 default → false", () => {
  assert.equal(bodyAtrGateSatisfied({ body_atr_mult: 0.4 }), false);
});

test("bodyAtrGateSatisfied: custom threshold 0.8 enforced", () => {
  assert.equal(bodyAtrGateSatisfied({ body_atr_mult: 0.7 }, 0.8), false);
  assert.equal(bodyAtrGateSatisfied({ body_atr_mult: 0.9 }, 0.8), true);
});

// ─── roleGateSatisfied ───────────────────────────────────────────────────

test("roleGateSatisfied: sweep with wick above prior high → true", () => {
  assert.equal(roleGateSatisfied("sweep", { high_vs_prior_bar_high: "above", low_vs_prior_bar_low: "above" }), true);
});

test("roleGateSatisfied: sweep with no wick beyond prior bar → false", () => {
  assert.equal(roleGateSatisfied("sweep", { high_vs_prior_bar_high: "below", low_vs_prior_bar_low: "above" }), false);
});

test("roleGateSatisfied: rejection with 60% upper wick + small body → true", () => {
  assert.equal(roleGateSatisfied("rejection", { upper_wick_pct: 60, lower_wick_pct: 5, body_pct_of_range: 30 }), true);
});

test("roleGateSatisfied: rejection with no dominant wick → false", () => {
  assert.equal(roleGateSatisfied("rejection", { upper_wick_pct: 10, lower_wick_pct: 10, body_pct_of_range: 70 }), false);
});

test("roleGateSatisfied: driver with body 60% + atr 0.7 → true", () => {
  assert.equal(roleGateSatisfied("driver", { body_pct_of_range: 60, body_atr_mult: 0.7 }), true);
});

test("roleGateSatisfied: driver with body 60% but atr 0.3 → false", () => {
  assert.equal(roleGateSatisfied("driver", { body_pct_of_range: 60, body_atr_mult: 0.3 }), false);
});

test("roleGateSatisfied: driver with small body → false", () => {
  assert.equal(roleGateSatisfied("driver", { body_pct_of_range: 30, body_atr_mult: 0.7 }), false);
});

test("roleGateSatisfied: inside bar with valid range → true", () => {
  assert.equal(roleGateSatisfied("inside", { high_vs_prior_bar_high: "below", low_vs_prior_bar_low: "above" }), true);
});

test("roleGateSatisfied: inside bar that broke prior high → false", () => {
  assert.equal(roleGateSatisfied("inside", { high_vs_prior_bar_high: "above", low_vs_prior_bar_low: "above" }), false);
});

test("roleGateSatisfied: pause / pullback / reversal → always true (softly typed)", () => {
  assert.equal(roleGateSatisfied("pause", { body_pct_of_range: 5 }), true);
  assert.equal(roleGateSatisfied("pullback", {}), true);
  assert.equal(roleGateSatisfied("reversal", {}), true);
});

// ─── validateCellConsistency: ATR clamp on solid_* + winner_strength ──────

test("validateCellConsistency: solid_bull with body_atr_mult 0.4 → pattern dropped to none", () => {
  const cell = mkDaily({
    candle_verdict: {
      body_pct_of_range: 70, upper_wick_pct: 10, lower_wick_pct: 10,
      close_position: "at_high", winner: "buyers", winner_strength: 7,
      liquidity_swept: "none", pattern: "solid_bull", in_bias: true, verdict: "x",
    },
    measurements: mkMeasurements({
      current_closed_bar: { ...mkMeasurements().current_closed_bar, body_atr_mult: 0.4 },
    }),
  });
  validateCellConsistency(cell, "long");
  assert.equal(cell.candle_verdict.pattern, "none");
  assert.ok((cell.consistency_log ?? []).some((l) => l.includes("body_atr_mult")));
});

test("validateCellConsistency: winner_strength 9 with body_atr_mult 0.7 → clamped to 7", () => {
  // V2.5 — clamp to 7 (was 5). 8+ implies elite expansion bar that needs ATR
  // backing, but 7 is the "decisive close at extreme" floor that body% +
  // close-position alone earn. Previous clamp to 5 killed the strong-trigger
  // override on slightly-sub-ATR bars where the close was textbook.
  const cell = mkDaily({
    candle_verdict: {
      body_pct_of_range: 70, upper_wick_pct: 10, lower_wick_pct: 10,
      close_position: "at_high", winner: "buyers", winner_strength: 9,
      liquidity_swept: "none", pattern: "engulfing_bull", in_bias: true, verdict: "x",
    },
    measurements: mkMeasurements({
      current_closed_bar: { ...mkMeasurements().current_closed_bar, body_atr_mult: 0.7 },
    }),
  });
  validateCellConsistency(cell, "long");
  assert.equal(cell.candle_verdict.winner_strength, 7);
});

test("validateCellConsistency: winner_strength 9 with body_atr_mult 0.9 → kept", () => {
  const cell = mkDaily({
    candle_verdict: {
      body_pct_of_range: 70, upper_wick_pct: 10, lower_wick_pct: 10,
      close_position: "at_high", winner: "buyers", winner_strength: 9,
      liquidity_swept: "none", pattern: "engulfing_bull", in_bias: true, verdict: "x",
    },
    measurements: mkMeasurements({
      current_closed_bar: { ...mkMeasurements().current_closed_bar, body_atr_mult: 0.9 },
    }),
  });
  validateCellConsistency(cell, "long");
  assert.equal(cell.candle_verdict.winner_strength, 9);
});

// ─── validateCellConsistency: per-bar role gate on last_5_candles ─────────

test("validateCellConsistency: unbacked sweep role downgraded to pause", () => {
  const m = mkMeasurements();
  m.last_5_candles[2] = mkBar({
    role: "sweep",
    high_vs_prior_bar_high: "below",
    low_vs_prior_bar_low: "above",
  });
  const cell = mkDaily({ measurements: m });
  validateCellConsistency(cell, "long");
  assert.equal(cell.measurements.last_5_candles[2].role, "pause");
});

test("validateCellConsistency: backed sweep role kept", () => {
  const m = mkMeasurements();
  // last_5_candles[2] already has role:'sweep' with valid wick
  const cell = mkDaily({ measurements: m });
  validateCellConsistency(cell, "long");
  assert.equal(cell.measurements.last_5_candles[2].role, "sweep");
});

// ─── validateCellConsistency: competition.sweep_then_displacement gate ────

test("validateCellConsistency: sweep_then_displacement requires last_5[-2].role==sweep", () => {
  const m = mkMeasurements();
  m.last_5_candles[3].role = "pause"; // -2 should be sweep but isn't
  const cell = mkDaily({ measurements: m, competition: { sweep_then_displacement: true } });
  validateCellConsistency(cell, "long");
  assert.equal(cell.competition.sweep_then_displacement, false);
});

test("validateCellConsistency: sweep_then_displacement with low body_atr_mult → dropped", () => {
  const m = mkMeasurements({
    current_closed_bar: { ...mkMeasurements().current_closed_bar, body_atr_mult: 0.3 },
  });
  m.last_5_candles[3].role = "sweep"; // index -2 = position 3 (5 bars indexed 0..4)
  m.last_5_candles[3].high_vs_prior_bar_high = "above";
  const cell = mkDaily({ measurements: m, competition: { sweep_then_displacement: true } });
  validateCellConsistency(cell, "long");
  assert.equal(cell.competition.sweep_then_displacement, false);
});

test("validateCellConsistency: sweep_then_displacement honored when both gates pass", () => {
  const m = mkMeasurements();
  // index -2 of a 5-element array is index 3 → make it a valid sweep
  m.last_5_candles[3] = mkBar({ role: "sweep", high_vs_prior_bar_high: "above", low_vs_prior_bar_low: "above" });
  const cell = mkDaily({ measurements: m, competition: { sweep_then_displacement: true } });
  validateCellConsistency(cell, "long");
  assert.equal(cell.competition.sweep_then_displacement, true);
});

// ─── validateCellConsistency: trade_plan rr_ratio recomputation ───────────

test("validateCellConsistency: trade_plan rr_ratio drift > 10% gets recomputed", () => {
  const cell = mkDaily({
    trade_plan: { entry_price_approx: 100, invalidation_level: 95, target_level: 115,
      invalidation_basis: "trigger_low", target_basis: "prior_swing_high",
      risk_atr: 1.0, reward_atr: 3.0, rr_ratio: 1.5 }, // claims 1.5 but is 3.0
  });
  validateCellConsistency(cell, "long");
  assert.equal(cell.trade_plan.rr_ratio, 3);
});

test("validateCellConsistency: trade_plan with risk_atr ≤ 0 → rr_ratio stripped", () => {
  const cell = mkDaily({
    trade_plan: { entry_price_approx: 100, invalidation_level: 100, target_level: 110,
      invalidation_basis: "trigger_low", target_basis: "prior_swing_high",
      risk_atr: 0, reward_atr: 1.0, rr_ratio: 99 },
  });
  validateCellConsistency(cell, "long");
  assert.equal(cell.trade_plan.rr_ratio, undefined);
});

// ─── computeDailyTriggerType ──────────────────────────────────────────────

test("computeDailyTriggerType: sweep_then_displacement is highest tier", () => {
  const cell = {
    competition: { sweep_then_displacement: true },
    candle_verdict: { liquidity_swept: "below_prior_low", pattern: "solid_bull" },
  };
  assert.equal(computeDailyTriggerType(cell, "long"), "sweep_displacement");
});

test("computeDailyTriggerType: sweep when no displacement", () => {
  const cell = {
    competition: { sweep_then_displacement: false },
    candle_verdict: { liquidity_swept: "below_prior_low", pattern: "none" },
  };
  assert.equal(computeDailyTriggerType(cell, "long"), "sweep");
});

test("computeDailyTriggerType: pattern → pattern", () => {
  const cell = {
    competition: { sweep_then_displacement: false },
    candle_verdict: { liquidity_swept: "none", pattern: "engulfing_bull" },
  };
  assert.equal(computeDailyTriggerType(cell, "long"), "pattern");
});

test("computeDailyTriggerType: solid_bull → momentum", () => {
  const cell = {
    competition: { sweep_then_displacement: false },
    candle_verdict: { liquidity_swept: "none", pattern: "solid_bull" },
  };
  assert.equal(computeDailyTriggerType(cell, "long"), "momentum");
});

test("computeDailyTriggerType: missing bias → none", () => {
  assert.equal(computeDailyTriggerType({ candle_verdict: {} }, "none"), "none");
});

// ─── dailyCellState: RR gate ──────────────────────────────────────────────

test("dailyCellState: ENTER candidate with rr_ratio 1.4 + non-strong trigger → WATCH (2.0 floor)", () => {
  // V2.5 — RR gate floor depends on whether strong-trigger fires.
  // mkDaily defaults to a candle that DOES trigger the override
  // (solid_bull, ws=8, body=70, close at_high, in_bias) — so we strip the
  // pattern here to drop into the standard 2.0 RR floor.
  const monthly = mkMonthly();
  const weekly = mkWeekly();
  const cell = mkDaily({
    candle_verdict: { ...mkDaily().candle_verdict, pattern: "none" },
    trade_plan: { risk_atr: 1, reward_atr: 1.4, rr_ratio: 1.4 },
  });
  assert.equal(dailyCellState(cell, monthly, weekly), "WATCH");
});

test("dailyCellState: strong-trigger candle with rr_ratio 1.5 → ENTER (relaxed floor)", () => {
  // V2.5 — strong-trigger override relaxes RR floor 2.0 → 1.5.
  const monthly = mkMonthly();
  const weekly = mkWeekly();
  const cell = mkDaily({ trade_plan: { risk_atr: 1, reward_atr: 1.5, rr_ratio: 1.5 } });
  assert.equal(dailyCellState(cell, monthly, weekly), "ENTER");
});

test("dailyCellState: strong-trigger candle with rr_ratio 1.0 → ENTER (relaxed floor 1.0)", () => {
  const monthly = mkMonthly();
  const weekly = mkWeekly();
  const cell = mkDaily({ trade_plan: { risk_atr: 1, reward_atr: 1.0, rr_ratio: 1.0 } });
  assert.equal(dailyCellState(cell, monthly, weekly), "ENTER");
});

test("dailyCellState: strong-trigger candle with rr_ratio 0.9 → WATCH (below 1.0 floor)", () => {
  const monthly = mkMonthly();
  const weekly = mkWeekly();
  const cell = mkDaily({ trade_plan: { risk_atr: 1, reward_atr: 0.9, rr_ratio: 0.9 } });
  assert.equal(dailyCellState(cell, monthly, weekly), "WATCH");
});

test("dailyCellState: ENTER candidate with rr_ratio 2.5 → ENTER", () => {
  const monthly = mkMonthly();
  const weekly = mkWeekly();
  const cell = mkDaily({ trade_plan: { risk_atr: 1, reward_atr: 2.5, rr_ratio: 2.5 } });
  assert.equal(dailyCellState(cell, monthly, weekly), "ENTER");
});

test("dailyCellState: ENTER candidate with no trade_plan → ENTER (legacy fall-through)", () => {
  const monthly = mkMonthly();
  const weekly = mkWeekly();
  const cell = mkDaily(); // no trade_plan
  assert.equal(dailyCellState(cell, monthly, weekly), "ENTER");
});

// ─── dailyCellState: move-maturity guard ──────────────────────────────────

test("dailyCellState: late monthly + momentum trigger → WATCH (not ENTER)", () => {
  const monthly = mkMonthly({ move_maturity: "late" });
  const weekly = mkWeekly();
  const cell = mkDaily({
    candle_verdict: {
      body_pct_of_range: 70, upper_wick_pct: 10, lower_wick_pct: 10,
      close_position: "at_high", winner: "buyers", winner_strength: 8,
      liquidity_swept: "none", pattern: "solid_bull", in_bias: true, verdict: "x",
    },
    trade_plan: { risk_atr: 1, reward_atr: 3, rr_ratio: 3 },
  });
  assert.equal(dailyCellState(cell, monthly, weekly), "WATCH");
});

test("dailyCellState: late monthly + sweep trigger → ENTER (reversals OK at extension)", () => {
  const monthly = mkMonthly({ move_maturity: "late" });
  const weekly = mkWeekly();
  const m = mkMeasurements();
  m.last_5_candles[3] = mkBar({ role: "sweep", high_vs_prior_bar_high: "above", low_vs_prior_bar_low: "above" });
  const cell = mkDaily({
    measurements: m,
    candle_verdict: {
      body_pct_of_range: 70, upper_wick_pct: 5, lower_wick_pct: 30,
      close_position: "upper_third", winner: "buyers", winner_strength: 8,
      liquidity_swept: "below_prior_low", pattern: "hammer", in_bias: true, verdict: "x",
    },
    competition: { sweep_then_displacement: true },
    trade_plan: { risk_atr: 1, reward_atr: 3, rr_ratio: 3 },
  });
  assert.equal(dailyCellState(cell, monthly, weekly), "ENTER");
});

test("dailyCellState: exhausted monthly + momentum → WATCH", () => {
  const monthly = mkMonthly({ move_maturity: "exhausted" });
  const weekly = mkWeekly();
  const cell = mkDaily({
    candle_verdict: {
      body_pct_of_range: 70, upper_wick_pct: 10, lower_wick_pct: 10,
      close_position: "at_high", winner: "buyers", winner_strength: 8,
      liquidity_swept: "none", pattern: "solid_bull", in_bias: true, verdict: "x",
    },
    trade_plan: { risk_atr: 1, reward_atr: 3, rr_ratio: 3 },
  });
  assert.equal(dailyCellState(cell, monthly, weekly), "WATCH");
});

// ─── deriveConfluence: POI + RR boosts ────────────────────────────────────

test("deriveConfluence: A+ requires POI count ≥ 2", () => {
  const monthly = mkMonthly();
  const weekly = mkWeekly();
  const daily = {
    state: "ENTER", direction_conflict: false, trigger_type: "sweep",
    poi_confluence: { count: 1 },
    trade_plan: { rr_ratio: 4 },
  };
  // A+ blocked by POI=1 (needs 2), A+ requires RR≥3 (have 4 ✓), monthly.in_9_15_zone ✓.
  // Falls through to A (POI≥1 ✓, RR≥2.5 ✓, weekly.score≥8 ✓).
  assert.equal(deriveConfluence(monthly, weekly, daily), "A");
});

test("deriveConfluence: A+ when POI=2 + RR=3", () => {
  const monthly = mkMonthly();
  const weekly = mkWeekly();
  const daily = {
    state: "ENTER", direction_conflict: false, trigger_type: "sweep_displacement",
    poi_confluence: { count: 3 },
    trade_plan: { rr_ratio: 4 },
  };
  assert.equal(deriveConfluence(monthly, weekly, daily), "A+");
});

test("deriveConfluence: A drops to B when POI=0", () => {
  const monthly = mkMonthly({ in_9_15_zone: false });
  const weekly = mkWeekly();
  const daily = {
    state: "ENTER", direction_conflict: false, trigger_type: "pattern",
    poi_confluence: { count: 0 },
    trade_plan: { rr_ratio: 4 },
  };
  assert.equal(deriveConfluence(monthly, weekly, daily), "B");
});

test("deriveConfluence: legacy cells (no poi_confluence, no trade_plan) grade as before", () => {
  const monthly = mkMonthly();
  const weekly = mkWeekly();
  const daily = { state: "ENTER", direction_conflict: false, trigger_type: "sweep" };
  // No POI/RR → both gates default to satisfied → A+ (matches legacy)
  assert.equal(deriveConfluence(monthly, weekly, daily), "A+");
});

// ─── formatWeeklyPoiList ──────────────────────────────────────────────────

test("formatWeeklyPoiList: empty array → 'none'", () => {
  assert.equal(formatWeeklyPoiList([]), "none");
});

test("formatWeeklyPoiList: undefined → 'none'", () => {
  assert.equal(formatWeeklyPoiList(undefined), "none");
});

test("formatWeeklyPoiList: formats kind + description + ATR distance", () => {
  const out = formatWeeklyPoiList([
    { kind: "swing_low", level_description: "low from 8 weeks", distance_to_current_close_atr: -1.2 },
    { kind: "order_block", level_description: "OB at 1.0850", distance_to_current_close_atr: 0.5 },
  ]);
  assert.match(out, /swing_low/);
  assert.match(out, /order_block/);
  assert.match(out, /-1\.20 ATR/);
  assert.match(out, /\+0\.50 ATR/);
});

// ─── clusters.js: clustersForLabel ────────────────────────────────────────

test("clustersForLabel: EURUSD → both fx_EUR + fx_USD", () => {
  assert.deepEqual(clustersForLabel("EURUSD"), ["fx_EUR", "fx_USD"]);
});

test("clustersForLabel: BTCUSDT → crypto_majors", () => {
  assert.deepEqual(clustersForLabel("BTCUSDT"), ["crypto_majors"]);
});

test("clustersForLabel: SOLUSDT → crypto_l1_alts", () => {
  assert.deepEqual(clustersForLabel("SOLUSDT"), ["crypto_l1_alts"]);
});

test("clustersForLabel: XAUUSD → idx_precious_metals (NOT crypto base)", () => {
  // ensures the precious-metals lookup wins over the crypto quote-strip.
  assert.deepEqual(clustersForLabel("XAUUSD"), ["idx_precious_metals"]);
});

test("clustersForLabel: TSLA → equity_ev_auto", () => {
  assert.deepEqual(clustersForLabel("TSLA"), ["equity_ev_auto"]);
});

test("clustersForLabel: AAPL → equity_mega_tech", () => {
  assert.deepEqual(clustersForLabel("AAPL"), ["equity_mega_tech"]);
});

test("clustersForLabel: USOIL → idx_energy", () => {
  assert.deepEqual(clustersForLabel("USOIL"), ["idx_energy"]);
});

test("clustersForLabel: unknown 4-letter ticker → solo bucket (no FX/crypto match)", () => {
  assert.deepEqual(clustersForLabel("ZZZZ"), ["solo_ZZZZ"]);
});

test("clustersForLabel: TVC: prefix stripped", () => {
  assert.deepEqual(clustersForLabel("TVC:USOIL"), ["idx_energy"]);
});

// ─── clusters.js: clusterDedupe ───────────────────────────────────────────

function mkCandidate(symbol, grade, rr, dir = "long") {
  return {
    symbol,
    confluence_grade: grade,
    weekly: { direction: dir },
    monthly: { direction: dir },
    daily: { trade_plan: { rr_ratio: rr }, probability_next_candle_in_bias: 60 },
  };
}

test("clusterDedupe: 4 EUR longs A/A/B/C → keeps top 2 by grade", () => {
  const results = [
    mkCandidate("EURUSD", "A", 3),
    mkCandidate("EURGBP", "A", 2.5),
    mkCandidate("EURJPY", "B", 2.0),
    mkCandidate("EURCAD", "C", 2.0),
  ];
  const out = clusterDedupe(results, { keep: 2 });
  const kept = out.filter((r) => r.cluster_decision?.kept);
  const dropped = out.filter((r) => r.cluster_decision?.kept === false);
  assert.equal(kept.length, 2);
  assert.equal(dropped.length, 2);
  // Top 2 should be the A grades
  assert.deepEqual(
    kept.map((r) => r.symbol).sort(),
    ["EURGBP", "EURUSD"],
  );
});

test("clusterDedupe: opposite-direction trades in same cluster don't compete", () => {
  const results = [
    mkCandidate("EURUSD", "A", 3, "long"),
    mkCandidate("EURGBP", "A", 3, "long"),
    mkCandidate("EURJPY", "A", 3, "short"), // opposite direction — separate bucket
  ];
  const out = clusterDedupe(results, { keep: 2 });
  const kept = out.filter((r) => r.cluster_decision?.kept);
  // All 3 kept — long bucket has 2, short has 1.
  assert.equal(kept.length, 3);
});

test("clusterDedupe: STOPs are passed through with no cluster_decision", () => {
  const results = [
    { symbol: "USDJPY", confluence_grade: "—", stop_reason: "monthly_no_trend" },
    mkCandidate("EURUSD", "A", 3),
  ];
  const out = clusterDedupe(results, { keep: 2 });
  const stop = out.find((r) => r.symbol === "USDJPY");
  assert.equal(stop.cluster_decision, undefined);
  const cand = out.find((r) => r.symbol === "EURUSD");
  assert.equal(cand.cluster_decision?.kept, true);
});

test("clusterDedupe: ties broken by RR then by probability", () => {
  // both A grade, EURJPY has higher RR so should win the second slot
  const results = [
    mkCandidate("EURUSD", "A", 5),    // best
    mkCandidate("EURGBP", "A", 2.5),  // worst RR
    mkCandidate("EURCAD", "A", 4),    // mid RR
  ];
  const out = clusterDedupe(results, { keep: 2 });
  const kept = out.filter((r) => r.cluster_decision?.kept).map((r) => r.symbol).sort();
  assert.deepEqual(kept, ["EURCAD", "EURUSD"]);
});

test("directionFromResult: prefers weekly over monthly", () => {
  assert.equal(
    directionFromResult({ weekly: { direction: "long" }, monthly: { direction: "short" } }),
    "long",
  );
});

test("directionFromResult: falls back to monthly when weekly missing", () => {
  assert.equal(directionFromResult({ monthly: { direction: "short" } }), "short");
});

// ─── dailyTriggerType integration ─────────────────────────────────────────

test("dailyTriggerType: returns sweep_displacement when state=ENTER + competition.sweep_then_displacement", () => {
  const monthly = mkMonthly();
  const weekly = mkWeekly();
  const m = mkMeasurements();
  m.last_5_candles[3] = mkBar({ role: "sweep", high_vs_prior_bar_high: "above", low_vs_prior_bar_low: "above" });
  const cell = mkDaily({
    measurements: m,
    competition: { sweep_then_displacement: true },
    candle_verdict: {
      body_pct_of_range: 70, upper_wick_pct: 5, lower_wick_pct: 30,
      close_position: "upper_third", winner: "buyers", winner_strength: 8,
      liquidity_swept: "below_prior_low", pattern: "hammer", in_bias: true, verdict: "x",
    },
    trade_plan: { risk_atr: 1, reward_atr: 3, rr_ratio: 3 },
  });
  // Need state=ENTER for dailyTriggerType to fire
  cell.state = dailyCellState(cell, monthly, weekly);
  assert.equal(cell.state, "ENTER");
  assert.equal(dailyTriggerType(cell, "long"), "sweep_displacement");
});
