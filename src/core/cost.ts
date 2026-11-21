import { ModelConfig } from "./types";

/** Rough token estimate (~4 characters per token for English text and code). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Cost in USD for a given token count on a model. */
export function costUsd(model: ModelConfig, inputTokens: number, outputTokens: number): number {
  return (inputTokens * model.inputPricePerMTok + outputTokens * model.outputPricePerMTok) / 1_000_000;
}

export function formatUsd(n: number): string {
  if (n === 0) return "$0";
  const a = Math.abs(n);
  // Keep two significant digits for tiny amounts, e.g. $0.0000068.
  if (a < 0.01) return `${n < 0 ? "-" : ""}$${a.toFixed(Math.min(10, -Math.floor(Math.log10(a)) + 1))}`;
  return `$${n.toFixed(4)}`;
}
