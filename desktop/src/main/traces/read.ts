import type { TraceBatch, TraceDocument, TraceResource } from '../../shared/trace-bridge';
import { isUuid } from '../uuid';

export function document(value: unknown): TraceDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('过程记录暂不可用。');
  return value as TraceDocument;
}
export function batchId(resource: TraceResource, row: TraceDocument): string {
  const id = row[resource === 'memory-traces' ? 'trace_id' : 'batch_id'];
  if (!isUuid(id)) throw new Error('过程记录暂不可用。');
  return id.toLowerCase();
}
export function batches(resource: TraceResource, value: unknown, contactId: string): TraceBatch[] {
  if (!Array.isArray(value)) throw new Error('过程记录暂不可用。');
  return value.map((entry) => {
    const row = document(entry);
    const date = row[resource === 'memory-traces' ? 'started_at' : 'recorded_at'];
    if (row.contact_id !== contactId || typeof row.status !== 'string' || typeof date !== 'string'
      || !Number.isFinite(Date.parse(date)) || (row.retry_of != null && !isUuid(row.retry_of))) throw new Error('过程记录暂不可用。');
    return { batchId: batchId(resource, row), status: row.status, recordedAt: date, retryOf: row.retry_of as string | null ?? null };
  });
}
