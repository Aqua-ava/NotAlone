import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const critical = Object.freeze({
  'notalone.server.app': 'backend/src/notalone/server/app.py',
  'notalone.persistence.expression_preferences': 'backend/src/notalone/persistence/expression_preferences.py',
  'notalone.persistence.reply_store': 'backend/src/notalone/persistence/reply_store.py',
  'notalone.reply.context': 'backend/src/notalone/reply/context.py',
  'notalone.persistence.assistant_session_store': 'backend/src/notalone/persistence/assistant_session_store.py',
  'notalone.persistence.style_sample_store': 'backend/src/notalone/persistence/style_sample_store.py',
  'notalone.application.skill_learning': 'backend/src/notalone/application/skill_learning.py',
  'notalone.persistence.skill_learning': 'backend/src/notalone/persistence/skill_learning.py',
  'notalone.persistence.skill_learning_materials': 'backend/src/notalone/persistence/skill_learning_materials.py',
  'notalone.persistence.skill_learning_generation': 'backend/src/notalone/persistence/skill_learning_generation.py',
  'notalone.skills.learning_runtime': 'backend/src/notalone/skills/learning_runtime.py',
  'notalone.server.command': 'backend/src/notalone/server/command.py',
  'tests.integration.server.test_memory_upgrade': 'backend/tests/integration/server/test_memory_upgrade.py',
  'tests.integration.server.grounded_upgrade_support': 'backend/tests/integration/server/grounded_upgrade_support.py',
  'notalone.application.memory_upgrade': 'backend/src/notalone/application/memory_upgrade.py',
  'notalone.application.memory_upgrade_runtime': 'backend/src/notalone/application/memory_upgrade_runtime.py',
  'notalone.application.memory_upgrade_preview': 'backend/src/notalone/application/memory_upgrade_preview.py',
  'notalone.persistence.memory_upgrade': 'backend/src/notalone/persistence/memory_upgrade.py',
  'notalone.persistence.memory_upgrade_apply': 'backend/src/notalone/persistence/memory_upgrade_apply.py',
  'notalone.persistence.memory_upgrade_generation': 'backend/src/notalone/persistence/memory_upgrade_generation.py',
  'notalone.memory.upgrade_snapshot': 'backend/src/notalone/memory/upgrade_snapshot.py',
  'notalone.memory.upgrade_algorithm': 'backend/src/notalone/memory/upgrade_algorithm.py',
  'notalone.memory_extraction.grounded': 'backend/src/notalone/memory_extraction/grounded.py',
  'notalone.memory_extraction.grounded_adapter': 'backend/src/notalone/memory_extraction/grounded_adapter.py',
  'notalone.memory_extraction.verification_adapters': 'backend/src/notalone/memory_extraction/verification_adapters.py',
  'notalone.memory_extraction.adjudication_adapters': 'backend/src/notalone/memory_extraction/adjudication_adapters.py',
  module_guard: 'desktop/tests/fixtures/module_guard.py',
});

// 固定当前工作树和实际Python入口；不从可变main或其他运行继承证据。
export async function memoryUpgradeModules(root, fixtureEntry) {
  if (!path.isAbsolute(root) || typeof fixtureEntry !== 'string' || path.isAbsolute(fixtureEntry)) {
    throw new Error('升级证据必须明确仓库根和相对夹具入口。');
  }
  return Object.fromEntries(await Promise.all(Object.entries({ ...critical, __main__: fixtureEntry })
    .map(async ([name, file]) => [name, { path: file,
      sha256: createHash('sha256').update(await readFile(path.join(root, file))).digest('hex') }])));
}
