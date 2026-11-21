/** Difficulty tiers, cheapest first. */
export type Tier = "cheap" | "balanced" | "premium";

export const TIER_ORDER: Tier[] = ["cheap", "balanced", "premium"];

export type ProviderKind = "anthropic" | "openai-compatible";

/** One model the router can send prompts to. */
export interface ModelConfig {
  /** Short unique name used in logs and overrides, e.g. "haiku". */
  id: string;
  /** Which difficulty tier this model serves. */
  tier: Tier;
  provider: ProviderKind;
  /** Model name sent to the provider API, e.g. "claude-haiku-5-5". */
  model: string;
  /** USD per 1M input tokens. */
  inputPricePerMTok: number;
  /** USD per 1M output tokens. */
  outputPricePerMTok: number;
  /** Override the API base URL (required for most openai-compatible providers). */
  baseUrl?: string;
  /** Environment variable holding the API key (CLI). Defaults per provider. */
  apiKeyEnv?: string;
  /** Optional effort hint for providers that support it (Anthropic `output_config.effort`). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Max output tokens for this model. Falls back to the router default. */
  maxOutputTokens?: number;
}

export interface Thresholds {
  /** Scores >= this go to "balanced". */
  balanced: number;
  /** Scores >= this go to "premium". */
  premium: number;
}

export interface Signal {
  /** Machine name of the signal, e.g. "code". */
  name: string;
  /** Contribution to the score (can be negative). */
  weight: number;
  /** Human readable explanation. */
  detail: string;
}

export interface Classification {
  /** 0 (trivial) to 1 (very hard). */
  score: number;
  tier: Tier;
  signals: Signal[];
  estimatedInputTokens: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface RouteOptions {
  /** Force a tier and skip classification. */
  forceTier?: Tier;
  /** Earlier turns of the conversation (affect the score and are sent to the model). */
  history?: ChatMessage[];
  /** Expected output tokens for cost estimates. Default 500. */
  expectedOutputTokens?: number;
}

export interface RouteDecision {
  tier: Tier;
  model: ModelConfig;
  classification: Classification;
  /** Prompt with any inline override prefix removed. */
  prompt: string;
  /** Why this tier was chosen, in one sentence. */
  reason: string;
  /** "auto" | "inline" | "forced" | "budget". */
  source: "auto" | "inline" | "forced" | "budget";
  estimatedCostUsd: number;
  /** What the same request would cost on the premium model. */
  baselineCostUsd: number;
  estimatedSavingsUsd: number;
}

export interface CompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
}

export interface RouterResponse {
  text: string;
  decision: RouteDecision;
  /** The model that actually answered (differs from decision.model after escalation/failover). */
  answeredBy: ModelConfig;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  baselineCostUsd: number;
  savingsUsd: number;
  /** Every attempt made, in order. */
  attempts: Attempt[];
  latencyMs: number;
}

export interface Attempt {
  modelId: string;
  tier: Tier;
  outcome: "ok" | "escalated" | "error";
  detail?: string;
  costUsd: number;
}

export interface UsageRecord {
  timestamp: string;
  tier: Tier;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  baselineCostUsd: number;
  escalated: boolean;
}
