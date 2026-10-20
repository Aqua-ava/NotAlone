import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const critical = Object.freeze({
  'notalone.server.app': 'backend/src/notalone/server/app.py',
  'notalone.persistence.expression_preferences': 'backend/src/notalone/persistence/expression_preferences.py',
  'notalone.persistence.reply_store': 'backend/src/notalone/persistence/reply_store.py',
  'notalone.reply.context': 'backend/src/notalone/reply/context.py',
  'notalone.persistence.assistant_session_store': 'backend/src/notalone/persistence/assistant_session_store.py',
  'notalone.persistence.reply_sources': 'backend/src/notalone/persistence/reply_sources.py',
  'tests.integration.server.test_expression_preferences': 'backend/tests/integration/server/test_expression_preferences.py',
  module_guard: 'desktop/tests/fixtures/module_guard.py',
});

// HTTP与页面共用关键模块合同，各自必须明确仓库根与实际Python入口。
export async function expressionPreferenceModules(root, fixtureEntry) {
  if (!path.isAbsolute(root) || typeof fixtureEntry !== 'string' || path.isAbsolute(fixtureEntry)) {
    throw new Error('偏好证据必须明确仓库根和相对夹具入口。');
  }
  return Object.fromEntries(await Promise.all(Object.entries({ ...critical, __main__: fixtureEntry })
    .map(async ([name, file]) => [name, { path: file,
      sha256: createHash('sha256').update(await readFile(path.join(root, file))).digest('hex') }])));
}
