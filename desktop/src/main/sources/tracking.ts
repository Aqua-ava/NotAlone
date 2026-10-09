import type { BackendHost } from '../backend/host';
import { deletionReceipt, deletionTask } from './read';

// 已确认的删除绑定真实连接代次；页面换联系人只取消展示读取，不取消原删除和最终核验。
export class SourceDeletionTracking {
  private readonly pending = new Map<AbortController, number>();
  constructor(private readonly backend: BackendHost,
    private readonly onSourceChanged: (contactId: string) => Promise<void>) {
    backend.onStateChanged(() => {
      for (const [pending, generation] of this.pending) {
        if (generation !== backend.getConnectionGeneration()) pending.abort();
      }
    });
  }
  async delete(contactId: string, sourceId: string, generation: number): Promise<string> {
    const pending = new AbortController();
    this.pending.set(pending, generation);
    let tracking = false;
    try {
      const response = await this.backend.requestJson({ method: 'DELETE',
        path: `/api/contacts/${contactId}/sources/${sourceId}`, signal: pending.signal });
      if (!this.current(pending, generation) || response.generation !== generation) throw new Error('删除连接已变化。');
      const taskId = deletionReceipt(response.data);
      try { await this.onSourceChanged(contactId); }
      finally {
        tracking = true;
        void this.verify(contactId, taskId, generation, pending).finally(() => this.pending.delete(pending));
      }
      return taskId;
    } finally { if (!tracking) this.pending.delete(pending); }
  }
  private current(pending: AbortController, generation: number) {
    return !pending.signal.aborted && generation === this.backend.getConnectionGeneration();
  }
  private async verify(contactId: string, taskId: string, generation: number, pending: AbortController) {
    try {
      for (let count = 0; count < 30 && this.current(pending, generation); count++) {
        const response = await this.backend.requestJson({ method: 'GET',
          path: `/api/tasks/status?contact_id=${contactId}&task_id=${taskId}`, signal: pending.signal, timeoutMs: 5000 });
        if (!this.current(pending, generation) || response.generation !== generation) return;
        const task = deletionTask(response.data, taskId);
        if (task.status === 'succeeded') { await this.onSourceChanged(contactId); return; }
        if (task.status === 'failed') return;
        await new Promise<void>((resolve) => {
          const finish = () => { clearTimeout(timer); pending.signal.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, 500);
          pending.signal.addEventListener('abort', finish, { once: true });
          if (pending.signal.aborted) finish();
        });
      }
    } catch {
      // 未知结果不发布完成；原持久任务保留，管理页可重新查询或重试同一来源。
    }
  }
}
