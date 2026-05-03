// Cluster maps for post-scan correlation dedupe.
//
// Top swing traders cap correlated risk: four EUR longs is one trade with four
// position sizes. After the cascade produces ENTER/WATCH candidates, we group
// them by cluster + direction and keep only the top N per cluster (ranked by
// confluence_grade then rr_ratio). The rest move to `clustered_out` so nothing
// is silently dropped — they show on the report card with a clear reason.
//
// Pure data + pure functions. No I/O. Imported by src/scanner.js.

// FX cluster derivation: for "EURUSD" return both "EUR" and "USD"; for "BTCUSDT"
// return ["BTC","USDT"] etc. Strips the venue prefix if present.
function stripVenue(label) {
  const idx = label.indexOf(":");
  return idx >= 0 ? label.slice(idx + 1) : label;
}

// FX/metals 6-letter pairs (EURUSD, XAUUSD, USDJPY, ...). Returns [base, quote]
// when the symbol matches the 6-letter pattern, else null.
function fxLegs(label) {
  const sym = stripVenue(label).toUpperCase();
  if (!/^[A-Z]{6}$/.test(sym)) return null;
  return [sym.slice(0, 3), sym.slice(3, 6)];
}

// Crypto cluster map: any symbol in the same row counts as the same cluster.
// Quote currency is stripped (USDT/USD/USDC) before lookup. Hand-curated; add
// to it as the watchlist grows.
const CRYPTO_CLUSTERS = {
  majors:    new Set(["BTC", "ETH"]),
  l1_alts:   new Set(["SOL", "AVAX", "BNB", "ADA", "TRX", "TON", "NEAR", "APT", "SUI"]),
  l2:        new Set(["MATIC", "ARB", "OP", "STRK", "BASE"]),
  defi:      new Set(["UNI", "AAVE", "LDO", "MKR", "CRV", "COMP"]),
  memes:     new Set(["DOGE", "SHIB", "PEPE", "WIF", "BONK"]),
};

// Quotes that ONLY appear on crypto pairs (no FX collisions). Stripping these
// is unambiguous.
const CRYPTO_QUOTES_UNAMBIGUOUS = new Set(["USDT", "USDC", "BUSD", "FDUSD", "DAI"]);
// USD also acts as a quote on FX (EURUSD, XAUUSD), so we only strip it when
// the resulting base is in one of the known crypto cluster sets.
const CRYPTO_QUOTES_AMBIGUOUS = new Set(["USD"]);

// Set of all known crypto bases (flattened from CRYPTO_CLUSTERS).
function knownCryptoBases() {
  const out = new Set();
  for (const set of Object.values(CRYPTO_CLUSTERS)) {
    for (const b of set) out.add(b);
  }
  return out;
}
const KNOWN_CRYPTO_BASES = knownCryptoBases();

// Strip a known crypto quote suffix from a ticker and return the base.
// Returns null when neither (a) the suffix is unambiguous nor (b) the base is
// a recognised crypto symbol — this stops EURUSD/XAUUSD from being mis-parsed
// as crypto.
function cryptoBase(label) {
  const sym = stripVenue(label).toUpperCase();
  for (const q of CRYPTO_QUOTES_UNAMBIGUOUS) {
    if (sym.endsWith(q) && sym.length > q.length) return sym.slice(0, sym.length - q.length);
  }
  for (const q of CRYPTO_QUOTES_AMBIGUOUS) {
    if (sym.endsWith(q) && sym.length > q.length) {
      const base = sym.slice(0, sym.length - q.length);
      if (KNOWN_CRYPTO_BASES.has(base)) return base;
    }
  }
  return null;
}

