import { classify } from "./classifier";
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MODELS, DEFAULT_THRESHOLDS } from "./catalog";
import { costUsd } from "./cost";
import { complete, DEFAULT_KEY_ENV, FetchLike, ProviderError } from "./providers";
import {
  Attempt, ChatMessage, CompletionResult, ModelConfig, RouteDecision, RouteOptions,
  RouterResponse, Thresholds, Tier, TIER_ORDER,
} from "./types";
import { UsageTracker } from "./usage";

export interface RouterConfig {
  models?: ModelConfig[];
  thresholds?: Thresholds;
  /** Daily spend cap in USD. When the next request would exceed it, the router drops to the cheap tier. 0 = off. */
  dailyBudgetUsd?: number;
  /** Retry on the next tier up when the answer looks unsure or empty. */
  escalateOnLowConfidence?: boolean;
  /** Max number of escalations per request. */
  maxEscalations?: number;
  /** On a provider error, try another model instead of failing. */
  failover?: boolean;
  maxOutputTokens?: number;
  systemPrompt?: string;
  /** Returns the API key for a model. Defaults to the model's env var. */
  getApiKey?: (model: ModelConfig) => string | undefined | Promise<string | undefined>;
  fetchImpl?: FetchLike;
  tracker?: UsageTracker;
  timeoutMs?: number;
}

const ALIASES: Record<string, Tier> = {
  cheap: "cheap", fast: "cheap", mini: "cheap", easy: "cheap", low: "cheap",
  balanced: "balanced", mid: "balanced", medium: "balanced", normal: "balanced",
  premium: "premium", smart: "premium", best: "premium", hard: "premium", high: "premium",
};

