# LLM Cost Router

Send easy prompts to cheap models and hard prompts to expensive ones, automatically.

Most prompts people send to an LLM ("what's the capital of France?", "rename this variable", "translate this
sentence") don't need the most capable model. LLM Cost Router scores each prompt's difficulty locally, in
microseconds and without an API call, and sends it to the cheapest model that should handle it well. It
tracks every request, shows how much you've saved compared to always using the premium model, and can cap
your daily spend.

It ships as three things that share one core:

- a **VS Code extension** (commands, cost dashboard, status bar spend, secret key storage),
- an **`llm-router` CLI**,
- a **TypeScript library** you can import into your own app.

---

## Contents

- [How it works](#how-it-works)
- [Why a VS Code extension](#why-a-vs-code-extension)
- [Quick start](#quick-start)
- [Features](#features)
  - [1. Difficulty classifier](#1-difficulty-classifier)
  - [2. Three-tier routing](#2-three-tier-routing)
  - [3. Default model catalog](#3-default-model-catalog)
  - [4. Inline overrides](#4-inline-overrides)
  - [5. Cost estimates and savings](#5-cost-estimates-and-savings)
  - [6. Daily budget guard](#6-daily-budget-guard)
  - [7. Low-confidence escalation](#7-low-confidence-escalation)
  - [8. Provider failover](#8-provider-failover)
  - [9. Multiple providers](#9-multiple-providers)
  - [10. Usage tracking](#10-usage-tracking)
  - [11. Conversation-aware scoring](#11-conversation-aware-scoring)
- [VS Code extension](#vs-code-extension)
- [CLI](#cli)
- [Library API](#library-api)
- [Configuration reference](#configuration-reference)
- [Tuning the router](#tuning-the-router)
- [Project layout](#project-layout)
- [Development](#development)
- [Limitations](#limitations)

---

## How it works

```
             ┌──────────────────────┐
 prompt ───► │ inline override?     │── @premium / @haiku … ──────────────┐
             └─────────┬────────────┘                                     │
                       ▼                                                  │
             ┌──────────────────────┐   score 0..1                        │
             │ difficulty classifier│──────────────┐                      │
             └──────────────────────┘              ▼                      ▼
                                       < 0.3  cheap   (Haiku 5.5)   ┌──────────────┐
                                      0.3–0.6 balanced (Sonnet 5.5) │ budget guard │
                                       ≥ 0.6  premium  (Opus 5.5)   └──────┬───────┘
                                                                           ▼
                                                                    ┌──────────────┐
                              unsure answer → next tier up  ◄────── │  call model  │
                              HTTP error    → another model ◄────── └──────┬───────┘
                                                                           ▼
                                                              answer + cost + savings
                                                              recorded in usage stats
```

1. If the prompt starts with an override such as `@premium`, that choice wins.
2. Otherwise the classifier scores the prompt from 0 (trivial) to 1 (very hard) using signals like length,
   code, reasoning words and math.
3. The score maps to a tier: **cheap**, **balanced** or **premium**.
4. If a daily budget is set and this request would go over it, the router drops to the cheap tier.
5. The chosen model is called. If its answer is empty or sounds unsure, the router retries one tier up.
   If the call fails (rate limit, outage, missing key), it tries another model.
6. Tokens, cost and savings against the premium baseline are recorded.

## Why a VS Code extension

A browser extension was the other obvious option. VS Code fits better because:

- **The people who pay per token are mostly developers**, and they already live in their editor. Asking
  about selected code is the most common use, and that needs editor access.
- **API keys stay safe.** VS Code's `SecretStorage` keeps keys in the OS keychain. A browser extension would
  either expose keys to page scripts or need its own backend.
- **No CORS problems.** The extension host is Node.js, so it can call any provider API directly, including
  local servers like Ollama.
- **The same core also runs as a CLI and library**, so the routing logic isn't locked inside the extension.

---

## Quick start

### VS Code

```bash
git clone https://github.com/Anushka180712/LLM-Cost-Router.git
cd LLM-Cost-Router
npm install
npm run compile
npm run package          # creates llm-cost-router-0.1.0.vsix
code --install-extension llm-cost-router-0.1.0.vsix
```

Or open the folder in VS Code and press **F5** to launch a development window with the extension loaded.

Then:

1. Run **LLM Router: Set API Key** from the Command Palette (`Ctrl/Cmd+Shift+P`) and paste your Anthropic key.
2. Press **`Ctrl+Alt+L`** (`Cmd+Alt+L` on macOS), type a question, press Enter.
3. The answer opens beside your editor, with the model, cost and savings at the top.

### CLI

```bash
npm install && npm run compile
npm link                       # puts `llm-router` on your PATH
export ANTHROPIC_API_KEY=sk-ant-...

llm-router route "What is the capital of France?"     # free: shows where it would go
llm-router ask   "What is the capital of France?"     # answers it
llm-router stats
```

---

## Features

### 1. Difficulty classifier

`src/core/classifier.ts`

The classifier is a set of fast, transparent heuristics. It never calls an API, so routing itself costs
nothing and adds no latency. Every prompt starts at a base score of **0.15**; each signal that fires adds or
subtracts a weight; the result is clamped to 0..1.

| Signal | Weight | Fires when |
|---|---|---|
| `length` | +0.15 / +0.25 | Prompt is over ~400 / ~1500 tokens |
| `short` | −0.10 | Prompt is 12 words or fewer |
| `code` | +0.15 to +0.25 | Code fences, code keywords with brackets, lines ending in `{ } ;`, function signatures, or error words like `Traceback`, `TypeError`, `segfault` (+0.05 per marker type) |
| `reasoning` | +0.10 each, max +0.30 | Words such as *why, explain, analyze, compare, design, architect, prove, derive, optimize, trade-off, debug, refactor, critique, strategy, plan, diagnose* |
| `math` | +0.15 to +0.25 | LaTeX (`\frac`, `\int`, …), words like *integral, eigenvalue, probability, theorem, proof, big-O*, arithmetic or algebra expressions |
| `multi-step` | +0.10 each, max +0.25 | 3+ list items, 3+ question marks, or wording like *step by step, first … then, finally* |
| `technical` | +0.05 each, max +0.15 | Words such as *distributed, concurrency, scalability, latency, security, algorithm, architecture, consistency, race condition, deadlock, memory leak* |
| `constraints` | +0.10 | 3+ constraint words: *must, should, ensure, without, at least, at most, exactly, unless* |
| `context` | +0.10 | The conversation history is over ~2000 tokens |
| `simple-task` | −0.15 | Greetings, "what is X?", *define / translate / spell / convert / list*, "yes or no", "one word", "tl;dr", "fix the typo" |

Every decision includes the list of signals that fired and why, so you can always see the reasoning:

```text
$ llm-router route "Explain how a hash map handles collisions and compare chaining with open addressing."
Tier:       balanced  →  sonnet (claude-sonnet-5-5)
Score:      0.35  (balanced ≥ 0.3, premium ≥ 0.6)
Reason:     difficulty score 0.35 → balanced (asks for reasoning (explain, compare))
Signals:
  +0.20  reasoning    asks for reasoning (explain, compare)
Est. cost:  $0.0050 vs $0.0101 on opus (saves $0.0050)
```

### 2. Three-tier routing

The score maps to one of three tiers using two thresholds:

| Score | Tier | Meant for |
|---|---|---|
| below `balanced` (default 0.3) | **cheap** | Lookups, greetings, translations, short rewrites |
| `balanced` to below `premium` (default 0.6) | **balanced** | Explanations, everyday coding questions, comparisons |
| `premium` (default 0.6) and above | **premium** | System design, debugging plus refactoring, proofs, long multi-part tasks |

You can put any number of models in your config, but the router uses the **first model listed for each
tier**. If a tier has no model, it uses the nearest tier above, then below. So a config with only a cheap and a
premium model sends balanced prompts to the premium model, and a config with one model sends everything there.

### 3. Default model catalog

`src/core/catalog.ts`

With no configuration, the router uses Anthropic's current Claude line:

| Tier | id | Model | Input $/MTok | Output $/MTok | Effort |
|---|---|---|---|---|---|
| cheap | `haiku` | `claude-haiku-5-5` | 0.10 | 0.50 | low |
| balanced | `sonnet` | `claude-sonnet-5-5` | 2.00 | 10.00 | medium |
| premium | `opus` | `claude-opus-5-5` | 4.00 | 20.00 | high |

Prices are Anthropic's first-party list prices as of November 2026. Prices change, so if yours differ, put the
right numbers in your config; every cost and savings figure is computed from these fields.

The `effort` field is sent as Anthropic's `output_config.effort`, so even within a model, easy prompts use
less thinking and fewer tokens.

### 4. Inline overrides

Start any prompt with `@` or `!` and a tier name or model id to skip the classifier:

| Prefix | Goes to |
|---|---|
| `@cheap`, `@fast`, `@mini`, `@easy`, `@low` | cheap tier |
| `@balanced`, `@mid`, `@medium`, `@normal` | balanced tier |
| `@premium`, `@smart`, `@best`, `@hard`, `@high` | premium tier |
| `@<model id>` (for example `@haiku`, `@opus`, `@local`) | that exact model |

The prefix is removed before the prompt is sent. An unknown prefix (for example `@someone`) is left alone and
the prompt is routed normally. `!` works the same as `@` (`!premium`), in case `@` means something else where
you are typing.

Choices you pin this way are never escalated, because you made the call.

### 5. Cost estimates and savings

`src/core/cost.ts`

- **Before the call**, `route()` estimates cost from the prompt's token count (about 4 characters per token)
  plus an expected 500 output tokens (change it with `expectedOutputTokens`). It also estimates what the same
  request would cost on the premium model and the difference.
- **After the call**, `ask()` uses the real token counts the provider returns. The cost includes every
  attempt that was billed, so an escalated request counts both the cheap attempt and the one that answered.
- **Savings** are always measured against the most expensive configured model (the "baseline"): what you
  would have paid if every request had gone there.

### 6. Daily budget guard

Set `dailyBudgetUsd` (for example `2`). Before each request, the router adds today's spend to the request's
estimated cost. If that would go over the budget, it switches to the cheap tier and says so in the decision
(`source: "budget"`). "Today" means since local midnight.

The guard downgrades rather than blocks, so you can keep working. Requests that are already cheap aren't
affected. In VS Code the status bar turns to a warning color once you've used 80% of the budget.

### 7. Low-confidence escalation

If the model's answer is empty, or its first 400 characters contain phrases like *"I'm not sure"*,
*"I don't know"*, *"I cannot determine"*, *"this is beyond my scope"* or *"I don't have enough information"*,
the router retries on the next tier up.

- Controlled by `escalateOnLowConfidence` (default on) and `maxEscalations` (default 1).
- Only applies to automatically routed prompts, not to inline overrides, forced tiers or budget downgrades.
- Every attempt is listed in the response's `attempts` array (`escalated`, `ok` or `error`).

This is the safety net that makes aggressive cheap routing workable: a misjudged prompt costs one cheap call
extra rather than a bad answer.

### 8. Provider failover

If a call fails, because of a rate limit (429), an overload or server error (5xx), a timeout, a network error
or a missing API key, the router tries the next model up the ladder, then any model not yet tried. Each model
is tried at most once per request.

Turn it off with `failover: false` to get the error right away. The default request timeout is 120 seconds.

### 9. Multiple providers

`src/core/providers.ts`

Two provider types cover almost every LLM API:

| `provider` | API | Default base URL | Key |
|---|---|---|---|
| `anthropic` | Messages API (`POST /v1/messages`) | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` |
| `openai-compatible` | Chat Completions (`POST /chat/completions`) | `https://api.openai.com/v1` | `OPENAI_API_KEY` |

`openai-compatible` works with OpenAI, OpenRouter, Groq, Together, Fireworks, DeepSeek, vLLM, LM Studio and
Ollama. Set `baseUrl` for anything other than OpenAI. For local servers without auth, leave the key unset and
no `Authorization` header is sent. Set prices to `0` for local models, and they'll count as free.

Mixing providers is the main way to save money. For example, use a free local model for the cheap tier and
Claude for the rest (see [`examples/llm-router.config.json`](examples/llm-router.config.json)).

There are no runtime dependencies: both providers use the built-in `fetch`.

### 10. Usage tracking

`src/core/usage.ts`

Every answered request records: time, tier, model id, input and output tokens, cost, baseline cost and
whether it was escalated. The summary reports:

- total requests, today's requests, number of escalations
- total spend and today's spend
- baseline cost (what everything would have cost on the premium model)
- savings in dollars and as a percentage
- requests and cost per tier, and requests, tokens and cost per model

Records are kept in VS Code's global state (extension) or `~/.llm-cost-router/usage.json` (CLI), capped at
the most recent 5000. Storage is pluggable through the `UsageStore` interface.

### 11. Conversation-aware scoring

Pass earlier turns as `history`. They're sent to the model, and if they add up to more than ~2000 tokens,
the prompt gets the `context` signal (+0.10), since follow-ups in a long conversation usually need a stronger
model to keep track.

---

## VS Code extension

### Commands

Open the Command Palette and type **LLM Router**:

| Command | Shortcut | What it does |
|---|---|---|
| **Ask (auto-routed)** | `Ctrl+Alt+L` / `Cmd+Alt+L` | Type a prompt; it's routed and the answer opens in a Markdown tab beside your editor |
| **Ask About Selection** | `Ctrl+Alt+Shift+L` / `Cmd+Alt+Shift+L`, or right-click | Sends the selected code (or the whole file if nothing is selected) with your instruction, as a fenced code block tagged with the file's language |
| **Ask a Specific Tier** | | Pick cheap / balanced / premium, then type a prompt |
| **Preview Routing Decision (free)** | | Shows the tier, score, signals and estimated cost in the output panel without calling any API |
| **Show Cost Dashboard** | click the status bar item | Spend, savings, requests per tier and per model |
| **Set API Key** | | Saves a key for `anthropic` or `openai-compatible` in VS Code secret storage. Submit an empty value to remove it |
| **Reset Usage Stats** | | Clears recorded usage after you confirm |
| **Show Routing Log** | | Opens the output channel with every decision and result |

### Answer view

Each answer opens as an unsaved Markdown document with a header like:

```markdown
> **Model:** haiku · **Tier:** cheap · **Score:** 0.00
> **Cost:** $0.0000059 · **Saved vs premium:** $0.00023 · **Tokens:** 14 in / 9 out · 812 ms
```

followed by your prompt and the answer. If the router escalated or failed over, an **Attempts** line shows the
path (for example `haiku (escalated) → sonnet (ok)`). Use the built-in Markdown preview to read it rendered.

### Status bar

The right side of the status bar shows today's spend (and the budget, if set). Hover for today's request count
and overall savings; click it to open the dashboard. It turns to the warning color at 80% of the daily budget.

### Dashboard

A webview with cards for total spent, saved vs always-premium, spent today and requests, plus tables by tier
(with a share bar) and by model (with token counts). It updates live after each request and runs with scripts
disabled.

### Routing log

The **LLM Cost Router** output channel logs every decision with its score, signals and estimated cost, and
the result (who answered, actual cost, savings) or the error.

### API keys

Keys are looked up in this order:

1. The key saved with **Set API Key** for that model's provider (stored in the OS keychain through VS Code
   `SecretStorage`, never in settings files).
2. The environment variable named in the model's `apiKeyEnv`, or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.

When a request fails, the error message offers **Set API Key** and **Show Log** buttons.

### Settings

All settings are under `llmRouter.*` (search "LLM Cost Router" in Settings):

| Setting | Default | Description |
|---|---|---|
| `llmRouter.models` | `[]` (built-in Claude catalog) | Models to route between; see [model fields](#model-fields) |
| `llmRouter.thresholds.balanced` | `0.3` | Score at or above which prompts go to balanced |
| `llmRouter.thresholds.premium` | `0.6` | Score at or above which prompts go to premium |
| `llmRouter.dailyBudgetUsd` | `0` (off) | Daily spend cap in USD |
| `llmRouter.escalateOnLowConfidence` | `true` | Retry one tier up on unsure or empty answers |
| `llmRouter.maxEscalations` | `1` | Max escalations per request (0–2) |
| `llmRouter.failover` | `true` | Try another model when one errors |
| `llmRouter.maxOutputTokens` | `4096` | Default max output tokens |
| `llmRouter.systemPrompt` | `""` | System prompt sent with every request |
| `llmRouter.showRoutingNotification` | `true` | Flash the chosen model in the status bar |

Example `settings.json` using a local model for the cheap tier:

```jsonc
{
  "llmRouter.models": [
    { "id": "local", "tier": "cheap", "provider": "openai-compatible", "model": "llama3.2",
      "baseUrl": "http://localhost:11434/v1", "inputPricePerMTok": 0, "outputPricePerMTok": 0 },
    { "id": "sonnet", "tier": "balanced", "provider": "anthropic", "model": "claude-sonnet-5-5",
      "inputPricePerMTok": 2, "outputPricePerMTok": 10, "effort": "medium" },
    { "id": "opus", "tier": "premium", "provider": "anthropic", "model": "claude-opus-5-5",
      "inputPricePerMTok": 4, "outputPricePerMTok": 20, "effort": "high" }
  ],
  "llmRouter.dailyBudgetUsd": 2
}
```

---

## CLI

```text
llm-router route "<prompt>"     Show the routing decision (no API call, free)
llm-router ask "<prompt>"       Route and answer the prompt
llm-router stats                Show spend and savings so far
llm-router models               List configured models and tiers
llm-router reset-stats          Clear recorded usage

Options:
  --tier <cheap|balanced|premium> Force a tier
  --config <file>                 Config file
  --json                          Machine readable output
  -                               Read the prompt from stdin
```

- **Config file:** `--config <file>`, else `./llm-router.config.json`, else `~/.llm-cost-router/config.json`,
  else the defaults. The format is the [router config](#configuration-reference) as JSON; see
  [`examples/llm-router.config.json`](examples/llm-router.config.json).
- **Keys:** from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or each model's `apiKeyEnv`.
- **Output:** `ask` prints the answer on stdout and a summary line on stderr, so piping keeps only the answer:

  ```text
  $ llm-router ask "hi" > answer.txt
  — haiku (cheap) · 8+12 tokens · $0.0000068 · saved $0.00027 · 640 ms
  ```

- **Stdin:** `git diff | llm-router ask -` or `cat error.log | llm-router route -`.
- **JSON:** `--json` prints the full decision, response or summary object for scripts.
- **Usage file:** `~/.llm-cost-router/usage.json`.

---

## Library API

```ts
import { LLMRouter } from "llm-cost-router/out/src/core";

const router = new LLMRouter({
  dailyBudgetUsd: 5,
  systemPrompt: "Answer concisely.",
  // getApiKey: (model) => mySecrets.get(model.provider),
});

// Free, synchronous: where would this go?
const decision = router.route("Prove that sqrt(2) is irrational");
console.log(decision.tier, decision.model.model, decision.reason);

// Route and answer.
const res = await router.ask("What is the capital of France?");
console.log(res.text, res.answeredBy.id, res.costUsd, res.savingsUsd);

// Multi-turn.
await router.ask("And its population?", {
  history: [
    { role: "user", content: "What is the capital of France?" },
    { role: "assistant", content: res.text },
  ],
});

console.log(router.tracker.summary());
```

### Main exports

| Export | Description |
|---|---|
| `LLMRouter` | The router. `route(prompt, opts)` decides; `ask(prompt, opts)` decides, calls, escalates, fails over and records |
| `classify(prompt, history?, thresholds?)` | The classifier on its own: `{ score, tier, signals, estimatedInputTokens }` |
| `tierForScore(score, thresholds?)` | Maps a score to a tier |
| `parseInlineOverride(prompt, models)` | Parses `@tier` / `@model` prefixes |
| `looksLowConfidence(result)` | The escalation check |
| `complete(request)` | Calls one provider directly |
| `UsageTracker`, `MemoryStore`, `UsageStore` | Usage recording and pluggable storage |
| `estimateTokens`, `costUsd`, `formatUsd` | Cost helpers |
| `DEFAULT_MODELS`, `DEFAULT_THRESHOLDS` | Built-in defaults |
| `ProviderError` | Error with `status` and `retryable` |

### `route()` / `ask()` options

| Option | Description |
|---|---|
| `forceTier` | Skip classification and use this tier |
| `history` | Earlier turns, `{ role: "user" \| "assistant", content }[]` |
| `expectedOutputTokens` | Output size used for cost estimates (default 500) |

### `RouteDecision`

`tier`, `model`, `classification` (score, signals), `prompt` (override stripped), `reason`, `source`
(`auto` / `inline` / `forced` / `budget`), `estimatedCostUsd`, `baselineCostUsd`, `estimatedSavingsUsd`.

### `RouterResponse`

`text`, `decision`, `answeredBy`, `inputTokens`, `outputTokens`, `costUsd`, `baselineCostUsd`, `savingsUsd`,
`attempts` (`{ modelId, tier, outcome, detail?, costUsd }[]`), `latencyMs`.

---

## Configuration reference

The same options apply to the library (`new LLMRouter({...})`), the CLI config file and, under `llmRouter.*`,
VS Code settings.

| Option | Type | Default | Description |
|---|---|---|---|
| `models` | `ModelConfig[]` | Claude Haiku / Sonnet / Opus 5.5 | Models to route between |
| `thresholds` | `{ balanced, premium }` | `{ 0.3, 0.6 }` | Score cut-offs; `balanced` must be ≤ `premium` |
| `dailyBudgetUsd` | number | `0` (off) | Daily spend cap |
| `escalateOnLowConfidence` | boolean | `true` | Retry one tier up on unsure answers |
| `maxEscalations` | number | `1` | Max escalations per request |
| `failover` | boolean | `true` | Try another model on errors |
| `maxOutputTokens` | number | `4096` | Default max output tokens |
| `systemPrompt` | string | none | System prompt for every request |
| `timeoutMs` | number | `120000` | Per-call timeout (library only) |
| `getApiKey` | `(model) => string` | env vars | Key lookup (library only) |
| `fetchImpl` | function | global `fetch` | Custom HTTP client, handy for tests or proxies (library only) |
| `tracker` | `UsageTracker` | in-memory | Where usage goes (library only) |

### Model fields

| Field | Required | Description |
|---|---|---|
| `id` | yes | Short unique name; also works as an inline override (`@id`) |
| `tier` | yes | `cheap`, `balanced` or `premium` |
| `provider` | yes | `anthropic` or `openai-compatible` |
| `model` | yes | Model name sent to the API |
| `inputPricePerMTok` | yes | USD per 1M input tokens |
| `outputPricePerMTok` | yes | USD per 1M output tokens |
| `baseUrl` | no | API base URL |
| `apiKeyEnv` | no | Environment variable for this model's key |
| `effort` | no | Anthropic effort: `low`, `medium`, `high`, `xhigh`, `max` |
| `maxOutputTokens` | no | Overrides the global max for this model |

---

## Tuning the router

- **Saving too little?** Raise `thresholds.balanced` (for example to 0.4) so more prompts go cheap.
  Escalation catches the misjudged ones.
- **Cheap answers not good enough?** Lower the thresholds, or keep them and raise `maxEscalations`.
- **Check before you change:** run `llm-router route` or **Preview Routing Decision** on a handful of your
  real prompts and look at the scores and signals.
- **Watch escalations** in `llm-router stats` or the dashboard. Many escalations means the cheap tier is
  getting prompts it can't handle, so lower `thresholds.balanced`.
- **Domain words:** the keyword lists in `src/core/classifier.ts` are plain arrays. Add your field's terms to
  `REASONING_WORDS` or `TECHNICAL_WORDS` if your hard prompts use vocabulary the defaults miss.

---

## Project layout

```text
src/
  core/
    types.ts        Shared types (tiers, models, decisions, responses)
    catalog.ts      Default models, prices and thresholds
    classifier.ts   Difficulty scoring heuristics
    cost.ts         Token estimates and cost math
    providers.ts    Anthropic and OpenAI-compatible HTTP clients
    router.ts       Routing, overrides, budget guard, escalation, failover
    usage.ts        Usage records, summaries, pluggable storage
    index.ts        Public exports
  extension.ts      VS Code extension (commands, dashboard, status bar, secrets)
  cli.ts            llm-router command line tool
test/
  router.test.ts    Classifier, routing, budget, escalation, failover and provider tests
examples/
  llm-router.config.json
```

## Development

```bash
npm install
npm run compile      # TypeScript → out/
npm test             # compile + run tests with node:test
npm run watch        # recompile on change
npm run package      # build a .vsix (uses @vscode/vsce)
```

Press **F5** in VS Code to start an Extension Development Host. Tests use a fake `fetch`, so they don't need
API keys or network access. CI runs the tests on every push and pull request
(`.github/workflows/ci.yml`).

Requirements: Node.js 20 or newer, VS Code 1.90 or newer.

## Limitations

- The classifier is heuristic. It judges how a prompt looks, not what it means, so a short prompt that is
  actually hard ("Is P = NP?") can be routed cheap. Escalation and inline overrides are the backstops.
- Token counts before a call are estimates (about 4 characters per token). Costs after a call use the
  provider's real counts.
- Low-confidence detection looks for English hedging phrases only.
- Answers are not streamed; each answer appears when it's complete.
- Prices in the default catalog are a snapshot. Check your provider's pricing page and override them in your
  config if they've changed.
