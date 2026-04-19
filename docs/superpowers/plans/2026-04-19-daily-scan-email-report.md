# Daily Scan Email Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a cron-ready script that runs the V2 scan, generates a color-coded HTML report with inline screenshots, and emails it to `thetajas@gmail.com`. Screenshots are timestamped per-capture so historical scans are preserved.

**Architecture:**
- `scripts/daily-scan-email.js` — entry point for cron (runs `runScanV2`, builds report, sends email)
- `src/report.js` — pure HTML generator from a scan result + chosen screenshots
- `src/email.js` — thin Nodemailer wrapper with SMTP config
- Screenshots move from `screenshots/{SYMBOL}/{TF}.png` (overwritten) to `screenshots/{YYYY-MM-DD}/{SYMBOL}/{TF}.png` (date-partitioned)

**Tech Stack:** Node 18+, `nodemailer` (SMTP), existing scanner pipeline. Email delivery via Gmail SMTP (recipient's own account, using a Google app password).

**Cron timing the user wants:** Every night 4 AM IST (= 22:30 UTC the prior day). User will install crontab themselves; we ship a runnable `node scripts/daily-scan-email.js` command and document the crontab line.

---

## File Structure

### Files to create

| Path | Purpose |
|---|---|
| `src/report.js` | Renders scan result → HTML report with color-coded status + inline CID image refs |
| `src/email.js` | `sendEmail({to, subject, html, attachments})` — Nodemailer + SMTP |
| `scripts/daily-scan-email.js` | CLI entry: run scan → build report → send email (or `--dry-run` to write HTML to file) |

### Files to modify

| Path | Change |
|---|---|
| `src/tv-navigate.js` | `captureSymbolTf` accepts an optional `dateDir` and writes to `screenshots/{dateDir}/{slug}/{tf}.png` when supplied, falls back to legacy layout when not |
| `src/scanner.js` | `runScanV2` passes today's date dir into each cell evaluator; cell results carry the new `image` path |
| `package.json` | Add `nodemailer` dependency |
| `.env.example` | Document `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `EMAIL_TO` |
| `README.md` | Append section: "Daily email report — setup & cron" |

### Status color coding (in email)

| State | Color | Example |
|---|---|---|
| ENTER + grade A+/A | 🟢 `#22c55e` (bright green) | GBPAUD SHORT |
| ENTER + grade B | 🟢 `#16a34a` (green) | XAUUSD LONG |
| WATCH (grade C) | 🟡 `#eab308` (yellow) | AUDUSD LONG |
| monthly_no_trend / daily_no_trigger | ⚫ `#6b7280` (gray, neutral) | NZDUSD |
| weekly_quality_low / no_setup / disagree | 🔵 `#0ea5e9` (blue, informational) | ETHUSDT |
| weekly_red_flag | 🟠 `#f97316` (orange, caution) | SOLUSDT |
| llm_parse_error | 🔴 `#ef4444` (red, tooling issue) | — |

### Screenshot inclusion policy

- **Candidates** (A+/A/B/C — state ENTER or WATCH): include all 3 TF screenshots (Monthly + Weekly + Daily) inline.
- **Stopped symbols**: include ONLY the screenshot from the timeframe that caused the stop (usually weekly). Keeps email under Gmail's 25 MB limit.
- **Parse-error symbols**: include the last-captured screenshot + a note about which model returned garbage.

---

## Task 1: Add nodemailer dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install nodemailer**

```bash
cd /Users/tejpalkumawat/Documents/buildfactory/claude-tradingview-mcp-trading
npm install nodemailer
```

- [ ] **Step 2: Verify package.json updated**

```bash
grep nodemailer package.json
```

Expected: `"nodemailer": "^..."` in dependencies.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add nodemailer for daily email report"
```

---

## Task 2: Add date-partitioned screenshot capture

**Files:**
- Modify: `src/tv-navigate.js`

- [ ] **Step 1: Update `captureSymbolTf` signature**

Find the existing `captureSymbolTf` function and add an optional `dateDir` parameter. When provided, the output path becomes `screenshots/{dateDir}/{slug}/{tf}.png`. When absent, fall back to legacy `screenshots/{slug}/{tf}.png`.

The function signature becomes:
```javascript
export async function captureSymbolTf(client, slug, timeframe, expectedSymbol = null, dateDir = null) {
  const baseDir = dateDir
    ? resolve("screenshots", dateDir, slug)
    : resolve("screenshots", slug);
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  const path = resolve(baseDir, `${timeframe}.png`);
  // ... rest unchanged
}
```

- [ ] **Step 2: Syntax check**

```bash
node --check src/tv-navigate.js
```

- [ ] **Step 3: Commit**

```bash
git add src/tv-navigate.js
git commit -m "feat(tv-navigate): support date-partitioned screenshot directory"
```

---

## Task 3: Plumb `dateDir` through scanner V2

**Files:**
- Modify: `src/scanner.js`

- [ ] **Step 1: Compute `dateDir` once per scan**

In `runScanV2`, compute a single date string at the top:

```javascript
const dateDir = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
```

Pass it through to `evaluateSymbolV2` via `opts`:

```javascript
const r = await evaluateSymbolV2(client, item, rubrics, { verbose: true, dateDir });
```

- [ ] **Step 2: Thread `dateDir` into each cell evaluator**

In `evaluateSymbolV2`, pass `opts.dateDir` into all three calls:

```javascript
result.monthly = await evaluateMonthlyCell(client, item, rubrics.monthlyRubric, opts.dateDir);
result.weekly  = await evaluateWeeklyCell(client, item, result.monthly, rubrics.weeklyRubric, opts.dateDir);
result.daily   = await evaluateDailyCell(client, item, result.monthly, result.weekly, rubrics.dailyRubric, opts.dateDir);
```

Update `evaluateMonthlyCell`, `evaluateWeeklyCell`, `evaluateDailyCell` each to accept a trailing `dateDir = null` param and pass it into the two `captureSymbolTf` calls inside (one per attempt).

- [ ] **Step 3: Run tests — should still pass**

```bash
node --test tests/scanner-flow.test.mjs
```

Expected: 36/36 pass.

- [ ] **Step 4: Commit**

```bash
git add src/scanner.js
git commit -m "feat(scanner): pass dateDir through V2 pipeline for per-day screenshot archival"
```

---

## Task 4: Email sender module

**Files:**
- Create: `src/email.js`

- [ ] **Step 1: Write the module**

```javascript
import nodemailer from "nodemailer";

// Reads SMTP config from env and sends an HTML email with optional CID
// attachments. Throws on failure — caller decides retry policy.
export async function sendEmail({ to, subject, html, attachments = [] }) {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.EMAIL_FROM || user;

  if (!host || !user || !pass) {
    throw new Error(
      "SMTP config missing — set SMTP_HOST, SMTP_USER, SMTP_PASS in .env",
    );
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // SSL only on 465; 587 uses STARTTLS
    auth: { user, pass },
  });

  const info = await transporter.sendMail({
    from,
    to,
    subject,
    html,
    attachments, // [{ filename, path, cid }] for inline images
  });

  return { messageId: info.messageId, accepted: info.accepted };
}
```

- [ ] **Step 2: Syntax check**

```bash
node --check src/email.js
```

- [ ] **Step 3: Commit**

```bash
git add src/email.js
git commit -m "feat(email): add nodemailer-based SMTP sender"
```

---

## Task 5: HTML report generator

**Files:**
- Create: `src/report.js`

- [ ] **Step 1: Write the module**

Module must export:
- `buildReport(scan)` → `{ html, attachments }` where `scan` is the payload returned by `runScanV2` and `attachments` are `[{filename, path, cid}]` entries for inline images.

Key responsibilities:
1. Header: "Daily Trading Scan — {date}", summary counts.
2. "Candidates" section: one card per symbol with state ∈ ENTER/WATCH, showing all 3 TF screenshots inline via CID, bias, score, confluence grade, daily reasoning.
3. "Full report card" table: every symbol with status, stop reason, and a one-line note. Rows color-coded by the state table in the plan header.
4. Footer: total cost, pipeline version, saved JSON path.

HTML must be self-contained with inline CSS (email clients strip `<style>` in `<head>` sometimes, but most modern Gmail renders it — use inline `style=""` on every element to be safe).

Screenshot CID naming: `{symbol}-{tf}` (e.g., `GBPAUD-1D`). Generate one attachment entry per included screenshot.

Policy for which screenshots to include:
- If `confluence_grade !== "—"`: include `monthly.image`, `weekly.image`, `daily.image` (skip if any is null).
- Else if `stopped_at` is set: include the single image for that TF (e.g., if `stopped_at === "1W"`, include `weekly.image`).
- If the screenshot file no longer exists (ENOENT), skip it and write a placeholder `<p>[screenshot unavailable]</p>` instead of attaching.

- [ ] **Step 2: Add a dev helper to render to file for inspection**

At the bottom of `src/report.js`, also export `writeReportToFile(scan, outPath)` that writes the HTML to a file path — used by the `--dry-run` flag in Task 6.

- [ ] **Step 3: Syntax check**

```bash
node --check src/report.js
```

- [ ] **Step 4: Commit**

```bash
git add src/report.js
git commit -m "feat(report): HTML report generator with color-coded status and inline screenshots"
```

---

## Task 6: CLI entry point for cron

**Files:**
- Create: `scripts/daily-scan-email.js`

- [ ] **Step 1: Write the script**

```javascript
#!/usr/bin/env node
// Runs the V2 scan, builds the HTML report, emails it. Entry point for
// the user's cron job.
//
// Usage:
//   node scripts/daily-scan-email.js                  → run scan + send email
//   node scripts/daily-scan-email.js --dry-run        → run scan + write HTML to /tmp (no email)
//   EMAIL_TO=other@example.com node scripts/daily-scan-email.js  → override recipient

