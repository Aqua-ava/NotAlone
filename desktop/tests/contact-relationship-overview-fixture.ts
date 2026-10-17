import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { withRewriteFixture, type RewriteFixture } from './rewrite-backend-fixture';

const project = path.resolve('..');
const modules = {
  'notalone.database_migrations': 'backend/src/notalone/database_migrations.py',
  'notalone.application.memory_service': 'backend/src/notalone/application/memory_service.py',
  'notalone.application.relationship_overview_service': 'backend/src/notalone/application/relationship_overview_service.py',
  'notalone.memory.overview': 'backend/src/notalone/memory/overview.py',
  'notalone.persistence.memory_overview': 'backend/src/notalone/persistence/memory_overview.py',
  'notalone.persistence.memory_store': 'backend/src/notalone/persistence/memory_store.py',
  'notalone.server.memory_overview': 'backend/src/notalone/server/memory_overview.py',
  'notalone.server.app': 'backend/src/notalone/server/app.py',
};

// HTTP 与页面共用既有夹具传输、连接环境和精确收尾；本入口不启动浏览器。
export async function withRelationshipOverviewFixture(use: (fixture: RewriteFixture) => Promise<void>, cleanupConfirmed?: () => void) {
  const requested = process.env.NOTALONE_OVERVIEW_TEST_EVIDENCE_DIR;
  if (!requested || !path.isAbsolute(requested)) throw new Error('请显式指定仓库外的概览验收证据目录。');
  const evidenceDirectory = await realpath(requested);
  const evidence = await stat(evidenceDirectory);
  if (!evidence.isDirectory() || (evidence.mode & 0o777) !== 0o700
    || evidenceDirectory === project || evidenceDirectory.startsWith(`${project}${path.sep}`)) {
    throw new Error('概览验收证据目录必须位于仓库外并使用700权限。');
  }
  const expected = Object.fromEntries(await Promise.all(Object.entries(modules).map(async ([name, relative]) =>
    [name, { path: relative, sha256: createHash('sha256').update(await readFile(path.join(project, relative))).digest('hex') }])));
  const keys = ['TMPDIR', 'NOTALONE_OVERVIEW_TEST_EXPECTED_MODULES'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.TMPDIR = evidenceDirectory;
  process.env.NOTALONE_OVERVIEW_TEST_EXPECTED_MODULES = JSON.stringify(expected);
  try {
    await withRewriteFixture('overview-fixture-', use, cleanupConfirmed,
      path.join(project, 'desktop/tests/fixtures/contact-relationship-overview.py'), path.join(project, 'backend'));
  } finally {
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
}
