/**
 * report.js — HTML email report generator for the v2-mtf-candle-verdict trading scanner.
 *
 * Exports:
 *   buildReport(scan)               → { html, attachments }
 *   writeReportToFile(scan, outPath) → void  (dev preview helper)
 */

import { existsSync, writeFileSync } from "fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function htmlEscape(str) {
  if (str == null) return "—";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function slugify(str) {
  if (!str) return "unknown";
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/** Format a UTC ISO string to a human-readable date (YYYY-MM-DD HH:mm UTC). */
function fmtDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
    );
  } catch {
    return htmlEscape(iso);
  }
}

/** Format USD cost with 4 decimal places. */
function fmtCost(n) {
  if (n == null || isNaN(n)) return "—";
  return `$${Number(n).toFixed(4)}`;
}

/** Map stop_reason to a human-readable label. */
function stopReasonLabel(reason) {
  if (!reason) return null;
  const map = {
    monthly_no_trend: "Monthly: no trend",
    monthly_weekly_disagree: "Monthly/Weekly disagree",
    weekly_no_setup: "Weekly: no setup",
    weekly_red_flag: "Weekly: red flag",
    weekly_quality_low: "Weekly: quality low",
    weekly_daily_disagree: "Weekly/Daily disagree",
    daily_no_trigger: "Daily: no trigger",
    llm_parse_error: "LLM parse error",
  };
  return map[reason] || htmlEscape(reason);
}

/**
 * Determine visual theme for a result row.
 * Returns { bg, text, border, label }
 */
function statusTheme(r) {
  const grade = r.confluence_grade;
  const state = r.daily?.state;
  const stop = r.stop_reason || "";

  // Candidates (full run completed)
  if (grade && grade !== "—") {
    if (state === "ENTER") {
      if (grade === "A+") return { bg: "#dcfce7", text: "#15803d", border: "#22c55e", label: "ENTER A+" };
      if (grade === "A")  return { bg: "#dcfce7", text: "#166534", border: "#16a34a", label: "ENTER A" };
      if (grade === "B")  return { bg: "#d1fae5", text: "#065f46", border: "#10b981", label: "ENTER B" };
    }
    if (state === "WATCH") {
      return { bg: "#fef9c3", text: "#854d0e", border: "#eab308", label: "WATCH C" };
    }
    // Grade but state not ENTER/WATCH — default green-ish
    return { bg: "#dcfce7", text: "#166534", border: "#16a34a", label: `${state || grade}` };
  }

  // Stopped early — color by stop reason
  if (stop === "monthly_no_trend" || stop === "daily_no_trigger") {
    return { bg: "#f3f4f6", text: "#6b7280", border: "#9ca3af", label: stopReasonLabel(stop) };
  }
  if (
    stop === "weekly_quality_low" ||
    stop === "weekly_no_setup" ||
    stop === "monthly_weekly_disagree" ||
    stop === "weekly_daily_disagree"
  ) {
    return { bg: "#e0f2fe", text: "#075985", border: "#0ea5e9", label: stopReasonLabel(stop) };
  }
  if (stop === "weekly_red_flag") {
    return { bg: "#ffedd5", text: "#9a3412", border: "#f97316", label: stopReasonLabel(stop) };
  }
  if (stop === "llm_parse_error" || stop.startsWith("error:")) {
    return { bg: "#fee2e2", text: "#991b1b", border: "#ef4444", label: stopReasonLabel(stop) };
  }

  // Fallback neutral
  return { bg: "#f9fafb", text: "#374151", border: "#d1d5db", label: stopReasonLabel(stop) || "—" };
}

/** Return direction icon (plain text, minimal emoji) */
function dirIcon(dir) {
  if (dir === "long")  return "📈 long";
  if (dir === "short") return "📉 short";
  return "— none";
}

/** Detect which TF image to show for stopped results. */
function stoppedTfKey(r) {
  const tf = r.stopped_at;
  if (tf === "1M") return "monthly";
  if (tf === "1W") return "weekly";
  if (tf === "1D") return "daily";
  return null;
}

// ---------------------------------------------------------------------------
// Attachment management
// ---------------------------------------------------------------------------