import "dotenv/config";
import { runScanV2 } from "../src/scanner.js";
import { buildReport, writeReportToFile } from "../src/report.js";
import { sendEmail } from "../src/email.js";

const DRY_RUN = process.argv.includes("--dry-run");
const EMAIL_TO = process.env.EMAIL_TO || "thetajas@gmail.com";

async function main() {
  console.log(`\n🌙 Daily scan + email — ${new Date().toISOString()}`);
  console.log(`   Recipient: ${EMAIL_TO}`);
  console.log(`   Mode: ${DRY_RUN ? "DRY RUN (no email)" : "LIVE"}\n`);

  // 1. Run the scan
  const scan = await runScanV2();

  // 2. Build report
  const { html, attachments } = buildReport(scan);

  if (DRY_RUN) {
    const outPath = `/tmp/daily-scan-${scan.started_at.replace(/[:.]/g, "-")}.html`;
    writeReportToFile(scan, outPath);
    console.log(`\n📄 Dry run — HTML written to ${outPath}`);
    console.log(`   Attachments that would have been sent: ${attachments.length}`);
    return;
  }

  // 3. Send
  const dateStr = scan.started_at.slice(0, 10);
  const candCount = scan.results.filter((r) => r.confluence_grade !== "—").length;
  const subject = `Daily Scan — ${dateStr} — ${candCount} candidates`;

  console.log(`\n📧 Sending email (${attachments.length} attachments) ...`);
  const result = await sendEmail({ to: EMAIL_TO, subject, html, attachments });
  console.log(`✅ Sent — messageId=${result.messageId}`);
}

