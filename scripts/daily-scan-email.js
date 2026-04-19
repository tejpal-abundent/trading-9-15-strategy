#!/usr/bin/env node
// Runs the V2 scan, builds the HTML report, emails it. Entry point for
// the user's cron job.
//
// Usage:
//   node scripts/daily-scan-email.js
//       → run a fresh scan, build report, send email
//
//   node scripts/daily-scan-email.js --dry-run
//       → run a fresh scan, write HTML to /tmp, skip email
//
//   node scripts/daily-scan-email.js --from-json=scan-results/latest-scan-v2.json
//       → skip scan, build report from an existing JSON (for fast iteration)
//
//   node scripts/daily-scan-email.js --from-json=<path> --dry-run
//       → same as above but also skip email (local preview workflow)
//
//   EMAIL_TO=other@example.com node scripts/daily-scan-email.js
//       → override recipient

import "dotenv/config";
import { readFileSync } from "fs";
import { runScanV2 } from "../src/scanner.js";
import { buildReport, writeReportToFile } from "../src/report.js";
import { sendEmail } from "../src/email.js";

const DRY_RUN = process.argv.includes("--dry-run");
const FROM_JSON_ARG = process.argv.find((a) => a.startsWith("--from-json="));
const EMAIL_TO = process.env.EMAIL_TO || "thetajas@gmail.com";

async function main() {
  console.log(`\n🌙 Daily scan + email — ${new Date().toISOString()}`);
  console.log(`   Recipient: ${EMAIL_TO}`);
  console.log(`   Mode: ${DRY_RUN ? "DRY RUN (no email)" : "LIVE"}\n`);

  // 1. Obtain a scan — either fresh or from a saved JSON
  let scan;
  if (FROM_JSON_ARG) {
    const p = FROM_JSON_ARG.split("=")[1];
    scan = JSON.parse(readFileSync(p, "utf8"));
    console.log(`   Loaded scan from ${p} (skipping fresh scan)\n`);
  } else {
    scan = await runScanV2();
  }

  // 2. Build the report (HTML + attachment manifest)
  const { html, attachments } = buildReport(scan);

  if (DRY_RUN) {
    const outPath = `/tmp/daily-scan-${scan.started_at.replace(/[:.]/g, "-")}.html`;
    writeReportToFile(scan, outPath);
    console.log(`\n📄 Dry run — HTML written to ${outPath}`);
    console.log(
      `   Attachments that would have been sent: ${attachments.length}`,
    );
    return;
  }

  // 3. Send the email
  const dateStr = scan.started_at.slice(0, 10);
  const candCount = scan.results.filter(
    (r) => r.confluence_grade !== "—",
  ).length;
  const subject = `Daily Scan — ${dateStr} — ${candCount} candidate${candCount === 1 ? "" : "s"}`;

  console.log(`\n📧 Sending email (${attachments.length} attachments) ...`);
  const result = await sendEmail({ to: EMAIL_TO, subject, html, attachments });
  console.log(`✅ Sent — messageId=${result.messageId}`);
}

main().catch((err) => {
  console.error("❌ Daily scan failed:", err);
  process.exit(1);
});
