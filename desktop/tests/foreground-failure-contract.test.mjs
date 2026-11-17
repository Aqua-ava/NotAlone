import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const generated = await build({ stdin: { contents: "export * from './src/shared/foreground-failure.mjs';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false });
const foreground = await import(`data:text/javascript;base64,${Buffer.from(generated.outputFiles[0].text).toString('base64')}`);
const controllerSource = await readFile('src/main/foreground/controller.ts', 'utf8');
const foregroundSource = await readFile('src/shared/foreground-failure.mjs', 'utf8');

test('前台待选原因集合来自共享模块，且每个原因都有固定中文说明', () => {
  assert.match(controllerSource, /isAwaitingForegroundSelection/, 'controller 必须引用共享待选判断');
  assert.doesNotMatch(controllerSource, /const awaitingSelectionReasons/, 'controller 不得保留第二份原因集合');
  const awaiting = ['ambiguous_requires_selection', 'unmatched_requires_selection',
    'session_candidates_truncated', 'manual_confirmation_required'];
  for (const code of awaiting) {
    assert.equal(foreground.isAwaitingForegroundSelection(code), true, code);
    assert.ok(foreground.foregroundFailureReason(code), `${code} 必须有固定说明`);
  }
  assert.equal(foreground.isAwaitingForegroundSelection('quality_unverified'), false);
  assert.equal(foreground.isAwaitingForegroundSelection(null), false);
});

test('后端前台失败原因都有共享说明，不靠界面默认分支静默兜底', async () => {
  const files = ['../backend-ts/src/foreground/foreground-location-locator.ts'];
  const produced = new Set();
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?:result|failure)\('[a-z-]+','([a-z_]+)'/g)) produced.add(match[1]);
  }
  assert.ok(produced.size>=10, '必须实际枚举TS前台原因，不能空集通过');
  // 成功或用独立状态表达的固定码不要求失败说明。
  const nonFailure = new Set(['confirmed_active_binding', 'group_chat_suspected', 'group_chat_unsupported']);
  for (const code of produced) {
    if (nonFailure.has(code)) continue;
    assert.ok(foreground.foregroundFailureReason(code), `后端原因 ${code} 缺少共享说明`);
  }
  assert.match(foregroundSource, /isKnownForegroundReason|isAwaitingForegroundSelection/);
});

test('桌面主进程自己置为不可用的前台原因都有共享说明，不落到“暂不可用”兜底文案', () => {
  // 主进程自产原因：连接重置、尚未连接、观察超时/取消等；漏映射时面板只显示泛化兜底并谎称“等待自动重试”。
  const produced = new Set([...controllerSource.matchAll(/clearObservation\('unavailable',\s*'([a-z_]+)'\)/g)].map((match) => match[1]));
  if (/invalidatePending\(phase[^)]*\)[^{]*\{[\s\S]*?clearObservation\(phase, '([a-z_]+)'\)/.test(controllerSource)) {
    produced.add(controllerSource.match(/clearObservation\(phase, '([a-z_]+)'\)/)[1]);
  }
  for (const code of ['connection_changed', 'connection_unavailable', 'observation_timeout', 'observation_cancelled']) {
    assert.ok(produced.has(code), `${code} 应仍由控制器产生；若已移除请同步更新本测试`);
  }
  for (const code of produced) assert.ok(foreground.foregroundFailureReason(code), `主进程原因 ${code} 缺少共享说明`);
});
