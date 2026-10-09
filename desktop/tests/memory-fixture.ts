import path from 'node:path';
import { test as appTest } from './app-fixture';
import { withSyntheticBackendFixture } from './synthetic-backend-fixture';
import { MemoryFixture, type MemoryDatabase } from './memory-backend-fixture';
export { MemoryFixture } from './memory-backend-fixture';

const project = path.resolve('..');

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
