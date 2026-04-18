import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/scanner.js";

test("slugify replaces colons", () => {
  assert.equal(slugify("BINANCE:BTCUSDT"), "BINANCE_BTCUSDT");
});

test("slugify keeps alphanumerics", () => {
  assert.equal(slugify("BTCUSDT"), "BTCUSDT");
});

test("slugify replaces slashes and spaces", () => {
  assert.equal(slugify("XAU/USD"), "XAU_USD");
  assert.equal(slugify("Some Label"), "Some_Label");
});

test("slugify keeps hyphens and underscores", () => {
  assert.equal(slugify("a-b_c"), "a-b_c");
});
