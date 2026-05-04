// CDP-driven navigation of TradingView Desktop.
// Required: TradingView Desktop running with --remote-debugging-port=9222.
//
// Each function reuses an existing CDP client (opened once per scan run) so
// we don't pay reconnect cost per symbol.

import CDP from "chrome-remote-interface";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";

const CDP_PORT = 9222;

// Hard-fail error type thrown when the chart canvas does NOT actually render
// the symbol we asked for. Surfaces the rendered-vs-expected drift the widget
// API silently hides (chart.symbol() and chart.symbolExt() both report the
// requested symbol even after a failed silent switch — the chart canvas keeps
// the previous symbol's bars visible). The scanner catches this and skips
// the symbol with a clear `chart_switch_failed` reason rather than feeding
// a stale chart to the LLM.
export class ChartSymbolSwitchFailedError extends Error {
  constructor({ requested, rendered, attempts, message }) {
    super(
      message ||
        `chart_switch_failed: requested=${requested} rendered=${
          rendered || "<unknown>"
        } attempts=${attempts}`,
    );
    this.name = "ChartSymbolSwitchFailedError";
    this.requested = requested;
    this.rendered = rendered;
    this.attempts = attempts;
  }
}

// Description tokens we expect to see in the chart legend for each watchlist
// symbol. The legend's first non-icon line is either the symbol description
// (e.g. "Apple Inc", "EUR/USD", "Bitcoin / TetherUS") or the pro_name format
// (e.g. "NASDAQ:AAPL") depending on TV state. Any of the listed tokens is
// considered a match, case-insensitive substring. Used as the second AND
// signal alongside exchange match in verifyRenderedMatchesExpected().
// Each entry maps an expected TV symbol to an array of "patterns". Each pattern
// is an array of substrings that must ALL appear (case-insensitive) in the
// rendered legend description. The match passes if ANY pattern fully matches.
// This handles TV's variations: pro_name format ("BINANCE:BTCUSDT"), short
// form ("BTC/USDT"), and spelled-out ("Bitcoin / TetherUS", "Gold Spot / U.S.
// Dollar"). Per-pattern ALL-must-match avoids false positives between pairs
// that share a single currency (e.g. GBP/JPY vs GBP/USD).
const SYMBOL_DESCRIPTION_TOKENS = {
  // Crypto (BINANCE)
  "BINANCE:BTCUSDT": [["BTCUSDT"], ["BTC", "USDT"], ["Bitcoin", "TetherUS"]],
  "BINANCE:ETHUSDT": [["ETHUSDT"], ["ETH", "USDT"], ["Ethereum", "TetherUS"]],
  "BINANCE:SOLUSDT": [["SOLUSDT"], ["SOL", "USDT"], ["SOL", "TetherUS"], ["Solana", "TetherUS"]],
  // Forex / metals (OANDA) — TV often prefixes "Gold" with "Gold Spot"
  "OANDA:XAUUSD": [["XAUUSD"], ["XAU", "USD"], ["Gold", "U.S. Dollar"]],
  "OANDA:EURUSD": [["EURUSD"], ["EUR/USD"], ["Euro", "U.S. Dollar"]],
  "OANDA:GBPUSD": [["GBPUSD"], ["GBP/USD"], ["British Pound", "U.S. Dollar"]],
  "OANDA:USDJPY": [["USDJPY"], ["USD/JPY"], ["U.S. Dollar", "Japanese Yen"]],
  "OANDA:USDCHF": [["USDCHF"], ["USD/CHF"], ["U.S. Dollar", "Swiss Franc"]],
  "OANDA:AUDUSD": [["AUDUSD"], ["AUD/USD"], ["Australian Dollar", "U.S. Dollar"]],
  "OANDA:USDCAD": [["USDCAD"], ["USD/CAD"], ["U.S. Dollar", "Canadian Dollar"]],
  "OANDA:NZDUSD": [["NZDUSD"], ["NZD/USD"], ["New Zealand Dollar", "U.S. Dollar"]],
  "OANDA:EURJPY": [["EURJPY"], ["EUR/JPY"], ["Euro", "Japanese Yen"]],
  "OANDA:GBPJPY": [["GBPJPY"], ["GBP/JPY"], ["British Pound", "Japanese Yen"]],
  "OANDA:GBPAUD": [["GBPAUD"], ["GBP/AUD"], ["British Pound", "Australian Dollar"]],
  "OANDA:EURCHF": [["EURCHF"], ["EUR/CHF"], ["Euro", "Swiss Franc"]],
  "OANDA:EURCAD": [["EURCAD"], ["EUR/CAD"], ["Euro", "Canadian Dollar"]],
  "OANDA:EURGBP": [["EURGBP"], ["EUR/GBP"], ["Euro", "British Pound"]],
  "OANDA:EURAUD": [["EURAUD"], ["EUR/AUD"], ["Euro", "Australian Dollar"]],
  "OANDA:AUDJPY": [["AUDJPY"], ["AUD/JPY"], ["Australian Dollar", "Japanese Yen"]],
  "OANDA:CHFJPY": [["CHFJPY"], ["CHF/JPY"], ["Swiss Franc", "Japanese Yen"]],
  "OANDA:AUDNZD": [["AUDNZD"], ["AUD/NZD"], ["Australian Dollar", "New Zealand Dollar"]],
  "OANDA:US30USD": [["US30"], ["Dow"], ["Wall Street"], ["Wall St"]],
  "OANDA:DE30EUR": [["DE30"], ["DAX"], ["Germany"]],
  "OANDA:HK33HKD": [["HK33"], ["Hang Seng"], ["Hong Kong"]],
  // Indices / commodities (TVC)
  "TVC:USOIL": [["USOIL"], ["WTI"], ["Crude Oil"]],
  // Equities (NASDAQ — TV may render via BATS sibling listing)
  "NASDAQ:TSLA": [["TSLA"], ["Tesla"]],
  "NASDAQ:AAPL": [["AAPL"], ["Apple"]],
};

