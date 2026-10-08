import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test as appTest } from './app-fixture';
import { ContactFixture } from './contact-fixture';
import { withSyntheticBackendFixture } from './synthetic-backend-fixture';

const project = path.resolve('..');
type MemoryDatabase = {
  database_name: string; database_url: string; owner_id: string; other_owner_id: string;
  contact_ids: string[]; other_contact_id: string; empty_contact_id: string;
  direct_message_id: string; source_document_id: string; supersedes_memory_id: string;
  corrected_memory_id: string; owner_candidate_id: string;
};
export class MemoryFixture extends ContactFixture {
  declare readonly data: MemoryDatabase;
  async addSyntheticContactMemory(contactId: string, text: string): Promise<void> {
    if (!this.data.contact_ids.includes(contactId)) throw new Error('合成资料只允许写入本轮联系人。');
    const info = await readFile(this.infoPath, 'utf8');
    const address = /^address=(127\.0\.0\.1:\d+)$/m.exec(info)?.[1];
    const token = /^token=([^\n]+)$/m.exec(info)?.[1];
    if (!address || !token) throw new Error('本轮资料后端握手未就绪。');
    const response = await fetch(`http://${address}/api/memories/manual-contact`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact_id: contactId, text, category: 'relationship_note' }),
    });
    if (response.status !== 200) throw new Error('本轮合成资料安排失败。');
  }
}

export const test = appTest.extend<{ memoryBackend: MemoryFixture; memoryBackendMode: 'owned' | 'reused' }>({
  memoryBackendMode: ['owned', { option: true }],
  memoryBackend: async ({ memoryBackendMode }, use) => {
    await withSyntheticBackendFixture<MemoryDatabase, MemoryFixture>({
      directoryPrefix: 'notalone-memory-reading-',
      databaseScript: path.join(project, 'desktop/tests/fixtures/memory-database.py'),
      createArguments: [], prepareTimeoutMs: 90_000, reuseBackend: memoryBackendMode === 'reused',
      createFixture: (directory, pythonExecutable, data) => new MemoryFixture(directory, pythonExecutable, data),
    }, use);
  },
  appEnvironment: async ({ memoryBackend }, use) => { await use(memoryBackend.environment()); },
  launchConfiguration: async ({ memoryBackend }, use) => {
    await use({ pythonExecutable: memoryBackend.pythonExecutable, projectDirectory: project,
      envFilePath: memoryBackend.envPath, backendInfoPath: memoryBackend.infoPath });
  },
});
