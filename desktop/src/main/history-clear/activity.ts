import { historyClearSingleOperationActive, type HistoryClearState } from '../../shared/history-clear-bridge';

/**
 * 单联系人历史操作与开发者批量修复之间的进程内互斥。
 * 批量运行期间拒绝单个修复/清空/重新同步；批量开始前若单操作在进行中则拒绝开始。
 * 只保留在内存中，不持久化批量状态。
 */
export class HistoryActivityMutex {
  private batchId: string | null = null;
  /** 返回 false 表示已有批量在运行；成功后必须由发起方在结束或中断时释放。 */
  beginBatch(batchId: string): boolean {
    if (this.batchId !== null) return false;
    this.batchId = batchId;
    return true;
  }
  endBatch(batchId: string): void {
    if (this.batchId === batchId) this.batchId = null;
  }
  batchRunning(): boolean { return this.batchId !== null; }
}

/** 单个联系人的历史操作是否正在占用共享读取进程。 */
export function singleHistoryOperationActive(state: HistoryClearState): boolean {
  return historyClearSingleOperationActive(state);
}
