import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify, costUsd, DEFAULT_MODELS, FetchLike, LLMRouter, looksLowConfidence, MemoryStore,
  parseInlineOverride, UsageTracker,
} from "../src/core";

const EASY = [
  "hi",
  "What is the capital of France?",
  "Translate 'good morning' to Spanish",
  "define photosynthesis",
];

const HARD = [
  `Design a distributed rate limiter for a multi-region API. Explain the trade-offs between token bucket and sliding window, analyze consistency under network partitions, and propose a strategy for failover. It must handle 1M requests per second, should keep p99 latency under 5ms, and must not require a global lock.`,
  "```ts\nfunction merge(a: number[], b: number[]) {\n  let i = 0, j = 0; const out = [];\n  while (i < a.length && j < b.length) { out.push(a[i] < b[j] ? a[i++] : b[j++]); }\n  return out;\n}\n```\nDebug this: why does it drop elements? Then refactor it, prove it's correct, and analyze its complexity step by step.",
  "Prove that the integral of \\frac{1}{x} from 1 to e is 1, derive the derivative of ln(x) from first principles, and explain why the limit definition works.",
];

test("easy prompts route to the cheap tier", () => {
  for (const p of EASY) {
    const c = classify(p);
    assert.equal(c.tier, "cheap", `${p} scored ${c.score}`);
  }
});

test("hard prompts route to the premium tier", () => {
  for (const p of HARD) {
    const c = classify(p);
    assert.equal(c.tier, "premium", `${p.slice(0, 40)} scored ${c.score} ${JSON.stringify(c.signals)}`);
  }
});

test("medium prompts route to the balanced tier", () => {
  const c = classify("Explain how a hash map handles collisions and compare chaining with open addressing.");
  assert.equal(c.tier, "balanced", `scored ${c.score}`);
});

test("score is clamped to 0..1 and signals explain it", () => {
  const c = classify(HARD[0].repeat(20));
  assert.ok(c.score <= 1 && c.score >= 0);
  assert.ok(c.signals.some((s) => s.name === "length"));
});

test("long history raises the score", () => {
  const p = "and what about the second one?";
  const history = [{ role: "user" as const, content: "x ".repeat(5000) }];
  assert.ok(classify(p, history).score > classify(p).score);
});

test("inline overrides pick a tier or a model id and are stripped", () => {
  assert.deepEqual(parseInlineOverride("@premium hi", DEFAULT_MODELS), { tier: "premium", prompt: "hi" });
  assert.deepEqual(parseInlineOverride("!fast hi", DEFAULT_MODELS), { tier: "cheap", prompt: "hi" });
  assert.deepEqual(parseInlineOverride("@sonnet hi", DEFAULT_MODELS), { tier: "balanced", modelId: "sonnet", prompt: "hi" });
  assert.deepEqual(parseInlineOverride("@unknown hi", DEFAULT_MODELS), { prompt: "@unknown hi" });
  const d = new LLMRouter().route("@opus hi");
  assert.equal(d.model.id, "opus");
  assert.equal(d.source, "inline");
  assert.equal(d.prompt, "hi");
});

test("route estimates cost and savings against the premium baseline", () => {
  const d = new LLMRouter().route("hi");
  assert.equal(d.model.id, "haiku");
  assert.ok(d.estimatedCostUsd < d.baselineCostUsd);
  assert.ok(Math.abs(d.estimatedSavingsUsd - (d.baselineCostUsd - d.estimatedCostUsd)) < 1e-12);
});

test("missing tiers fall back to the nearest configured model", () => {
  const r = new LLMRouter({ models: [DEFAULT_MODELS[0], DEFAULT_MODELS[2]] });
  assert.equal(r.modelForTier("balanced").id, "opus");
  const only = new LLMRouter({ models: [DEFAULT_MODELS[0]] });
  assert.equal(only.modelForTier("premium").id, "haiku");
});

test("budget guard downgrades to the cheap tier once the daily cap is near", () => {
  const tracker = new UsageTracker(new MemoryStore());
  tracker.record({ timestamp: new Date().toISOString(), tier: "premium", modelId: "opus", inputTokens: 0, outputTokens: 0, costUsd: 0.999, baselineCostUsd: 0.999, escalated: false });
  const r = new LLMRouter({ dailyBudgetUsd: 1, tracker });
  const d = r.route(HARD[0]);
  assert.equal(d.source, "budget");
  assert.equal(d.model.id, "haiku");
});

test("bad thresholds are rejected", () => {
  assert.throws(() => new LLMRouter({ thresholds: { balanced: 0.8, premium: 0.5 } }));
});

// ---- API calls with a fake fetch ----

type Reply = { status?: number; body: unknown };
function fakeFetch(replies: Record<string, Reply[]>) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const impl: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const queue = replies[body.model];
    const r = queue?.shift() ?? { status: 500, body: { error: "no reply queued" } };
    const status = r.status ?? 200;
    return { ok: status < 300, status, text: async () => JSON.stringify(r.body) };
  };
  return { impl, calls };
}

