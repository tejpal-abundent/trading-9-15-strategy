import CDP from "chrome-remote-interface";
import { GoogleGenAI } from "@google/genai";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";

const SCREENSHOT_DIR = "screenshots";
const CDP_PORT = 9222;

// Connects to local TradingView Desktop CDP, screenshots the first TV tab.
export async function captureChart(filename) {
  if (!existsSync(SCREENSHOT_DIR)) mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const outPath = resolve(SCREENSHOT_DIR, filename);

  let client;
  try {
    const targets = await CDP.List({ port: CDP_PORT });
    const tvTarget = targets.find(
      (t) => t.type === "page" && /tradingview\.com/i.test(t.url),
    );
    if (!tvTarget) {
      throw new Error(
        "TradingView tab not found on CDP:9222 — is TradingView Desktop running with remote debugging enabled?",
      );
    }

    client = await CDP({ port: CDP_PORT, target: tvTarget });
    const { Page } = client;
    await Page.enable();
    const { data } = await Page.captureScreenshot({ format: "png" });
    writeFileSync(outPath, Buffer.from(data, "base64"));
    return outPath;
  } finally {
    if (client) await client.close();
  }
}

// Sends a screenshot + rubric prompt to Gemini Vision, parses the JSON response.
export async function askGeminiVision({
  imagePath,
  prompt,
  model = "gemini-2.5-flash",
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY missing in .env — skipping visual confirmation.",
    );
  }

  const ai = new GoogleGenAI({ apiKey });
  const imageData = readFileSync(imagePath).toString("base64");

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: "image/png", data: imageData } },
        ],
      },
    ],
    config: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  });

  const text = response.text?.trim() ?? "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Gemini returned non-JSON: ${text.slice(0, 200)}... (${err.message})`,
    );
  }

  // Token usage for cost tracking
  const usage = response.usageMetadata || {};
  const inputTokens = usage.promptTokenCount ?? 0;
  const outputTokens = usage.candidatesTokenCount ?? 0;

  // Gemini 2.5 Flash: $0.30/M input, $2.50/M output (approx, as of 2026-04)
  const costUSD =
    (inputTokens / 1_000_000) * 0.3 + (outputTokens / 1_000_000) * 2.5;

  return { result: parsed, inputTokens, outputTokens, costUSD, model };
}

export function fillRubric(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

const COST_LOG = "visual-cost.json";

export function getTodaysCost() {
  if (!existsSync(COST_LOG)) return 0;
  const data = JSON.parse(readFileSync(COST_LOG, "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  return data[today] ?? 0;
}

export function recordCost(costUSD) {
  const today = new Date().toISOString().slice(0, 10);
  const data = existsSync(COST_LOG)
    ? JSON.parse(readFileSync(COST_LOG, "utf8"))
    : {};
  data[today] = (data[today] ?? 0) + costUSD;
  writeFileSync(COST_LOG, JSON.stringify(data, null, 2));
  return data[today];
}
