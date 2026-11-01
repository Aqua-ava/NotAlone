import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('../../', import.meta.url).pathname);
const productEntries = ['backend-ts/src/sqlite-host-plugin.ts', 'backend-ts/src/launch.ts', 'desktop/src/main/index.ts'];
const sourceRoots = ['backend-ts/src', 'desktop/src'];

test('旧宿主消费者退役后清除遗留解析器与模型测试孤岛，保留现行验收入口', () => {
  for (const file of [
    'backend-ts/src/memory/records/json.ts',
    'backend-ts/test/diagnostic-scenario-budget-plugin.ts',
    'backend-ts/test/extraction-model-plugin.ts',
    'backend-ts/test/host-model-network-guard.mjs',
    'backend-ts/test/stalled-tool.ts',
    'backend-ts/test/pure-ts-provider-fixture.mjs',
    'backend-ts/test/main-host-reply-chain-preload.mjs',
  ]) assert.equal(existsSync(path.join(root, file)), false, `${file} 的旧宿主或测试消费者已退役`);
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
  ]) assert.equal(existsSync(path.join(root, file)), true, `${file} 的现行调用或独立验收入口须保留`);
});

test('旧同步解析、候选协议及已移除导入页的孤立模块不再留在当前树', () => {
  for (const file of [
    'backend-ts/src/memory/overview/evidence/semantic.ts',
    'backend-ts/src/memory/overview/evidence/legacy-semantic.ts',
    'backend-ts/src/memory/overview/evidence/legacy-grammar.ts',
    'backend-ts/src/memory/processing/reason.ts',
    'backend-ts/src/memory/records/documents/target.ts',
    'backend-ts/src/reply/generation/reply-candidate-prompt.ts',
    'backend-ts/src/reply/generation/reply-prepared-schema.ts',
    'backend-ts/src/reply/generation/reply-prompts.ts',
    'backend-ts/src/skills/skills-root.ts',
    'backend-ts/src/sync/sync-incremental-cli-stream.ts',
    'backend-ts/src/sync/sync-incremental-cli-history.ts',
    'backend-ts/src/sync/sync-incremental-normalize.ts',
    'backend-ts/src/sync/wechat-scope-json.ts',
    'desktop/src/renderer/SourceDeletionPanel.tsx',
  ]) assert.equal(existsSync(path.join(root, file)), false, `${file} 已无当前消费者`);
  for (const file of ['backend-ts/src/sync/wechat-http-body.ts',
    'backend-ts/src/history/sqlite/incremental-coordinator.ts',
    'backend-ts/src/memory/overview/evidence/bounded-body.ts',
    'backend-ts/src/memory/overview/evidence/bounded-graph.ts',
    'backend-ts/src/memory/overview/evidence/bounded-contract.ts',
    'desktop/src/shared/source-deletion-bridge.ts',
    'desktop/src/preload/source-deletion.ts']) {
    assert.equal(existsSync(path.join(root, file)), true, `${file} 的现行能力不能随孤立模块移除`);
  }
});

test('SQLite 切换后不保留无消费者的旧合成宿主与传输辅助文件', () => {
  const retired = [
    'backend-ts/src/plugin.ts',
    'backend-ts/src/host/service.ts',
    'backend-ts/src/host/runtime.ts',
    'backend-ts/src/host/business.ts',
    'backend-ts/src/host/pure-ts-public-pages.ts',
    'backend-ts/src/host/pure-ts-runtime.ts',
    'backend-ts/test/reply-service-runtime-support.mjs',
    'backend-ts/test/assistant-runtime-faults.mjs',
    'backend-ts/test/assistant-runtime-lock-holder.mjs',
    'desktop/scripts/test-dsh-host.mjs',
    'desktop/scripts/test-dsh-contact-context.mjs',
  ];
  for (const file of retired) assert.equal(existsSync(path.join(root, file)), false, `${file} 已无当前入口或测试消费者`);
  // 原生辅助程序和 SQLite 共用模块仍是当前依赖，不能按旧目录名整体移除。
  for (const file of ['backend-ts/src/host/host-json.ts', 'backend-ts/src/host/host-reply-config.ts',
    'backend-ts/src/host/pure-ts-events.ts', 'native/skill-read/build.sh', 'native/media-validation/build.sh']) {
    assert.equal(existsSync(path.join(root, file)), true, `${file} 仍须保留`);
  }
});

