import type { VisualAcceptanceView, VisualAction, VisualCoordination, VisualCounts } from './visual-acceptance-view.mjs';
export const visualAcceptanceHtml: string;
export function renderVisualAcceptance(input: { view: VisualAcceptanceView; coordination: VisualCoordination;
  counts: VisualCounts }): VisualAction[];
