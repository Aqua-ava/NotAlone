import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { withRewriteFixture, type RewriteFixture } from './rewrite-backend-fixture';

const project = path.resolve('..');
const modules = {
  'notalone.application.layered_memory_service': 'backend/src/notalone/application/layered_memory_service.py',
  'notalone.memory.layered': 'backend/src/notalone/memory/layered.py',
  'notalone.persistence.layered_memory': 'backend/src/notalone/persistence/layered_memory.py',
  'notalone.persistence.layered_coverage': 'backend/src/notalone/persistence/layered_coverage.py',
  'notalone.persistence.background_tasks': 'backend/src/notalone/persistence/background_tasks.py',
  'notalone.tasks.worker': 'backend/src/notalone/tasks/worker.py',
  'notalone.tasks.organization_dispatch': 'backend/src/notalone/tasks/organization_dispatch.py',
  'notalone.persistence.memory_overview': 'backend/src/notalone/persistence/memory_overview.py',
  'notalone.server.app': 'backend/src/notalone/server/app.py',
};

// 页面和实际 Electron 共用同一生产 HTTP 与精确自有测试库。
export async function withLayeredMemoryFixture(use: (fixture: RewriteFixture) => Promise<void>, cleanupConfirmed?: () => void) {
  const requested = process.env.NOTALONE_LAYERED_TEST_EVIDENCE_DIR;
  if (!requested || !path.isAbsolute(requested)) throw new Error('主题资料验收须指定仓库外证据目录。');
  const directory = await realpath(requested);
  const value = await stat(directory);
  if (!value.isDirectory() || (value.mode & 0o777) !== 0o700 || directory === project || directory.startsWith(`${project}${path.sep}`)) {
    throw new Error('主题资料证据须位于仓库外的700目录。');
  }
  const expected = Object.fromEntries(await Promise.all(Object.entries(modules).map(async ([name, relative]) =>
    [name, { path: relative, sha256: createHash('sha256').update(await readFile(path.join(project, relative))).digest('hex') }])));
  const previous = process.env.NOTALONE_LAYERED_EXPECTED_MODULES;
  process.env.NOTALONE_LAYERED_EXPECTED_MODULES = JSON.stringify(expected);
  try {
    await withRewriteFixture('notalone-layered-page-', use, cleanupConfirmed,
      path.join(project, 'desktop/tests/fixtures/layered-memory-page.py'), path.join(project, 'backend'));
  } finally {
    if (previous === undefined) delete process.env.NOTALONE_LAYERED_EXPECTED_MODULES;
    else process.env.NOTALONE_LAYERED_EXPECTED_MODULES = previous;
  }
}
