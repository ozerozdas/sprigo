import { test } from "node:test";
import assert from "node:assert/strict";
import { costOf, priceOf } from "./prices.ts";
import { monthOf, summarize, type UsageRow } from "./usage.ts";

test("cost comes from the verified price table", () => {
  assert.deepEqual(priceOf("openai", "gpt-4o-mini"), { input: 0.15, output: 0.6 });
  assert.equal(costOf("openai", "gpt-4o-mini", 1_000_000, 0), 0.15);
  assert.equal(costOf("anthropic", "claude-sonnet-4.5", 0, 1_000_000), 15);
  assert.ok(Math.abs(costOf("gemini", "gemini-2.5-flash", 1_000_000, 1_000_000)! - 2.8) < 1e-9);
});

test("dated ids, models/ prefixes and OpenRouter vendor ids find the same price", () => {
  const want = costOf("openai", "gpt-4o-mini", 1000, 1000);
  assert.equal(costOf("openai", "gpt-4o-mini-2024-07-18", 1000, 1000), want);
  assert.equal(costOf("openrouter", "openai/gpt-4o-mini", 1000, 1000), want);
  assert.equal(costOf("gemini", "models/gemini-2.5-flash", 1000, 1000), costOf("openrouter", "google/gemini-2.5-flash", 1000, 1000));
});

test("an unknown model has no price; a local model is free", () => {
  assert.equal(priceOf("openai", "some-new-model"), null);
  assert.equal(costOf("openai", "some-new-model", 1000, 1000), null);
  assert.equal(costOf("openrouter", "someone/unlisted", 1000, 1000), null);
  assert.equal(costOf("openrouter", "openai/gpt-4o-mini:free", 1000, 1000), 0, "OpenRouter's free variants cost nothing");
  assert.equal(costOf("ollama", "qwen3:8b", 1000, 1000), 0);
  assert.equal(costOf("lmstudio", "whatever", 1000, 1000), 0);
});

test("monthOf is the local YYYY-MM", () => {
  assert.equal(monthOf(new Date(2026, 0, 9)), "2026-01");
  assert.equal(monthOf(new Date(2026, 10, 30)), "2026-11");
});

test("summarize keeps one month, totals it and flags unpriced models", () => {
  const row = (feature: UsageRow["feature"], provider: string, model: string, input: number, output: number, month = "2026-11"): UsageRow =>
    ({ month, feature, provider, model, input_tokens: input, output_tokens: output });
  const data = summarize([
    row("lesson", "openai", "gpt-4o-mini", 1_000_009, 1),
    row("check", "ollama", "qwen3:8b", 10, 5),
    row("tutor", "anthropic", "claude-unlisted", 7, 3),
    row("lesson", "openai", "gpt-4o-mini", 100, 100, "2026-10"),
  ], "2026-11");
  assert.equal(data.input, 1_000_026);
  assert.equal(data.output, 9);
  assert.ok(Math.abs(data.usd - 0.15000195) < 1e-9, "priced rows only");
  assert.equal(data.priced, true);
  assert.equal(data.unpriced, true);
  assert.deepEqual(data.features.map((f) => f.feature), ["lesson", "check", "tutor"], "FEATURES order");
  assert.equal(data.features[0].input, 1_000_009);
  assert.equal(data.features[0].output, 1);
  assert.ok(Math.abs(data.features[0].usd - 0.15000195) < 1e-9);
  assert.equal(data.features[0].models.length, 1);
  assert.equal(data.features[0].models[0].model, "gpt-4o-mini");
  assert.equal(data.features[2].priced, false, "only an unpriced model");
  assert.equal(data.features[2].usd, 0);
});
