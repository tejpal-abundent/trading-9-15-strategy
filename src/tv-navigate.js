// CDP-driven navigation of TradingView Desktop.
// Required: TradingView Desktop running with --remote-debugging-port=9222.
//
// Each function reuses an existing CDP client (opened once per scan run) so
// we don't pay reconnect cost per symbol.

import CDP from "chrome-remote-interface";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";

const CDP_PORT = 9222;

// Prefer the actual chart tab. TV Desktop sometimes has multiple pages open
// (settings, watchlists, etc.). The chart's URL contains "/chart/".
export async function openTvClient() {
  const targets = await CDP.List({ port: CDP_PORT });
  const tv =
    targets.find(
      (t) => t.type === "page" && /tradingview\.com\/chart/i.test(t.url),
    ) ||
    targets.find((t) => t.type === "page" && /tradingview/i.test(t.url));
  if (!tv) {
    throw new Error(
      "No TradingView chart tab on CDP:9222 — is TradingView Desktop running with remote debugging enabled?",
    );
  }
  const client = await CDP({ port: CDP_PORT, target: tv });
  await client.Page.enable();
  await client.Runtime.enable();
  await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Escape" }).catch(
    () => {},
  );
  return client;
}

// TradingView Desktop exposes the visible chart widget here.
// This is the same path the upstream MCP uses (verified via live probing) —
// _activeChartWidgetWV.value() controls the chart the user actually sees.
const CHART_API = "window.TradingViewApi._activeChartWidgetWV.value()";

// Wait until the chart's loading spinner is gone — TV's data feed loads
// asynchronously after setSymbol/setResolution and silently drops subsequent
// API calls if you don't wait for completion.
export async function waitForChartReady(client, maxWaitMs = 10000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const { result } = await client.Runtime.evaluate({
      expression: `
        (function() {
          var spinner = document.querySelector('[class*="loader"]')
            || document.querySelector('[class*="loading"]')
            || document.querySelector('[data-name="loading"]');
          return !!(spinner && spinner.offsetParent !== null);
        })()
      `,
      returnByValue: true,
    }).catch(() => ({ result: { value: false } }));
    if (!result.value) {
      // Loading done — give a small additional settle before returning
      await sleep(400);
      return true;
    }
    await sleep(200);
  }
  return false;
}