async function sourceFiles() {
  const files = [];
  const walk = async (relative) => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const next = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') await walk(next); }
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(next);
    }
  };
  for (const directory of sourceRoots) await walk(directory);
  return files;
}
const fileSet = new Set(await sourceFiles());
const importsOf = (source) => {
  const result = [];
  for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const body = match[2].trim();
    const isType = Boolean(match[1]) || /^\{\s*type\s+[^}]*\}$/.test(body);
    result.push({ specifier: match[3], isType });
  }
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) result.push({ specifier: match[1], isType: false });
  return result;
};
function resolveImport(from, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base.replace(/\.js$/, '.ts')]) {
    if (fileSet.has(candidate)) return candidate;
  }
  return undefined;
}
function reachable(entries) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || !fileSet.has(file)) continue;
    seen.add(file);
    stack.push(...graph.get(file));
  }
  return seen;
}
const graph = new Map();
const pgImports = [];
const pgValueImports = [];
for (const file of fileSet) {
  const source = await readFile(path.join(root, file), 'utf8');
  const dependencies = [];
  for (const { specifier, isType } of importsOf(source)) {
    if (specifier === 'pg') { pgImports.push(file); if (!isType) pgValueImports.push(file); continue; }
    const resolved = resolveImport(file, specifier);
    if (resolved && !isType) dependencies.push(resolved);
  }
  graph.set(file, dependencies);
}

test('产品源码不导入 PostgreSQL 驱动，旧 PG 宿主与 schema 准备不可达', () => {
  assert.deepEqual([...new Set(pgImports)].sort(), [], '产品源码不得保留 pg 值、类型或动态导入');
  assert.deepEqual([...new Set(pgValueImports)].sort(), [], '产品源码不得保留 pg 值导入');
  for (const entry of productEntries) {
    const files = reachable([entry]);
    assert.ok(files.has(entry), `入口 ${entry} 必须存在`);
    const violations = [...files].filter(file => pgValueImports.includes(file));
    assert.deepEqual(violations, [], `${entry} 运行时可到达 pg 值导入：${violations.join(',')}`);
    for (const retired of ['backend-ts/src/host-plugin.ts', 'backend-ts/src/managed-postgres.ts', 'backend-ts/src/schema-prepare-cli.ts',
      'backend-ts/src/platform/database/host-storage.ts', 'backend-ts/src/imports/history-import-api.ts']) {
      assert.equal(files.has(retired), false, `${entry} 不得到达已退役模块 ${retired}`);
    }
  }
});

test('launch.ts 只有 SQLite 宿主，不再读取旧 profile 或透传 PG 环境', async () => {
  const source = await readFile(path.join(root, 'backend-ts/src/launch.ts'), 'utf8');
  assert.match(source, /backend_launch_requires_sqlite/);
  assert.match(source, /profile\/sqlite\.patch\.yml/);
  assert.match(source, /src\/sqlite-host-plugin\.ts/);
  assert.doesNotMatch(source, /profile\/host\.patch\.yml|from '\.\/host-plugin\.ts'|startsWith\('PG'\)/);
  assert.doesNotMatch(source, /managed-postgres/);
});

test('手动聊天文件导入与导入新建入口已从产品源码移除', async () => {
  for (const retired of ['backend-ts/src/imports/history-import-api.ts', 'backend-ts/src/imports/history-import-service.ts',
    'backend-ts/src/imports/history-import-format.ts', 'desktop/src/main/imports', 'desktop/src/shared/import-bridge.ts',
    'desktop/src/preload/imports.ts', 'desktop/src/renderer/ImportPage.tsx']) {
    assert.equal(existsSync(path.join(root, retired)), false, `${retired} 应已退役`);
  }
  const files = [...fileSet].filter(file => file.startsWith('backend-ts/src/') || file.startsWith('desktop/src/'));
  for (const file of files) {
    const source = await readFile(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /history-import-api|history-import-service|ImportController|import-bridge|ImportPage/, `${file} 仍引用已退役导入入口`);
  }
});

test('13偏好、15纠错诊断、17真实媒体与回复入口在SQLite宿主保持不可用声明', async () => {
  const source = await readFile(path.join(root, 'backend-ts/src/sqlite-host-plugin.ts'), 'utf8');
  for (const capability of ["expressionPreferences: 'unavailable'", "replies: 'unavailable'", "skillLearning: 'unavailable'",
    "taskApi: 'unavailable'", "tasks: 'unavailable'", "imports: 'unavailable'", "mediaExtraction: 'unavailable'"]) {
    assert.ok(source.includes(capability), `SQLite 宿主缺少停用声明：${capability}`);
  }
  assert.ok(source.includes("mediaExtraction: 'unavailable'"));
});

test('受管 PostgreSQL 运行时与旧 schema 准备不再被桌面正常入口引用', async () => {
  for (const retired of ['desktop/src/main/startup/managed-runtime.ts', 'desktop/src/main/startup/managed-manifest.ts',
    'desktop/src/main/startup/historical-update.ts']) {
    assert.equal(existsSync(path.join(root, retired)), false, `${retired} 应已退役`);
  }
  const diagnostics = await readFile(path.join(root, 'desktop/src/main/startup/diagnostics.ts'), 'utf8');
  assert.doesNotMatch(diagnostics, /ManagedRuntime|managed-runtime|manag(e|ed)-manifest|historicalUpdateComplete|schema-prepare-cli/);
  assert.match(diagnostics, /runDefaultDatabaseStartup|SqliteDevelopmentProbe/);
});
