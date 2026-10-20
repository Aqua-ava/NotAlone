import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { validateTestInventory } from '../scripts/test-inventory.mjs';

const inventory = () => ({ 'safe-node': [], headless: [], 'isolated-http-pg': [], native: [], app: [] });

async function withTree(use) {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-test-inventory-'));
  try {
    await mkdir(path.join(directory, 'tests'));
    await use(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('新增未登记测试会阻止默认入口，扫描不会执行原生或 App 文件', async () => withTree(async directory => {
  await writeFile(path.join(directory, 'tests/new.spec.ts'), "throw Error('不得执行 App');");
  await assert.rejects(validateTestInventory(directory, inventory()), /未登记.*tests\/new.spec.ts/);
}));

test('登记覆盖全部前置条件，默认仅返回明确的 safe-node 文件', async () => withTree(async directory => {
  const groups = inventory();
  for (const [group, file] of [['safe-node', 'safe.test.mjs'], ['headless', 'page.test.ts'],
    ['isolated-http-pg', 'http.test.mjs'], ['native', 'native.spec.ts'], ['app', 'app.spec.ts']]) {
    await writeFile(path.join(directory, 'tests', file), "throw Error('只扫描文件名');");
    groups[group].push(`tests/${file}`);
  }
  const result = await validateTestInventory(directory, groups);
  assert.deepEqual(result.safeNode, ['tests/safe.test.mjs']);
  assert.deepEqual(result.counts, { 'safe-node': 1, headless: 1, 'isolated-http-pg': 1, native: 1, app: 1 });
}));

test('重复登记、已删除文件和未知分类均失败关闭', async () => withTree(async directory => {
  await writeFile(path.join(directory, 'tests/safe.test.mjs'), '');
  const duplicate = inventory();
  duplicate['safe-node'].push('tests/safe.test.mjs'); duplicate.app.push('tests/safe.test.mjs');
  await assert.rejects(validateTestInventory(directory, duplicate), /重复登记/);
  const stale = inventory(); stale.app.push('tests/deleted.spec.ts');
  await assert.rejects(validateTestInventory(directory, stale), /不存在/);
  await assert.rejects(validateTestInventory(directory, { ...inventory(), unknown: [] }), /分类/);
}));
