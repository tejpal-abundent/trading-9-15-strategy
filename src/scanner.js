// Scanner — iterates a watchlist × timeframes, evaluates each chart with
// (optional) numeric MTF gate + Gemini visual gate, prints a report card,
// and saves results to scan-results/.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import {
  openTvClient,
  closeTvClient,
  setSymbol,
  setTimeframe,
  captureSymbolTf,
  getChartState,
  dismissPopups,
} from "./tv-navigate.js";
import { askGeminiVision, getTodaysCost, recordCost, fillRubric } from "./visual.js";
import {
  fetchCandles as fetchHT,
  emaAlignment,
  agree,
  priceInZone,
} from "./higher-tf.js";

const TIMEFRAMES = ["1H", "2H", "4H"];
const HTF_TIMEFRAMES = ["1M", "1W", "1D"];
const ENTRY_TIMEFRAMES = ["4H", "2H", "1H"];
const RESULT_DIR = "scan-results";

// Filesystem-safe slug from a watchlist entry's TV symbol.
export function slugify(label) {
  return label.replace(/[^A-Za-z0-9_-]/g, "_");
}

function loadWatchlist(path = "watchlist.json") {
  if (!existsSync(path)) {
    throw new Error(`watchlist.json not found at ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error("watchlist.json must be an array of {label, tv_symbol, binance_symbol}");
  }
  return raw;
}

// Numeric Multi-TF gate (only callable for Binance-supported symbols).
async function runNumericGate(binanceSymbol, entryTf, pullbackTolerancePct) {
  const [monthly, weekly, daily, entry] = await Promise.all([
    fetchHT(binanceSymbol, "1M", 60),
    fetchHT(binanceSymbol, "1W", 80),
    fetchHT(binanceSymbol, "1D", 120),
    fetchHT(binanceSymbol, entryTf, 200),
  ]);
  const aM = emaAlignment(monthly);
  const aW = emaAlignment(weekly);
  const aD = emaAlignment(daily);
  const aE = emaAlignment(entry);

  const htfDirection = agree(aM, aW, aD);
  const lastEntry = entry[entry.length - 1];
  const inZone = priceInZone(lastEntry, aE.ema9, aE.ema15, pullbackTolerancePct);

  const checks = {
    monthly: aM.direction,
    weekly: aW.direction,
    daily: aD.direction,
    entry: aE.direction,
    htf_direction: htfDirection,
    entry_aligns_with_htf: aE.direction === htfDirection,
    in_zone: inZone,
  };

  const pass =
    htfDirection !== null &&
    aE.direction === htfDirection &&
    inZone;

  return { pass, direction: htfDirection, checks };
}

// Single (symbol, tf) cell — runs numeric (if Binance) + visual.
async function evaluateCell(client, item, tf, options) {
  const { rubricTemplate, pullbackTolerancePct, minLlmScore } = options;
  const slug = slugify(item.label);
  const cell = {
    label: item.label,
    tv_symbol: item.tv_symbol,
    binance_symbol: item.binance_symbol,
    timeframe: tf,
    numeric: { skipped: true, reason: "non_binance_or_skipped" },
    visual: { skipped: true, reason: "not_run" },
    overall: "skip",
    notes: [],
  };

  // Numeric gate (only for Binance symbols)
  if (item.binance_symbol) {
    try {
      const num = await runNumericGate(
        item.binance_symbol,
        tf,
        pullbackTolerancePct,
      );
      cell.numeric = { skipped: false, ...num };
    } catch (err) {
      cell.numeric = { skipped: true, reason: `error: ${err.message}` };
      cell.notes.push(`numeric error: ${err.message}`);
    }
  }

  // Switch chart TF + screenshot, with verification.
  await setTimeframe(client, tf);
  await dismissPopups(client);
  const stateAfter = await getChartState(client);
  if (stateAfter && stateAfter.resolution) {
    cell.actualResolution = stateAfter.resolution;
  }
  const imagePath = await captureSymbolTf(client, slug, tf);
  cell.imagePath = imagePath;

  // Visual gate (Gemini)
  const spentToday = getTodaysCost();
  const maxSpend = parseFloat(process.env.MAX_LLM_SPEND_USD_PER_DAY || "2");
  if (spentToday >= maxSpend) {
    cell.visual = {
      skipped: true,
      reason: `daily_budget_exhausted ($${spentToday.toFixed(2)}/$${maxSpend})`,
    };
    cell.overall = "skipped";
    return cell;
  }

  const direction = cell.numeric.direction || null;
  const prompt = fillRubric(rubricTemplate, {
    SYMBOL: item.label,
    TIMEFRAME: tf,
  });

  try {
    const { result, costUSD, model, inputTokens, outputTokens } =
      await askGeminiVision({
        imagePath,
        prompt,
        model: process.env.VISUAL_MODEL || "gemini-2.5-flash",
      });
    recordCost(costUSD);

    const visConfirm =
      result.direction !== "none" &&
      result.angle_ok === true &&
      result.price_at_zone === true &&
      result.coc_present === true &&
      result.confirm_candle != null &&
      (result.red_flags?.length ?? 0) === 0 &&
      (result.score ?? 0) >= minLlmScore;

    cell.visual = {
      skipped: false,
      ...result,
      costUSD,
      model,
      inputTokens,
      outputTokens,
      confirm: visConfirm,
    };

    // Overall: visual must pass; if numeric ran, it must also pass; if numeric
    // and visual both vote on direction, they should agree.
    if (cell.numeric.skipped) {
      cell.overall = visConfirm ? "PASS" : "reject";
    } else {
      const directionAgreed =
        !cell.numeric.direction ||
        result.direction === "none" ||
        cell.numeric.direction.startsWith(result.direction.slice(0, 4)) ||
        // bullish ↔ long, bearish ↔ short
        (cell.numeric.direction === "bullish" && result.direction === "long") ||
        (cell.numeric.direction === "bearish" && result.direction === "short");

      cell.overall =
        cell.numeric.pass && visConfirm && directionAgreed ? "PASS" : "reject";
      if (cell.numeric.pass && visConfirm && !directionAgreed) {
        cell.notes.push(
          `direction mismatch: numeric=${cell.numeric.direction}, visual=${result.direction}`,
        );
      }
    }
  } catch (err) {
    cell.visual = { skipped: true, reason: `error: ${err.message}` };
    cell.overall = "error";
    cell.notes.push(`visual error: ${err.message}`);
  }

  return cell;
}

export async function runScan(options = {}) {
  const watchlist = loadWatchlist(options.watchlistPath || "watchlist.json");
  const rubricTemplate = readFileSync(
    options.rubricPath || "prompts/scan-rubric.md",
    "utf8",
  );
  const pullbackTolerancePct = parseFloat(
    process.env.PULLBACK_TOLERANCE_PCT || "0.5",
  );
  const minLlmScore = parseInt(process.env.MIN_LLM_SCORE || "7");

  const startedAt = new Date().toISOString();
  console.log(
    `\n═══════════════════════════════════════════════════════════\n` +
      `  Scan started: ${startedAt}\n` +
      `  Watchlist: ${watchlist.length} symbols × ${TIMEFRAMES.length} timeframes ` +
      `= ${watchlist.length * TIMEFRAMES.length} cells\n` +
      `═══════════════════════════════════════════════════════════\n`,
  );

  let client;
  const results = [];

  try {
    client = await openTvClient();

    for (const [index, item] of watchlist.entries()) {
      console.log(
        `\n[${index + 1}/${watchlist.length}] ▶ ${item.label} (${item.tv_symbol})`,
      );

      try {
        await setSymbol(client, item.tv_symbol);
        await dismissPopups(client);
        const state = await getChartState(client);
        if (state) {
          console.log(`    chart now showing: ${state.symbol} @ ${state.resolution}`);
        }
      } catch (err) {
        console.log(`    ❌ navigation failed: ${err.message}`);
        results.push({
          label: item.label,
          error: `nav: ${err.message}`,
          cells: [],
        });
        continue;
      }

      const cells = [];
      for (const tf of TIMEFRAMES) {
        process.stdout.write(`    ${tf} ...`);
        const cell = await evaluateCell(client, item, tf, {
          rubricTemplate,
          pullbackTolerancePct,
          minLlmScore,
        });
        cells.push(cell);
        const score = cell.visual.score ?? "—";
        const dir = cell.visual.direction ?? "—";
        const tag =
          cell.overall === "PASS"
            ? "✅ PASS"
            : cell.overall === "error"
              ? "⚠️  ERROR"
              : cell.overall === "skipped"
                ? "⏭  SKIP"
                : `🚫 reject`;
        console.log(` ${tag}  (dir=${dir}, score=${score})`);
      }
      results.push({ label: item.label, tv_symbol: item.tv_symbol, cells });
    }
  } finally {
    await closeTvClient(client);
  }

  const finishedAt = new Date().toISOString();
  printReportCard(results);

  if (!existsSync(RESULT_DIR)) mkdirSync(RESULT_DIR, { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, "-");
  const outPath = `${RESULT_DIR}/scan-${stamp}.json`;
  const summary = { startedAt, finishedAt, results };
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  writeFileSync(`${RESULT_DIR}/latest.json`, JSON.stringify(summary, null, 2));
  console.log(`\nFull results saved → ${outPath}`);
  console.log(`                  ↘ ${RESULT_DIR}/latest.json (always overwritten)`);
}

function printReportCard(results) {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Report Card");
  console.log("═══════════════════════════════════════════════════════════\n");
  const colHeader = ["Symbol".padEnd(12), ...TIMEFRAMES.map((t) => t.padEnd(15))];
  console.log("  " + colHeader.join(""));
  console.log("  " + "─".repeat(colHeader.join("").length));

  for (const r of results) {
    if (r.error) {
      console.log(
        "  " + r.label.padEnd(12) + ` (skipped: ${r.error})`,
      );
      continue;
    }
    const cells = TIMEFRAMES.map((tf) => {
      const c = r.cells.find((x) => x.timeframe === tf);
      if (!c) return "—".padEnd(15);
      const score = c.visual?.score ?? "—";
      const tag =
        c.overall === "PASS"
          ? `✅ PASS(${score})`
          : c.overall === "error"
            ? "⚠️  ERR"
            : c.overall === "skipped"
              ? "⏭  SKIP"
              : `reject(${score})`;
      return tag.padEnd(15);
    });
    console.log("  " + r.label.padEnd(12) + cells.join(""));
  }

  // Summary line
  const passes = [];
  for (const r of results) {
    if (r.error) continue;
    for (const c of r.cells) {
      if (c.overall === "PASS") {
        passes.push(`${r.label} @ ${c.timeframe}`);
      }
    }
  }
  console.log("");
  if (passes.length === 0) {
    console.log("  No setups passed both gates this scan.");
  } else {
    console.log(`  ✅ ${passes.length} setup(s) passed:`);
    passes.forEach((p) => console.log(`     - ${p}`));
  }
}

// ─── DEEP SCAN — single symbol, 6 timeframes, HTF aggregation ───────────

// Reads only `direction` from a TF cell — used for HTF bias agreement.
function dirOf(cell) {
  return cell?.visual?.direction || "none";
}

function htfAgree(monthly, weekly, daily) {
  const dirs = [dirOf(monthly), dirOf(weekly), dirOf(daily)];
  if (dirs.some((d) => d === "none" || d == null)) return null;
  return dirs.every((d) => d === dirs[0]) ? dirs[0] : null;
}

// Visual-only cell evaluation (no numeric gate). Used for non-Binance symbols
// in deep scan. Returns the same shape as evaluateCell for compat.
async function evaluateVisualCell(client, item, tf, options) {
  const { rubricTemplate, minLlmScore } = options;
  const slug = slugify(item.label);
  const cell = {
    label: item.label,
    tv_symbol: item.tv_symbol,
    timeframe: tf,
    numeric: { skipped: true, reason: "deep_scan_visual_only" },
    visual: { skipped: true, reason: "not_run" },
    overall: "skip",
    notes: [],
  };

  await setTimeframe(client, tf);
  await dismissPopups(client);
  const stateAfter = await getChartState(client);
  if (stateAfter?.resolution) cell.actualResolution = stateAfter.resolution;

  const imagePath = await captureSymbolTf(client, slug, tf);
  cell.imagePath = imagePath;

  const spentToday = getTodaysCost();
  const maxSpend = parseFloat(process.env.MAX_LLM_SPEND_USD_PER_DAY || "2");
  if (spentToday >= maxSpend) {
    cell.visual = {
      skipped: true,
      reason: `daily_budget_exhausted ($${spentToday.toFixed(2)}/$${maxSpend})`,
    };
    return cell;
  }

  const prompt = fillRubric(rubricTemplate, {
    SYMBOL: item.label,
    TIMEFRAME: tf,
  });

  try {
    const { result, costUSD, model } = await askGeminiVision({
      imagePath,
      prompt,
      model: process.env.VISUAL_MODEL || "gemini-2.5-flash",
    });
    recordCost(costUSD);

    const visConfirm =
      result.direction !== "none" &&
      result.angle_ok === true &&
      result.price_at_zone === true &&
      result.coc_present === true &&
      result.confirm_candle != null &&
      (result.red_flags?.length ?? 0) === 0 &&
      (result.score ?? 0) >= minLlmScore;

    cell.visual = { skipped: false, ...result, costUSD, model, confirm: visConfirm };
    cell.overall = visConfirm ? "PASS" : "reject";
  } catch (err) {
    cell.visual = { skipped: true, reason: `error: ${err.message}` };
    cell.overall = "error";
    cell.notes.push(`visual error: ${err.message}`);
  }

  return cell;
}

export async function runDeepScan(symbolLabel, tvSymbol, options = {}) {
  const rubricTemplate = readFileSync(
    options.rubricPath || "prompts/scan-rubric.md",
    "utf8",
  );
  const minLlmScore = parseInt(process.env.MIN_LLM_SCORE || "7");
  const item = {
    label: symbolLabel,
    tv_symbol: tvSymbol,
    binance_symbol: null,
  };

  const startedAt = new Date().toISOString();
  console.log(
    `\n═══════════════════════════════════════════════════════════\n` +
      `  Deep scan: ${symbolLabel} (${tvSymbol})\n` +
      `  Timeframes: ${HTF_TIMEFRAMES.join(", ")} (HTF bias) + ` +
      `${ENTRY_TIMEFRAMES.join(", ")} (entry candidates)\n` +
      `  Started: ${startedAt}\n` +
      `═══════════════════════════════════════════════════════════\n`,
  );

  let client;
  const allCells = [];

  try {
    client = await openTvClient();
    await setSymbol(client, tvSymbol);
    await dismissPopups(client);
    const state = await getChartState(client);
    if (state) console.log(`  chart now showing: ${state.symbol} @ ${state.resolution}\n`);

    for (const tf of [...HTF_TIMEFRAMES, ...ENTRY_TIMEFRAMES]) {
      process.stdout.write(`  ${tf} ...`);
      const cell = await evaluateVisualCell(client, item, tf, {
        rubricTemplate,
        minLlmScore,
      });
      allCells.push(cell);
      const dir = cell.visual?.direction ?? "—";
      const score = cell.visual?.score ?? "—";
      console.log(` dir=${dir}  score=${score}`);
    }
  } finally {
    await closeTvClient(client);
  }

  // Aggregate HTF bias and decide entry
  const monthly = allCells.find((c) => c.timeframe === "1M");
  const weekly = allCells.find((c) => c.timeframe === "1W");
  const daily = allCells.find((c) => c.timeframe === "1D");
  const htfDirection = htfAgree(monthly, weekly, daily);

  const entryCells = allCells.filter((c) => ENTRY_TIMEFRAMES.includes(c.timeframe));
  const validEntries = [];
  for (const c of entryCells) {
    const v = c.visual ?? {};
    if (
      htfDirection &&
      v.direction === htfDirection &&
      v.angle_ok === true &&
      v.price_at_zone === true &&
      v.coc_present === true &&
      v.confirm_candle != null &&
      (v.red_flags?.length ?? 0) === 0 &&
      (v.score ?? 0) >= minLlmScore
    ) {
      validEntries.push(c);
    }
  }

  printDeepReport(symbolLabel, allCells, htfDirection, validEntries);

  if (!existsSync(RESULT_DIR)) mkdirSync(RESULT_DIR, { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, "-");
  const outPath = `${RESULT_DIR}/deep-${slugify(symbolLabel)}-${stamp}.json`;
  const summary = {
    type: "deep",
    label: symbolLabel,
    tv_symbol: tvSymbol,
    startedAt,
    finishedAt: new Date().toISOString(),
    htfDirection,
    cells: allCells,
    validEntries: validEntries.map((c) => ({
      timeframe: c.timeframe,
      direction: c.visual.direction,
      score: c.visual.score,
      candle: c.visual.confirm_candle,
    })),
  };
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  writeFileSync(`${RESULT_DIR}/latest-deep.json`, JSON.stringify(summary, null, 2));
  console.log(`\nFull results saved → ${outPath}`);
}

function printDeepReport(label, cells, htfDirection, validEntries) {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  Deep Report — ${label}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  console.log("  HTF BIAS (Monthly / Weekly / Daily)");
  console.log("  ──────────────────────────────────────────────");
  for (const tf of HTF_TIMEFRAMES) {
    const c = cells.find((x) => x.timeframe === tf);
    const v = c?.visual ?? {};
    const flagsTxt = (v.red_flags?.length ? ` flags=[${v.red_flags.join(",")}]` : "");
    console.log(
      `    ${tf.padEnd(4)}  dir=${(v.direction ?? "—").padEnd(8)}  ` +
        `angle_ok=${String(v.angle_ok ?? "—").padEnd(5)}  score=${v.score ?? "—"}${flagsTxt}`,
    );
  }
  console.log("");
  if (htfDirection) {
    console.log(`  ✅ HTF AGREE: ${htfDirection.toUpperCase()}`);
  } else {
    console.log(`  🚫 HTF DISAGREE — no trade regardless of entry TFs`);
  }

  console.log("\n  ENTRY CANDIDATES (4H / 2H / 1H — looking for confirmation)");
  console.log("  ──────────────────────────────────────────────");
  for (const tf of ENTRY_TIMEFRAMES) {
    const c = cells.find((x) => x.timeframe === tf);
    const v = c?.visual ?? {};
    const matches = htfDirection && v.direction === htfDirection;
    const allOK =
      matches &&
      v.angle_ok &&
      v.price_at_zone &&
      v.coc_present &&
      v.confirm_candle != null &&
      (v.red_flags?.length ?? 0) === 0 &&
      (v.score ?? 0) >= 7;
    const tag = allOK ? "✅ ENTRY" : matches ? "○ aligned, weak" : "✗ misaligned";
    console.log(
      `    ${tf.padEnd(4)}  dir=${(v.direction ?? "—").padEnd(8)}  ` +
        `zone=${String(v.price_at_zone ?? "—").padEnd(5)}  ` +
        `coc=${String(v.coc_present ?? "—").padEnd(5)}  ` +
        `candle=${(v.confirm_candle ?? "—").toString().padEnd(10)}  ` +
        `score=${(v.score ?? "—").toString().padEnd(3)}  ${tag}`,
    );
  }

  console.log("\n  ──────────────────────────────────────────────");
  if (validEntries.length === 0) {
    console.log(`  🚫 NO VALID ENTRY for ${label} right now`);
    if (!htfDirection) {
      console.log(`     Reason: HTFs don't agree on direction`);
    } else {
      console.log(
        `     Reason: HTFs say ${htfDirection.toUpperCase()}, but no entry TF` +
          ` showed all conditions met (angle + zone + CoC + confirm candle + score≥7)`,
      );
    }
  } else {
    console.log(`  ✅ ENTRY SIGNAL on ${validEntries.length} TF(s):`);
    for (const c of validEntries) {
      console.log(
        `     ${c.timeframe} → ${c.visual.direction.toUpperCase()}  ` +
          `(score ${c.visual.score}, ${c.visual.confirm_candle} candle)`,
      );
      console.log(`     reasoning: ${c.visual.reasoning}`);
    }
  }
  console.log("");
}
