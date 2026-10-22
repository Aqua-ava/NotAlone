import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

// 死代码删除回归：已确认零生产/测试引用的组件与常量不得重新出现或残留引用。
const removedComponents = ['ReplyModePicker', 'ReplySourcePicker', 'RewriteInput', 'DirectedReplyInput', 'ProactiveReplyInput',
  'StrategyControls', 'ReplySceneInput', 'ForegroundCalibration'];
const removedFiles = [
  'src/renderer/DirectedReplyInput.tsx',
  'src/renderer/ProactiveReplyInput.tsx',
  'tests/rewrite-generation-entry.test.mjs',
  // 未接线的前台校准集群与仅测试打包的方向/场景组件（audit 2026-10-22）。
  'src/main/foreground/calibration.ts',
  'src/main/foreground/calibration-form.ts',
  'src/main/foreground/calibration-profile.ts',
  'src/main/foreground/calibration-selection.ts',
  'src/renderer/StrategyControls.tsx',
  'src/renderer/ReplySceneInput.tsx',
  'tests/helpers/calibration-progress.test.mjs',
  'tests/reply-strategy-display.test.mjs',
];

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) { yield* walk(target); continue; }
    if (/\.(?:tsx?|mjs|mts|json)$/.test(entry.name)) yield target;
  }
}

test('已删除的旧输入组件与其测试不残留', async () => {
  for (const file of removedFiles) {
    await assert.rejects(stat(file), `${file} 应已删除`);
  }
  const page = await readFile('src/renderer/RewritePanel.tsx', 'utf8');
  assert.doesNotMatch(page, /export function (?:ReplyModePicker|ReplySourcePicker|RewriteInput)/);
});

test('生产与测试源码零引用已删除组件', async () => {
  const references = [];
  for (const directory of ['src', 'tests']) {
    for await (const file of walk(directory)) {
      if (path.resolve(file) === path.resolve('tests/dead-code-removal.test.mjs')) continue;
      const source = await readFile(file, 'utf8');
      for (const name of removedComponents) if (source.includes(name)) references.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(references, [], `仍存在死组件引用：${references.join(', ')}`);
});

test('构建与测试入口不引用已删除的未接线代码', async () => {
  const entries = ['scripts/build.mjs', 'scripts/dev.mjs', 'scripts/test-inventory.mjs', 'scripts/test-safe.mjs',
    'scripts/package.mjs', 'scripts/release-check.mjs'];
  const removed = ['calibration-form', 'calibration-profile', 'calibration-selection', 'StrategyControls', 'ReplySceneInput'];
  for (const file of entries) {
    const source = await readFile(file, 'utf8');
    for (const name of removed) assert.ok(!source.includes(name), `${file} 仍引用已删除的 ${name}`);
  }
});

test('固定三候选复核协议常量不再与动态构建重复定义', async () => {
  const contract = await readFile('../backend/src/notalone/reply/adapters/constraint_review_contract.py', 'utf8');
  assert.doesNotMatch(contract, /^REVIEW_TOOL = build_review_tool\(3\)$/m);
  // 动态构建入口保留：协议仍按本次候选数量生成。
  assert.match(contract, /def build_review_tool\(candidate_count: int\)/);
});
