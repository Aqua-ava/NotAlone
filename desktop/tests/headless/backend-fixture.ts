import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ContactFixture } from '../contact-backend-fixture';
import { MemoryFixture, type MemoryDatabase } from '../memory-backend-fixture';
import { withImportFixture, type ImportFixture } from '../import-backend-fixture';
import { withRewriteFixture, type RewriteFixture } from '../rewrite-backend-fixture';
import { withSyntheticBackendFixture } from '../synthetic-backend-fixture';
import { isolatedAppEnvironment } from '../isolated-environment';
import { ownResource } from './cleanup';

const project = path.resolve('..');
export type MemoryData = MemoryDatabase;
export type TraceData = MemoryDatabase & { trace_id: string; traced_memory_id: string | null; trace_candidate_id: string; processing_id: string; trace_message_id: string; trace_text: string };
export async function withTraceBackend(use: (fixture: MemoryFixture, data: TraceData) => Promise<void>, mode?: 'deletion-contact' | 'deletion-owner' | 'deletion-candidate') {
  const released = ownResource();
  try {
    await withSyntheticBackendFixture<TraceData, MemoryFixture>({
      directoryPrefix: 'notalone-headless-traces-', databaseScript: path.resolve('tests/fixtures/trace-database.py'),
      createArguments: mode ? [mode] : [], prepareTimeoutMs: 70_000, reuseBackend: true,
      createFixture: (directory, python, data) => new MemoryFixture(directory, python, data),
    }, (fixture) => use(fixture, fixture.data as TraceData));
  } finally { released(); }
}
export async function withMemoryBackend(use: (fixture: MemoryFixture) => Promise<void>, emptyOwnerMemory = false) {
  const released = ownResource();
  let failure: unknown;
  await withSyntheticBackendFixture<MemoryData, MemoryFixture>({
    directoryPrefix: 'notalone-headless-memory-', databaseScript: path.resolve('tests/fixtures/memory-database.py'),
    createArguments: emptyOwnerMemory ? ['empty-owner-memory'] : [], prepareTimeoutMs: 70_000, reuseBackend: true,
    createFixture: (directory, python, data) => new MemoryFixture(directory, python, data),
  }, async (fixture) => { try { await use(fixture); } catch (error) { failure = error; } });
  released();
  if (failure) throw failure;
}
export async function withRewriteBackend(use: (fixture: RewriteFixture) => Promise<void>) {
  const released = ownResource();
  await withRewriteFixture('notalone-headless-rewrite-', use, released);
}
export async function withImportBackend(use: (fixture: ImportFixture) => Promise<void>) {
  const released = ownResource();
  await withImportFixture('notalone-headless-import-', use, released);
}
export async function withControllerEnvironment(fixture: ContactFixture | RewriteFixture | ImportFixture, use: (userData: string) => Promise<void>) {
  const userData = path.join(fixture.directory, 'page-controller');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(userData);
  await writeFile(path.join(userData, 'backend-launch.json'), JSON.stringify({
    pythonExecutable: fixture.pythonExecutable, projectDirectory: project,
    envFilePath: fixture.envPath, backendInfoPath: fixture.infoPath,
  }), { mode: 0o600 });
  const original = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith('NOTALONE_') || key.startsWith('DEEPSEEK_')) delete process.env[key];
  Object.assign(process.env, isolatedAppEnvironment(userData, fixture.environment()));
  try { await use(userData); }
  finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
}
