// Diagnostic helper for inspecting which DOM/widget signals reliably reflect
// the *rendered* TradingView chart symbol vs the requested one. Used while
// developing the rendered-symbol drift hard-fail in src/tv-navigate.js.
//
// Usage: node tools/diag-legend.mjs
//   - connects to the running TV Desktop on CDP:9222
//   - dumps legendMainSourceWrapper innerText, the bottom-right symbol-info
//     widget text, chart.symbol() / chart.symbolExt() / mainSeries.symbolInfo
//   - prints a side-by-side comparison so we can see which one lies after a
//     failed silent-switch and which one tells the truth.

import CDP from "chrome-remote-interface";

const CDP_PORT = 9222;

async function open() {
  const targets = await CDP.List({ port: CDP_PORT });
  const tv =
    targets.find(
      (t) => t.type === "page" && /tradingview\.com\/chart/i.test(t.url),
    ) ||
    targets.find((t) => t.type === "page" && /tradingview/i.test(t.url));
  if (!tv) throw new Error("No TradingView chart tab on CDP:9222");
  const client = await CDP({ port: CDP_PORT, target: tv });
  await client.Runtime.enable();
  return client;
}

async function evalJson(client, expr) {
  const { result } = await client.Runtime.evaluate({
    expression: expr,
    returnByValue: true,
  });
  return result.value;
}

async function main() {
  const client = await open();
  try {
    // Widget API readouts
    const widgetReadout = await evalJson(
      client,
      `
      (function () {
        var out = { chart_symbol: null, chart_symbolExt: null, chart_resolution: null, mainSeries_symbolInfo: null };
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          if (chart) {
            try { out.chart_symbol = chart.symbol(); } catch (e) {}
            try { out.chart_resolution = chart.resolution(); } catch (e) {}
            try {
              if (typeof chart.symbolExt === 'function') {
                var ext = chart.symbolExt();
                out.chart_symbolExt = JSON.parse(JSON.stringify(ext || null));
              }
            } catch (e) {}
            try {
              if (typeof chart.mainSeries === 'function') {
                var ms = chart.mainSeries();
                if (ms && typeof ms.symbolInfo === 'function') {
                  var si = ms.symbolInfo();
                  out.mainSeries_symbolInfo = JSON.parse(JSON.stringify(si || null));
                }
              }
            } catch (e) {}
          }
        } catch (e) { out.error = e.message; }
        return JSON.stringify(out);
      })()
    `,
    );
    console.log("=== Widget API readout ===");
    console.log(widgetReadout);
    console.log();

    // Legend wrapper
    const legendDump = await evalJson(
      client,
      `
      (function () {
        var els = document.querySelectorAll('[class*="legendMainSourceWrapper"]');
        var out = [];
        els.forEach(function (el, i) {
          out.push({
            index: i,
            class: el.className,
            innerText: (el.innerText || '').trim(),
            textContent: (el.textContent || '').trim().slice(0, 400)
          });
        });
        return JSON.stringify(out);
      })()
    `,
    );
    console.log("=== legendMainSourceWrapper ===");
    console.log(legendDump);
    console.log();

    // Symbol-info bottom widget — the price label at the bottom of the chart.
    const symInfoDump = await evalJson(
      client,
      `
      (function () {
        // Look for any element on the page with [class*="symbolInfo"]
        var nodes = document.querySelectorAll('[class*="symbolInfo"], [class*="SymbolInfo"], [data-name*="symbol-info"], [data-name="symbol-info"]');
        var out = [];
        nodes.forEach(function (el, i) {
          var cls = (el.className || '').toString();
          if (cls.length > 200) cls = cls.slice(0, 200);
          out.push({
            i,
            class: cls,
            tag: el.tagName,
            innerText: (el.innerText || '').trim().slice(0, 400)
          });
        });
        return JSON.stringify(out.slice(0, 20));
      })()
    `,
    );
    console.log("=== symbolInfo nodes ===");
    console.log(symInfoDump);
    console.log();

    // What does the tab title look like?
    const tabTitle = await evalJson(client, `document.title`);
    console.log("=== document.title ===");
    console.log(tabTitle);
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