// Indices + commodities are correlated by macro risk-on/off. Hand-grouped.
const INDEX_COMMODITY_CLUSTERS = {
  us_indices:        new Set(["US30", "US30USD", "SPX", "SPX500", "NAS100", "US500", "NDX", "NDQ100"]),
  global_indices:    new Set(["GER40", "DE30EUR", "DE40", "UK100", "JP225", "HK50", "HK33HKD", "AU200", "FRA40"]),
  energy:            new Set(["USOIL", "UKOIL", "BRENT", "WTICO", "NGAS"]),
  precious_metals:   new Set(["XAUUSD", "XAGUSD", "GOLD", "SILVER"]),
};

// Equities: bucket the watchlisted single names by sector. Cheap, hand-curated.
const EQUITY_CLUSTERS = {
  mega_tech: new Set(["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA"]),
  ev_auto:   new Set(["TSLA", "RIVN", "LCID", "F", "GM"]),
};

// Returns the cluster IDs a given watchlist label belongs to (one symbol can
// belong to multiple — e.g., EURUSD is in cluster "fx_EUR" and "fx_USD"). The
// dedupe pass groups by (clusterId, direction); a symbol that shares ANY
// cluster with a higher-ranked symbol in the same direction is a candidate
// for demotion.
//
// Returned IDs are namespaced ("fx_EUR", "crypto_majors", "indices_us", ...)
// so two unrelated 3-letter codes can't collide.
//
// Lookup order matters: precious metals + indices come BEFORE FX parsing so
// XAUUSD is treated as a precious-metals cluster (correlated with XAGUSD)
// rather than as the FX leg "XAU".
export function clustersForLabel(label) {
  if (!label || typeof label !== "string") return [];
  const upper = stripVenue(label).toUpperCase();

  // Indices + commodities first — beats the FX parser on tickers like XAUUSD
  // and gives them their actual macro cluster.
  for (const [name, set] of Object.entries(INDEX_COMMODITY_CLUSTERS)) {
    if (set.has(upper)) return [`idx_${name}`];
  }

  // Equities second — also beats FX parsing on 4-letter tickers like AAPL.
  for (const [name, set] of Object.entries(EQUITY_CLUSTERS)) {
    if (set.has(upper)) return [`equity_${name}`];
  }

  // Crypto — try the quote-strip lookup before FX so symbols like SOLUSDT
  // don't accidentally parse as 6-letter FX (they wouldn't, but BTCUSD would).
  const base = cryptoBase(label);
  if (base) {
    const out = [];
    for (const [name, set] of Object.entries(CRYPTO_CLUSTERS)) {
      if (set.has(base)) out.push(`crypto_${name}`);
    }
    if (out.length > 0) return out;
    // Quote suffix matched a known crypto quote but base isn't in any map —
    // bucket alone so it doesn't dedupe against unrelated coins.
    return [`crypto_other_${base}`];
  }

  // FX / metals last: 6-letter pair → both legs (deduped if base == quote).
  const legs = fxLegs(label);
  if (legs) {
    const out = [`fx_${legs[0]}`];
    if (legs[1] !== legs[0]) out.push(`fx_${legs[1]}`);
    return out;
  }

  // Catch-all — symbol is alone in its own cluster (won't dedupe against anything).
  return [`solo_${upper}`];
}

// Direction extracted from a result row: prefer weekly, fall back to monthly.
// Returns "long" | "short" | null. Used as half of the cluster grouping key.
export function directionFromResult(r) {
  if (!r) return null;
  return r.weekly?.direction || r.monthly?.direction || null;
}

// Default per-cluster cap. Top swing traders typically take 1-2 trades per
// correlated cluster; 2 lets the strategy hold both legs of a strong move
// (e.g., EURUSD long + GBPUSD long both against weak USD) but caps risk.
export const DEFAULT_CLUSTER_KEEP = 2;

// Grade ranking — same order as src/scanner.js v2SummaryLine. Lower = better.
const GRADE_RANK = { "A+": 0, A: 1, B: 2, C: 3, "—": 4 };

function gradeRank(g) {
  return GRADE_RANK[g] ?? 5;
}

