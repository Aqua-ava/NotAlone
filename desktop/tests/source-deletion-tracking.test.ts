import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SourceDeletionTracking } from '../src/main/sources/tracking.ts';

test('删除后的辅助资料失效失败不会掩盖已持久化任务回执', async () => {
  const taskId = randomUUID();
  let invalidationCalls = 0;
  const backend = {
    onStateChanged() { return () => {}; },
    getConnectionGeneration() { return 1; },
    async requestJson(request: { method: string }) {
      if (request.method === 'DELETE') return { generation: 1, data: { task_id: taskId, status: 'queued' } };
      return { generation: 1, data: {
        task_id: taskId, task_type: 'delete', status: 'succeeded', step: 'verify_not_retrievable',
        steps: ['mark_deleted', 'delete_derived', 'delete_index', 'clear_cache', 'verify_not_retrievable']
          .map(name => ({ name, status: 'succeeded' })),
      } };
    },
  };
  const tracking = new SourceDeletionTracking(backend as unknown as import('../src/main/backend/host.ts').BackendHost, async () => {
    invalidationCalls += 1;
    throw new Error('synthetic invalidation unavailable');
  });

  assert.equal(await tracking.delete(randomUUID(), randomUUID(), 1), taskId);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(invalidationCalls >= 1);
});