/**
 * Register an image for inline CID embedding if the file exists.
 * Returns { cid, exists } — use cid in the img src.
 */
function makeAttachment(symbol, tf, imagePath, attachments) {
  const cid = `${slugify(symbol)}-${tf}`;
  if (!imagePath) return { cid, exists: false };
  if (!existsSync(imagePath)) return { cid, exists: false, missingPath: imagePath };

  // Avoid duplicate attachments for the same cid
  const already = attachments.find((a) => a.cid === cid);
  if (!already) {
    const filename = `${slugify(symbol)}-${tf}.png`;
    attachments.push({ filename, path: imagePath, cid });
  }
  return { cid, exists: true };
}

// ---------------------------------------------------------------------------
// HTML sub-components (all inline styles, no <style> blocks)
// ---------------------------------------------------------------------------

const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;

function renderCandleVerdict(cv) {
  if (!cv) return `<span style="color:#9ca3af;font-size:12px;">candle verdict unavailable</span>`;

  const rows = [
    ["Pattern", htmlEscape(cv.pattern)],
    ["Body", `${cv.body_pct_of_range ?? "—"}% of range (${htmlEscape(cv.body_type)})`],
    ["Upper wick", `${cv.upper_wick_pct ?? "—"}%`],
    ["Lower wick", `${cv.lower_wick_pct ?? "—"}%`],
    ["Close position", htmlEscape(cv.close_position)],
    ["Winner", `${htmlEscape(cv.winner)} (strength: ${cv.winner_strength ?? "—"})`],
    ["Liquidity swept", htmlEscape(cv.liquidity_swept)],
    ["In bias", cv.in_bias ? "Yes" : "No"],
  ];

  const rowsHtml = rows
    .map(
      ([k, v]) =>
        `<tr>
          <td style="padding:3px 8px 3px 0;color:#6b7280;font-size:11px;white-space:nowrap;font-family:${FONT};">${k}</td>
          <td style="padding:3px 0;font-size:11px;color:#374151;font-family:${FONT};">${v}</td>
        </tr>`
    )
    .join("");

  return `
    <table style="border-collapse:collapse;margin-top:4px;">
      <tbody>${rowsHtml}</tbody>
    </table>
    <p style="margin:6px 0 0 0;font-size:11px;color:#4b5563;font-style:italic;font-family:${FONT};">
      ${htmlEscape(cv.verdict)}
    </p>`;
}

function renderImage(symbol, tf, imagePath, attachments) {
  const { cid, exists, missingPath } = makeAttachment(symbol, tf, imagePath, attachments);

  if (!exists) {
    const msg = missingPath
      ? `[screenshot unavailable: ${htmlEscape(missingPath)}]`
      : `[screenshot unavailable]`;
    return `<p style="color:#6b7280;font-size:12px;font-family:${FONT};margin:4px 0;">${msg}</p>`;
  }

  return `<img src="cid:${cid}" alt="${htmlEscape(symbol)} ${tf}" style="max-width:680px;width:100%;height:auto;border:1px solid #e5e7eb;display:block;margin:6px 0;" />`;
}

function renderTfBlock(label, cell, symbol, tfKey, attachments) {
  if (!cell) {
    return `<div style="margin-bottom:16px;">
      <p style="font-size:12px;color:#9ca3af;font-family:${FONT};margin:0;">${label}: not analysed</p>
    </div>`;
  }

  const tf = cell.tf || tfKey.toUpperCase().replace("LY", "").replace("WEEK", "1W").replace("MONTH", "1M").replace("DAIL", "1D");
  const imageHtml = renderImage(symbol, tf, cell.image, attachments);

  return `
    <div style="margin-bottom:24px;">
      <h4 style="margin:0 0 6px 0;font-size:13px;font-weight:600;color:#374151;font-family:${FONT};border-bottom:1px solid #e5e7eb;padding-bottom:4px;">
        ${htmlEscape(label)} (${htmlEscape(cell.tf || tf)})
        ${cell.direction ? ` — ${dirIcon(cell.direction)}` : ""}
        ${cell.score != null ? ` — Score: ${cell.score}/10` : ""}
        ${cell.state ? ` — State: <strong>${htmlEscape(cell.state)}</strong>` : ""}
      </h4>
      ${imageHtml}
      <div style="margin-top:6px;">
        ${renderCandleVerdict(cell.candle_verdict)}
      </div>
      ${cell.reasoning ? `<p style="margin:8px 0 0 0;font-size:12px;color:#374151;font-family:${FONT};">${htmlEscape(cell.reasoning)}</p>` : ""}
      ${cell.red_flags && cell.red_flags.length
        ? `<p style="margin:4px 0 0 0;font-size:11px;color:#9a3412;font-family:${FONT};">
            Red flags: ${cell.red_flags.map(htmlEscape).join(", ")}
           </p>`
        : ""}
    </div>`;
}

