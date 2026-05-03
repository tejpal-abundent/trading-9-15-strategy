import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScanCells } from "../tools/golden-loader.mjs";

test("loadScanCells: returns Map<symbol, {monthly, weekly, daily}> for latest scan", async () => {
  const cells = await loadScanCells("scan-results/latest-scan-v2.json");
  assert.ok(cells instanceof Map, "expected a Map");
  assert.ok(cells.size >= 5, `expected ≥ 5 symbols, got ${cells.size}`);
  const audusd = cells.get("AUDUSD");
  assert.ok(audusd, "AUDUSD missing from latest scan");
  assert.ok(audusd.weekly, "weekly cell missing for AUDUSD");
  assert.ok(audusd.weekly.measurements, "AUDUSD weekly.measurements missing");
});

import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { loadGolden } from "../tools/golden-loader.mjs";

test("loadGolden: parses CSV into row objects (skips comments + blank lines)", () => {
  mkdirSync("/tmp/gl-test", { recursive: true });
  const path = "/tmp/gl-test/test.csv";
  writeFileSync(
    path,
    "symbol,scenario,note\n# this is a comment\nAUDUSD,test-scenario,\"a, b, c\"\n\nGBPJPY,other,",
  );
  const rows = loadGolden(path);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, "AUDUSD");
  assert.equal(rows[0].note, "a, b, c");
  assert.equal(rows[1].symbol, "GBPJPY");
  rmSync("/tmp/gl-test", { recursive: true, force: true });
});

import { replayResult } from "../tools/replay-engine.mjs";

test("replayResult: stops at monthly_no_trend when monthly.direction is none", () => {
  const cells = {
    monthly: { direction: "none", in_9_15_zone: false, parse_failed: false },
    weekly: null,
    daily: null,
  };
  const result = replayResult(cells);
  assert.equal(result.stopped_at, "1M");
  assert.equal(result.stop_reason, "monthly_no_trend");
  assert.equal(result.confluence_grade, "—");
});

test("replayResult: full pipeline runs when monthly + weekly + daily all valid", () => {
  // Full pipeline test — synthetic cells crafted to clear every gate under
  // the CURRENT (pre-T4) gate code.
  const cells = {
    monthly: {
      direction: "long",
      in_9_15_zone: false,
      parse_failed: false,
      measurements: { ema_state: { slope_steepness: "medium", ema9_ema15_distance: "normal" } },
    },
    weekly: {
      direction: "long",
      direction_conflict: false,
      score: 8,
      red_flags: [],
      parse_failed: false,
      candle_verdict: { in_bias: true, winner_strength: 8, pattern: "solid_bull", liquidity_swept: "none" },
      measurements: {
        current_closed_bar: { color: "green", body_pct_of_range: 80, close_position: "upper_third" },
        ema_state: { slope_steepness: "steep", ema9_ema15_distance: "wide" },
        recent_5_bars: { direction: "up", overlap_pct: 30 },
      },
    },
    daily: {
      direction_conflict: false,
      red_flags: [],
      prep_signals_count: 3,
      angle_ok: true,
      zone_rejection: true,
      coc_present: false,
      solid_continuation: true,
      setup_type: "pullback",
      parse_failed: false,
      candle_verdict: { in_bias: true, winner_strength: 8, pattern: "solid_bull", liquidity_swept: "none" },
      measurements: {},
    },
  };
  const result = replayResult(cells);
  assert.equal(result.stop_reason, null);
  assert.equal(result.confluence_grade !== "—", true, `expected non-stop grade, got ${result.confluence_grade}`);
});

test("replayResult: does not mutate the caller's nested cell fields", () => {
  // Regression test for the shallow-copy bug found in T1 code review:
  // validateCellConsistency mutates candle_verdict.liquidity_swept when its
  // sweep gate fails. With a shallow spread, those writes leak back to the
  // caller's input. With structuredClone, they don't.
  const cells = {
    monthly: null,
    weekly: {
      direction: "long",
      candle_verdict: {
        in_bias: true,
        // liquidity_swept claim that the gate will reject (high not above prior)
        liquidity_swept: "above_prior_high",
      },
      measurements: {
        current_closed_bar: {
          color: "green",
          body_pct_of_range: 80,
          close_position: "upper_third",
          high_vs_prior_bar_high: "below",
          low_vs_prior_bar_low: "above",
        },
      },
    },
    daily: null,
  };
  const before = cells.weekly.candle_verdict.liquidity_swept;
  replayResult(cells);
  assert.equal(
    cells.weekly.candle_verdict.liquidity_swept,
    before,
    "replayResult should not mutate the caller's nested candle_verdict",
  );
});

import { spawnSync } from "node:child_process";

test("backtest CLI: golden assertion against scan rows passes after gate recalibration", () => {
  const result = spawnSync("node", ["tools/backtest.mjs", "--quiet"], {
    encoding: "utf8",
    cwd: process.cwd(),
  });
  // After P1-P8' gate recalibration, all 6 golden rows should PASS — the
  // recalibrated gates produce the verdicts the golden CSV asserts.
  assert.equal(
    result.status,
    0,
    `expected exit 0 (all golden rows pass) — stdout was:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /AUDUSD.*PASS/, "expected AUDUSD to pass after recalibration");
  assert.match(result.stdout, /GBPJPY.*PASS/, "expected GBPJPY to pass after recalibration");
});

test("backtest CLI: --strict flag exits 2 when replay diff is non-empty after recalibration", () => {
  const result = spawnSync("node", ["tools/backtest.mjs", "--quiet", "--strict"], {
    encoding: "utf8",
    cwd: process.cwd(),
  });
  // After gate recalibration, the replay engine produces verdicts that differ
  // from the stored scan results (the stored results were produced by the
  // pre-recalibration code). With --strict, that non-empty diff makes backtest
  // exit 2 even though golden assertions all pass.
  assert.equal(result.status, 2, `expected exit 2 (replay diff non-empty under --strict) — stdout was:\n${result.stdout}\nstderr:\n${result.stderr}`);
});
