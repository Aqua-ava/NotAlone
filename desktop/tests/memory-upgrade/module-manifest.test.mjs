import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { memoryUpgradeModules } from '../fixtures/memory-upgrade-modules.mjs';

test('升级页面固定实际入口、持久算法与Grounded核验关键模块', async () => {
  const root = path.resolve('..');
  const manifest = await memoryUpgradeModules(root, 'desktop/tests/fixtures/memory-upgrade-page.py');
  for (const name of ['notalone.memory.upgrade_algorithm', 'notalone.application.memory_upgrade_runtime',
    'notalone.persistence.memory_upgrade_apply', 'notalone.memory_extraction.grounded_adapter',
    'notalone.memory_extraction.verification_adapters', 'module_guard', '__main__']) {
    assert.match(manifest[name]?.sha256 ?? '', /^[a-f0-9]{64}$/);
  }
  assert.equal(manifest.__main__.path, 'desktop/tests/fixtures/memory-upgrade-page.py');
  assert.ok(Object.keys(manifest).length >= 15);
  await assert.rejects(memoryUpgradeModules('.', 'entry.py'));
  await assert.rejects(memoryUpgradeModules(root, '/entry.py'));
});
