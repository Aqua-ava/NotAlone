import type { HistoryClearState } from '../../shared/history-clear-bridge';

type Observer = { getState(): HistoryClearState; onStateChanged(listener: (state: HistoryClearState) => void): () => void };
type Effects = { withdraw(contactId: string): void; revalidate(): Promise<void>; refresh(contactId: string): Promise<void> };

/** 认证改变来源资格而不改变联系人选择；撤下旧快照，未知结果只允许状态查询。 */
export function coordinateHistoryRecertification(observer: Observer, effects: Effects): () => void {
  let operation: { contactId: string; scopeRevision: number; key: string; settled: boolean; refreshed: boolean } | undefined;
  const settle = () => {
    if (!operation || operation.settled) return;
    operation.settled = true;
    void effects.revalidate().catch(() => {});
  };
  const receive = (state: HistoryClearState) => {
    if (operation && (operation.contactId !== state.contactId || operation.scopeRevision !== state.scopeRevision)) { settle(); operation = undefined; }
    const key = state.pendingRecertifyKey ?? state.recertifyStoppingKey ?? state.recertify?.requestKey;
    const active = state.busy === 'recertify' || !!state.pendingRecertifyKey || !!state.recertifyStoppingKey || state.recertify?.state === 'running';
    if (active && state.contactId && key && operation?.key !== key) {
      settle();
      operation = { contactId: state.contactId, scopeRevision: state.scopeRevision, key, settled: false, refreshed: false };
      effects.withdraw(state.contactId);
    }
    if (state.busy !== 'recertify') settle();
    if (operation && !active && state.recertify?.completed && state.recertify.requestKey === operation.key && !operation.refreshed) {
      operation.refreshed = true;
      void effects.refresh(operation.contactId).catch(() => {});
    }
  };
  const unsubscribe = observer.onStateChanged(receive); receive(observer.getState());
  return () => { unsubscribe(); settle(); };
}
