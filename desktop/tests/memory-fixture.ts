import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test as appTest, isolatedAppEnvironment } from './app-fixture';
import { ContactFixture } from './contact-fixture';

const execute = promisify(execFile);
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
    if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone' || !process.env.CONDA_PREFIX) throw new Error('资料验收须先激活 Conda NotAlone。');
    const directory = await mkdtemp(path.join(tmpdir(), 'notalone-memory-reading-'));
    const pythonExecutable = path.join(process.env.CONDA_PREFIX, 'bin/python');
    const script = path.join(project, 'desktop/tests/fixtures/memory-database.py');
    const env = isolatedAppEnvironment(directory, { PYTHONPATH: path.join(project, 'backend/src'), NOTALONE_DEEPSEEK_API_KEY: '' });
    let data: MemoryDatabase | undefined;
    let fixture: MemoryFixture | undefined;
    try {
      const prepared = await execute(pythonExecutable, [script, 'create'], { env, timeout: 90_000 });
      data = JSON.parse(prepared.stdout);
      fixture = new MemoryFixture(directory, pythonExecutable, data!);
      if (memoryBackendMode === 'reused') await fixture.startBackend();
      await use(fixture);
    } finally {
      try { await fixture?.cleanup(); }
      finally {
        try { if (data) await execute(pythonExecutable, [script, 'drop', data.database_name], { env, timeout: 15_000 }); }
        finally { await rm(directory, { recursive: true, force: true }); }
      }
    }
  },
  appEnvironment: async ({ memoryBackend }, use) => { await use(memoryBackend.environment()); },
  launchConfiguration: async ({ memoryBackend }, use) => {
    await use({ pythonExecutable: memoryBackend.pythonExecutable, projectDirectory: project,
      envFilePath: memoryBackend.envPath, backendInfoPath: memoryBackend.infoPath });
  },
});
