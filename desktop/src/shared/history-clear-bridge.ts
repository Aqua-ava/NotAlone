/** 清空聊天与明确重读历史的页面合同：只含状态、进度和原因码，不含正文、渠道键或边界证明原文。 */
export type HistoryClearPhase = 'none' | 'boundary_pending' | 'cleaning' | 'cleanup_blocked' | 'completed';
export interface HistoryBoundaryView {
  state: 'pending' | 'verified' | 'blocked';
  barrierGeneration: string;
  manifestSha256: string | null;
  memberCount: number | null;
  reason: string | null;
  establishedAt: string | null;
}
export interface HistoryClearView {
  contactId: string;
  phase: HistoryClearPhase;
  completed: boolean;
  boundary: HistoryBoundaryView | null;
  boundaryPending: boolean;
  failureCode: string | null;
  boundaryReason: string | null;
  storedMessages: number;
  storedSources: number;
  openGoals: number;
}
export type HistoryResyncPhase = 'none' | 'authorized' | 'active' | 'completed';
export interface HistoryResyncView {
  contactId: string;
  requestKey: string | null;
  state: HistoryResyncPhase;
  completed: boolean;
  goalPhase: 'not_started' | 'syncing' | 'complete' | 'incomplete' | null;
  messageCount: number;
  nonTextCount: number;
  failureCode: string | null;
}
export interface HistoryRecertifyView {
  contactId: string;
  requestKey: string | null;
  state: 'none' | 'running' | 'completed' | 'failed' | 'interrupted';
  stage: 'none' | 'metadata' | 'history' | 'activation' | 'completed';
  completed: boolean;
  failureCode: string | null;
  messageCount: number;
  nonTextCount: number;
  pageCount: number;
  preservedMessageCount: number;
  startedAt: number | null;
  finishedAt: number | null;
}
export function historyRecertifyFailureMessage(code: string | null): string {
  const messages: Record<string, string> = {
    history_recertify_not_required: '当前来源没有需要重新认证的围栏，请核对普通同步状态。',
    history_recertify_already_running: '这位联系人已有来源认证正在进行，请查询当前状态。',
    history_recertify_guard_required: '本机读取工具暂不支持完整来源守卫，未恢复读取。',
    history_recertify_source_changed: '当前来源与旧资料无法可靠对应，不能保留原有删除与清空保护，未恢复读取。',
    history_recertify_deletion_pending: '资料删除尚未完成，请完成删除后重新确认。',
    history_recertify_stale: '来源或读取授权已变化，本次认证已停止。',
    read_eligibility_stale: '来源或读取授权已变化，本次认证已停止。',
    read_not_authorized: '同步读取已关闭或授权已撤销，请先核对同步范围。',
    history_no_active_binding: '当前没有有效的微信会话绑定，请先核对联系人同步范围。',
    history_recertify_interrupted: '本次认证已中断，读取保持停止。',
    history_recertify_cancelled: '本次认证已停止，读取保持停止。',
    history_source_continuity_unverified: '来源连续性证明已失效，读取保持停止。',
    history_recertify_page_limit: '尚未完成全部本机历史核验，读取保持停止。',
    history_recertify_incomplete: '全量历史尚未核验完整，读取保持停止。',
    history_recertify_request_conflict: '本次认证标识与联系人不一致，请刷新并重新确认范围。',
  };
  return messages[code ?? ''] ?? '来源重新认证未完成，读取保持停止。请核对来源与授权后重新确认。';
}
export interface HistoryClearState {
  revision: number;
  contactId: string | null;
  scopeRevision: number;
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  clear: HistoryClearView | null;
  resync: HistoryResyncView | null;
  recertify: HistoryRecertifyView | null;
  pendingRecertifyKey: string | null;
  recertifyStoppingKey: string | null;
  recertifyCancelBusy: boolean;
  busy: 'clear' | 'resync' | 'recertify' | null;
  error: string | null;
}
export interface HistoryClearRequest { contactId: string; scopeRevision: number }
export interface HistoryResyncRequest extends HistoryClearRequest { requestKey: string; confirmed: true }
export interface HistoryRecertifyRequest extends HistoryClearRequest { requestKey: string; confirmed: true }
export interface HistoryRecertifyCancelRequest extends HistoryClearRequest { requestKey: string }
export interface HistoryClearBridge {
  getState(): Promise<HistoryClearState>;
  refresh(request: HistoryClearRequest): Promise<void>;
  clear(request: HistoryClearRequest): Promise<void>;
  resync(request: HistoryResyncRequest): Promise<void>;
  recertify(request: HistoryRecertifyRequest): Promise<void>;
  cancelRecertify(request: HistoryRecertifyCancelRequest): Promise<void>;
  onStateChanged(listener: (state: HistoryClearState) => void): () => void;
}
/** 单个联系人的历史操作是否正在占用共享读取进程；批量修复开始前用它拒绝同时操作。 */
export function historyClearSingleOperationActive(state: HistoryClearState): boolean {
  return state.busy !== null || state.pendingRecertifyKey !== null || state.recertifyStoppingKey !== null
    || state.recertify?.state === 'running';
}
