import { Tier, UsageRecord } from "./types";

/** Where usage records are persisted. The extension uses VS Code globalState; the CLI uses a JSON file. */
export interface UsageStore {
  load(): UsageRecord[];
  save(records: UsageRecord[]): void;
}

export class MemoryStore implements UsageStore {
  private records: UsageRecord[] = [];
  load() { return [...this.records]; }
  save(r: UsageRecord[]) { this.records = [...r]; }
}

export interface UsageSummary {
  requests: number;
  totalCostUsd: number;
  baselineCostUsd: number;
  savingsUsd: number;
  /** Savings as a fraction of the baseline (0..1). */
  savingsRate: number;
  todayCostUsd: number;
  todayRequests: number;
  escalations: number;
  byTier: Record<Tier, { requests: number; costUsd: number }>;
  byModel: Record<string, { requests: number; costUsd: number; inputTokens: number; outputTokens: number }>;
}

/** Keeps at most this many records so storage stays small. */
const MAX_RECORDS = 5000;

function localDay(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export class UsageTracker {
  constructor(private store: UsageStore = new MemoryStore(), private now: () => Date = () => new Date()) {}

  record(r: UsageRecord): void {
    const all = this.store.load();
    all.push(r);
    this.store.save(all.slice(-MAX_RECORDS));
  }

  records(): UsageRecord[] {
    return this.store.load();
  }

  reset(): void {
    this.store.save([]);
  }

  /** Spend since local midnight. Used by the daily budget guard. */
  spentToday(): number {
    const today = localDay(this.now());
    return this.store.load()
      .filter((r) => localDay(new Date(r.timestamp)) === today)
      .reduce((s, r) => s + r.costUsd, 0);
  }

  summary(): UsageSummary {
    const all = this.store.load();
    const today = localDay(this.now());
    const s: UsageSummary = {
      requests: all.length,
      totalCostUsd: 0,
      baselineCostUsd: 0,
      savingsUsd: 0,
      savingsRate: 0,
      todayCostUsd: 0,
      todayRequests: 0,
      escalations: 0,
      byTier: { cheap: { requests: 0, costUsd: 0 }, balanced: { requests: 0, costUsd: 0 }, premium: { requests: 0, costUsd: 0 } },
      byModel: {},
    };
    for (const r of all) {
      s.totalCostUsd += r.costUsd;
      s.baselineCostUsd += r.baselineCostUsd;
      if (r.escalated) s.escalations++;
      if (localDay(new Date(r.timestamp)) === today) {
        s.todayCostUsd += r.costUsd;
        s.todayRequests++;
      }
      s.byTier[r.tier].requests++;
      s.byTier[r.tier].costUsd += r.costUsd;
      const m = (s.byModel[r.modelId] ??= { requests: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 });
      m.requests++;
      m.costUsd += r.costUsd;
      m.inputTokens += r.inputTokens;
      m.outputTokens += r.outputTokens;
    }
    s.savingsUsd = s.baselineCostUsd - s.totalCostUsd;
    s.savingsRate = s.baselineCostUsd > 0 ? s.savingsUsd / s.baselineCostUsd : 0;
    return s;
  }
}
