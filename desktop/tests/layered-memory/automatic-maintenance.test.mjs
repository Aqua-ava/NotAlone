import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, readyPayload, ids } from './support.mjs';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const compiled = await build({ stdin: { contents: `
  import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
  import { LayeredMemoryPanel } from './src/renderer/LayeredMemoryPanel';
  export const render = state => renderToStaticMarkup(<LayeredMemoryPanel state={state} contactName="合成联系人"
    busy={false} read={async () => {}} manage={async () => {}} facts={() => {}} />);
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', jsx: 'automatic', write: false });
const rendered = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), rendered, rendered.exports);

for (const scope of ['contact', 'owner']) test(`${scope}默认逐项核验模式持续显示后台整理进度`, { timeout: 4000 }, async () => {
  let reads = 0, notify;
  const updated = new Promise(resolve => { notify = resolve; });
  const f = await fixture(async () => {
    reads++;
    if (reads > 1) notify();
    return { generation: 1, data: readyPayload({ scope_kind: scope, contact_id: scope === 'owner' ? null : ids.contact,
      runtime_policy: 'verified_items', quality_status: 'unknown', quality: undefined }) };
  });
  const deadline = setTimeout(() => notify(), 2200);
  try {
    if (scope === 'owner') await f.bridge.readOwnerLayeredMemory({});
    else await f.bridge.readLayeredMemory(f.selection());
    await updated;
    await new Promise(resolve => setImmediate(resolve));
    const state = scope === 'owner' ? await f.bridge.getOwnerLayeredMemoryState() : (await f.bridge.getState()).layeredMemory;
    assert.equal(state.value.runtimePolicy, 'verified_items');
    assert.ok(reads > 1, '自动维护不应因没有旧评测报告停止读取进度');
    assert.equal(state.value.quality.organization.status, 'unknown', '不冒充质量评测已通过');
    const html = rendered.exports.render(state);
    assert.match(html, /已整理 2 \/ 3 条记忆/);
    assert.match(html, /自动整理记忆/);
    assert.doesNotMatch(html, /资料不会发给模型|当前不开放真实资料整理|真实资料自动加载已关闭/);
  } finally { clearTimeout(deadline); f.disconnect(); }
});