function renderCandidateCard(r, attachments) {
  const theme = statusTheme(r);
  const monthDir = r.monthly?.direction || "—";

  const gradeBadge = (grade) => {
    let bg = "#d1fae5", color = "#065f46";
    if (grade === "A+") { bg = "#dcfce7"; color = "#15803d"; }
    else if (grade === "A") { bg = "#dcfce7"; color = "#166534"; }
    else if (grade === "B") { bg = "#d1fae5"; color = "#065f46"; }
    else if (grade === "C") { bg = "#fef9c3"; color = "#854d0e"; }
    return `<span style="display:inline-block;padding:4px 14px;border-radius:9999px;font-size:20px;font-weight:700;background:${bg};color:${color};font-family:${FONT};">${htmlEscape(grade)}</span>`;
  };

  const stateBadge = (state) => {
    const c = state === "ENTER" ? "#15803d" : "#854d0e";
    const bg = state === "ENTER" ? "#dcfce7" : "#fef9c3";
    return `<span style="display:inline-block;padding:2px 10px;border-radius:4px;font-size:13px;font-weight:600;background:${bg};color:${c};font-family:${FONT};">${htmlEscape(state)}</span>`;
  };

  // Decide which TF images to include for candidates: all 3 (if image exists)
  const monthlyBlock = renderTfBlock("Monthly", r.monthly, r.symbol, "1M", attachments);
  const weeklyBlock  = renderTfBlock("Weekly",  r.weekly,  r.symbol, "1W", attachments);
  const dailyBlock   = renderTfBlock("Daily",   r.daily,   r.symbol, "1D", attachments);

  return `
    <div style="margin-bottom:32px;border:1px solid ${theme.border};border-left:5px solid ${theme.border};border-radius:6px;overflow:hidden;background:#ffffff;">
      <!-- Card header -->
      <div style="background:${theme.bg};padding:14px 16px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <span style="font-size:20px;font-weight:700;color:${theme.text};font-family:${FONT};">${htmlEscape(r.symbol)}</span>
          <span style="margin-left:10px;font-size:13px;color:#6b7280;font-family:${FONT};">${htmlEscape(r.tv_symbol)}</span>
          <span style="margin-left:12px;font-size:13px;font-family:${FONT};">${dirIcon(monthDir)}</span>
        </div>
        <div style="text-align:right;">
          ${gradeBadge(r.confluence_grade)}
          ${r.daily?.state ? `<div style="margin-top:4px;">${stateBadge(r.daily.state)}</div>` : ""}
        </div>
      </div>

      <!-- Daily reasoning highlighted -->
      ${r.daily?.reasoning ? `
      <div style="padding:12px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb;">
        <p style="margin:0;font-size:13px;color:#1e293b;font-family:${FONT};">
          <strong>Daily outlook:</strong> ${htmlEscape(r.daily.reasoning)}
        </p>
        ${r.daily.trigger_type && r.daily.trigger_type !== "none"
          ? `<p style="margin:4px 0 0 0;font-size:12px;color:#374151;font-family:${FONT};">
              Trigger: <strong>${htmlEscape(r.daily.trigger_type)}</strong>
              ${r.daily.prep_signals_count != null ? ` &nbsp;|&nbsp; Prep signals: ${r.daily.prep_signals_count}/4` : ""}
             </p>`
          : ""}
      </div>` : ""}

      <!-- TF screenshots + verdicts -->
      <div style="padding:16px;">
        ${monthlyBlock}
        ${weeklyBlock}
        ${dailyBlock}
        <p style="margin:0;font-size:11px;color:#9ca3af;font-family:${FONT};">LLM cost: ${fmtCost(r.cost_usd)}</p>
      </div>
    </div>`;
}