// Exchange families. TV may report a sibling listing on a different exchange
// for an equity (e.g. NASDAQ:TSLA gets reported by the chart legend as
// "BATS"); both are considered the same family. For forex/crypto TV uses the
// exchange we asked for verbatim. Keys and values normalized to upper case.
const EXCHANGE_ALIASES = {
  NASDAQ: ["NASDAQ", "BATS", "NYSE", "AMEX"],
  BATS: ["BATS", "NASDAQ", "NYSE", "AMEX"],
  NYSE: ["NYSE", "NASDAQ", "BATS", "AMEX"],
  OANDA: ["OANDA"],
  BINANCE: ["BINANCE"],
  TVC: ["TVC", "OANDA", "FX"],
  FX: ["FX", "OANDA"],
};

function exchangesMatch(expected, rendered) {
  if (!expected || !rendered) return false;
  const e = expected.toUpperCase();
  const r = rendered.toUpperCase();
  if (e === r) return true;
  const aliases = EXCHANGE_ALIASES[e];
  if (aliases) {
    for (const a of aliases) {
      if (a.toUpperCase() === r) return true;
    }
  }
  return false;
}

// Inverse of exchangesMatch's lookup — for symbols not in our aliases map,
// require an exact exchange-token match in the legend.

// Activate the TradingView Desktop macOS app so it's the frontmost OS window.
// Without this, the OS throttles GPU paints for background apps and our
// CDP screenshots return stale frames even though setResolution succeeded.
function activateTvDesktopApp() {
  if (process.platform !== "darwin") return;
  try {
    execSync(
      `osascript -e 'tell application "TradingView" to activate'`,
      { stdio: "ignore", timeout: 2000 },
    );
  } catch {
    // App not named "TradingView" or AppleScript failed — non-fatal
  }
}

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

