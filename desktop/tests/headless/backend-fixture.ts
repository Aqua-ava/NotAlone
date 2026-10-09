import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ContactFixture, type ContactDatabase } from '../contact-backend-fixture';
import { RewriteFixture } from '../rewrite-backend-fixture';
import { withSyntheticBackendFixture } from '../synthetic-backend-fixture';
import { isolatedAppEnvironment } from '../isolated-environment';
import { ownResource } from './cleanup';

const project = path.resolve('..');
export type MemoryData = ContactDatabase & { empty_contact_id: string; direct_message_id: string; source_document_id: string };
export async function withMemoryBackend(use: (fixture: ContactFixture & { data: MemoryData }) => Promise<void>) {
  const released = ownResource();
  let failure: unknown;
  await withSyntheticBackendFixture<MemoryData, ContactFixture & { data: MemoryData }>({
    directoryPrefix: 'notalone-headless-memory-', databaseScript: path.resolve('tests/fixtures/memory-database.py'),
    createArguments: [], prepareTimeoutMs: 70_000, reuseBackend: true,
    createFixture: (directory, python, data) => new ContactFixture(directory, python, data) as ContactFixture & { data: MemoryData },
  }, async (fixture) => { try { await use(fixture); } catch (error) { failure = error; } });
  released();
  if (failure) throw failure;
}
export async function withRewriteBackend(use: (fixture: RewriteFixture) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-headless-rewrite-'));
  const python = path.join(process.env.CONDA_PREFIX!, 'bin/python');
  const child = spawn(python, [path.resolve('tests/fixtures/rewrite-backend.py')], { cwd: project,
    stdio: ['pipe', 'pipe', 'ignore'], env: isolatedAppEnvironment(directory, {
      PYTHONPATH: `${path.join(project, 'backend/src')}:${path.join(project, 'backend')}`, PYTHONNOUSERSITE: '1',
      NOTALONE_DEEPSEEK_API_KEY: '', NOTALONE_DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
    }) });
  const fixture = new RewriteFixture(directory, python, child);
  const released = ownResource();
  try { await fixture.ready; await use(fixture); }
  finally { await fixture.cleanup(); await rm(directory, { recursive: true, force: true }); released(); }
}
export async function withControllerEnvironment(fixture: ContactFixture | RewriteFixture, use: (userData: string) => Promise<void>) {
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
