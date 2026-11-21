import * as vscode from "vscode";
import {
  formatUsd, LLMRouter, ModelConfig, ProviderKind, RouterResponse, RouteDecision, Tier, TIER_ORDER,
  UsageRecord, UsageStore, UsageSummary, UsageTracker,
} from "./core";

const USAGE_KEY = "llmRouter.usage";
const secretKey = (provider: ProviderKind) => `llmRouter.apiKey.${provider}`;

class GlobalStateStore implements UsageStore {
  constructor(private ctx: vscode.ExtensionContext) {}
  load(): UsageRecord[] { return this.ctx.globalState.get<UsageRecord[]>(USAGE_KEY, []); }
  save(records: UsageRecord[]): void { void this.ctx.globalState.update(USAGE_KEY, records); }
}

let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let dashboard: vscode.WebviewPanel | undefined;

function buildRouter(ctx: vscode.ExtensionContext, tracker: UsageTracker): LLMRouter {
  const c = vscode.workspace.getConfiguration("llmRouter");
  const models = c.get<ModelConfig[]>("models", []);
  return new LLMRouter({
    models: models.length ? models : undefined,
    thresholds: { balanced: c.get("thresholds.balanced", 0.3), premium: c.get("thresholds.premium", 0.6) },
    dailyBudgetUsd: c.get("dailyBudgetUsd", 0),
    escalateOnLowConfidence: c.get("escalateOnLowConfidence", true),
    maxEscalations: c.get("maxEscalations", 1),
    failover: c.get("failover", true),
    maxOutputTokens: c.get("maxOutputTokens", 4096),
    systemPrompt: c.get<string>("systemPrompt") || undefined,
    tracker,
    getApiKey: async (m) => {
      const fromSecret = await ctx.secrets.get(secretKey(m.provider));
      if (fromSecret) return fromSecret;
      const env = m.apiKeyEnv ?? (m.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY");
      return process.env[env];
    },
  });
}

function describeDecision(d: RouteDecision, router: LLMRouter): string {
  const lines = [
    `Tier: ${d.tier} → ${d.model.id} (${d.model.model})`,
    `Score: ${d.classification.score.toFixed(2)} (balanced ≥ ${router.thresholds.balanced}, premium ≥ ${router.thresholds.premium})`,
    `Reason: ${d.reason}`,
    `Signals:`,
    ...d.classification.signals.map((s) => `  ${s.weight >= 0 ? "+" : ""}${s.weight.toFixed(2)} ${s.name}: ${s.detail}`),
    `Estimated cost: ${formatUsd(d.estimatedCostUsd)} (premium baseline ${formatUsd(d.baselineCostUsd)}, saves ${formatUsd(d.estimatedSavingsUsd)})`,
  ];
  return lines.join("\n");
}

function responseMarkdown(prompt: string, r: RouterResponse): string {
  const trail = r.attempts.map((a) => `${a.modelId} (${a.outcome})`).join(" → ");
  const header = [
    `> **Model:** ${r.answeredBy.id} · **Tier:** ${r.answeredBy.tier} · **Score:** ${r.decision.classification.score.toFixed(2)}`,
    `> **Cost:** ${formatUsd(r.costUsd)} · **Saved vs premium:** ${formatUsd(r.savingsUsd)} · **Tokens:** ${r.inputTokens} in / ${r.outputTokens} out · ${r.latencyMs} ms`,
  ];
  if (r.attempts.length > 1) header.push(`> **Attempts:** ${trail}`);
  const shownPrompt = prompt.length > 2000 ? prompt.slice(0, 2000) + "\n…" : prompt;
  return [...header, "", "## Prompt", "", shownPrompt, "", "## Answer", "", r.text, ""].join("\n");
}

function updateStatusBar(router: LLMRouter) {
  const s = router.tracker.summary();
  const budget = vscode.workspace.getConfiguration("llmRouter").get("dailyBudgetUsd", 0);
  statusBar.text = `$(pulse) ${formatUsd(s.todayCostUsd)}${budget > 0 ? ` / $${budget}` : ""}`;
  statusBar.tooltip = `LLM Cost Router: ${s.todayRequests} requests today, ${formatUsd(s.savingsUsd)} saved overall (${(s.savingsRate * 100).toFixed(0)}%). Click for the dashboard.`;
  statusBar.backgroundColor = budget > 0 && s.todayCostUsd >= budget * 0.8
    ? new vscode.ThemeColor("statusBarItem.warningBackground")
    : undefined;
  if (dashboard) dashboard.webview.html = dashboardHtml(s, router);
}

async function runAsk(ctx: vscode.ExtensionContext, tracker: UsageTracker, prompt: string, forceTier?: Tier) {
  const router = buildRouter(ctx, tracker);
  const decision = router.route(prompt, { forceTier });
  output.appendLine(`[${new Date().toLocaleTimeString()}] ${describeDecision(decision, router).replace(/\n/g, "\n    ")}`);
  if (vscode.workspace.getConfiguration("llmRouter").get("showRoutingNotification", true)) {
    void vscode.window.setStatusBarMessage(`$(arrow-right) Routing to ${decision.model.id} (${decision.tier})…`, 4000);
  }
  try {
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Asking ${decision.model.id} (${decision.tier})…`, cancellable: false },
      () => router.ask(prompt, { forceTier }),
    );
    output.appendLine(`    → answered by ${r.answeredBy.id}, ${formatUsd(r.costUsd)}, saved ${formatUsd(r.savingsUsd)}`);
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: responseMarkdown(decision.prompt, r) });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  } catch (e: any) {
    output.appendLine(`    ✗ ${e?.message ?? e}`);
    const choice = await vscode.window.showErrorMessage(`LLM Cost Router: ${e?.message ?? e}`, "Set API Key", "Show Log");
    if (choice === "Set API Key") void vscode.commands.executeCommand("llmRouter.setApiKey");
    if (choice === "Show Log") output.show();
  } finally {
    updateStatusBar(router);
  }
}

function selectionOrDocument(): { text: string; language: string } | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return undefined;
  const text = ed.selection.isEmpty ? ed.document.getText() : ed.document.getText(ed.selection);
  return { text, language: ed.document.languageId };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function dashboardHtml(s: UsageSummary, router: LLMRouter): string {
  const pct = (n: number) => (s.requests ? Math.round((n / s.requests) * 100) : 0);
  const tierRows = TIER_ORDER.map((t) => `
    <tr><td>${t}</td><td>${escapeHtml(router.modelForTier(t).id)}</td><td>${s.byTier[t].requests}</td>
    <td><div class="bar"><span style="width:${pct(s.byTier[t].requests)}%"></span></div> ${pct(s.byTier[t].requests)}%</td>
    <td>${formatUsd(s.byTier[t].costUsd)}</td></tr>`).join("");
  const modelRows = Object.entries(s.byModel).map(([id, m]) => `
    <tr><td>${escapeHtml(id)}</td><td>${m.requests}</td><td>${m.inputTokens.toLocaleString()}</td><td>${m.outputTokens.toLocaleString()}</td><td>${formatUsd(m.costUsd)}</td></tr>`).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px; }
  .card .v { font-size: 1.6em; font-weight: 600; }
  .card .l { opacity: .75; font-size: .9em; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .bar { display: inline-block; width: 100px; height: 8px; background: var(--vscode-editorWidget-background); border-radius: 4px; vertical-align: middle; }
  .bar span { display: block; height: 100%; background: var(--vscode-charts-green, #3c3); border-radius: 4px; }
</style></head><body>
<h2>LLM Cost Router</h2>
<div class="cards">
  <div class="card"><div class="v">${formatUsd(s.totalCostUsd)}</div><div class="l">Total spent</div></div>
  <div class="card"><div class="v">${formatUsd(s.savingsUsd)}</div><div class="l">Saved vs always-premium (${(s.savingsRate * 100).toFixed(1)}%)</div></div>
  <div class="card"><div class="v">${formatUsd(s.todayCostUsd)}</div><div class="l">Spent today (${s.todayRequests} requests)</div></div>
  <div class="card"><div class="v">${s.requests}</div><div class="l">Requests (${s.escalations} escalated)</div></div>
</div>
<h3>By tier</h3>
<table><tr><th>Tier</th><th>Model</th><th>Requests</th><th>Share</th><th>Cost</th></tr>${tierRows}</table>
<h3>By model</h3>
<table><tr><th>Model</th><th>Requests</th><th>Input tokens</th><th>Output tokens</th><th>Cost</th></tr>${modelRows || '<tr><td colspan="5">No requests yet.</td></tr>'}</table>
</body></html>`;
}

export function activate(ctx: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("LLM Cost Router");
  const tracker = new UsageTracker(new GlobalStateStore(ctx));
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "llmRouter.showDashboard";
  statusBar.show();
  updateStatusBar(buildRouter(ctx, tracker));

  const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg("llmRouter.ask", async () => {
    const prompt = await vscode.window.showInputBox({
      prompt: "Ask anything. Easy prompts go to the cheap model, hard ones to the premium model.",
      placeHolder: "e.g. @premium design a rate limiter for a multi-region API",
      ignoreFocusOut: true,
    });
    if (prompt?.trim()) await runAsk(ctx, tracker, prompt);
  });

  reg("llmRouter.askWithTier", async () => {
    const pick = await vscode.window.showQuickPick(
      TIER_ORDER.map((t) => ({ label: t, description: buildRouter(ctx, tracker).modelForTier(t).model })),
      { placeHolder: "Pick a tier (skips automatic routing)" },
    );
    if (!pick) return;
    const prompt = await vscode.window.showInputBox({ prompt: `Ask the ${pick.label} model`, ignoreFocusOut: true });
    if (prompt?.trim()) await runAsk(ctx, tracker, prompt, pick.label as Tier);
  });

  reg("llmRouter.askAboutSelection", async () => {
    const sel = selectionOrDocument();
    if (!sel || !sel.text.trim()) { void vscode.window.showWarningMessage("Open a file or select some text first."); return; }
    const question = await vscode.window.showInputBox({
      prompt: "What should the model do with the selection?",
      value: "Explain this code",
      ignoreFocusOut: true,
    });
    if (!question?.trim()) return;
    await runAsk(ctx, tracker, `${question}\n\n\`\`\`${sel.language}\n${sel.text}\n\`\`\``);
  });

  reg("llmRouter.explainRoute", async () => {
    const sel = selectionOrDocument();
    const prompt = await vscode.window.showInputBox({
      prompt: "Preview where a prompt would be routed (free, no API call)",
      value: sel && !vscode.window.activeTextEditor?.selection.isEmpty ? sel.text : "",
      ignoreFocusOut: true,
    });
    if (!prompt?.trim()) return;
    const router = buildRouter(ctx, tracker);
    const text = describeDecision(router.route(prompt), router);
    output.appendLine(`[preview] ${text.replace(/\n/g, "\n    ")}`);
    output.show(true);
  });

  reg("llmRouter.showDashboard", () => {
    const router = buildRouter(ctx, tracker);
    if (dashboard) { dashboard.reveal(); updateStatusBar(router); return; }
    dashboard = vscode.window.createWebviewPanel("llmRouterDashboard", "LLM Cost Router", vscode.ViewColumn.Active, { enableScripts: false });
    dashboard.onDidDispose(() => (dashboard = undefined), null, ctx.subscriptions);
    dashboard.webview.html = dashboardHtml(tracker.summary(), router);
  });

  reg("llmRouter.setApiKey", async () => {
    const provider = await vscode.window.showQuickPick(
      [
        { label: "anthropic" as ProviderKind, description: "Claude models (Haiku / Sonnet / Opus)" },
        { label: "openai-compatible" as ProviderKind, description: "OpenAI, OpenRouter, Groq, Together, local servers…" },
      ],
      { placeHolder: "Which provider is this key for?" },
    );
    if (!provider) return;
    const key = await vscode.window.showInputBox({ prompt: `API key for ${provider.label}`, password: true, ignoreFocusOut: true });
    if (key === undefined) return;
    if (key === "") { await ctx.secrets.delete(secretKey(provider.label)); void vscode.window.showInformationMessage(`Removed the ${provider.label} key.`); return; }
    await ctx.secrets.store(secretKey(provider.label), key.trim());
    void vscode.window.showInformationMessage(`Saved the ${provider.label} key in VS Code secret storage.`);
  });

  reg("llmRouter.resetStats", async () => {
    const ok = await vscode.window.showWarningMessage("Clear all recorded usage and savings?", { modal: true }, "Clear");
    if (ok !== "Clear") return;
    tracker.reset();
    updateStatusBar(buildRouter(ctx, tracker));
  });

  reg("llmRouter.showLog", () => output.show());

  ctx.subscriptions.push(
    output,
    statusBar,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("llmRouter")) updateStatusBar(buildRouter(ctx, tracker));
    }),
  );
}

export function deactivate() {}
