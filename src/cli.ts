#!/usr/bin/env node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_MODELS, formatUsd, LLMRouter, RouterConfig, Tier, TIER_ORDER, UsageRecord, UsageStore, UsageTracker,
} from "./core";

const HOME_DIR = path.join(os.homedir(), ".llm-cost-router");
const USAGE_FILE = path.join(HOME_DIR, "usage.json");

class FileStore implements UsageStore {
  constructor(private file: string) {}
  load(): UsageRecord[] {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return []; }
  }
  save(records: UsageRecord[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(records));
  }
}

function loadConfig(explicit?: string): RouterConfig {
  const candidates = explicit ? [explicit] : [path.resolve("llm-router.config.json"), path.join(HOME_DIR, "config.json")];
  for (const file of candidates) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  if (explicit) throw new Error(`config file not found: ${explicit}`);
  return {};
}

const HELP = `llm-router: send easy prompts to cheap models and hard ones to expensive models.

Usage:
  llm-router route "<prompt>"     Show the routing decision (no API call, free)
  llm-router ask "<prompt>"       Route and answer the prompt
  llm-router stats                Show spend and savings so far
  llm-router models               List configured models and tiers
  llm-router reset-stats          Clear recorded usage

Options:
  --tier <cheap|balanced|premium> Force a tier
  --config <file>                 Config file (default ./llm-router.config.json or ~/.llm-cost-router/config.json)
  --json                          Machine readable output
  -                               Read the prompt from stdin

Inline overrides: start a prompt with @cheap, @balanced, @premium or @<model id>.
API keys come from ANTHROPIC_API_KEY / OPENAI_API_KEY, or each model's "apiKeyEnv".`;

function parseArgs(argv: string[]) {
  const out: { cmd?: string; prompt: string[]; tier?: Tier; config?: string; json: boolean } = { prompt: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tier") out.tier = argv[++i] as Tier;
    else if (a === "--config") out.config = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "-h" || a === "--help") out.cmd = "help";
    else if (!out.cmd) out.cmd = a;
    else out.prompt.push(a);
  }
  return out;
}

async function readPrompt(parts: string[]): Promise<string> {
  if (parts.length === 1 && parts[0] === "-" || (parts.length === 0 && !process.stdin.isTTY)) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
  return parts.join(" ");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cmd || args.cmd === "help") { console.log(HELP); return; }
  if (args.tier && !TIER_ORDER.includes(args.tier)) throw new Error(`--tier must be one of ${TIER_ORDER.join(", ")}`);

  const cfg = loadConfig(args.config);
  const router = new LLMRouter({ ...cfg, tracker: new UsageTracker(new FileStore(USAGE_FILE)) });

  switch (args.cmd) {
    case "route": {
      const prompt = await readPrompt(args.prompt);
      const d = router.route(prompt, { forceTier: args.tier });
      if (args.json) { console.log(JSON.stringify(d, null, 2)); return; }
      console.log(`Tier:       ${d.tier}  →  ${d.model.id} (${d.model.model})`);
      console.log(`Score:      ${d.classification.score.toFixed(2)}  (balanced ≥ ${router.thresholds.balanced}, premium ≥ ${router.thresholds.premium})`);
      console.log(`Reason:     ${d.reason}`);
      console.log(`Signals:`);
      for (const s of d.classification.signals) console.log(`  ${s.weight >= 0 ? "+" : ""}${s.weight.toFixed(2)}  ${s.name.padEnd(12)} ${s.detail}`);
      console.log(`Est. cost:  ${formatUsd(d.estimatedCostUsd)} vs ${formatUsd(d.baselineCostUsd)} on ${router.baselineModel().id} (saves ${formatUsd(d.estimatedSavingsUsd)})`);
      return;
    }
    case "ask": {
      const prompt = await readPrompt(args.prompt);
      if (!prompt.trim()) throw new Error("empty prompt");
      const r = await router.ask(prompt, { forceTier: args.tier });
      if (args.json) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(r.text);
      console.error(`\n— ${r.answeredBy.id} (${r.decision.tier}) · ${r.inputTokens}+${r.outputTokens} tokens · ${formatUsd(r.costUsd)} · saved ${formatUsd(r.savingsUsd)} · ${r.latencyMs} ms`);
      if (r.attempts.length > 1) console.error(`  attempts: ${r.attempts.map((a) => `${a.modelId}:${a.outcome}`).join(" → ")}`);
      return;
    }
    case "stats": {
      const s = router.tracker.summary();
      if (args.json) { console.log(JSON.stringify(s, null, 2)); return; }
      console.log(`Requests:     ${s.requests} (${s.todayRequests} today, ${s.escalations} escalated)`);
      console.log(`Spent:        ${formatUsd(s.totalCostUsd)} (${formatUsd(s.todayCostUsd)} today)`);
      console.log(`If all premium: ${formatUsd(s.baselineCostUsd)}`);
      console.log(`Saved:        ${formatUsd(s.savingsUsd)} (${(s.savingsRate * 100).toFixed(1)}%)`);
      for (const t of TIER_ORDER) console.log(`  ${t.padEnd(9)} ${String(s.byTier[t].requests).padStart(5)} requests  ${formatUsd(s.byTier[t].costUsd)}`);
      return;
    }
    case "models": {
      const models = router.models;
      if (args.json) { console.log(JSON.stringify(models, null, 2)); return; }
      for (const m of models) {
        console.log(`${m.tier.padEnd(9)} ${m.id.padEnd(10)} ${m.provider.padEnd(18)} ${m.model.padEnd(22)} $${m.inputPricePerMTok}/$${m.outputPricePerMTok} per MTok`);
      }
      if (models === DEFAULT_MODELS) console.log("(defaults; add a config file to change)");
      return;
    }
    case "reset-stats":
      router.tracker.reset();
      console.log("Usage cleared.");
      return;
    default:
      console.error(`unknown command "${args.cmd}"\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`error: ${e?.message ?? e}`);
  process.exitCode = 1;
});