/** Phrases that suggest the model could not handle the prompt well. */
const LOW_CONFIDENCE = [
  /\bi('| a)m not (sure|certain|able)\b/i,
  /\bi (don't|do not) know\b/i,
  /\bi (can't|cannot|am unable to) (determine|answer|solve|help with that)\b/i,
  /\bthis is (beyond|outside) (my|the scope)/i,
  /\bi (don't|do not) have enough (information|context)\b/i,
];

export function looksLowConfidence(result: CompletionResult): boolean {
  const t = result.text.trim();
  if (!t) return true;
  const head = t.slice(0, 400);
  return LOW_CONFIDENCE.some((p) => p.test(head));
}

/** Parses an inline override such as "@premium explain..." or "!haiku hi". */
export function parseInlineOverride(prompt: string, models: ModelConfig[]): { tier?: Tier; modelId?: string; prompt: string } {
  const m = prompt.match(/^\s*[@!]([\w.-]+)\s+/);
  if (!m) return { prompt };
  const key = m[1].toLowerCase();
  const rest = prompt.slice(m[0].length);
  if (ALIASES[key]) return { tier: ALIASES[key], prompt: rest };
  const model = models.find((x) => x.id.toLowerCase() === key);
  if (model) return { tier: model.tier, modelId: model.id, prompt: rest };
  return { prompt };
}

export class LLMRouter {
  readonly models: ModelConfig[];
  readonly thresholds: Thresholds;
  readonly tracker: UsageTracker;
  private cfg: RouterConfig;

  constructor(cfg: RouterConfig = {}) {
    this.cfg = cfg;
    this.models = cfg.models && cfg.models.length ? cfg.models : DEFAULT_MODELS;
    this.thresholds = cfg.thresholds ?? DEFAULT_THRESHOLDS;
    this.tracker = cfg.tracker ?? new UsageTracker();
    if (this.thresholds.balanced > this.thresholds.premium) {
      throw new Error("thresholds.balanced must be <= thresholds.premium");
    }
  }

  /** First model for a tier; if the tier has none, the nearest tier above, then below. */
  modelForTier(tier: Tier): ModelConfig {
    const idx = TIER_ORDER.indexOf(tier);
    const order = [...TIER_ORDER.slice(idx), ...TIER_ORDER.slice(0, idx).reverse()];
    for (const t of order) {
      const m = this.models.find((x) => x.tier === t);
      if (m) return m;
    }
    throw new Error("no models configured");
  }

  /** The most expensive configured model, used as the "what if I always used the best model" baseline. */
  baselineModel(): ModelConfig {
    return this.modelForTier("premium");
  }

  /** Next model above `current` in the tier ladder, or undefined if it is already the top. */
  nextModelUp(current: ModelConfig): ModelConfig | undefined {
    const idx = TIER_ORDER.indexOf(current.tier);
    for (const t of TIER_ORDER.slice(idx + 1)) {
      const m = this.models.find((x) => x.tier === t);
      if (m) return m;
    }
    return undefined;
  }

  /** Decide where a prompt should go, without calling any API. */
  route(rawPrompt: string, opts: RouteOptions = {}): RouteDecision {
    const history = opts.history ?? [];
    const inline = parseInlineOverride(rawPrompt, this.models);
    const prompt = inline.prompt;
    const classification = classify(prompt, history, this.thresholds);
    const expectedOut = opts.expectedOutputTokens ?? 500;

    let tier: Tier = classification.tier;
    let source: RouteDecision["source"] = "auto";
    let model: ModelConfig;
    let reason: string;

    if (opts.forceTier) {
      tier = opts.forceTier;
      source = "forced";
      model = this.modelForTier(tier);
      reason = `tier forced to ${tier} by caller`;
    } else if (inline.tier) {
      tier = inline.tier;
      source = "inline";
      model = inline.modelId ? this.models.find((m) => m.id === inline.modelId)! : this.modelForTier(tier);
      reason = `inline override selected ${model.id}`;
    } else {
      model = this.modelForTier(tier);
      const top = [...classification.signals].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 2);
      reason = `difficulty score ${classification.score.toFixed(2)} → ${tier}` +
        (top.length ? ` (${top.map((s) => s.detail).join("; ")})` : "");
    }

    let estimated = costUsd(model, classification.estimatedInputTokens, expectedOut);
    const budget = this.cfg.dailyBudgetUsd ?? 0;
    if (budget > 0 && model.tier !== "cheap") {
      const spent = this.tracker.spentToday();
      if (spent + estimated > budget) {
        model = this.modelForTier("cheap");
        tier = model.tier;
        source = "budget";
        reason = `daily budget guard: $${spent.toFixed(4)} spent of $${budget.toFixed(2)}, downgraded to ${model.id}`;
        estimated = costUsd(model, classification.estimatedInputTokens, expectedOut);
      }
    }

    const baseline = costUsd(this.baselineModel(), classification.estimatedInputTokens, expectedOut);
    return {
      tier,
      model,
      classification,
      prompt,
      reason,
      source,
      estimatedCostUsd: estimated,
      baselineCostUsd: baseline,
      estimatedSavingsUsd: baseline - estimated,
    };
  }

  private async apiKey(model: ModelConfig): Promise<string | undefined> {
    if (this.cfg.getApiKey) return this.cfg.getApiKey(model);
    const env = model.apiKeyEnv ?? DEFAULT_KEY_ENV[model.provider];
    return typeof process !== "undefined" ? process.env[env] : undefined;
  }

  /** Route the prompt, call the chosen model, escalate/fail over if needed, and record usage. */
  async ask(rawPrompt: string, opts: RouteOptions = {}): Promise<RouterResponse> {
    const started = Date.now();
    const decision = this.route(rawPrompt, opts);
    const messages: ChatMessage[] = [...(opts.history ?? []), { role: "user", content: decision.prompt }];
    const fetchImpl: FetchLike = this.cfg.fetchImpl ?? ((url, init) => fetch(url, init) as any);
    const maxEsc = this.cfg.escalateOnLowConfidence === false ? 0 : (this.cfg.maxEscalations ?? 1);
    const failover = this.cfg.failover !== false;
    // Pinned choices (inline model, forced tier, budget) are not escalated.
    const canEscalate = decision.source === "auto";

    const attempts: Attempt[] = [];
    let model: ModelConfig | undefined = decision.model;
    const tried = new Set<string>();
    let escalations = 0;
    let lastError: unknown;
    let final: { model: ModelConfig; result: CompletionResult } | undefined;

    while (model && !tried.has(model.id)) {
      tried.add(model.id);
      let result: CompletionResult;
      try {
        result = await complete({
          model,
          messages,
          system: this.cfg.systemPrompt,
          maxOutputTokens: model.maxOutputTokens ?? this.cfg.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          apiKey: await this.apiKey(model),
          fetchImpl,
          timeoutMs: this.cfg.timeoutMs,
        });
      } catch (e) {
        lastError = e;
        attempts.push({ modelId: model.id, tier: model.tier, outcome: "error", detail: (e as Error).message, costUsd: 0 });
        if (!failover || !(e instanceof ProviderError)) break;
        model = this.nextModelUp(model) ?? this.models.find((m) => !tried.has(m.id));
        continue;
      }
      const cost = costUsd(model, result.inputTokens, result.outputTokens);
      const next = this.nextModelUp(model);
      if (canEscalate && escalations < maxEsc && next && looksLowConfidence(result)) {
        attempts.push({ modelId: model.id, tier: model.tier, outcome: "escalated", detail: "answer looked unsure or empty", costUsd: cost });
        escalations++;
        model = next;
        continue;
      }
      attempts.push({ modelId: model.id, tier: model.tier, outcome: "ok", costUsd: cost });
      final = { model, result };
      break;
    }

    const spent = attempts.reduce((s, a) => s + a.costUsd, 0);
    if (!final) {
      // Still record spend from escalated attempts that did cost money.
      if (spent > 0) {
        this.tracker.record({
          timestamp: new Date().toISOString(), tier: decision.tier, modelId: decision.model.id,
          inputTokens: 0, outputTokens: 0, costUsd: spent, baselineCostUsd: spent, escalated: escalations > 0,
        });
      }
      const msg = lastError instanceof Error ? lastError.message : "all models failed";
      throw new ProviderError(`routing failed after ${attempts.length} attempt(s): ${msg}`, undefined, false);
    }

    const { result } = final;
    const baseline = costUsd(this.baselineModel(), result.inputTokens, result.outputTokens);
    this.tracker.record({
      timestamp: new Date().toISOString(),
      tier: final.model.tier,
      modelId: final.model.id,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: spent,
      baselineCostUsd: baseline,
      escalated: escalations > 0,
    });

    return {
      text: result.text,
      decision,
      answeredBy: final.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: spent,
      baselineCostUsd: baseline,
      savingsUsd: baseline - spent,
      attempts,
      latencyMs: Date.now() - started,
    };
  }
}

