import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadPriorRunsForWatchlist,
  derivePriorContext,
} from "../src/history.js";

// Builds an isolated temp resultsDir, populated with the given scan files.
// Each entry: { name: "scan-v2-watchlist-...json", payload: <scan payload> }
function withTempResultsDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "history-test-"));
  try {
    for (const { name, payload } of files) {
      writeFileSync(join(dir, name), JSON.stringify(payload));
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makePayload(startedAt, results) {
  return { started_at: startedAt, finished_at: startedAt, results };
}

function makeMonthlyCell(direction, extra = {}) {
  return {
    tf: "1M",
    direction,
    in_9_15_zone: false,
    candle_verdict: { winner: "buyers", winner_strength: 7, pattern: "solid_bull", verdict: "test" },
    captured_at: extra.captured_at ?? null,
    parse_failed: false,
    ...extra,
  };
}

function makeDailyCell(state, extra = {}) {
  return {
    tf: "1D",
    state,
    trigger_type: extra.trigger_type ?? "none",
    direction_conflict: false,
    prep_signals_count: 3,
    candle_verdict: { winner: "buyers", winner_strength: 8, pattern: "hammer", verdict: "rejection wick" },
    captured_at: extra.captured_at ?? null,
    parse_failed: false,
    ...extra,
  };
}

// ─── loadPriorRunsForWatchlist ─────────────────────────────────────────

test("loadPriorRunsForWatchlist: missing dir → empty map", () => {
  const map = loadPriorRunsForWatchlist({
    resultsDir: "/tmp/__definitely_does_not_exist_xyz_42",
  });
  assert.equal(map.size, 0);
});

test("loadPriorRunsForWatchlist: empty dir → empty map", () => {
  withTempResultsDir([], (dir) => {
    const map = loadPriorRunsForWatchlist({ resultsDir: dir });
    assert.equal(map.size, 0);
  });
});

test("loadPriorRunsForWatchlist: groups by symbol, newest first", () => {
  withTempResultsDir(
    [
      {
        name: "scan-v2-watchlist-2026-04-23.json",
        payload: makePayload("2026-04-23T06:00:00.000Z", [
          { symbol: "EURUSD", monthly: makeMonthlyCell("long"), weekly: null, daily: null },
        ]),
      },
      {
        name: "scan-v2-watchlist-2026-04-24.json",
        payload: makePayload("2026-04-24T06:00:00.000Z", [
          { symbol: "EURUSD", monthly: makeMonthlyCell("long"), weekly: null, daily: null },
        ]),
      },
    ],
    (dir) => {
      const map = loadPriorRunsForWatchlist({ resultsDir: dir });
      const eu = map.get("EURUSD");
      assert.equal(eu.length, 2);
      assert.equal(eu[0].started_at, "2026-04-24T06:00:00.000Z");
      assert.equal(eu[1].started_at, "2026-04-23T06:00:00.000Z");
    },
  );
});

test("loadPriorRunsForWatchlist: respects beforeIso filter", () => {
  withTempResultsDir(
    [
      {
        name: "scan-v2-watchlist-old.json",
        payload: makePayload("2026-04-23T06:00:00.000Z", [
          { symbol: "BTCUSDT", monthly: makeMonthlyCell("long"), weekly: null, daily: null },
        ]),
      },
      {
        name: "scan-v2-watchlist-future.json",
        payload: makePayload("2026-04-25T06:00:00.000Z", [
          { symbol: "BTCUSDT", monthly: makeMonthlyCell("short"), weekly: null, daily: null },
        ]),
      },
    ],
    (dir) => {
      const map = loadPriorRunsForWatchlist({
        resultsDir: dir,
        beforeIso: "2026-04-24T00:00:00.000Z",
      });
      const btc = map.get("BTCUSDT");
      assert.equal(btc.length, 1);
      assert.equal(btc[0].monthly.direction, "long");
    },
  );
});

test("loadPriorRunsForWatchlist: caps at maxPriorRuns", () => {
  const files = [];
  for (let i = 1; i <= 5; i++) {
    files.push({
      name: `scan-v2-watchlist-day-${i}.json`,
      payload: makePayload(`2026-04-2${i}T06:00:00.000Z`, [
        { symbol: "EURUSD", monthly: makeMonthlyCell("long"), weekly: null, daily: null },
      ]),
    });
  }
  withTempResultsDir(files, (dir) => {
    const map = loadPriorRunsForWatchlist({ resultsDir: dir, maxPriorRuns: 2 });
    const eu = map.get("EURUSD");
    assert.equal(eu.length, 2);
    assert.equal(eu[0].started_at, "2026-04-25T06:00:00.000Z");
    assert.equal(eu[1].started_at, "2026-04-24T06:00:00.000Z");
  });
});

test("loadPriorRunsForWatchlist: skips malformed JSON files", () => {
  const dir = mkdtempSync(join(tmpdir(), "history-malformed-"));
  try {
    writeFileSync(join(dir, "scan-v2-watchlist-bad.json"), "{ not valid json");
    writeFileSync(
      join(dir, "scan-v2-watchlist-good.json"),
      JSON.stringify(
        makePayload("2026-04-23T06:00:00.000Z", [
          { symbol: "EURUSD", monthly: makeMonthlyCell("long"), weekly: null, daily: null },
        ]),
      ),
    );
    const map = loadPriorRunsForWatchlist({ resultsDir: dir });
    assert.equal(map.get("EURUSD").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPriorRunsForWatchlist: ignores files that do not match prefix", () => {
  withTempResultsDir(
    [
      {
        name: "scan-v2-watchlist-real.json",
        payload: makePayload("2026-04-23T06:00:00.000Z", [
          { symbol: "EURUSD", monthly: makeMonthlyCell("long"), weekly: null, daily: null },
        ]),
      },
      {
        name: "latest-scan-v2.json",
        payload: makePayload("2026-04-23T06:00:00.000Z", [
          { symbol: "EURUSD", monthly: makeMonthlyCell("short"), weekly: null, daily: null },
        ]),
      },
    ],
    (dir) => {
      const map = loadPriorRunsForWatchlist({ resultsDir: dir });
      // only the prefix-matching file should count
      assert.equal(map.get("EURUSD").length, 1);
      assert.equal(map.get("EURUSD")[0].monthly.direction, "long");
    },
  );
});

// ─── derivePriorContext ───────────────────────────────────────────────

test("derivePriorContext: empty history → cold scan", () => {
  const ctx = derivePriorContext([]);
  assert.equal(ctx.runs.length, 0);
  assert.equal(ctx.priorRunsCount, 0);
});

test("derivePriorContext: null/non-array → cold scan", () => {
  assert.equal(derivePriorContext(null).runs.length, 0);
  assert.equal(derivePriorContext(undefined).priorRunsCount, 0);
});

test("derivePriorContext: trims fields and preserves order", () => {
  const history = [
    {
      started_at: "2026-04-24T06:00:00.000Z",
      stop_reason: "daily_no_trigger",
      confluence_grade: "—",
      monthly: makeMonthlyCell("long", { captured_at: "2026-04-24T06:01:00.000Z" }),
      weekly: null,
      daily: makeDailyCell("WATCH", { trigger_type: "none" }),
    },
    {
      started_at: "2026-04-23T06:00:00.000Z",
      stop_reason: null,
      confluence_grade: "B",
      monthly: makeMonthlyCell("long"),
      weekly: null,
      daily: makeDailyCell("ENTER", { trigger_type: "pattern" }),
    },
  ];
  const ctx = derivePriorContext(history);
  assert.equal(ctx.priorRunsCount, 2);
  assert.equal(ctx.runs[0].started_at, "2026-04-24T06:00:00.000Z");
  assert.equal(ctx.runs[0].monthly.direction, "long");
  assert.equal(ctx.runs[0].monthly.captured_at, "2026-04-24T06:01:00.000Z");
  assert.equal(ctx.runs[0].daily.state, "WATCH");
  assert.equal(ctx.runs[1].confluence_grade, "B");
  assert.equal(ctx.runs[1].daily.trigger_type, "pattern");
});

test("derivePriorContext: parse_failed cells dropped to null", () => {
  const history = [
    {
      started_at: "2026-04-24T06:00:00.000Z",
      stop_reason: "llm_parse_error",
      confluence_grade: "—",
      monthly: { ...makeMonthlyCell("long"), parse_failed: true },
      weekly: null,
      daily: null,
    },
  ];
  const ctx = derivePriorContext(history);
  assert.equal(ctx.runs[0].monthly, null);
});
