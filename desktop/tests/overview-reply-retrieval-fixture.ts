import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { withRewriteFixture, type RewriteFixture } from './rewrite-backend-fixture';

const project = path.resolve('..');
export const replyOverviewModules = {
  'notalone.database_migrations': 'backend/src/notalone/database_migrations.py',
  'notalone.application.memory_service': 'backend/src/notalone/application/memory_service.py',
  'notalone.application.relationship_overview_service': 'backend/src/notalone/application/relationship_overview_service.py',
  'notalone.memory.overview': 'backend/src/notalone/memory/overview.py',
  'notalone.persistence.memory_overview': 'backend/src/notalone/persistence/memory_overview.py',
  'notalone.persistence.owner_memory_store': 'backend/src/notalone/persistence/owner_memory_store.py',
  'notalone.persistence.memory_store': 'backend/src/notalone/persistence/memory_store.py',
  'notalone.server.memory_overview': 'backend/src/notalone/server/memory_overview.py',
  'notalone.server.app': 'backend/src/notalone/server/app.py',
  'notalone.server.reply_wiring': 'backend/src/notalone/server/reply_wiring.py',
  'notalone.application.reply_evidence': 'backend/src/notalone/application/reply_evidence.py',
  'notalone.persistence.assistant_prepared_context': 'backend/src/notalone/persistence/assistant_prepared_context.py',
  'notalone.persistence.reply_overview_navigation': 'backend/src/notalone/persistence/reply_overview_navigation.py',
  'notalone.reply.prepared_context_codec': 'backend/src/notalone/reply/prepared_context_codec.py',
  'notalone.reply.context': 'backend/src/notalone/reply/context.py',
  'notalone.reply.generator': 'backend/src/notalone/reply/generator.py',
  'notalone.reply.retrieval_receipt': 'backend/src/notalone/reply/retrieval_receipt.py',
  'notalone.reply.tools': 'backend/src/notalone/reply/tools.py',
  'notalone.reply.store': 'backend/src/notalone/reply/store.py',
  'notalone.persistence.reply_store': 'backend/src/notalone/persistence/reply_store.py',
  'notalone.persistence.retrieval': 'backend/src/notalone/persistence/retrieval.py',
  'tests.integration.server.overview_reply_support': 'backend/tests/integration/server/overview_reply_support.py',
};
export type ReplyOverviewPrepared = {
  contactId: string; otherContactId: string; emptyContactId: string; sourceToDelete: string;
  draft: string; rawText: string; otherPrivateText: string;
  history: { memory_id: string; text: string }; unknown: { memory_id: string; text: string };
  manualContact: { memory_id: string; text: string }; manualOwner: { memory_id: string; text: string };
  self: { memory_id: string; text: string }; otherSelf: { memory_id: string; text: string };
  pending: { candidate_id: string; text: string };
};

// HTTP 和有限页面共用现有夹具的传输及清理，不在本入口启动页面或 App。
export async function withReplyOverviewFixture(use: (fixture: RewriteFixture) => Promise<void>, cleanupConfirmed?: () => void) {
  const requested = process.env.NOTALONE_REPLY_OVERVIEW_TEST_EVIDENCE_DIR;
  if (!requested || !path.isAbsolute(requested)) throw new Error('请显式指定仓库外的概览回复验收证据目录。');
  const evidenceDirectory = await realpath(requested), evidence = await stat(evidenceDirectory);
  if (!evidence.isDirectory() || (evidence.mode & 0o777) !== 0o700
    || evidenceDirectory === project || evidenceDirectory.startsWith(`${project}${path.sep}`)) {
    throw new Error('概览回复验收证据目录必须位于仓库外并使用700权限。');
  }
  const expected = Object.fromEntries(await Promise.all(Object.entries(replyOverviewModules).map(async ([name, relative]) =>
    [name, { path: relative, sha256: createHash('sha256').update(await readFile(path.join(project, relative))).digest('hex') }])));
  const keys = ['TMPDIR', 'NOTALONE_REPLY_OVERVIEW_TEST_EXPECTED_MODULES'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.TMPDIR = evidenceDirectory;
  process.env.NOTALONE_REPLY_OVERVIEW_TEST_EXPECTED_MODULES = JSON.stringify(expected);
  try {
    await withRewriteFixture('notalone-overview-reply-', use, cleanupConfirmed,
      path.join(project, 'desktop/tests/fixtures/overview-reply-retrieval.py'), path.join(project, 'backend'));
  } finally {
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
}
