import type { ForegroundState } from '../src/shared/foreground-bridge';
import type { ForegroundFailureReason } from '../src/shared/foreground-failure.mjs';
export interface VisualAcceptanceView {
  headline: string;
  classification: 'wechat' | 'other' | 'unknown';
  matched: boolean;
  ageSeconds: number | null;
  detail: string;
  failure: ForegroundFailureReason | null;
  recognizedName: string | null;
  confidencePercent: number | null;
  selectedLabel: string;
  confirmedLabel: string;
  generationAllowed: boolean;
  draftLength: number;
}
export interface VisualCounts {
  matches: number; mismatches: number; unverified: number; monitorFailed: boolean;
  stateUpdates: number; matchedSamples: number; helperPausedSamples: number; otherPausedSamples: number;
  failures: Record<string, number>;
  checks?: Record<string, 'matches' | 'mismatches' | 'unverified'>;
}
export interface VisualCoordination { runId: string; stage: string | null; state: string }
export interface VisualAction { runId: string; stage: string | null; type: string; classification?: string; displayedAt?: number;
  checkId?: string; outcome?: 'matches' | 'mismatches' | 'unverified' }
export function projectVisualAcceptance(input: { foreground: ForegroundState; selectedContactId: string | null;
  expectedContactId: string; alternateContactId?: string; draftLength?: number }, now?: number): VisualAcceptanceView;
export const visualChecklist: ReadonlyArray<readonly [string, string]>;
export function visualAcceptanceAction(current: VisualCoordination | null, event: VisualAction): string | null;
export function visualPreviewAction(current: VisualCoordination | null, event: VisualAction): string | null;
