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
  'tests.integration.server.test_skill_learning': 'backend/tests/integration/server/test_skill_learning.py',
  'notalone.application.skill_learning': 'backend/src/notalone/application/skill_learning.py',
  'notalone.persistence.skill_learning': 'backend/src/notalone/persistence/skill_learning.py',
  'notalone.persistence.skill_learning_materials': 'backend/src/notalone/persistence/skill_learning_materials.py',
  'notalone.persistence.skill_learning_generation': 'backend/src/notalone/persistence/skill_learning_generation.py',
  'notalone.skills.learning_runtime': 'backend/src/notalone/skills/learning_runtime.py',
  'notalone.server.command': 'backend/src/notalone/server/command.py',
  module_guard: 'desktop/tests/fixtures/module_guard.py',
});

// HTTP与页面共用关键模块合同，各自必须明确仓库根与实际Python入口。
export async function skillLearningModules(root, fixtureEntry, { reviewing = false, lifecycle = false, feedback = false } = {}) {
  if (!path.isAbsolute(root) || typeof fixtureEntry !== 'string' || path.isAbsolute(fixtureEntry)) {
    throw new Error('学习证据必须明确仓库根和相对夹具入口。');
  }
  const review = reviewing || lifecycle || feedback ? {
    'notalone.application.skill_review': 'backend/src/notalone/application/skill_review.py',
    'notalone.persistence.skill_review': 'backend/src/notalone/persistence/skill_review.py',
    'notalone.persistence.skill_review_navigation': 'backend/src/notalone/persistence/skill_review_navigation.py',
    'notalone.persistence.skill_version_lineage': 'backend/src/notalone/persistence/skill_version_lineage.py',
    'notalone.skills.review': 'backend/src/notalone/skills/review.py',
    'notalone.persistence.skill_port': 'backend/src/notalone/persistence/skill_port.py',
    'notalone.application.reply_request': 'backend/src/notalone/application/reply_request.py',
    'tests.integration.server.test_skill_review': 'backend/tests/integration/server/test_skill_review.py',
  } : {};
  const history = lifecycle || feedback ? {
    'notalone.persistence.skill_history': 'backend/src/notalone/persistence/skill_history.py',
    'tests.integration.server.test_skill_lifecycle': 'backend/tests/integration/server/test_skill_lifecycle.py',
  } : {};
  const policies = feedback ? {
    'notalone.persistence.skill_policies': 'backend/src/notalone/persistence/skill_policies.py',
    'notalone.persistence.skill_execution_view': 'backend/src/notalone/persistence/skill_execution_view.py',
    'tests.integration.server.test_skill_feedback': 'backend/tests/integration/server/test_skill_feedback.py',
  } : {};
  return Object.fromEntries(await Promise.all(Object.entries({ ...critical, ...review, ...history, ...policies, __main__: fixtureEntry })
    .map(async ([name, file]) => [name, { path: file,
      sha256: createHash('sha256').update(await readFile(path.join(root, file))).digest('hex') }])));
}