main().catch((err) => {
  console.error("❌ Daily scan failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Syntax check**

```bash
node --check scripts/daily-scan-email.js
```

- [ ] **Step 3: Commit**

```bash
git add scripts/daily-scan-email.js
git commit -m "feat(scripts): add daily-scan-email entry point for cron"
```

---

## Task 7: Document SMTP config + cron in README

**Files:**
- Modify: `.env.example` (create if doesn't exist)
- Modify: `README.md`

- [ ] **Step 1: Add env vars to .env.example**

Append (or create):
```
# ─── Daily email report ────────────────────────────────────
# SMTP_HOST=smtp.gmail.com
# SMTP_PORT=587
# SMTP_USER=youremail@gmail.com
# SMTP_PASS=your-google-app-password   # NOT your regular password — generate at https://myaccount.google.com/apppasswords
# EMAIL_FROM=youremail@gmail.com
# EMAIL_TO=thetajas@gmail.com
```

- [ ] **Step 2: Add README section**

Append to `README.md`:
```markdown
## Daily email report

Runs the V2 scan and emails a color-coded HTML report with screenshot justification.

### Setup
1. Add SMTP config to `.env` (see `.env.example`). Gmail users: generate an app password at https://myaccount.google.com/apppasswords (regular password won't work with 2FA enabled).
2. Test dry-run:
   ```
   node scripts/daily-scan-email.js --dry-run
   ```
   This writes the HTML to `/tmp/daily-scan-*.html` — open it in a browser to preview.
3. Test live send (sends one email right now):
   ```
   node scripts/daily-scan-email.js
   ```

### Cron setup (4 AM IST daily)

4 AM IST = 22:30 UTC the prior day. Add to crontab:
```
30 22 * * * cd /path/to/claude-tradingview-mcp-trading && /usr/local/bin/node scripts/daily-scan-email.js >> logs/daily-scan.log 2>&1
```

Ensure TradingView Desktop is running with `--remote-debugging-port=9222` at that time.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example README.md
git commit -m "docs: document SMTP config and cron setup for daily email report"
```

---

## Task 8: Smoke test — dry-run build a report against the existing V2 scan JSON

**Files:**
- Run: `scripts/daily-scan-email.js --dry-run` (but this re-runs scan)

Since `--dry-run` in Task 6 still runs a fresh scan (which is expensive and requires TradingView open), add a lighter dev-mode option:

- [ ] **Step 1: Add `--from-json=<path>` flag to the script**

Modify `scripts/daily-scan-email.js`:
```javascript
const fromJsonArg = process.argv.find((a) => a.startsWith("--from-json="));
...
let scan;
if (fromJsonArg) {
  const p = fromJsonArg.split("=")[1];
  scan = JSON.parse(readFileSync(p, "utf8"));
  console.log(`   Loaded scan from ${p} (skipping fresh scan)`);
} else {
  scan = await runScanV2();
}
```

Needs `import { readFileSync } from "fs"` added at top.

- [ ] **Step 2: Run against the most-recent V2 scan**

```bash
node scripts/daily-scan-email.js --dry-run --from-json=scan-results/latest-scan-v2.json
```

Expected:
- Prints "Dry run — HTML written to /tmp/daily-scan-*.html"
- The HTML file exists and opens cleanly in a browser
- Screenshots referenced by CID in the HTML match actual files in `screenshots/` (check `<img src="cid:...">` refs against the attachments list)

- [ ] **Step 3: Commit**

```bash
git add scripts/daily-scan-email.js
git commit -m "feat(scripts): add --from-json flag for fast report iteration without re-scanning"
```

---

## Task 9: Final verification

- [ ] **Step 1: All tests pass**

```bash
node --test tests/*.test.mjs
```

Expected: 36/36 pass (scanner tests should be unaffected).

- [ ] **Step 2: Dry-run produces a valid HTML**

```bash
node scripts/daily-scan-email.js --dry-run --from-json=scan-results/latest-scan-v2.json
open /tmp/daily-scan-*.html
```

Expected: browser shows the report with:
- Candidate cards (GBPAUD + XAUUSD + AUDUSD from most recent scan)
- 3 TF screenshots inline per candidate
- Full color-coded symbol table
- Footer with cost + timestamp

- [ ] **Step 3: Push all commits**

```bash
git push tejpal feat/htf-ltf-prompt-split
```

---

## Self-Review

### Spec coverage

| Requirement | Task |
|---|---|
| Cron-ready script | Task 6, Task 7 (cron doc) |
| Screenshots with date + time in path | Tasks 2-3 (date-partitioned, timestamp via TF+capture-moment) |
| Detailed per-symbol report (passed + failed) | Task 5 (full table, not just candidates) |
| Color-coded status | Task 5 (7 color levels in plan header) |
| Include screenshots in email | Task 5 (CID inline for candidates + stop-TF for failures) |
| Email to thetajas@gmail.com | Task 6 (`EMAIL_TO` default) |
| 4 AM IST scheduling | Task 7 (crontab line 30 22 * * * UTC) |
| SMTP via Gmail app password | Task 4 + Task 7 |

### Placeholder scan
- All steps are concrete: exact paths, full code where code is required.
- No "implement later" / "TBD".

### Type consistency
- `scan` object shape comes from `runScanV2` return — consistent with Task 5 consumer.
- `attachments` array format `[{filename, path, cid}]` — same in Task 4 and Task 5.
- `dateDir` threaded consistently (Tasks 2, 3).
