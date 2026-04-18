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

// Switch chart to {tvSymbol} using TradingView's exposed widget API. Same
// approach as the official MCP server. Bypasses all keyboard/UI flakiness.
export async function setSymbol(client, tvSymbol) {
  await dismissPopups(client);

  // Skip the symbol switch entirely if the chart is already on this symbol —
  // calling setSymbol on the same symbol triggers TV to reload the data feed
  // AND silently revert the timeframe to the user's last view, which then
  // races with the next setResolution() call.
  const { result: cur } = await client.Runtime.evaluate({
    expression: `(function() { try { return ${CHART_API}.symbol(); } catch (e) { return null; } })()`,
    returnByValue: true,
  }).catch(() => ({ result: { value: null } }));
  if (cur.value && cur.value.toUpperCase() === tvSymbol.toUpperCase()) {
    return;
  }

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
      // Toolbar updates as soon as the button is clicked — but TV's actual
      // chart data load can lag by 1-2 seconds especially when changing TF
      // right after a symbol switch. Sleep long enough for the bars to
      // actually re-render before any subsequent screenshot.
      await sleep(2500);
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
// so we never save a stale chart from the previous TF. Optionally verifies
// the symbol matches `expectedSymbol` and re-asserts it if it has drifted
// (e.g., user clicked a different watchlist item mid-scan).
export async function captureSymbolTf(client, slug, timeframe, expectedSymbol = null) {
  const dir = resolve("screenshots", slug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${timeframe}.png`);

  await dismissPopups(client);

  // Defensive: if the user clicked a different symbol while we were scanning,
  // re-set the symbol back to what this cell expects.
  if (expectedSymbol) {
    const { result: cur } = await client.Runtime.evaluate({
      expression: `(function() { try { return ${CHART_API}.symbol(); } catch (e) { return null; } })()`,
      returnByValue: true,
    }).catch(() => ({ result: { value: null } }));
    if (cur.value && cur.value.toUpperCase() !== expectedSymbol.toUpperCase()) {
      console.log(
        `      [capture: symbol drifted to '${cur.value}', expected ${expectedSymbol} — re-setting]`,
      );
      await setSymbol(client, expectedSymbol);
      await setTimeframe(client, timeframe);
    }
  }

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

  // Force the page to the front. When TV Desktop is in the background, the
  // GPU compositor throttles paints and Page.captureScreenshot returns a
  // stale frame (chart's internal state is correct but the canvas hasn't
  // been redrawn). bringToFront wakes the renderer.
  await client.Page.bringToFront().catch(() => {});

  // bringToFront alone isn't enough after the first screenshot — the chart
  // canvas only repaints in response to user interaction. Send a tiny
  // mouseMove over the chart area to invalidate the canvas region.
  await client.Input.dispatchMouseEvent({
    type: "mouseMoved",
    x: 400,
    y: 300,
    button: "none",
  }).catch(() => {});
  await sleep(150);
  await client.Input.dispatchMouseEvent({
    type: "mouseMoved",
    x: 410,
    y: 305,
    button: "none",
  }).catch(() => {});

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
