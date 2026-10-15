import type { ForegroundState } from '../src/shared/foreground-bridge';
import type { ForegroundFailureReason } from '../src/shared/foreground-failure.mjs';
export interface VisualAcceptanceView {
  headline: string;
  classification: 'wechat' | 'other' | 'unknown';
  matched: boolean;
  ageSeconds: number | null;
  detail: string;
  failure: ForegroundFailureReason | null;
}
export interface VisualCounts {
  matches: number; mismatches: number; unverified: number; monitorFailed: boolean;
  stateUpdates: number; matchedSamples: number; helperPausedSamples: number; otherPausedSamples: number;
  failures: Record<string, number>;
}
export interface VisualCoordination { runId: string; stage: string | null; state: string }
export interface VisualAction { runId: string; stage: string | null; type: string; classification?: string; displayedAt?: number }
export function projectVisualAcceptance(input: { foreground: ForegroundState; selectedContactId: string | null;
  expectedContactId: string }, now?: number): VisualAcceptanceView;
export function visualAcceptanceAction(current: VisualCoordination | null, event: VisualAction): string | null;
export function visualPreviewAction(current: VisualCoordination | null, event: VisualAction): string | null;
