import { useEffect, useState } from 'react';
import type { HistoryRecertifyBatchBridge, HistoryRecertifyBatchState } from '../shared/history-recertify-batch-bridge';

export const emptyHistoryRecertifyBatchState: HistoryRecertifyBatchState = {
  revision: -1, phase: 'idle', batchId: null,
  overview: { phase: 'idle', total: 0, withUnsavedImages: 0, messageTotal: 0, imageUnsavedTotal: 0, fencedTotal: 0, readEnabled: false, error: null },
  total: 0, completed: 0, failedByCode: {}, skippedByCode: {}, alreadyFixed: 0, current: null,
  startedAt: null, finishedAt: null, stopRequested: false, limit: null, interruptedReason: null, aggregateComplete: null, error: null,
};

/** 只有开发宿主会在 preload 暴露批量入口；打包模式下为 undefined。 */
export function historyRecertifyBatchBridge(): HistoryRecertifyBatchBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.notalone?.historyRecertifyBatch;
}

/** 批量状态订阅；页面只接收批次、阶段、计数与原因码，不接收联系人名称或 ID。 */
export function useHistoryRecertifyBatch(): { bridge: HistoryRecertifyBatchBridge | undefined; state: HistoryRecertifyBatchState; active: boolean } {
  const bridge = historyRecertifyBatchBridge();
  const [state, setState] = useState(emptyHistoryRecertifyBatchState);
  useEffect(() => {
    if (!bridge) return;
    let subscribed = true;
    const latest = { revision: -1 };
    const receive = (next: HistoryRecertifyBatchState) => {
      if (!subscribed || !next || next.revision < latest.revision) return;
      latest.revision = next.revision;
      setState(next);
    };
    const unsubscribe = bridge.onStateChanged(receive);
    void bridge.getState().then(receive).catch(() => {});
    return () => { subscribed = false; unsubscribe(); };
  }, [bridge]);
  return { bridge, state, active: state.phase === 'running' || state.phase === 'stopping' };
}
