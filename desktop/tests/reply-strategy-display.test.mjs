import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { build } from 'esbuild';

const bundled = await build({ stdin: { contents: `
  export { StrategyControls } from './src/renderer/StrategyControls';
  export { createElement } from 'react';
  export { renderToStaticMarkup } from 'react-dom/server';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const view = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
function render(overrides = {}) {
  const state = { contactId: 'synthetic-contact', scopeRevision: 1, mode: 'initiate_conversation', phase: 'ready',
    correction: '', requirements: '', exploration: { phase: 'idle', result: null },
    skillChoice: { mode: 'auto', versionId: null }, skillChoices: [], ...overrides };
  return view.renderToStaticMarkup(view.createElement(view.StrategyControls, { replies: { state } }));
}
const exploration = usedSkill => ({ phase: 'ready', result: { usedSkill, understanding: '合成当前理解',
  evidence: [], citationIds: [], ambiguities: [], tradeoffs: [], directions: [] } });

test('方向页面默认自动匹配策略，用户不需要选择 Skill 或声明精确场景', () => {
  const html = render();
  assert.match(html, /role="status" aria-label="本次使用的策略"/);
  assert.ok(html.includes('将根据当前对话自动匹配'));
  assert.doesNotMatch(html, /<select\b|策略选择|本次精确场景|场景与策略设置/);
});

test('方向页面展示实际选用版本，无匹配时明确使用通用流程', () => {
  const html = render({ exploration: exploration({ name: '先核对事实', versionNumber: 2 }) });
  assert.ok(html.includes('实际 Skill：先核对事实 · 版本 2'));
  assert.ok(render({ exploration: exploration(null) }).includes('本次使用通用流程。'));
});

test('方向理解与候选分别展示实际策略，通用方向结果不会隐藏候选版本', () => {
  const result = { usedSkill: { name: '上一组实际策略', versionNumber: 1, loadState: 'loaded' } };
  assert.ok(render({ result }).includes('实际 Skill：上一组实际策略 · 版本 1'));
  const html = render({ result, exploration: exploration(null) });
  assert.ok(html.includes('本次使用通用流程。'));
  assert.ok(html.includes('方向理解：本次使用通用流程。'));
  assert.ok(html.includes('候选生成：实际 Skill：上一组实际策略 · 版本 1'));
});

test('读取失败与历史缺少实际策略记录不会被展示成成功加载', () => {
  const failed = render({ result: { usedSkill: { name: '失败的策略', versionNumber: 1, loadState: 'resource_failed' } } });
  assert.ok(failed.includes('策略资源读取失败，本次使用通用流程。'));
  assert.ok(!failed.includes('实际 Skill：失败的策略'));
  assert.ok(render({ result: {} }).includes('该结果未记录实际策略。'));
  const unknownVersion = render({ result: { usedSkill: { name: '版本未记录', loadState: 'loaded' } } });
  assert.ok(unknownVersion.includes('实际 Skill：版本未记录'));
  assert.ok(!unknownVersion.includes('undefined'));
});
