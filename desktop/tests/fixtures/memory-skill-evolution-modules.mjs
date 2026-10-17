import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { skillLearningModules } from './skill-learning-modules.mjs';
import { memoryUpgradeModules } from './memory-upgrade-modules.mjs';

// 同源页面同时经过升级、审核和范围政策；每轮固定本树实际入口。
export async function memorySkillEvolutionModules(root) {
  const entry = 'desktop/tests/fixtures/memory-skill-evolution-page.py';
  const extra = {
    'tests.integration.server.test_memory_skill_evolution': 'backend/tests/integration/server/test_memory_skill_evolution.py',
    'tests.integration.server.memory_skill_evolution_models': 'backend/tests/integration/server/memory_skill_evolution_models.py',
    'tests.integration.server.memory_skill_evolution_support': 'backend/tests/integration/server/memory_skill_evolution_support.py',
    'notalone.persistence.skill_history': 'backend/src/notalone/persistence/skill_history.py',
    'notalone.persistence.skill_policies': 'backend/src/notalone/persistence/skill_policies.py',
    'notalone.persistence.skill_execution_view': 'backend/src/notalone/persistence/skill_execution_view.py',
  };
  return {
    ...await skillLearningModules(root, entry, { reviewing: true }),
    ...await memoryUpgradeModules(root, entry),
    ...Object.fromEntries(await Promise.all(Object.entries(extra).map(async ([name, file]) => [name, {
      path: file, sha256: createHash('sha256').update(await readFile(path.join(root, file))).digest('hex'),
    }]))),
  };
}
