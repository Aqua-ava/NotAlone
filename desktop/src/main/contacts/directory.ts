import type { ContactSummary } from '../../shared/contact-session-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactDirectoryResult } from './session';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function readContactDirectory(backend: BackendHost): Promise<ContactDirectoryResult> {
  const generation = backend.getConnectionGeneration();
  if (generation === undefined) throw new Error('联系人目录不可用。');
  const setup = await backend.requestJson({ method: 'GET', path: '/api/setup/status', maxResponseBytes: 4096 });
  if (setup.generation !== generation || backend.getConnectionGeneration() !== generation) throw new Error('联系人目录已失效。');
  if (!runtimeOwnerConfigured(setup.data)) return { generation, contacts: null };
  const directory = await backend.requestJson({ method: 'GET', path: '/api/contacts' });
  if (directory.generation !== generation || backend.getConnectionGeneration() !== generation) throw new Error('联系人目录已失效。');
  return { generation, contacts: contactSummaries(directory.data) };
}

export function runtimeOwnerConfigured(value: unknown): boolean {
  if (!record(value) || typeof value.runtime_owner_configured !== 'boolean') throw new Error('本人身份状态不可用。');
  return value.runtime_owner_configured;
}

// 只投影现有 contacts 的真实摘要，不从名称推断身份或补造详情字段。
export function contactSummaries(value: unknown): ContactSummary[] {
  if (!record(value) || !Array.isArray(value.contacts)) throw new Error('联系人目录不可用。');
  const known = new Set<string>();
  return value.contacts.map((entry: unknown) => {
    if (!record(entry) || typeof entry.contact_id !== 'string' || !uuid.test(entry.contact_id)
      || typeof entry.display_name !== 'string' || !entry.display_name.trim()
      || !record(entry.data_status)) throw new Error('联系人目录不可用。');
    const contactId = entry.contact_id.toLowerCase();
    const { message_count: messageCount, source_count: sourceCount } = entry.data_status;
    if (known.has(contactId) || typeof messageCount !== 'number' || !Number.isSafeInteger(messageCount) || messageCount < 0
      || typeof sourceCount !== 'number' || !Number.isSafeInteger(sourceCount) || sourceCount < 0) {
      throw new Error('联系人目录不可用。');
    }
    known.add(contactId);
    return { contactId, displayName: entry.display_name, messageCount, sourceCount };
  });
}