function renderStoppedRow(r, index, attachments) {
  const theme = statusTheme(r);

  // For stopped results — attach the TF image that caused the stop, and
  // keep a reference so we can render it right under the row (justification).
  const stopTfKey = stoppedTfKey(r);
  let stopImgTag = "";
  if (stopTfKey && r[stopTfKey]?.image) {
    const tfLabel = r[stopTfKey].tf || r.stopped_at || stopTfKey;
    const { cid, exists, missingPath } = makeAttachment(
      r.symbol,
      tfLabel,
      r[stopTfKey].image,
      attachments,
    );
    if (exists) {
      stopImgTag = `<img src="cid:${cid}" alt="${htmlEscape(r.symbol)} ${tfLabel}" style="max-width:480px;width:100%;height:auto;border:1px solid #e5e7eb;display:block;margin:4px 0;" />`;
    } else {
      stopImgTag = `<p style="color:#6b7280;font-size:11px;font-style:italic;margin:4px 0;">[screenshot unavailable: ${htmlEscape(missingPath || "")}]</p>`;
    }
  }

  const monthDir = r.monthly?.direction || "—";
  const dailyState = r.daily?.state || "—";

  // Rationale: prefer daily reasoning, then weekly, then monthly
  const rationale =
    (r.daily?.reasoning || r.weekly?.reasoning || r.monthly?.reasoning || "").slice(0, 200);

  const zebra = index % 2 === 0 ? "#ffffff" : "#f9fafb";
  const rowBg = theme.bg !== "#f9fafb" ? theme.bg : zebra;

  const mainRow = `
    <tr style="background:${rowBg};border-left:4px solid ${theme.border};">
      <td style="padding:8px 10px;font-size:13px;font-weight:600;color:#111827;font-family:${FONT};white-space:nowrap;">${htmlEscape(r.symbol)}</td>
      <td style="padding:8px 10px;font-size:12px;color:#374151;font-family:${FONT};white-space:nowrap;">${dirIcon(monthDir)}</td>
      <td style="padding:8px 10px;font-size:12px;color:#374151;font-family:${FONT};white-space:nowrap;">${htmlEscape(dailyState)}</td>
      <td style="padding:8px 10px;font-size:12px;font-family:${FONT};white-space:nowrap;">
        <span style="padding:2px 8px;border-radius:3px;background:${theme.bg};color:${theme.text};border:1px solid ${theme.border};font-size:11px;">${htmlEscape(theme.label)}</span>
      </td>
      <td style="padding:8px 10px;font-size:11px;color:#6b7280;font-family:${FONT};">${htmlEscape(rationale)}${rationale.length >= 200 ? "…" : ""}</td>
    </tr>`;

  // Second row spans all 5 columns with the stop-TF screenshot as visual
  // justification. Only rendered if an image exists.
  const imageRow = stopImgTag
    ? `
    <tr style="background:${rowBg};border-left:4px solid ${theme.border};">
      <td colspan="5" style="padding:4px 10px 12px 10px;">${stopImgTag}</td>
    </tr>`
    : "";

  return mainRow + imageRow;
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export function buildReport(scan) {
  const attachments = [];
  const results = scan.results || [];

  // Separate candidates (grade !== "—") from filtered
  const candidates = results.filter((r) => r.confluence_grade && r.confluence_grade !== "—");
  const filtered   = results.filter((r) => !r.confluence_grade || r.confluence_grade === "—");

  // Grade breakdown for header subtitle
  const gradeCounts = {};
  for (const r of candidates) {
    const g = r.confluence_grade;
    gradeCounts[g] = (gradeCounts[g] || 0) + 1;
  }
  const gradeBreakdown = ["A+", "A", "B", "C"]
    .filter((g) => gradeCounts[g])
    .map((g) => `${gradeCounts[g]} ${g}`)
    .join(", ");

  const totalCost = results.reduce((sum, r) => sum + (r.cost_usd || 0), 0);

  const scanDate = scan.started_at
    ? new Date(scan.started_at).toISOString().slice(0, 10)
    : "—";

  // Build candidates section
  const candidatesHtml = candidates.length
    ? candidates.map((r) => renderCandidateCard(r, attachments)).join("")
    : `<p style="color:#6b7280;font-size:13px;font-family:${FONT};padding:16px 0;">No candidates found this scan.</p>`;

  // Build full-report table (all symbols)
  const allRows = results
    .map((r, i) => renderStoppedRow(r, i, attachments))
    .join("");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Trading Scan — ${htmlEscape(scanDate)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;">

  <!-- Outer wrapper -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0;">
    <tr>
      <td align="center">
        <!-- Inner container -->
        <table width="720" cellpadding="0" cellspacing="0" style="max-width:720px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">

          <!-- ===== HEADER ===== -->
          <tr>
            <td style="background:#0f172a;padding:24px 28px;">
              <h1 style="margin:0;font-size:22px;font-weight:700;color:#f8fafc;font-family:${FONT};">
                Daily Trading Scan — ${htmlEscape(scanDate)}
              </h1>
              <p style="margin:6px 0 0 0;font-size:13px;color:#94a3b8;font-family:${FONT};">
                ${candidates.length} candidate${candidates.length !== 1 ? "s" : ""}
                ${gradeBreakdown ? `(${gradeBreakdown})` : ""}
                &nbsp;&bull;&nbsp;
                ${filtered.length} filtered out
                &nbsp;&bull;&nbsp;
                ${results.length} total symbols
              </p>
              <p style="margin:4px 0 0 0;font-size:11px;color:#64748b;font-family:${FONT};">
                Pipeline: ${htmlEscape(scan.pipeline || "—")}
              </p>
            </td>
          </tr>

          <!-- ===== CANDIDATES SECTION ===== -->
          <tr>
            <td style="padding:24px 28px 8px 28px;">
              <h2 style="margin:0 0 16px 0;font-size:16px;font-weight:700;color:#111827;font-family:${FONT};border-bottom:2px solid #e5e7eb;padding-bottom:8px;">
                Trade Candidates
              </h2>
              ${candidatesHtml}
            </td>
          </tr>

          <!-- ===== FULL SCAN TABLE ===== -->
          <tr>
            <td style="padding:8px 28px 24px 28px;">
              <h2 style="margin:0 0 12px 0;font-size:16px;font-weight:700;color:#111827;font-family:${FONT};border-bottom:2px solid #e5e7eb;padding-bottom:8px;">
                Full Scan Summary
              </h2>
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-family:${FONT};">
                <thead>
                  <tr style="background:#f8fafc;">
                    <th style="padding:8px 10px;text-align:left;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb;white-space:nowrap;">Symbol</th>
                    <th style="padding:8px 10px;text-align:left;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb;white-space:nowrap;">Bias</th>
                    <th style="padding:8px 10px;text-align:left;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb;white-space:nowrap;">State</th>
                    <th style="padding:8px 10px;text-align:left;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb;white-space:nowrap;">Status</th>
                    <th style="padding:8px 10px;text-align:left;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb;">Rationale</th>
                  </tr>
                </thead>
                <tbody>
                  ${allRows}
                </tbody>
              </table>
            </td>
          </tr>

          <!-- ===== FOOTER ===== -->
          <tr>
            <td style="background:#f8fafc;border-top:1px solid #e5e7eb;padding:16px 28px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size:11px;color:#6b7280;font-family:${FONT};">
                    Total LLM cost: <strong>${fmtCost(totalCost)}</strong>
                    &nbsp;&bull;&nbsp;
                    Pipeline: ${htmlEscape(scan.pipeline || "—")}
                  </td>
                  <td style="font-size:11px;color:#9ca3af;text-align:right;font-family:${FONT};">
                    Started: ${fmtDate(scan.started_at)}<br />
                    Finished: ${fmtDate(scan.finished_at)}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;

  return { html, attachments };
}

// ---------------------------------------------------------------------------
// Dev preview helper
// ---------------------------------------------------------------------------

export function writeReportToFile(scan, outPath) {
  const { html } = buildReport(scan);
  writeFileSync(outPath, html);
}
