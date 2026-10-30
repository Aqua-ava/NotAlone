import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('../../', import.meta.url).pathname);

async function files() {
  const result = [];
  const walk = async (relative) => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const next = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) { await walk(next); continue; }
      if (/\.(mjs|tjs)$/.test(entry.name)) result.push(next);
    }
  };
  await walk('backend-ts/test');
  return result;
}

// 说明：本守卫是文件级启发式（调用参数可能是同文件内组装的 config/变量），
// 只能保证出现 launchDsh( 的 current 文件存在受控 sqlite 配置来源，不能证明每次调用
// 在调用点绑定；历史PG helper由独立退役清单按固定提交追溯，不在当前扫描树中。
test('current 后端测试与 helper 中所有 launchDsh 调用必须显式装配受控 SQLite', async () => {
  const scanned = await files();
  const violated = [];
  for (const file of scanned) {
    if (path.basename(file) === 'sqlite-cutover-launch-sqlite-guard.test.mjs') continue;
    const source = await readFile(path.join(root, file), 'utf8');
    if (!/\blaunchDsh\s*\(/.test(source)) continue;
    // 调用参数可能是同文件内组装的 config；文件级断言确认该调用有受控 SQLite 配置来源，
    // 足以阻止无 sqlite 的旧宿主启动回退。
    if (!/\bsqlite\s*:/.test(source)) violated.push(file);
  }
  assert.deepEqual(violated, [], `current 中仍有 launchDsh 未带 sqlite：${violated.join(', ')}`);
});
