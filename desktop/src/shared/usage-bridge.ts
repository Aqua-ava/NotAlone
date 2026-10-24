export type UsageDispatch = 'authorized_unconfirmed' | 'response_observed' | 'http_accepted' | 'not_sent' | 'legacy_recorded';
export type UsageOutcome = 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'unknown' | 'run_failed' | 'rejected_by_validation';
export interface UsageEntry {
  scopeKind: 'contact' | 'owner_memory'; provider: string; modelName: string; calledAt: string;
  latencyMs: number | null; dispatch: UsageDispatch; outcome: UsageOutcome;
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null;
  costStatus: 'known' | 'estimated' | 'unknown'; costAmount: string | null; currency: string | null;
  pricingVersion: string | null; source: 'receipt' | 'legacy'; confirmed: boolean;
}
export interface UsageCostTotal { status: 'known' | 'estimated'; currency: string; pricingVersion: string; amount: string; calls: number }
export interface UsageSummary {
  totalCalls: number; totalAttempts: number; authorizedUnconfirmedCalls: number; notSentAttempts: number;
  unknownUsageCalls: number; totalInputTokens: number | null; totalOutputTokens: number | null;
  knownInputTokens: number; knownOutputTokens: number; unknownCostCalls: number;
  providerCounts: Record<string, number>; outcomeCounts: Record<string, number>; costTotals: UsageCostTotal[]; recent: UsageEntry[];
}
export interface UsageState {
  revision: number; phase: 'idle' | 'loading' | 'ready' | 'offline' | 'error';
  summary: UsageSummary | null; errorCode: 'usage_read_failed' | null;
}
export interface UsageBridge {
  getState(): Promise<UsageState>; refresh(): Promise<void>;
  onStateChanged(listener: (state: UsageState) => void): () => void;
}
