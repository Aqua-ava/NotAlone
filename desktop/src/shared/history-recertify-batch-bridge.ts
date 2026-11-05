/**
 * 开发者批量来源重新认证的页面合同（ADR-173、规格 6.8）。
 * 只含批次 ID、阶段、计数、原因码与耗时；不含联系人名称、联系人 ID、消息正文或账号路径。
 * 该能力只在开发宿主注册 IPC，并由 preload 仅在开发模式暴露。
 */
export type HistoryRecertifyBatchPhase = 'idle' | 'running' | 'stopping' | 'finished' | 'interrupted';
export type HistoryRecertifyBatchOverviewPhase = 'idle' | 'loading' | 'ready' | 'failed';
export interface HistoryRecertifyBatchOverview {
  phase: HistoryRecertifyBatchOverviewPhase;
  /** 当前被围栏且有有效读取授权的候选总数。 */
  total: number;
  /** 候选中有未保存图片的数量。 */
  withUnsavedImages: number;
  /** 候选预计需要重新读取的消息总数。 */
  messageTotal: number;
  /** 候选未保存图片总数。 */
  imageUnsavedTotal: number;
  /** 当前仍被围栏的联系人总数；大于 total 说明部分联系人没有有效读取授权。 */
  fencedTotal: number;
  /** 同步读取总开关与本人身份当前是否允许读取。 */
  readEnabled: boolean;
  error: string | null;
}
export type HistoryRecertifyBatchStage = 'starting' | 'metadata' | 'history' | 'activation' | 'completed' | 'cancelling';
export interface HistoryRecertifyBatchCurrent {
  /** 本次批次内的 1 起序号，不包含联系人 ID。 */
  index: number;
  stage: HistoryRecertifyBatchStage;
  messageCount: number;
  pageCount: number;
  startedAt: number | null;
}
export interface HistoryRecertifyBatchState {
  revision: number;
  phase: HistoryRecertifyBatchPhase;
  batchId: string | null;
  overview: HistoryRecertifyBatchOverview;
  total: number;
  completed: number;
  failedByCode: Record<string, number>;
  skippedByCode: Record<string, number>;
  alreadyFixed: number;
  current: HistoryRecertifyBatchCurrent | null;
  startedAt: number | null;
  finishedAt: number | null;
  stopRequested: boolean;
  limit: number | null;
  /** 整体停止原因：连接代次变化、授权撤销、能力缺失、程序错误或熔断码。 */
  interruptedReason: string | null;
  /** 每修完 5 位读取一次汇总状态时的已完成覆盖数；读取失败为 null。 */
  aggregateComplete: number | null;
  error: string | null;
}
export interface HistoryRecertifyBatchStartRequest {
  /** null 表示全部当前候选；否则为本次最多修复的联系人数。 */
  limit: number | null;
  confirmed: true;
}
export interface HistoryRecertifyBatchBridge {
  getState(): Promise<HistoryRecertifyBatchState>;
  refreshOverview(): Promise<void>;
  start(request: HistoryRecertifyBatchStartRequest): Promise<void>;
  stop(): Promise<void>;
  onStateChanged(listener: (state: HistoryRecertifyBatchState) => void): () => void;
}
export const historyRecertifyBatchLimitMax = 500;