// Sort key for a candidate within a cluster: best grade first, then best RR,
// then highest probability_next_candle_in_bias as final tiebreak.
function compareCandidates(a, b) {
  const ga = gradeRank(a.confluence_grade);
  const gb = gradeRank(b.confluence_grade);
  if (ga !== gb) return ga - gb;
  const rra = a.daily?.trade_plan?.rr_ratio ?? 0;
  const rrb = b.daily?.trade_plan?.rr_ratio ?? 0;
  if (rra !== rrb) return rrb - rra;
  const pa = a.daily?.probability_next_candle_in_bias ?? 0;
  const pb = b.daily?.probability_next_candle_in_bias ?? 0;
  return pb - pa;
}

// Pure: given the full results array from a v2 scan, mark up to `keep` results
// per (cluster, direction) bucket. Returns a NEW array of result objects with
// `cluster_decision = { kept: bool, clusters: [...], dominant_cluster, reason }`
// attached to every ENTER/WATCH candidate. Stops are passed through unchanged
// (no cluster_decision attached).
//
// We don't mutate the input. The caller (runScanV2) writes the new array back
// into the payload + uses cluster_decision.kept to filter the candidates list
// and to surface a `clustered_out` section on the report.
export function clusterDedupe(results, opts = {}) {
  const keep = Math.max(1, opts.keep ?? DEFAULT_CLUSTER_KEEP);
  if (!Array.isArray(results)) return results;

  // Annotate each candidate with its clusters + sortable position.
  const candidates = [];
  const others = [];
  for (const r of results) {
    if (!r) continue;
    const isCandidate = r.confluence_grade && r.confluence_grade !== "—";
    if (!isCandidate) {
      others.push(r);
      continue;
    }
    candidates.push({
      ref: r,
      clusters: clustersForLabel(r.symbol),
      direction: directionFromResult(r),
    });
  }

  // Stable sort candidates best→worst so we always KEEP the strongest first
  // and the demotions are deterministic.
  candidates.sort((a, b) => compareCandidates(a.ref, b.ref));

  // Per-bucket count: bucket key = `${clusterId}|${direction}`.
  const bucketCount = new Map();
  const annotated = [];

  for (const c of candidates) {
    if (!c.direction) {
      // No direction → nothing to cluster against. Keep, no decision.
      annotated.push({ ...c.ref, cluster_decision: { kept: true, clusters: c.clusters, dominant_cluster: null, reason: "no_direction" } });
      continue;
    }
    // A candidate is demoted if ANY cluster it touches is already at
    // capacity in this direction. This matches how a top trader thinks:
    // if I already have 2 EUR longs (EURUSD + EURGBP) at cap on fx_EUR,
    // EURJPY is duplicated EUR exposure — even though fx_JPY is still empty.
    let dominantFullCluster = null;
    for (const cl of c.clusters) {
      const key = `${cl}|${c.direction}`;
      const count = bucketCount.get(key) ?? 0;
      if (count >= keep) {
        dominantFullCluster = cl;
        break;
      }
    }

    if (dominantFullCluster !== null) {
      annotated.push({
        ...c.ref,
        cluster_decision: {
          kept: false,
          clusters: c.clusters,
          dominant_cluster: dominantFullCluster,
          reason: `cluster_full_${c.direction}`,
        },
      });
      continue;
    }

    // Keep — increment EVERY one of its cluster counters so future weaker
    // candidates in any of the same clusters see them filled.
    for (const cl of c.clusters) {
      const key = `${cl}|${c.direction}`;
      bucketCount.set(key, (bucketCount.get(key) ?? 0) + 1);
    }
    annotated.push({
      ...c.ref,
      cluster_decision: {
        kept: true,
        clusters: c.clusters,
        dominant_cluster: c.clusters[0] ?? null,
        reason: "kept",
      },
    });
  }

  // Re-merge: preserve the original order, but swap in annotated copies.
  const annotatedById = new Map();
  for (const a of annotated) annotatedById.set(a.symbol, a);
  return results.map((r) => annotatedById.get(r?.symbol) ?? r);
}
