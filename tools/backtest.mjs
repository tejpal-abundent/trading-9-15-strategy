#!/usr/bin/env node
import { loadGolden, loadScanCells, loadFreshSnapshot } from "./golden-loader.mjs";
import { replayResult } from "./replay-engine.mjs";

// CLI flags
function parseArgs(argv) {
  const opts = {
    scan: "scan-results/latest-scan-v2.json",
    golden: "docs/golden-set/charts.csv",
    quiet: false,
    strict: false,
  };
  const requireValue = (flag, val) => {
    if (!val || val.startsWith("--")) {
      console.error(`Error: ${flag} requires a path argument`);
      process.exit(1);
    }
    return val;
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scan") opts.scan = requireValue("--scan", argv[++i]);
    else if (a === "--golden") opts.golden = requireValue("--golden", argv[++i]);
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--strict") opts.strict = true;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: node tools/backtest.mjs [options]
  --scan <path>     Scan-results JSON to replay (default: ${opts.scan})
  --golden <path>   Golden set CSV (default: ${opts.golden})
  --quiet           Suppress per-symbol diff lines
  --strict          Exit 2 if replay diff is non-empty`);
      process.exit(0);
    }
  }
  return opts;
}

function compareVerdicts(stored, replayed) {
  // Returns null when verdicts match, or a short narrative when they differ.
  if (!stored) return null;
  const a = `${stored.stopped_at ?? "—"}/${stored.stop_reason ?? "—"}/${stored.confluence_grade ?? "—"}`;
  const b = `${replayed.stopped_at ?? "—"}/${replayed.stop_reason ?? "—"}/${replayed.confluence_grade ?? "—"}`;
  if (a === b) return null;
  return `${a} → ${b}`;
}

function checkGoldenRow(row, replayed) {
  const fails = [];
  if (row.expected_monthly_dir && replayed.monthly?.direction !== row.expected_monthly_dir) {
    fails.push(`monthly.direction=${replayed.monthly?.direction} != ${row.expected_monthly_dir}`);
  }
  if (row.expected_weekly_dir && row.expected_weekly_dir !== "" && replayed.weekly?.direction !== row.expected_weekly_dir) {
    fails.push(`weekly.direction=${replayed.weekly?.direction} != ${row.expected_weekly_dir}`);
  }
  const minScore = parseInt(row.expected_weekly_score_min ?? "0", 10);
  if (minScore > 0 && (replayed.weekly?.score ?? 0) < minScore) {
    fails.push(`weekly.score=${replayed.weekly?.score} < ${minScore}`);
  }
  const maxFatal = parseInt(row.expected_weekly_red_flags_max ?? "99", 10);
  const fatalCount = (replayed.weekly?.red_flags || []).filter(
    (f) => f === "exhaustion" || f === "direction_conflict",
  ).length;
  if (fatalCount > maxFatal) {
    fails.push(`weekly.red_flags fatal count ${fatalCount} > ${maxFatal}`);
  }
  if (row.expected_daily_state && replayed.daily?.state && replayed.daily.state !== row.expected_daily_state) {
    fails.push(`daily.state=${replayed.daily.state} != ${row.expected_daily_state}`);
  }
  if (row.expected_grade && replayed.confluence_grade !== row.expected_grade) {
    fails.push(`grade=${replayed.confluence_grade} != ${row.expected_grade}`);
  }
  if (row.expected_stop_reason && row.expected_stop_reason !== "" && replayed.stop_reason !== row.expected_stop_reason) {
    fails.push(`stop_reason=${replayed.stop_reason} != ${row.expected_stop_reason}`);
  }
  return fails;
}

async function main() {
  const opts = parseArgs(process.argv);

  // ─── Replay layer ──────────────────────────────────────────────────────
  const scanCells = loadScanCells(opts.scan);
  let diffCount = 0;
  if (!opts.quiet) console.log(`\n=== Replay diff vs ${opts.scan} (${scanCells.size} symbols) ===`);
  for (const [sym, cells] of scanCells) {
    const replayed = replayResult(cells);
    const diff = compareVerdicts(cells.stored, replayed);
    if (diff) {
      diffCount++;
      if (!opts.quiet) console.log(`  ${sym.padEnd(10)}  ${diff}`);
    }
  }
  if (!opts.quiet) console.log(`Total verdict changes: ${diffCount}/${scanCells.size}`);

  // ─── Golden assertion layer ────────────────────────────────────────────
  const goldenRows = loadGolden(opts.golden);
  let goldenFails = 0;
  console.log(`\n=== Golden set assertions (${goldenRows.length} rows) ===`);
  for (const row of goldenRows) {
    let cells;
    if (row.source === "fresh") {
      const path = `docs/golden-set/snapshots/${row.symbol}-${row.capture_date}.json`;
      try {
        cells = loadFreshSnapshot(path);
      } catch (err) {
        console.log(`  ${row.symbol.padEnd(10)}  FAIL  snapshot missing at ${path}`);
        goldenFails++;
        continue;
      }
    } else {
      cells = scanCells.get(row.symbol);
      if (!cells) {
        console.log(`  ${row.symbol.padEnd(10)}  FAIL  not found in ${opts.scan}`);
        goldenFails++;
        continue;
      }
    }
    const replayed = replayResult(cells);
    const fails = checkGoldenRow(row, replayed);
    if (fails.length === 0) {
      console.log(`  ${row.symbol.padEnd(10)}  PASS  (${row.scenario})`);
    } else {
      goldenFails++;
      console.log(`  ${row.symbol.padEnd(10)}  FAIL  (${row.scenario})`);
      for (const f of fails) console.log(`              ${f}`);
    }
  }
  console.log(`\nGolden: ${goldenRows.length - goldenFails}/${goldenRows.length} pass.`);

  if (goldenFails > 0) process.exit(1);
  if (opts.strict && diffCount > 0) process.exit(2);
  process.exit(0);
}

main().catch((err) => {
  console.error("backtest fatal:", err);
  process.exit(3);
});
