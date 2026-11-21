import { ModelConfig, Thresholds } from "./types";

/**
 * Default models: Anthropic's current Haiku / Sonnet / Opus line.
 * Prices are USD per 1M tokens (Anthropic first-party API list prices, Nov 2026).
 * Override them in settings if your prices differ.
 */
export const DEFAULT_MODELS: ModelConfig[] = [
  {
    id: "haiku",
    tier: "cheap",
    provider: "anthropic",
    model: "claude-haiku-5-5",
    inputPricePerMTok: 0.1,
    outputPricePerMTok: 0.5,
    effort: "low",
  },
  {
    id: "sonnet",
    tier: "balanced",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    inputPricePerMTok: 2,
    outputPricePerMTok: 10,
    effort: "medium",
  },
  {
    id: "opus",
    tier: "premium",
    provider: "anthropic",
    model: "claude-opus-5-5",
    inputPricePerMTok: 4,
    outputPricePerMTok: 20,
    effort: "high",
  },
];

export const DEFAULT_THRESHOLDS: Thresholds = { balanced: 0.3, premium: 0.6 };

export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
