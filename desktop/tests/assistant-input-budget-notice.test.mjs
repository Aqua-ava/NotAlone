import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

const output = await build({ stdin: { contents: `
  export { AssistantInputBudgetNotice } from './src/renderer/AssistantInputBudgetNotice';
  export { readInputBudget } from './src/main/reply/input-budget-read';
  export { createElement } from 'react';
  export { renderToStaticMarkup } from 'react-dom/server';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const ports = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const estimate = { state: 'ready', allowed: true, model_id: 'synthetic-json-model-v1', context_window_tokens: 1000,
  input_tokens: 500, output_reserve_tokens: 100, safety_margin_tokens: 200, total_tokens: 800,
  measurement_kind: 'approximate', measurement_id: 'synthetic-request-estimate-v1', reason: null };
const render = (receipt, historical = false) => ports.renderToStaticMarkup(
  ports.createElement(ports.AssistantInputBudgetNotice, { budget: ports.readInputBudget(receipt), historical }));

test('正常估算生成也显示估算和余量，不声称精确计量或已核实上界', () => {
  const html = render(estimate);
  assert.match(html, /输入长度为估算，已预留余量/);
  assert.match(html, /role="status"/);
  assert.match(html, /估算总量/);
  const details = html.match(/<details[^>]*class="record-metadata"[^>]*>/)?.[0];
  assert.ok(details, '正常预算数字放在可展开的详情中');
  assert.doesNotMatch(details, /\bopen(?:=|\s|>)/);
  assert.match(html, /<summary>查看输入长度详情<\/summary>/);
  assert.match(html, /输出预留 100 token/);
  assert.match(html, /安全余量 200 token/);
  assert.doesNotMatch(html, /精确|已核实的保守上界|ECNU|ecnu-max/);
});

test('估算接近预算时提示建议长度，历史回执保留当时语境', () => {
  const warning = { ...estimate, state: 'warning' };
  assert.match(render(warning), /讨论快达到建议长度/);
  assert.match(render(warning, true), /这轮讨论当时快达到建议长度/);
  assert.doesNotMatch(render(warning), /已接近模型输入上限|已核实的保守上界/);
});

test('估算超出建议长度时明确停止并要求新开，继续保留讨论', () => {
  const html = render({ ...estimate, state: 'exceeded', allowed: false,
    input_tokens: 801, total_tokens: 1101, reason: 'context_window_exceeded' });
  assert.match(html, /role="alert"/);
  assert.match(html, /当前讨论超过建议长度，本次生成已停止/);
  assert.match(html, /已保存讨论仍可查看/);
  assert.match(html, /请新开助手会话/);
  assert.match(html, /估算总量/);
  assert.doesNotMatch(html, /已核实的保守上界/);
});

test('估算不可用时保留输入且不编造计量总数', () => {
  const html = render({ ...estimate, state: 'unavailable', allowed: false,
    input_tokens: null, total_tokens: null, reason: 'counter_unavailable' });
  assert.match(html, /当前模型的输入长度暂无法估算/);
  assert.match(html, /已填写内容和已保存讨论仍会保留/);
  assert.doesNotMatch(html, /估算总量|800|已核实的保守上界/);
});
