import { readFileSync } from "node:fs";

// loadScanCells: opens a scan-results JSON and returns a Map<symbol, {monthly, weekly, daily}>.
// Each cell is the raw cell as the LLM returned it (already passed through the OLD validator
// once at scan time — that's fine; the replay engine handles re-application idempotently).
export function loadScanCells(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const out = new Map();
  for (const r of raw.results || []) {
    out.set(r.symbol, {
      monthly: r.monthly,
      weekly: r.weekly,
      daily: r.daily,
      stored: {
        stopped_at: r.stopped_at,
        stop_reason: r.stop_reason,
        confluence_grade: r.confluence_grade,
      },
    });
  }
  return out;
}

// loadFreshSnapshot: opens a single-symbol snapshot JSON from docs/golden-set/snapshots/
// and returns it in the same {monthly, weekly, daily} shape.
export function loadFreshSnapshot(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return {
    monthly: raw.monthly,
    weekly: raw.weekly,
    daily: raw.daily,
    stored: null,  // fresh snapshots are not previously evaluated; no stored verdict
  };
}

// loadGolden: parses the golden-set CSV into an array of row objects.
// Schema documented in docs/superpowers/specs/2026-05-02-gate-recalibration-design.md §5.
export function loadGolden(path) {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((s) => s.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length !== header.length) continue;
    const row = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = cols[j];
    }
    rows.push(row);
  }
  return rows;
}

// Minimal CSV line parser supporting double-quoted fields with commas inside.
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
