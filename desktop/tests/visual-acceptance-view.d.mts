import type { ForegroundState } from '../src/shared/foreground-bridge';
export interface VisualAcceptanceView {
  headline: string;
  classification: 'wechat' | 'other' | 'unknown';
  matched: boolean;
  ageSeconds: number | null;
  detail: string;
}
export interface VisualCoordination { runId: string; stage: string | null; state: string }
export interface VisualAction { runId: string; stage: string | null; type: string; classification?: string; displayedAt?: number }
export function projectVisualAcceptance(input: { foreground: ForegroundState; selectedContactId: string | null;
  expectedContactId: string }, now?: number): VisualAcceptanceView;
export function visualAcceptanceAction(current: VisualCoordination | null, event: VisualAction): string | null;
