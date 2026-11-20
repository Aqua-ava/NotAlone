import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('../../', import.meta.url).pathname);

test('切换后仍被现行调用或独立验收入口使用的文件不能随旧目录整体移除', () => {
  for (const file of [
    'backend-ts/src/host/host-json.ts',
    'backend-ts/src/memory/sqlite/http.ts',
    'backend-ts/test/observe.mjs',
    'backend-ts/test/model-provider-fixture.ts',
    'backend-ts/test/profile-support.mjs',
    'backend-ts/test/prepare-memory-desktop.mjs',
    'backend-ts/test/prepare-memory-management-desktop.mjs',
    'backend-ts/test/prepare-skill-desktop.mjs',
    'backend-ts/test/prepare-visual-desktop.mjs',
    'backend-ts/src/platform/http/body.ts',
    'backend-ts/src/history/sqlite/incremental-coordinator.ts',
    'backend-ts/src/memory/extraction/model.ts',
    'backend-ts/src/skills/skill-package.ts',
    'backend-ts/test/skill-package-validation.test.mjs',
    'desktop/src/renderer/MemoryProcessingEntry.tsx',
    'desktop/src/renderer/SqliteMemoryManagementPanel.tsx',
    'backend-ts/src/history/sqlite/source-deletion.ts',
    'backend-ts/test/sqlite-history-host.test.mjs',
    'backend-ts/src/host/host-reply-config.ts',
    'backend-ts/src/host/pure-ts-events.ts',
    'native/skill-read/build.sh',
    'native/media-validation/build.sh',
  ]) assert.equal(existsSync(path.join(root, file)), true, `${file} 的现行调用或独立验收入口须保留`);
});

test('launch.ts 只有 SQLite 宿主，不再读取旧 profile 或透传 PG 环境', async () => {
  const source = await readFile(path.join(root, 'backend-ts/src/launch.ts'), 'utf8');
  assert.match(source, /backend_launch_requires_sqlite/);
  assert.match(source, /profile\/sqlite\.patch\.yml/);
  assert.match(source, /src\/sqlite-host-plugin\.ts/);
  assert.doesNotMatch(source, /profile\/host\.patch\.yml|from '\.\/host-plugin\.ts'|startsWith\('PG'\)/);
  assert.doesNotMatch(source, /managed-postgres/);
});
