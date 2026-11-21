import { ChatMessage, Classification, Signal, Thresholds, Tier } from "./types";
import { DEFAULT_THRESHOLDS } from "./catalog";
import { estimateTokens } from "./cost";

const REASONING_WORDS = [
  "why", "explain", "analy", "compare", "contrast", "evaluate", "design", "architect",
  "prove", "derive", "optimi", "trade-off", "tradeoff", "debug", "refactor", "critique",
  "strategy", "implications", "reason", "justify", "plan", "investigate", "diagnose",
];

const MATH_PATTERNS: RegExp[] = [
  /\\(frac|int|sum|sqrt|lim|begin\{)/, // LaTeX
  /\b(integral|derivative|eigen\w*|matrix|probability|theorem|lemma|proof|big-?o|complexity)\b/i,
  /\d+\s*[\^*/]\s*\d+/, // arithmetic like 3^4, 12*7
  /[=<>≤≥]\s*[a-z]\s*[\^+\-*/]/i, // algebra like = x^2
];

const SIMPLE_PATTERNS: RegExp[] = [
  /^(hi|hello|hey|thanks|thank you|ok|okay)\b/i,
  /^(what|who|when|where) (is|are|was|were) (a |an |the )?[\w\s'-]{1,40}\??$/i,
  /^(define|translate|spell|convert|capitalize|list)\b/i,
  /\b(yes or no|one word|in a sentence|tl;?dr|short answer)\b/i,
  /^fix (the )?(typo|grammar|spelling)/i,
];

const CODE_PATTERNS: RegExp[] = [
  /```/,
  /\b(function|def|class|import|return|const|let|var|public|private|async|await)\b.*[({;:]/,
  /[{};]\s*$/m,
  /\b\w+\([^)]*\)\s*[{:]/,
  /\b(stack ?trace|traceback|exception|segfault|null pointer|TypeError|undefined is not)\b/i,
];

const TECHNICAL_WORDS = [
  "distributed", "concurren", "scalab", "latency", "throughput", "security", "vulnerab",
  "algorithm", "architecture", "partition", "consistency", "migration", "race condition",
  "deadlock", "memory leak", "performance", "cryptograph", "compiler", "kernel",
];

const CONSTRAINT_WORDS = /\b(must|should|ensure|without|at least|at most|no more than|exactly|only if|unless|constraint|requirement)\b/gi;

function clamp(n: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Score how hard a prompt is, using fast local heuristics (no API call).
 * Returns a 0..1 score, the tier it maps to, and every signal that fired.
 */
export function classify(
  prompt: string,
  history: ChatMessage[] = [],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Classification {
  const text = prompt.trim();
  const lower = text.toLowerCase();
  const signals: Signal[] = [];
  const add = (name: string, weight: number, detail: string) => signals.push({ name, weight, detail });

  const tokens = estimateTokens(text);
  const words = text.split(/\s+/).filter(Boolean).length;

  // 1. Length
  if (tokens > 1500) add("length", 0.25, `very long prompt (~${tokens} tokens)`);
  else if (tokens > 400) add("length", 0.15, `long prompt (~${tokens} tokens)`);
  else if (words <= 12) add("short", -0.1, `short prompt (${words} words)`);

  // 2. Code
  const codeHits = CODE_PATTERNS.filter((p) => p.test(text)).length;
  if (codeHits > 0) add("code", Math.min(0.1 + 0.05 * codeHits, 0.25), `contains code or error output (${codeHits} code markers)`);

  // 3. Reasoning vocabulary
  const reasoningHits = REASONING_WORDS.filter((w) => new RegExp(`\\b${w}`, "i").test(lower));
  if (reasoningHits.length > 0) {
    add("reasoning", Math.min(0.1 * reasoningHits.length, 0.3), `asks for reasoning (${reasoningHits.slice(0, 4).join(", ")})`);
  }

  // 4. Math
  const mathHits = MATH_PATTERNS.filter((p) => p.test(text)).length;
  if (mathHits > 0) add("math", Math.min(0.1 * mathHits + 0.05, 0.25), `math or formal notation (${mathHits} markers)`);

  // 5. Multi-step structure
  const numbered = (text.match(/^\s*(\d+[.)]|[-*•])\s+/gm) || []).length;
  const questions = (text.match(/\?/g) || []).length;
  const stepWords = /\b(step[- ]by[- ]step|first\b.*\bthen\b|and then|after that|finally)\b/i.test(text);
  let multi = 0;
  const multiDetail: string[] = [];
  if (numbered >= 3) { multi += 0.1; multiDetail.push(`${numbered} list items`); }
  if (questions >= 3) { multi += 0.1; multiDetail.push(`${questions} questions`); }
  if (stepWords) { multi += 0.1; multiDetail.push("step-by-step wording"); }
  if (multi > 0) add("multi-step", Math.min(multi, 0.25), multiDetail.join(", "));

  // 6. Technical depth
  const techHits = TECHNICAL_WORDS.filter((w) => lower.includes(w));
  if (techHits.length > 0) {
    add("technical", Math.min(0.05 * techHits.length, 0.15), `technical depth (${techHits.slice(0, 4).join(", ")})`);
  }

  // 7. Constraints
  const constraints = (text.match(CONSTRAINT_WORDS) || []).length;
  if (constraints >= 3) add("constraints", 0.1, `${constraints} explicit constraints`);

  // 8. Conversation depth
  const historyTokens = history.reduce((n, m) => n + estimateTokens(m.content), 0);
  if (historyTokens > 2000) add("context", 0.1, `long conversation (~${historyTokens} tokens of history)`);

  // 9. Simple-task markers
  const simpleHit = SIMPLE_PATTERNS.find((p) => p.test(text));
  if (simpleHit) add("simple-task", -0.15, "looks like a lookup, greeting, or rote transformation");

  const base = 0.15;
  const score = clamp(base + signals.reduce((s, x) => s + x.weight, 0));
  return {
    score: Math.round(score * 1000) / 1000,
    tier: tierForScore(score, thresholds),
    signals,
    estimatedInputTokens: tokens + historyTokens,
  };
}

export function tierForScore(score: number, t: Thresholds = DEFAULT_THRESHOLDS): Tier {
  if (score >= t.premium) return "premium";
  if (score >= t.balanced) return "balanced";
  return "cheap";
}