export async function closeTvClient(client) {
  if (client) await client.close().catch(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Send a single character to TV (used for typing symbol names).
async function typeText(client, text) {
  for (const char of text) {
    await client.Input.dispatchKeyEvent({
      type: "char",
      text: char,
    });
    await sleep(20);
  }
}

async function pressKey(client, { key, code, windowsVirtualKeyCode }) {
  await client.Input.dispatchKeyEvent({
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode,
  });
  await client.Input.dispatchKeyEvent({
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode,
  });
}

// Press Escape several times to clear stuck dialogs / popups, then click any
// "close" / "X" / "skip" / "no thanks" button visible on screen.
export async function dismissPopups(client) {
  // ESC twice catches most modals
  for (let i = 0; i < 2; i++) {
    await pressKey(client, { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(80);
  }

  // Best-effort: click anything that looks like a dismiss button.
  await client.Runtime.evaluate({
    expression: `
      (function() {
        const labels = ['close', 'no thanks', 'skip', 'dismiss', 'maybe later', 'not now'];
        const els = Array.from(document.querySelectorAll('button, [role="button"], a'));
        let clicked = 0;
        for (const el of els) {
          const text = (el.innerText || el.getAttribute('aria-label') || '').trim().toLowerCase();
          const dataName = (el.getAttribute('data-name') || '').toLowerCase();
          if (
            labels.some(l => text === l || text.includes(l)) ||
            dataName.includes('close') ||
            dataName.includes('dismiss')
          ) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight) {
              try { el.click(); clicked++; } catch (e) {}
            }
          }
        }
        return clicked;
      })()
    `,
    returnByValue: true,
  }).catch(() => {});

  await sleep(200);
}

// Extract just the bare symbol part (e.g. "BINANCE:BTCUSDT" → "BTCUSDT")
// for matching the title bar, which only shows the ticker not the exchange.
function bareTicker(tvSymbol) {
  return tvSymbol.includes(":") ? tvSymbol.split(":")[1] : tvSymbol;
}

// Wait until document.title contains a substring (case-insensitive),
// up to maxWaitMs. Returns true on match, false on timeout.
async function waitForTitle(client, substring, maxWaitMs = 6000, intervalMs = 250) {
  const deadline = Date.now() + maxWaitMs;
  const re = new RegExp(substring.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  while (Date.now() < deadline) {
    const title = await readChartTitle(client);
    if (re.test(title)) return true;
    await sleep(intervalMs);
  }
  return false;
}

// Switch chart to {tvSymbol} using TradingView's exposed widget API. Same
// approach as the official MCP server. Bypasses all keyboard/UI flakiness.
export async function setSymbol(client, tvSymbol) {
  await dismissPopups(client);

  const { result } = await client.Runtime.evaluate({
    expression: `
      (function() {
        try {
          var chart = ${CHART_API};
          if (!chart || typeof chart.setSymbol !== 'function') {
            return JSON.stringify({ ok: false, reason: 'api_not_available' });
          }
          chart.setSymbol('${tvSymbol.replace(/'/g, "\\'")}', {});
          return JSON.stringify({ ok: true });
        } catch (e) {
          return JSON.stringify({ ok: false, reason: 'exception:' + (e.message || e) });
        }
      })()
    `,
    returnByValue: true,
  });
  const r = JSON.parse(result.value);
  if (!r.ok) {
    throw new Error(
      `setSymbol failed for ${tvSymbol}: ${r.reason}`,
    );
  }

  // Hard wait for chart's data feed to load new symbol — without this,
  // subsequent setResolution() calls get silently dropped.
  await waitForChartReady(client);
  await sleep(3000); // extra settle — spinner check alone is insufficient

  // Verify by reading current symbol back
  const { result: verify } = await client.Runtime.evaluate({
    expression: `(function() { try { return ${CHART_API}.symbol(); } catch (e) { return null; } })()`,
    returnByValue: true,
  });
  if (verify.value && verify.value.toUpperCase() !== tvSymbol.toUpperCase()) {
    console.log(
      `      [warn: setSymbol asked '${tvSymbol}', chart reports '${verify.value}']`,
    );
  }

  await dismissPopups(client);
}

// Map our TF labels → the value passed to chart.setResolution().
// Note: TV accepts "M" but reports it back as "1M" via chart.resolution().
const TF_TO_RESOLUTION = {
  "1m": "1",   "3m": "3",   "5m": "5",   "15m": "15",  "30m": "30",
  "1H": "60",  "2H": "120", "4H": "240", "6H": "360",  "12H": "720",
  "1D": "D",   "1W": "W",   "1M": "M",
};

// What chart.resolution() returns AFTER setResolution() — sometimes prefixed.
const TF_RESOLUTION_REPORTED = {
  "1m": "1",   "3m": "3",   "5m": "5",   "15m": "15",  "30m": "30",
  "1H": "60",  "2H": "120", "4H": "240", "6H": "360",  "12H": "720",
  "1D": "1D",  "1W": "1W",  "1M": "1M",
};

// What the active interval-toolbar button shows for each TF. The toolbar
// updates AFTER the chart visually re-renders — chart.resolution() updates
// instantly even when the visible chart hasn't changed yet, so the toolbar
// is the real signal that the TF switch took effect. Note TradingView shows
// "M"/"W"/"D" (no digit prefix) for monthly/weekly/daily.
const TF_LEGEND_LABEL = {
  "1m": ["1m"],  "3m": ["3m"],  "5m": ["5m"],  "15m": ["15m"], "30m": ["30m"],
  "1H": ["1h"],  "2H": ["2h"],  "4H": ["4h"],  "6H": ["6h"],   "12H": ["12h"],
  "1D": ["D", "1D"],  "1W": ["W", "1W"],  "1M": ["M", "1M"],
};

function legendMatches(tf, seen) {
  if (!seen) return false;
  const accepted = TF_LEGEND_LABEL[tf] || [];
  return accepted.some((a) => a.toLowerCase() === seen.toLowerCase());
}

// Read the chart's current symbol + TF from TV's chart-legend DOM elements.
// document.title is the browser tab — unreliable for chart state. The legend
// at top-left always shows "<SYMBOL> · <RES> · <EXCHANGE>" — query that.
async function readChartTitle(client) {
  const { result } = await client.Runtime.evaluate({
    expression: `
      (function() {
        // Try several known TradingView legend selectors, in order of preference.
        const selectors = [
          '[data-name="legend-source-title"]',
          '[class*="mainTitle"]',
          '[class*="legendMainSourceWrapper"]',
          '[data-name="legend-source-item"]',
        ];
        const parts = [];
        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            const t = (el.innerText || '').trim();
            if (t) parts.push(t);
          }
          if (parts.length) break;
        }
        // Add document.title as a fallback signal too — it sometimes updates.
        if (document.title) parts.push(document.title);
        return parts.join(' | ');
      })()
    `,
    returnByValue: true,
  });
  return result.value || "";
}

// Locate the toolbar button for a given TF and click it. Uses TradingView's
// React-synthetic-event-friendly programmatic .click() — CDP raw mouse events
// don't trigger TV's React handlers.
async function clickToolbarTfButton(client, buttonText) {
  const { result } = await client.Runtime.evaluate({
    expression: `
      (function() {
        const wanted = ${JSON.stringify(buttonText)};
        let target = null;
        let source = '';

        // Strategy 1: TradingView's known interval-toolbar
        const tvSelectors = [
          '[data-name="header-toolbar-intervals"] button',
          '[id*="header-toolbar-intervals"] button',
        ];
        for (const sel of tvSelectors) {
          const els = Array.from(document.querySelectorAll(sel));
          target = els.find(el => (el.innerText || '').trim() === wanted);
          if (target) { source = 'tv_selector:' + sel; break; }
        }

        // Strategy 2: any top-toolbar button by text
        if (!target) {
          const all = Array.from(document.querySelectorAll('button, [role="button"]'));
          const cands = all.filter(b => {
            const t = (b.innerText || '').trim();
            if (t !== wanted) return false;
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top < 60;
          });
          cands.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
          target = cands[0] || null;
          if (target) source = 'top_toolbar_text:' + cands.length + 'candidates';
        }

        if (!target) return null;
        const r = target.getBoundingClientRect();

        // Programmatic click — fires React's synthetic event system. Plus a
        // mousedown/mouseup pair for sites that need full event sequence.
        try { target.scrollIntoView({block: 'center', inline: 'center'}); } catch (e) {}
        const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
        target.dispatchEvent(new MouseEvent('pointerover', opts));
        target.dispatchEvent(new MouseEvent('mouseover', opts));
        target.dispatchEvent(new MouseEvent('pointerdown', opts));
        target.dispatchEvent(new MouseEvent('mousedown', opts));
        target.dispatchEvent(new MouseEvent('pointerup', opts));
        target.dispatchEvent(new MouseEvent('mouseup', opts));
        target.dispatchEvent(new MouseEvent('click', opts));
        try { target.click(); } catch (e) {}

        return JSON.stringify({
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          source,
          dispatched: true,
        });
      })()
    `,
    returnByValue: true,
  });
  if (!result.value) return null;
  return JSON.parse(result.value);
}

// Check whether the toolbar button for `buttonText` is currently in "active"
// state — TradingView toggles a class containing "isActive" or sets
// aria-pressed="true" on the selected TF button.
async function isTfButtonActive(client, buttonText) {
  const { result } = await client.Runtime.evaluate({
    expression: `
      (function() {
        const wanted = ${JSON.stringify(buttonText)};
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const b of buttons) {
          const t = (b.innerText || '').trim();
          if (t !== wanted) continue;
          const r = b.getBoundingClientRect();
          if (r.top > 200) continue;  // not in toolbar
          const cls = (b.className || '').toString().toLowerCase();
          const ap  = (b.getAttribute('aria-pressed') || '').toLowerCase();
          const ac  = (b.getAttribute('data-active') || '').toLowerCase();
          if (cls.includes('isactive') || cls.includes('active') ||
              ap === 'true' || ac === 'true') {
            return true;
          }
        }
        return false;
      })()
    `,
    returnByValue: true,
  }).catch(() => ({ result: { value: false } }));
  return !!result.value;
}

// Read the active TF from TradingView's UI. Two complementary signals:
//   1. Top-toolbar interval button with `isActive-` class — most reliable
//   2. Chart legend text ("4h" line in legendMainSourceWrapper) — fallback
// chart.resolution() updates instantly on setResolution() even when the
// chart hasn't visually re-rendered, so do NOT use it for verification.
async function readLegendTf(client) {
  const { result } = await client.Runtime.evaluate({
    expression: `
      (function() {
        // Strategy 1: find the active TF button in the top toolbar
        var btns = document.querySelectorAll(
          '[id*="header-toolbar-intervals"] button, ' +
          '[data-name="header-toolbar-intervals"] button'
        );
        for (var i = 0; i < btns.length; i++) {
          var b = btns[i];
          var cls = (b.className || '').toString();
          if (cls.indexOf('isActive') !== -1) {
            var t = (b.innerText || '').trim();
            if (t) return t;
          }
        }
        // Strategy 2: parse legend wrapper text — TF appears as one line
        // between the symbol name and the exchange ("Euro / U.S. Dollar\\n4h\\nOANDA")
        var legend = document.querySelector('[class*="legendMainSourceWrapper"]');
        if (legend) {
          var text = (legend.innerText || legend.textContent || '').trim();
          var lines = text.split(/\\n/).map(function(l) { return l.trim(); });
          for (var j = 0; j < lines.length; j++) {
            if (/^(\\d+(s|m|h)|[1-9][0-9]*[DWM]|[DWM])$/.test(lines[j])) {
              return lines[j];
            }
          }
        }
        return null;
      })()
    `,
    returnByValue: true,
  }).catch(() => ({ result: { value: null } }));
  return result.value || null;
}

// Poll legend/toolbar until the TF matches one of the accepted labels for `tf`.
async function waitForLegendTf(client, tf, maxWaitMs = 8000) {
  const deadline = Date.now() + maxWaitMs;
  let last = null;
  while (Date.now() < deadline) {
    const seen = await readLegendTf(client);
    last = seen;
    if (legendMatches(tf, seen)) return { ok: true, saw: seen };
    await sleep(200);
  }
  return { ok: false, saw: last };
}

export async function setTimeframe(client, timeframe) {
  const resolution = TF_TO_RESOLUTION[timeframe];
  if (!resolution) throw new Error(`Unknown timeframe: ${timeframe}`);

  // If the chart is already on this TF, we're done.
  const current = await readLegendTf(client);
  if (legendMatches(timeframe, current)) {
    return;
  }

  for (let attempt = 1; attempt <= 4; attempt++) {
    const { result } = await client.Runtime.evaluate({
      expression: `
        (function() {
          try {
            var chart = ${CHART_API};
            if (!chart || typeof chart.setResolution !== 'function') {
              return JSON.stringify({ ok: false, reason: 'api_not_available' });
            }
            chart.setResolution('${resolution}', {});
            return JSON.stringify({ ok: true });
          } catch (e) {
            return JSON.stringify({ ok: false, reason: 'exception:' + (e.message || e) });
          }
        })()
      `,
      returnByValue: true,
    });
    const r = JSON.parse(result.value);
    if (!r.ok) {
      console.log(`      [tf ${timeframe}: API failed (attempt ${attempt}): ${r.reason}]`);
      await sleep(500);
      continue;
    }

    // Wait for spinner to clear, then poll the toolbar for the new TF marker.
    await waitForChartReady(client);
    const { ok, saw } = await waitForLegendTf(client, timeframe, 8000);
    if (ok) {
      // Extra settle so candles fully paint before any subsequent screenshot
      await sleep(1200);
      return;
    }
    console.log(
      `      [tf ${timeframe}: setResolution OK but toolbar still '${saw}' after 8s (attempt ${attempt}/4); retrying]`,
    );
    await sleep(800);
  }

  console.log(
    `    ⚠️  TF switch did not converge for ${timeframe} after 4 attempts.`,
  );
}

// Capture the current chart state into a PNG file under
// `screenshots/{slug}/{tf}.png`. Slug is filesystem-safe label.
// Re-confirms the legend reflects the requested timeframe before capturing
// so we never save a stale chart from the previous TF.
export async function captureSymbolTf(client, slug, timeframe) {
  const dir = resolve("screenshots", slug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${timeframe}.png`);

  await dismissPopups(client);

  if (TF_LEGEND_LABEL[timeframe]) {
    const { ok, saw } = await waitForLegendTf(client, timeframe, 4000);
    if (!ok) {
      console.log(
        `      [capture: toolbar showed '${saw}', expected ${timeframe} — ` +
          `re-issuing setResolution then waiting]`,
      );
      await setTimeframe(client, timeframe);
    }
  }

  // Extra settle time so candles fully render before capture
  await sleep(1000);
  const { data } = await client.Page.captureScreenshot({ format: "png" });
  writeFileSync(path, Buffer.from(data, "base64"));
  return path;
}

// Read the chart's currently displayed symbol + resolution from TV's widget,
// so we can verify nav succeeded before screenshotting.
export async function getChartState(client) {
  const { result } = await client.Runtime.evaluate({
    expression: `
      (function() {
        const candidates = [
          window.tvWidget?.activeChart?.(),
          window.TradingView?.activeChart?.(),
        ];
        for (const c of candidates) {
          if (c) {
            try {
              return JSON.stringify({
                symbol: typeof c.symbol === 'function' ? c.symbol() : null,
                resolution: typeof c.resolution === 'function' ? c.resolution() : null,
              });
            } catch (e) { return null; }
          }
        }
        return null;
      })()
    `,
    returnByValue: true,
  }).catch(() => ({ result: { value: null } }));

  if (!result.value) return null;
  try {
    return JSON.parse(result.value);
  } catch {
    return null;
  }
}
