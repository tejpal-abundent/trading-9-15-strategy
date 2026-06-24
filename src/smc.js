// V2.6 — Smart Money Concepts (SMC) primitives.
//
// Pure functions over OHLC bars (the array shape returned by getRecentBars in
// tv-navigate.js: [{ time, open, high, low, close }] in chronological order,
// oldest-first; the LAST entry is the most recent / forming bar).
//
// Why pure / deterministic: today's vision-derived signals like coc_present
// vary run-to-run on the same chart. SMC concepts (FVGs, swings, BOS, CHoCH,
// liquidity sweeps) are functions of price — once OHLC is fixed they always
// return the same answer. We use these to replace noisy vision booleans and
// to add bonus confluence to the grading.
//
// Idea map:
//   findSwings           — local pivots, foundation for everything else
//   detectFVGs           — three-bar imbalances (bar i-2 high < bar i low)
//   detectBosChoCH       — break of last opposite swing = BOS or CHoCH
//   detectLiquiditySweeps — clusters of equal highs/lows that get pierced
//   computeSmcContext    — aggregates the above + bias-aware booleans

// A swing high at index i means bars[i].high > all neighbors within
// `swingLength` on each side. swingLength=2 is the standard fractal (5-bar
// swing). On daily TF a 3-bar swing is more responsive; 5 is more reliable.
// We default to 2 (5-bar fractal) — same convention as the joshyattridge lib.
export function findSwings(bars, swingLength = 2) {
  if (!Array.isArray(bars) || bars.length < 2 * swingLength + 1) return [];
  const swings = [];
  for (let i = swingLength; i < bars.length - swingLength; i++) {
    const b = bars[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - swingLength; j <= i + swingLength; j++) {
      if (j === i) continue;
      if (bars[j].high >= b.high) isHigh = false;
      if (bars[j].low <= b.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swings.push({ index: i, type: "high", level: b.high });
    if (isLow) swings.push({ index: i, type: "low", level: b.low });
  }
  return swings;
}

// Fair value gap: a 3-bar imbalance where bar i and bar i-2 do not overlap.
//   Bullish FVG: bars[i].low > bars[i-2].high   (gap between [i-2].high and [i].low)
//   Bearish FVG: bars[i].high < bars[i-2].low   (gap between [i].high and [i-2].low)
//
// "mitigated_at" is the index of the first later bar whose range fully reaches
// back into the gap (the gap is "filled"). null if still open at the end of
// the series. An unmitigated bullish FVG below current price is a likely
// support / pullback target.
export function detectFVGs(bars) {
  if (!Array.isArray(bars) || bars.length < 3) return [];
  const fvgs = [];
  for (let i = 2; i < bars.length; i++) {
    const left = bars[i - 2];
    const cur = bars[i];
    if (cur.low > left.high) {
      fvgs.push({
        index: i,
        type: "bullish",
        top: cur.low,
        bottom: left.high,
        mitigated_at: findFvgMitigation(bars, i, "bullish", cur.low, left.high),
      });
    } else if (cur.high < left.low) {
      fvgs.push({
        index: i,
        type: "bearish",
        top: left.low,
        bottom: cur.high,
        mitigated_at: findFvgMitigation(bars, i, "bearish", left.low, cur.high),
      });
    }
  }
  return fvgs;
}

function findFvgMitigation(bars, fromIndex, type, top, bottom) {
  for (let j = fromIndex + 1; j < bars.length; j++) {
    const b = bars[j];
    // Mitigation = price wicks back into the gap zone.
    if (type === "bullish" && b.low <= top) return j;
    if (type === "bearish" && b.high >= bottom) return j;
  }
  return null;
}

// BOS = Break of Structure: price closes beyond the most recent swing in the
// CURRENT trend direction (continuation).
// CHoCH = Change of Character: price closes beyond the most recent swing in
// the OPPOSITE direction of the prior trend (potential reversal).
//
// We only need the MOST RECENT BOS and CHoCH for decision-making.
//
// Algorithm: walk swings forward. Keep track of "current trend":
//   trend=up if last confirmed event was a higher-high broken
//   trend=down symmetric
// At each bar after the swing, check if close pierces:
//   - last opposite swing → CHoCH (trend flips)
//   - last same-direction swing → BOS (trend continues)
// Returns the most recent of each, or null.
export function detectBosChoCH(bars, swings) {
  if (!Array.isArray(bars) || !Array.isArray(swings) || swings.length === 0) {
    return { last_bos: null, last_choch: null };
  }

  // We walk bars left-to-right. At each bar we know which prior swings have
  // been confirmed (swing.index < currentIndex + 1 because swings need
  // swingLength bars after to confirm — but for simplicity we treat a swing
  // as available immediately at its index; the lookback already buys us
  // confirmation).
  let lastBos = null;
  let lastChoch = null;
  let trend = null; // "up" | "down" | null

  // Track the most recent swing of each type that has NOT yet been broken.
  let lastSwingHigh = null;
  let lastSwingLow = null;

  let swingPtr = 0;

  for (let i = 0; i < bars.length; i++) {
    // Add any swings that became available at or before this bar.
    while (swingPtr < swings.length && swings[swingPtr].index <= i - 1) {
      const s = swings[swingPtr];
      if (s.type === "high") lastSwingHigh = s;
      else lastSwingLow = s;
      swingPtr++;
    }
    const close = bars[i].close;

    // Check break of swing high (bullish event).
    if (lastSwingHigh && close > lastSwingHigh.level) {
      const event = {
        index: i,
        direction: "bullish",
        level: lastSwingHigh.level,
        broken_swing_index: lastSwingHigh.index,
      };
      if (trend === "down") {
        lastChoch = event;
        trend = "up";
      } else {
        lastBos = event;
        trend = "up";
      }
      lastSwingHigh = null; // consumed
    }
    // Check break of swing low (bearish event).
    if (lastSwingLow && close < lastSwingLow.level) {
      const event = {
        index: i,
        direction: "bearish",
        level: lastSwingLow.level,
        broken_swing_index: lastSwingLow.index,
      };
      if (trend === "up") {
        lastChoch = event;
        trend = "down";
      } else {
        lastBos = event;
        trend = "down";
      }
      lastSwingLow = null;
    }
  }

  return { last_bos: lastBos, last_choch: lastChoch };
}

// Liquidity zone = cluster of swing highs (or lows) within `rangePct` of each
// other. The cluster represents resting orders (buy-stops above equal highs,
// sell-stops below equal lows). A "sweep" is when a later bar pokes through
// the cluster level and closes back inside the prior range — running the
// stops without follow-through.
//
// Returns sweeps detected in the bar series, most recent first.
export function detectLiquiditySweeps(bars, swings, rangePct = 0.001) {
  if (!Array.isArray(bars) || !Array.isArray(swings) || swings.length < 2) return [];

  const sweeps = [];
  // Find clusters: pairs of swings of same type within rangePct.
  const clusters = [];
  const used = new Set();
  for (let i = 0; i < swings.length; i++) {
    if (used.has(i)) continue;
    const s = swings[i];
    const members = [s];
    for (let j = i + 1; j < swings.length; j++) {
      if (used.has(j)) continue;
      const t = swings[j];
      if (t.type !== s.type) continue;
      const ref = Math.max(Math.abs(s.level), 1e-9);
      if (Math.abs(t.level - s.level) / ref <= rangePct) {
        members.push(t);
        used.add(j);
      }
    }
    if (members.length >= 2) {
      used.add(i);
      // Cluster level = mean of members; cluster end = max index of members.
      const level = members.reduce((a, m) => a + m.level, 0) / members.length;
      const endIndex = Math.max(...members.map((m) => m.index));
      clusters.push({ type: s.type, level, end_index: endIndex });
    }
  }

  // For each cluster, look for a sweep: a bar AFTER end_index whose extreme
  // pierces level then closes back on the inside.
  for (const c of clusters) {
    for (let i = c.end_index + 1; i < bars.length; i++) {
      const b = bars[i];
      if (c.type === "high" && b.high > c.level && b.close < c.level) {
        sweeps.push({
          index: i,
          type: "high_sweep", // swept buy-stops above equal highs
          level: c.level,
          cluster_end: c.end_index,
        });
        break;
      }
      if (c.type === "low" && b.low < c.level && b.close > c.level) {
        sweeps.push({
          index: i,
          type: "low_sweep", // swept sell-stops below equal lows
          level: c.level,
          cluster_end: c.end_index,
        });
        break;
      }
    }
  }

  // Most recent first.
  sweeps.sort((a, b) => b.index - a.index);
  return sweeps;
}

// Aggregates all SMC primitives into a single object plus bias-aware
// booleans the daily decision can consume directly.
//
// Inputs:
//   bars            — getRecentBars output (chronological, oldest-first).
//                     For meaningful results pass ≥ 30 bars; ideal is 50-100.
//   biasDirection   — "long" | "short" | "none" — used to decide which
//                     side of each signal counts as in-bias.
//
// Returns:
//   {
//     swings, fvgs, last_bos, last_choch, sweeps,    // raw primitives
//     recent_choch_in_bias,    // CHoCH within last 5 bars in bias direction
//     recent_bos_in_bias,      // BOS within last 5 bars in bias direction
//     unmitigated_fvg_in_bias, // bullish FVG below price (long) / bearish above (short)
//     recent_sweep_in_bias,    // counter-bias liquidity sweep within last 3 bars
//                              //   (counter-bias sweep IS bullish for our bias —
//                              //    the move that ran the wrong-side stops)
//     bonus_count,             // 0-3, sum of the four above (capped at 3)
//     summary_lines            // ≤6 lines for prompt injection
//   }
const RECENT_LOOKBACK = 5;
const SWEEP_LOOKBACK = 3;

export function computeSmcContext(bars, biasDirection = "none") {
  const empty = {
    swings: [], fvgs: [], last_bos: null, last_choch: null, sweeps: [],
    recent_choch_in_bias: false,
    recent_bos_in_bias: false,
    unmitigated_fvg_in_bias: false,
    recent_sweep_in_bias: false,
    bonus_count: 0,
    summary_lines: [],
  };
  if (!Array.isArray(bars) || bars.length < 5) return empty;

  const swings = findSwings(bars, 2);
  const fvgs = detectFVGs(bars);
  const { last_bos, last_choch } = detectBosChoCH(bars, swings);
  const sweeps = detectLiquiditySweeps(bars, swings, 0.001);

  const lastIdx = bars.length - 1;
  const lastClose = bars[lastIdx].close;

  const inBiasDir = (eventDir) => {
    if (biasDirection === "long") return eventDir === "bullish";
    if (biasDirection === "short") return eventDir === "bearish";
    return false;
  };
  const counterBiasDir = (eventDir) => {
    if (biasDirection === "long") return eventDir === "bearish";
    if (biasDirection === "short") return eventDir === "bullish";
    return false;
  };

  const recentChoch =
    last_choch &&
    lastIdx - last_choch.index <= RECENT_LOOKBACK &&
    inBiasDir(last_choch.direction);

  const recentBos =
    last_bos &&
    lastIdx - last_bos.index <= RECENT_LOOKBACK &&
    inBiasDir(last_bos.direction);

  // Unmitigated in-bias FVG that price has NOT yet revisited:
  //   long bias  → looking for a bullish FVG BELOW current price (support)
  //   short bias → bearish FVG ABOVE current price (resistance)
  const unmitigatedFvg = fvgs.some((f) => {
    if (f.mitigated_at !== null) return false;
    if (biasDirection === "long" && f.type === "bullish" && f.top < lastClose) return true;
    if (biasDirection === "short" && f.type === "bearish" && f.bottom > lastClose) return true;
    return false;
  });

  // A counter-bias sweep within the last few bars means stops on the WRONG
  // side just got run — bullish for our bias (the trapped-trader story the
  // user keeps citing).
  const recentSweep = sweeps.some((s) => {
    if (lastIdx - s.index > SWEEP_LOOKBACK) return false;
    // high_sweep ran buy-stops → counter-bias for short, in-bias-momentum
    // for long. For our purposes "counter-bias sweep" is the useful one.
    if (s.type === "high_sweep") return counterBiasDir("bullish"); // bullish event swept
    if (s.type === "low_sweep") return counterBiasDir("bearish");
    return false;
  });

  const bools = [recentChoch, recentBos, unmitigatedFvg, recentSweep];
  const bonusCount = Math.min(3, bools.filter(Boolean).length);

  const summary_lines = [];
  summary_lines.push(`SMC swings detected: ${swings.length} (last ${swings.length > 0 ? `${swings[swings.length - 1].type}@${fmtNum(swings[swings.length - 1].level)} ${lastIdx - swings[swings.length - 1].index} bars ago` : "none"})`);
  if (last_bos) {
    summary_lines.push(`Last BOS: ${last_bos.direction}@${fmtNum(last_bos.level)} (${lastIdx - last_bos.index} bars ago)`);
  } else {
    summary_lines.push("Last BOS: none in window");
  }
  if (last_choch) {
    summary_lines.push(`Last CHoCH: ${last_choch.direction}@${fmtNum(last_choch.level)} (${lastIdx - last_choch.index} bars ago)`);
  } else {
    summary_lines.push("Last CHoCH: none in window");
  }
  const openFvgs = fvgs.filter((f) => f.mitigated_at === null);
  if (openFvgs.length > 0) {
    const last = openFvgs[openFvgs.length - 1];
    summary_lines.push(`Unmitigated FVGs: ${openFvgs.length} (last ${last.type} ${fmtNum(last.bottom)}-${fmtNum(last.top)})`);
  } else {
    summary_lines.push("Unmitigated FVGs: none");
  }
  if (sweeps.length > 0) {
    const last = sweeps[0]; // already sorted most-recent-first
    summary_lines.push(`Last liquidity sweep: ${last.type}@${fmtNum(last.level)} (${lastIdx - last.index} bars ago)`);
  } else {
    summary_lines.push("Last liquidity sweep: none");
  }
  summary_lines.push(
    `Bias-aware bonus: choch=${recentChoch ? "Y" : "N"} bos=${recentBos ? "Y" : "N"} fvg=${unmitigatedFvg ? "Y" : "N"} counter_sweep=${recentSweep ? "Y" : "N"} → bonus_count=${bonusCount}`,
  );

  return {
    swings, fvgs, last_bos, last_choch, sweeps,
    recent_choch_in_bias: !!recentChoch,
    recent_bos_in_bias: !!recentBos,
    unmitigated_fvg_in_bias: !!unmitigatedFvg,
    recent_sweep_in_bias: !!recentSweep,
    bonus_count: bonusCount,
    summary_lines,
  };
}

function fmtNum(n) {
  if (typeof n !== "number") return String(n);
  // Adaptive precision: more digits for low-priced FX (USDCHF ~0.78) vs
  // indices (US30 ~38000).
  const abs = Math.abs(n);
  if (abs < 1) return n.toFixed(5);
  if (abs < 100) return n.toFixed(4);
  if (abs < 10000) return n.toFixed(2);
  return n.toFixed(0);
}

export function formatSmcContextForPrompt(smc) {
  if (!smc || !Array.isArray(smc.summary_lines) || smc.summary_lines.length === 0) {
    return "(SMC context unavailable — insufficient bar history)";
  }
  return [
    "## SMC ground truth (computed from OHLC — these are deterministic; do NOT estimate from pixels)",
    "",
    ...smc.summary_lines.map((l) => `- ${l}`),
  ].join("\n");
}
