import type { BackendHost } from '../backend/host';
import type { StyleSample } from '../../shared/style-sample-bridge';
import { isUuid } from '../uuid';

export function readSample(value: unknown): StyleSample {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('样本格式无效。');
  const row = value as Record<string, unknown>;
  if (!isUuid(row.sample_id) || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 4096
    || !['manual', 'candidate', 'message'].includes(row.origin_kind as string)
    || (row.origin_id !== null && !isUuid(row.origin_id)) || !Array.isArray(row.source_ids)
    || !row.source_ids.every(isUuid) || typeof row.saved_at !== 'string' || row.sending_status !== 'unknown') throw new Error('样本格式无效。');
  return { sampleId: row.sample_id.toLowerCase(), text: row.text, originKind: row.origin_kind as StyleSample['originKind'],
    originId: row.origin_id === null ? null : (row.origin_id as string).toLowerCase(), sourceIds: row.source_ids as string[],
    savedAt: row.saved_at, sendingStatus: 'unknown' };
}
export async function listSamples(backend: BackendHost, contactId: string, signal: AbortSignal) {
  const response = await backend.requestJson({ method: 'GET', path: `/api/contacts/${contactId}/style-samples`, timeoutMs: 5000, signal });
  const value = response.data as Record<string, unknown>;
  if (!value || !Array.isArray(value.samples)) throw new Error('样本目录格式无效。');
  const samples = value.samples.map(readSample);
  if (new Set(samples.map((sample) => sample.sampleId)).size !== samples.length) throw new Error('样本目录格式无效。');
  return { generation: response.generation, samples };
}
