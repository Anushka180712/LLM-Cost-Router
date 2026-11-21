import { ChatMessage, CompletionResult, ModelConfig } from "./types";

export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface CompletionRequest {
  model: ModelConfig;
  messages: ChatMessage[];
  system?: string;
  maxOutputTokens: number;
  apiKey: string | undefined;
  fetchImpl: FetchLike;
  timeoutMs?: number;
}

/** Error from a provider. `retryable` is true for rate limits, overload and network failures. */
export class ProviderError extends Error {
  constructor(message: string, public status: number | undefined, public retryable: boolean) {
    super(message);
    this.name = "ProviderError";
  }
}

const DEFAULT_BASE_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  "openai-compatible": "https://api.openai.com/v1",
};

export const DEFAULT_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  "openai-compatible": "OPENAI_API_KEY",
};

async function post(req: CompletionRequest, url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 120_000);
  let res;
  try {
    res = await req.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e: any) {
    throw new ProviderError(`network error calling ${req.model.id}: ${e?.message ?? e}`, undefined, true);
  } finally {
    clearTimeout(timer);
  }
  const raw = await res.text();
  if (!res.ok) {
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    throw new ProviderError(`${req.model.id} returned HTTP ${res.status}: ${raw.slice(0, 300)}`, res.status, retryable);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ProviderError(`${req.model.id} returned invalid JSON`, res.status, false);
  }
}

async function callAnthropic(req: CompletionRequest): Promise<CompletionResult> {
  if (!req.apiKey) throw new ProviderError(`no API key for ${req.model.id} (anthropic)`, undefined, false);
  const base = (req.model.baseUrl ?? DEFAULT_BASE_URLS.anthropic).replace(/\/$/, "");
  const body: Record<string, unknown> = {
    model: req.model.model,
    max_tokens: req.maxOutputTokens,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (req.system) body.system = req.system;
  if (req.model.effort) body.output_config = { effort: req.model.effort };
  const data = await post(req, `${base}/v1/messages`, {
    "x-api-key": req.apiKey,
    "anthropic-version": "2023-06-01",
  }, body);
  const text = (data.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  return {
    text,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    stopReason: data.stop_reason ?? "unknown",
  };
}

async function callOpenAICompatible(req: CompletionRequest): Promise<CompletionResult> {
  const base = (req.model.baseUrl ?? DEFAULT_BASE_URLS["openai-compatible"]).replace(/\/$/, "");
  const messages: { role: string; content: string }[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push(...req.messages);
  const headers: Record<string, string> = {};
  if (req.apiKey) headers.authorization = `Bearer ${req.apiKey}`;
  const data = await post(req, `${base}/chat/completions`, headers, {
    model: req.model.model,
    max_tokens: req.maxOutputTokens,
    messages,
  });
  const choice = data.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    stopReason: choice?.finish_reason ?? "unknown",
  };
}

export function complete(req: CompletionRequest): Promise<CompletionResult> {
  switch (req.model.provider) {
    case "anthropic":
      return callAnthropic(req);
    case "openai-compatible":
      return callOpenAICompatible(req);
    default:
      throw new ProviderError(`unknown provider "${(req.model as ModelConfig).provider}"`, undefined, false);
  }
}