// Wait until the chart is ready. Two modes:
//   1. legacy (no expectedSymbol): only checks the loading spinner. Use this
//      when the caller doesn't know what symbol to expect (e.g. initial
//      bring-up, popup dismissal).
//   2. symbol-aware (expectedSymbol set): polls until the spinner is gone
//      AND the rendered legend matches expectedSymbol. This closes the
//      false-positive case where setSymbol no-ops silently — without a
//      spinner appearing, the legacy path returns true and the caller
//      believes the switch worked.
//
// Returns true on ready, false on timeout. Caller should treat false as
// "switch did not take, retry or escalate".
export async function waitForChartReady(client, maxWaitMs = 10000, expectedSymbol = null) {
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
    const stillLoading = result.value;

    if (!stillLoading) {
      if (!expectedSymbol) {
        await sleep(400);
        return true;
      }
      // Symbol-aware: also require the rendered legend to match.
      const rendered = await readRenderedSymbol(client);
      if (rendered) {
        const v = verifyRenderedMatchesExpected(rendered, expectedSymbol);
        if (v.ok) {
          await sleep(200);
          return true;
        }
      }
    }
    await sleep(200);
  }
  return false;
}

export async function closeTvClient(client) {
  if (client) await client.close().catch(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pressKey(client, { key, code, windowsVirtualKeyCode, modifiers = 0 }) {
  await client.Input.dispatchKeyEvent({
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode,
    modifiers,
  });
  await client.Input.dispatchKeyEvent({
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode,
    modifiers,
  });
}

// F3 — switch via TV's actual symbol-search dialog instead of the widget API.
//
// IMPORTANT (2026-05-04 root-cause): a previous iteration tried Cmd+K — but
// that opens TV's COMMAND PALETTE ("Search tool or function"), not the symbol
// search. TV's symbol search dialog has placeholder "Symbol, ISIN, or CUSIP"
// and is opened via `chart.executeActionById('symbolSearch')`.
//
// The dialog has its own input (no data-role attribute, has data-qa-id =
// "symbol-search-input") and result rows (data-name = "symbol-search-dialog-
// content-item"). Each row's innerText contains the ticker, the description,
// the asset-class tags, AND the exchange name as plain text. We scan the
// rows, find the first whose text contains BOTH our ticker and our exchange
// (or an alias for the exchange), and click it. A click on the row activates
// TV's own symbol-load flow — no data-feed lock to worry about.
//
// React-aware text injection: setting input.value directly only updates the
// DOM, not React's state. We use the prototype's value setter + dispatch a
// real `input` event so React's onChange handler runs and the search filters.
//
// Returns true if the legend matches tvSymbol within timeoutMs, false otherwise.
async function setSymbolViaSearchBar(client, tvSymbol, timeoutMs = 8000) {
  await dismissPopups(client);

  const colon = tvSymbol.indexOf(":");
  const exchange = colon >= 0 ? tvSymbol.slice(0, colon) : "";
  const ticker = colon >= 0 ? tvSymbol.slice(colon + 1) : tvSymbol;

  // 1. Open the symbol-search dialog via TV's own action. Verify it actually
  // opened — on a cold-launched TV the very first executeActionById can fire
  // before TV's UI is fully wired, leaving no dialog visible. Retry once if
  // the dialog isn't found.
  let dialogOpen = false;
  for (let openAttempt = 0; openAttempt < 2; openAttempt++) {
    await client.Runtime.evaluate({
      expression: `
        (function() {
          try {
            var chart = ${CHART_API};
            if (chart && typeof chart.executeActionById === 'function') {
              chart.executeActionById('symbolSearch');
              return 'ok';
            }
            return 'no_api';
          } catch (e) { return 'err:' + (e.message || e); }
        })()
      `,
      returnByValue: true,
    }).catch(() => {});
    await sleep(openAttempt === 0 ? 800 : 1500);

    const { result } = await client.Runtime.evaluate({
      expression: `(function(){
        var dlg = document.querySelector('[data-name="symbol-search-items-dialog"]');
        return !!(dlg && dlg.offsetParent !== null);
      })()`,
      returnByValue: true,
    }).catch(() => ({ result: { value: false } }));
    if (result.value) {
      dialogOpen = true;
      break;
    }
  }
  if (!dialogOpen) return false;

  // 2. Inject the ticker into the search input and dispatch a React-aware
  // `input` event so search results actually filter.
  await client.Runtime.evaluate({
    expression: `
      (function() {
        var dlg = document.querySelector('[data-name="symbol-search-items-dialog"]');
        var inp = dlg && dlg.querySelector('input');
        if (!inp) return 'no_input';
        inp.focus();
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, ${JSON.stringify(ticker)});
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      })()
    `,
    returnByValue: true,
  }).catch(() => {});
  await sleep(1500); // settle for search debounce + result render

  // 3. Find the result row whose innerText contains both ticker and exchange
  // (or an alias) and click it. Click drives TV's own load path.
  const aliases = (EXCHANGE_ALIASES[exchange] || [exchange])
    .filter(Boolean)
    .map((a) => a.toUpperCase());
  const { result: clickRes } = await client.Runtime.evaluate({
    expression: `
      (function() {
        var rows = document.querySelectorAll('[data-name="symbol-search-dialog-content-item"]');
        var aliases = ${JSON.stringify(aliases)};
        var tick = ${JSON.stringify(ticker.toUpperCase())};
        for (var i = 0; i < rows.length; i++) {
          var t = (rows[i].innerText || '').toUpperCase();
          if (t.indexOf(tick) === -1) continue;
          for (var j = 0; j < aliases.length; j++) {
            if (aliases[j] && t.indexOf(aliases[j]) !== -1) {
              rows[i].click();
              return JSON.stringify({ clicked: true, idx: i });
            }
          }
        }
        return JSON.stringify({ clicked: false, rows: rows.length });
      })()
    `,
    returnByValue: true,
  }).catch(() => ({ result: { value: '{"clicked":false}' } }));

  let clickInfo = { clicked: false };
  try { clickInfo = JSON.parse(clickRes.value); } catch {}

  if (!clickInfo.clicked) {
    // No matching row — fall through to caller's escalation. ESC closes the
    // dialog so we don't leave it open.
    await pressKey(client, { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    return false;
  }

  // 4. Wait for the legend to actually reflect the click.
  return await waitForChartReady(client, timeoutMs, tvSymbol);
}

// Press Escape several times to clear stuck dialogs / popups, then click
// anything that looks like a dismiss/close affordance — including the
// unlabeled "X" buttons TV uses on promotional ads ("50% lower FX trading
// costs", "get 30% off", etc.) which previously slipped past the explicit
// label list and could block setSymbol from taking effect.
export async function dismissPopups(client) {
  // ESC twice catches most modals
  for (let i = 0; i < 2; i++) {
    await pressKey(client, { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(80);
  }

  await client.Runtime.evaluate({
    expression: `
      (function() {
        const labels = ['close', 'no thanks', 'skip', 'dismiss', 'maybe later', 'not now'];
        const els = Array.from(document.querySelectorAll('button, [role="button"], a, [class*="close"]'));
        let clicked = 0;
        for (const el of els) {
          const text = (el.innerText || el.getAttribute('aria-label') || '').trim().toLowerCase();
          const dataName = (el.getAttribute('data-name') || '').toLowerCase();
          const className = (el.className || '').toString().toLowerCase();
          // Visible icon-only X buttons: <button class="…close…">×</button>.
          const looksLikeXButton =
            (className.includes('close') || dataName.includes('close')) &&
            (text === '' || text === '×' || text === 'x' || text.length <= 2);
          // Promotional ad container's close button: usually has class /Promo|Banner|Cta/
          // with a child button.
          if (
            labels.some((l) => text === l || text.includes(l)) ||
            dataName.includes('close') ||
            dataName.includes('dismiss') ||
            looksLikeXButton
          ) {
            const rect = el.getBoundingClientRect();
            if (
              rect.width > 0 &&
              rect.height > 0 &&
              rect.top < window.innerHeight &&
              rect.left < window.innerWidth
            ) {
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

// Read the symbol *actually being rendered* on the chart canvas, NOT the
// requested symbol. Source-of-truth: the chart legend DOM
// (`legendMainSourceWrapper`).
//
// Why not chart.symbol() / chart.symbolExt()? Live evidence (tools/diag-switch.mjs):
// after a silent setSymbol failure the widget API reports the *requested*
// symbol — `chart.symbol()` returns "OANDA:EURUSD" and `chart.symbolExt()`
// returns `{ pro_name: "OANDA:EURUSD", description: "EUR/USD", exchange: "OANDA" }`
// even while the chart canvas keeps rendering Apple bars. Only the legend DOM
// updates from the rendered canvas data.
//
// Returns: { description, exchange, raw }. `raw` is the full legend text for
// debugging.
export async function readRenderedSymbol(client) {
  const { result } = await client.Runtime.evaluate({
    expression: `
      (function () {
        var legend = document.querySelector('[class*="legendMainSourceWrapper"]');
        if (!legend) return null;
        var raw = (legend.innerText || legend.textContent || '').trim();
        if (!raw) return null;
        var lines = raw.split(/\\n/).map(function (s) { return s.trim(); }).filter(Boolean);
        // Lines often look like: ["A", "Apple Inc", "1M", "NASDAQ", "O", "278.86", ...]
        // The first line ("A" / "B" / etc.) is a single-letter dataset icon —
        // skip lines that are <=2 chars. The first long line is the description
        // (or the pro_name "NASDAQ:AAPL" form when the description hasn't
        // populated yet). The exchange line is one of the all-caps lines
        // appearing AFTER the timeframe line (matches the upper-case exchange
        // token: OANDA / NASDAQ / BINANCE / TVC / BATS / FX / NYSE / AMEX / Cboe One).
        var description = null;
        var exchange = null;
        var tfRegex = /^(\\d+(s|m|h)|[1-9][0-9]*[DWM]|[DWM])$/;
        // Known exchange tokens we accept on a legend exchange line.
        var EXCHANGES = ['OANDA','NASDAQ','BINANCE','TVC','BATS','NYSE','AMEX','FX','COINBASE','BITSTAMP','KRAKEN','CBOE'];
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (!description && line.length > 2 && !tfRegex.test(line) && !/^[A-Z]$/.test(line) && !/^[OHLCV]$/i.test(line)) {
            description = line;
            continue;
          }
          if (!exchange) {
            // Match all-caps short token, or a string starting with one of
            // the known exchange tokens.
            var upper = line.toUpperCase();
            for (var j = 0; j < EXCHANGES.length; j++) {
              if (upper === EXCHANGES[j] || upper.indexOf(EXCHANGES[j]) === 0) {
                exchange = EXCHANGES[j];
                break;
              }
            }
            // Description sometimes looks like "NASDAQ:AAPL" (pro_name form).
            // In that case the first colon-separated token IS the exchange.
            if (!exchange && description && description.indexOf(':') !== -1) {
              var head = description.split(':')[0].toUpperCase();
              for (var k = 0; k < EXCHANGES.length; k++) {
                if (head === EXCHANGES[k]) { exchange = head; break; }
              }
            }
          }
          if (description && exchange) break;
        }
        return JSON.stringify({ description: description, exchange: exchange, raw: raw.slice(0, 500) });
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

// Decide whether the rendered chart matches the requested TV symbol.
// Two independent signals, AND-ed together:
//   1. Exchange family match (OANDA == OANDA, NASDAQ == BATS, etc.)
//   2. Description / ticker token match (legend description contains one of
//      the SYMBOL_DESCRIPTION_TOKENS entries for this expectedTvSymbol — or,
//      if the symbol isn't in the table, falls back to the raw ticker letters)
// Returns { ok: bool, reason: string } so callers can log a precise diagnosis.
export function verifyRenderedMatchesExpected(rendered, expectedTvSymbol) {
  if (!rendered) return { ok: false, reason: "no_legend" };
  if (!rendered.description) return { ok: false, reason: "no_description" };

  const colonIdx = expectedTvSymbol.indexOf(":");
  const expectedExchange =
    colonIdx > 0 ? expectedTvSymbol.slice(0, colonIdx).toUpperCase() : null;
  const expectedTicker =
    colonIdx > 0 ? expectedTvSymbol.slice(colonIdx + 1) : expectedTvSymbol;

  // Exchange check
  if (expectedExchange) {
    if (!exchangesMatch(expectedExchange, rendered.exchange || "")) {
      return {
        ok: false,
        reason: `exchange_mismatch (expected=${expectedExchange} rendered=${rendered.exchange || "<none>"})`,
      };
    }
  }

  // Description / ticker check. Patterns are arrays of arrays: each inner
  // array is "all substrings must appear in description" — match passes if
  // ANY inner array fully matches. Falls back to the bare ticker if the
  // symbol isn't in the token table.
  const descUpper = (rendered.description || "").toUpperCase();
  const patterns = SYMBOL_DESCRIPTION_TOKENS[expectedTvSymbol] || [
    [expectedTicker],
  ];
  const hit = patterns.some((pattern) =>
    pattern.every((sub) => descUpper.includes(sub.toUpperCase())),
  );
  if (!hit) {
    const pretty = patterns
      .map((p) => `[${p.join(" + ")}]`)
      .join(" OR ");
    return {
      ok: false,
      reason: `description_mismatch (expected ${pretty}, rendered="${rendered.description}")`,
    };
  }
  return { ok: true, reason: "match" };
}

// Internal: ask the widget API to switch to tvSymbol. Returns parsed result.
// Call TradingView's `chart.setSymbol(...)` widget API and wait long enough
// for the call's internal async work to start. The call itself is fire-and-
// forget on TV's side — it schedules a data-feed reload + canvas re-render
// and returns immediately. Without an internal settle here, the next CDP
// call can race the previous one and TV may collapse / drop calls. The MCP
// reference implementation uses 500ms; we use the same.
async function callSetSymbolApi(client, tvSymbol) {
  const { result, exceptionDetails } = await client.Runtime.evaluate({
    expression: `
      (function() {
        var chart = ${CHART_API};
        if (!chart || typeof chart.setSymbol !== 'function') {
          return Promise.resolve(JSON.stringify({ ok: false, reason: 'api_not_available' }));
        }
        return new Promise(function(resolve) {
          try {
            chart.setSymbol('${tvSymbol.replace(/'/g, "\\'")}', {});
            setTimeout(function() { resolve(JSON.stringify({ ok: true })); }, 500);
          } catch (e) {
            resolve(JSON.stringify({ ok: false, reason: 'exception:' + (e.message || e) }));
          }
        });
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    return { ok: false, reason: "cdp_eval_exception" };
  }
  try {
    return JSON.parse(result.value);
  } catch {
    return { ok: false, reason: "parse_error" };
  }
}

// Switch chart to {tvSymbol} using TradingView's exposed widget API. Same
// approach as the official MCP server. Bypasses all keyboard/UI flakiness.
//
// CRITICAL: this verifies the chart canvas ACTUALLY rendered the requested
// symbol via readRenderedSymbol(), NOT the lying chart.symbol() API. If the
// rendered legend disagrees, retry up to 2 more attempts (re-call setSymbol
// then a Page.reload + setSymbol). If still wrong, throw
// ChartSymbolSwitchFailedError so callers can skip the symbol cleanly.
export async function setSymbol(client, tvSymbol) {
  await dismissPopups(client);

  // Fast-path: skip the switch if the chart is ALREADY rendering tvSymbol.
  // Uses the truthful legend DOM, not chart.symbol(). Avoids redundant data-
  // feed reloads that race with subsequent setResolution() calls.
  const renderedNow = await readRenderedSymbol(client);
  if (renderedNow) {
    const v = verifyRenderedMatchesExpected(renderedNow, tvSymbol);
    if (v.ok) {
      // Also confirm chart.symbol() reports the same — defensive against the
      // very-rare case the legend matches but the widget API hasn't updated.
      const { result: cur } = await client.Runtime.evaluate({
        expression: `(function() { try { return ${CHART_API}.symbol(); } catch (e) { return null; } })()`,
        returnByValue: true,
      }).catch(() => ({ result: { value: null } }));
      if (
        cur.value &&
        cur.value.toUpperCase() === tvSymbol.toUpperCase()
      ) {
        return;
      }
    }
  }

  // Recovery (post-2026-05-04 root-cause):
  //   1) Plain widget setSymbol with awaitPromise + 500ms internal settle.
  //      Fast path — works ~95% of the time when TV is healthy. Verifies
  //      via symbol-aware waitForChartReady (legend match required).
  //   2) Symbol-search-dialog fallback. Calls executeActionById('symbolSearch'),
  //      injects the ticker via React-aware setter, finds and clicks the row
  //      whose text matches both the ticker AND the exchange. This is a
  //      completely different code path inside TV that does its own load —
  //      bulletproof against widget-API silent no-ops, popup races, etc.
  //
  // Page.reload was REMOVED as a recovery — TV restores the wedged symbol
  // from saved layout state on every reload, counterproductive.
  // Each attempt runs dismissPopups() first so promotional ads don't
  // intercept our clicks.
  const MAX_ATTEMPTS = 2;
  let lastRendered = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await dismissPopups(client);

    if (attempt === 1) {
      const r = await callSetSymbolApi(client, tvSymbol);
      if (!r.ok) {
        await sleep(500);
        await callSetSymbolApi(client, tvSymbol);
      }
      // 25s timeout — TV's data feed can take 15-20s for cold-loads (esp.
      // BTC weekly, GER40), and our verification was timing out at 8s right
      // before TV's canvas finally caught up. Polls every 200ms and returns
      // the moment the legend matches, so this is a CEILING not a floor —
      // fast loads still return in 2-3s.
      const ready = await waitForChartReady(client, 25000, tvSymbol);
      if (ready) {
        await dismissPopups(client);
        return;
      }
      lastRendered = await readRenderedSymbol(client);
      console.log(
        `      [setSymbol: attempt 1/${MAX_ATTEMPTS} — rendered legend still '${
          lastRendered?.description || "<none>"
        }' / '${lastRendered?.exchange || "<none>"}', escalating to search dialog]`,
      );
    } else {
      const ok = await setSymbolViaSearchBar(client, tvSymbol, 15000);
      if (ok) {
        await dismissPopups(client);
        return;
      }
      lastRendered = await readRenderedSymbol(client);
      console.log(
        `      [setSymbol: attempt 2/${MAX_ATTEMPTS} (search dialog) — rendered legend still '${
          lastRendered?.description || "<none>"
        }' / '${lastRendered?.exchange || "<none>"}']`,
      );
    }
  }

  throw new ChartSymbolSwitchFailedError({
    requested: tvSymbol,
    rendered: lastRendered
      ? `${lastRendered.description || "<none>"} (${lastRendered.exchange || "<none>"})`
      : "<no_legend>",
    attempts: MAX_ATTEMPTS,
  });
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

// Capture the current chart state into a PNG file.
// When `dateDir` is null (legacy callers): `screenshots/{slug}/{tf}_<stamp>.png`.
// When `dateDir` is "YYYY-MM-DD" (daily runs): `screenshots/{dateDir}/{slug}/{tf}_<stamp>.png`.
// The date-partitioned layout preserves history across daily cron runs so the
// email report always has the exact chart image Gemini saw that day. Each file
// also embeds its UTC capture time (`<tf>_YYYY-MM-DD_HH-MM-SSZ.png`) so the
// retry that overwrites a stale frame keeps both attempts on disk.
//
// Returns `{ path, capturedAt }` — capturedAt is a Date instance set at the
// moment the screenshot was actually taken, so callers can pass the timestamp
// down to the LLM prompt and persist it on the resulting cell.
//
// Re-confirms the legend reflects the requested timeframe before capturing
// so we never save a stale chart from the previous TF. Optionally verifies
// the symbol matches `expectedSymbol` and re-asserts it if it has drifted
// (e.g., user clicked a different watchlist item mid-scan).
export async function captureSymbolTf(
  client,
  slug,
  timeframe,
  expectedSymbol = null,
  dateDir = null,
) {
  const dir = dateDir
    ? resolve("screenshots", dateDir, slug)
    : resolve("screenshots", slug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  await dismissPopups(client);

  // Defensive: verify the chart is ACTUALLY rendering the expected symbol.
  // We deliberately use the legend DOM (readRenderedSymbol) and NOT
  // chart.symbol() — the widget API lies after a silent setSymbol failure
  // (reports the requested symbol while the canvas keeps the previous
  // symbol's bars visible). If the rendered legend disagrees, attempt a
  // re-set; if still wrong, throw ChartSymbolSwitchFailedError so the
  // scanner can skip cleanly rather than feed a wrong screenshot to the LLM.
  if (expectedSymbol) {
    const rendered = await readRenderedSymbol(client);
    const v = rendered
      ? verifyRenderedMatchesExpected(rendered, expectedSymbol)
      : { ok: false, reason: "no_legend" };
    if (!v.ok) {
      console.log(
        `      [capture: rendered chart does not match expected ${expectedSymbol} — ${v.reason}; re-setting]`,
      );
      // setSymbol now hard-fails on persistent drift; let the error propagate.
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

  // Activate the TV Desktop app at the OS level. macOS throttles GPU paints
  // for non-frontmost apps; without this, the chart canvas keeps showing the
  // previous TF even though setResolution succeeded.
  activateTvDesktopApp();

  // Force the CDP-attached page to the front within the app.
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

  // FINAL GATE — last-mile rendered-symbol check immediately before the
  // screenshot. After all the focus-toggling, popup-dismissing, and
  // mouseMove canvas-invalidation above there is still a small window where
  // the chart could have drifted (e.g., a popup re-routed focus, or the
  // user clicked a different watchlist row). Hard-fail if so.
  if (expectedSymbol) {
    const rendered = await readRenderedSymbol(client);
    const v = rendered
      ? verifyRenderedMatchesExpected(rendered, expectedSymbol)
      : { ok: false, reason: "no_legend" };
    if (!v.ok) {
      throw new ChartSymbolSwitchFailedError({
        requested: expectedSymbol,
        rendered: rendered
          ? `${rendered.description || "<none>"} (${rendered.exchange || "<none>"})`
          : "<no_legend>",
        attempts: 1,
        message: `chart_switch_failed at screenshot gate: ${v.reason} — refusing to save stale chart for ${expectedSymbol}`,
      });
    }
  }

  const capturedAt = new Date();
  const stamp = capturedAt
    .toISOString()
    .slice(0, 19)
    .replace("T", "_")
    .replace(/:/g, "-") + "Z";
  const path = resolve(dir, `${timeframe}_${stamp}.png`);
  const { data } = await client.Page.captureScreenshot({ format: "png" });
  writeFileSync(path, Buffer.from(data, "base64"));
  return { path, capturedAt };
}

// Format a Date as the human-readable timestamp injected into LLM prompts.
// "2026-04-25 10:14:23 UTC" — unambiguous, sortable, no locale issues.
export function formatCapturedAtForPrompt(date) {
  return date.toISOString().slice(0, 19).replace("T", " ") + " UTC";
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
