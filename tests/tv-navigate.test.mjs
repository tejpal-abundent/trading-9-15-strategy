// Unit tests for the symbol-aware waitForChartReady, which closes the false-
// positive case where setSymbol no-ops silently and the legacy spinner-only
// check returned true even though the canvas hadn't moved.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  waitForChartReady,
  verifyRenderedMatchesExpected,
} from "../src/tv-navigate.js";

// Minimal mock CDP client. Each Runtime.evaluate call dispatches to a stub
// keyed by a fragment of the expression. Tests construct the stub map.
function mockClient(stubs) {
  return {
    Runtime: {
      evaluate: async ({ expression }) => {
        for (const key of Object.keys(stubs)) {
          if (expression.includes(key)) {
            const fn = stubs[key];
            return { result: { value: typeof fn === "function" ? await fn() : fn } };
          }
        }
        return { result: { value: null } };
      },
    },
  };
}

test("waitForChartReady (legacy mode, no expectedSymbol): returns true when spinner clears", async () => {
  let pollCount = 0;
  const client = mockClient({
    "spinner": () => {
      pollCount++;
      return pollCount > 2; // first two polls: hidden, then... oh wait, returning 'spinner visible'
    },
  });
  // Reset: spinner returns false (not loading) on first poll → returns true
  const c2 = mockClient({ "spinner": () => false });
  const out = await waitForChartReady(c2, 2000);
  assert.equal(out, true);
});

test("waitForChartReady (symbol-aware): returns true only when legend matches", async () => {
  let phase = "loading"; // loading → wrong-symbol → right-symbol
  const client = mockClient({
    "spinner": () => phase === "loading",
    "legendMainSourceWrapper": () =>
      phase === "wrong-symbol"
        ? JSON.stringify({ description: "Bitcoin / U.S. Dollar", exchange: "BINANCE" })
        : phase === "right-symbol"
          ? JSON.stringify({ description: "Euro / U.S. Dollar", exchange: "OANDA" })
          : null,
  });

  // Drive the phase progression in parallel with the wait.
  setTimeout(() => { phase = "wrong-symbol"; }, 250);
  setTimeout(() => { phase = "right-symbol"; }, 700);

  const out = await waitForChartReady(client, 4000, "OANDA:EURUSD");
  assert.equal(out, true);
});

test("waitForChartReady (symbol-aware): returns false when legend NEVER matches (silent no-op case)", async () => {
  // The exact regression: spinner is never visible (because setSymbol silently
  // no-op'd, no data feed reload was kicked off), and the legend stays on the
  // wrong symbol forever. Pre-fix code would return true here. Post-fix MUST
  // return false so callers escalate to recovery.
  const client = mockClient({
    "spinner": () => false, // no loading
    "legendMainSourceWrapper": () =>
      JSON.stringify({ description: "British Pound / Japanese Yen", exchange: "OANDA" }),
  });
  const out = await waitForChartReady(client, 800, "OANDA:GBPAUD");
  assert.equal(out, false);
});

test("waitForChartReady (symbol-aware): returns false when legend is null (TV just loading)", async () => {
  const client = mockClient({
    "spinner": () => false,
    "legendMainSourceWrapper": () => null,
  });
  const out = await waitForChartReady(client, 600, "OANDA:EURUSD");
  assert.equal(out, false);
});

// Regression: the symbol-aware mode must NOT match a similar-looking symbol.
// Pre-fix code passed because the spinner check is symbol-blind.
test("waitForChartReady (symbol-aware): same-prefix mismatch is rejected", async () => {
  const client = mockClient({
    "spinner": () => false,
    "legendMainSourceWrapper": () =>
      // GBPAUD requested but rendered is GBPJPY — verifyRenderedMatchesExpected
      // should reject this even though both share GBP*.
      JSON.stringify({ description: "British Pound / Japanese Yen", exchange: "OANDA" }),
  });
  const out = await waitForChartReady(client, 600, "OANDA:GBPAUD");
  assert.equal(out, false);

  // Sanity: the matcher itself agrees.
  const v = verifyRenderedMatchesExpected(
    { description: "British Pound / Japanese Yen", exchange: "OANDA" },
    "OANDA:GBPAUD",
  );
  assert.equal(v.ok, false);
});