const anthropicReply = (text: string, inTok = 10, outTok = 20): Reply => ({
  body: { content: [{ type: "text", text }], usage: { input_tokens: inTok, output_tokens: outTok }, stop_reason: "end_turn" },
});

test("ask calls the Anthropic Messages API with the routed model and records usage", async () => {
  const { impl, calls } = fakeFetch({ "claude-haiku-5-5": [anthropicReply("Paris", 12, 3)] });
  const tracker = new UsageTracker(new MemoryStore());
  const r = new LLMRouter({ fetchImpl: impl, tracker, getApiKey: () => "k", systemPrompt: "be brief" });
  const res = await r.ask("What is the capital of France?");
  assert.equal(res.text, "Paris");
  assert.equal(res.answeredBy.id, "haiku");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].headers["x-api-key"], "k");
  assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(calls[0].body.system, "be brief");
  assert.deepEqual(calls[0].body.output_config, { effort: "low" });
  assert.equal(res.costUsd, costUsd(DEFAULT_MODELS[0], 12, 3));
  const s = tracker.summary();
  assert.equal(s.requests, 1);
  assert.equal(s.byTier.cheap.requests, 1);
  assert.ok(s.savingsUsd > 0);
});

test("unsure answers escalate to the next tier", async () => {
  const { impl, calls } = fakeFetch({
    "claude-haiku-5-5": [anthropicReply("I'm not sure about that.")],
    "claude-sonnet-5-5": [anthropicReply("Here is the answer.")],
  });
  const r = new LLMRouter({ fetchImpl: impl, getApiKey: () => "k" });
  const res = await r.ask("hi");
  assert.equal(res.answeredBy.id, "sonnet");
  assert.deepEqual(res.attempts.map((a) => a.outcome), ["escalated", "ok"]);
  assert.equal(calls.length, 2);
  assert.ok(res.costUsd > res.attempts[1].costUsd, "escalated attempt cost is included");
});

test("escalation can be turned off and does not apply to pinned choices", async () => {
  const off = fakeFetch({ "claude-haiku-5-5": [anthropicReply("I don't know")] });
  const r1 = await new LLMRouter({ fetchImpl: off.impl, getApiKey: () => "k", escalateOnLowConfidence: false }).ask("hi");
  assert.equal(r1.answeredBy.id, "haiku");
  const pinned = fakeFetch({ "claude-haiku-5-5": [anthropicReply("I don't know")] });
  const r2 = await new LLMRouter({ fetchImpl: pinned.impl, getApiKey: () => "k" }).ask("@cheap hi");
  assert.equal(r2.answeredBy.id, "haiku");
});

test("provider errors fail over to another model", async () => {
  const { impl } = fakeFetch({
    "claude-haiku-5-5": [{ status: 529, body: { error: "overloaded" } }],
    "claude-sonnet-5-5": [anthropicReply("ok")],
  });
  const res = await new LLMRouter({ fetchImpl: impl, getApiKey: () => "k" }).ask("hi");
  assert.equal(res.answeredBy.id, "sonnet");
  assert.equal(res.attempts[0].outcome, "error");
});

test("failover off surfaces the error", async () => {
  const { impl } = fakeFetch({ "claude-haiku-5-5": [{ status: 429, body: {} }] });
  await assert.rejects(new LLMRouter({ fetchImpl: impl, getApiKey: () => "k", failover: false }).ask("hi"), /HTTP 429/);
});

test("openai-compatible providers use chat completions", async () => {
  const models = [{
    id: "local", tier: "cheap" as const, provider: "openai-compatible" as const, model: "llama3",
    inputPricePerMTok: 0, outputPricePerMTok: 0, baseUrl: "http://localhost:11434/v1",
  }];
  const { impl, calls } = fakeFetch({
    llama3: [{ body: { choices: [{ message: { content: "hey" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } } }],
  });
  const res = await new LLMRouter({ models, fetchImpl: impl, getApiKey: () => undefined, systemPrompt: "s" }).ask("hi");
  assert.equal(res.text, "hey");
  assert.equal(calls[0].url, "http://localhost:11434/v1/chat/completions");
  assert.equal(calls[0].headers.authorization, undefined);
  assert.deepEqual(calls[0].body.messages[0], { role: "system", content: "s" });
  assert.equal(res.costUsd, 0);
});

test("low confidence detection", () => {
  assert.ok(looksLowConfidence({ text: "", inputTokens: 0, outputTokens: 0, stopReason: "end_turn" }));
  assert.ok(looksLowConfidence({ text: "I cannot determine that.", inputTokens: 0, outputTokens: 0, stopReason: "end_turn" }));
  assert.ok(!looksLowConfidence({ text: "The answer is 42.", inputTokens: 0, outputTokens: 0, stopReason: "end_turn" }));
});
