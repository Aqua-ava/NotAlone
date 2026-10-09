import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test as appTest } from './app-fixture';
import { isolatedAppEnvironment } from './isolated-environment';
import { RewriteFixture } from './rewrite-backend-fixture';
export { RewriteFixture, type ModelPlan } from './rewrite-backend-fixture';
const project = path.resolve('..');

export const test = appTest.extend<{ rewriteBackend: RewriteFixture }>({
  rewriteBackend: async ({}, use) => {
    if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone' || !process.env.CONDA_PREFIX) throw new Error('改写验收须先激活 Conda NotAlone。');
    const directory = await mkdtemp(path.join(tmpdir(), 'notalone-rewrite-'));
    const pythonExecutable = path.join(process.env.CONDA_PREFIX, 'bin/python');
    const child = spawn(pythonExecutable, [path.join(project, 'desktop/tests/fixtures/rewrite-backend.py')], {
      cwd: project, stdio: ['pipe', 'pipe', 'ignore'], env: isolatedAppEnvironment(directory, {
        PYTHONPATH: `${path.join(project, 'backend/src')}:${path.join(project, 'backend')}`, PYTHONNOUSERSITE: '1',
        NOTALONE_DEEPSEEK_API_KEY: '', NOTALONE_DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
      }),
    });
    const fixture = new RewriteFixture(directory, pythonExecutable, child);
    try { await fixture.ready; await use(fixture); }
    finally {
      try { await fixture.cleanup(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  },
  appEnvironment: async ({ rewriteBackend }, use) => { await use(rewriteBackend.environment()); },
  launchConfiguration: async ({ rewriteBackend }, use) => {
    await use({ pythonExecutable: rewriteBackend.pythonExecutable, projectDirectory: project,
      envFilePath: rewriteBackend.envPath, backendInfoPath: rewriteBackend.infoPath });
  },
});
