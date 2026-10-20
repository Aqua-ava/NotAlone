import { readFile } from 'node:fs/promises';
import { ContactFixture } from './contact-backend-fixture';

export type MemoryDatabase = {
  database_name: string; database_url: string; owner_id: string; other_owner_id: string;
  contact_ids: string[]; other_contact_id: string; empty_contact_id: string;
  direct_message_id: string; source_document_id: string; manual_source_id: string; manual_source_name: string; supersedes_memory_id: string;
  corrected_memory_id: string; owner_candidate_id: string | null;
};
export class MemoryFixture extends ContactFixture {
  declare readonly data: MemoryDatabase;
  async addSyntheticContactMemory(contactId: string, text: string): Promise<void> {
    if (!this.data.contact_ids.includes(contactId)) throw new Error('合成资料只允许写入本轮联系人。');
    const response = await this.memoryRequest('/api/memories/manual-contact', { contact_id: contactId, text, category: 'relationship_note' });
    if (response.status !== 200) throw new Error('本轮合成资料安排失败。');
  }
  async addSyntheticOwnerMemory(contactId: string, text: string): Promise<void> {
    if (!this.data.contact_ids.includes(contactId)) throw new Error('合成本人资料只允许写入本轮联系人。');
    const response = await this.memoryRequest(`/api/contacts/${contactId}/owner-memories`, { text, category: 'common_fact' });
    if (response.status !== 200) throw new Error('本轮合成本人资料安排失败。');
  }
  async readMemorySection(contactId: string, section: 'contact' | 'owner' | 'pending' | 'sources') {
    if (![...this.data.contact_ids, this.data.empty_contact_id, this.data.other_contact_id].includes(contactId)) {
      throw new Error('合成读取只允许本轮固定联系人。');
    }
    const contact = `/api/contacts/${contactId}`;
    const endpoints = { contact: `${contact}/memories`, owner: `${contact}/owner-memories`,
      pending: `${contact}/memory-candidates`, sources: `${contact}/sources` };
    return this.memoryRequest(endpoints[section]);
  }
  private async memoryRequest(endpoint: string, body?: object) {
    const info = await readFile(this.infoPath, 'utf8');
    const address = /^address=(127\.0\.0\.1:\d+)$/m.exec(info)?.[1];
    const token = /^token=([^\n]+)$/m.exec(info)?.[1];
    if (!address || !token) throw new Error('本轮资料后端握手未就绪。');
    const response = await fetch(`http://${address}${endpoint}`, {
      signal: AbortSignal.timeout(5_000),
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  }
}
