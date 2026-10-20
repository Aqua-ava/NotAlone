import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fixture, profilePayload, ids } from './support.mjs';

const compiled = await build({ stdin: { contents: `
  import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
  import { LayeredMemoryPanel } from './src/renderer/LayeredMemoryPanel';
  export const render = (state, owner) => renderToStaticMarkup(<LayeredMemoryPanel state={state} owner={owner}
    contactName="合成联系人" busy={false} read={async () => {}} manage={async () => {}} facts={() => {}} />);
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', jsx: 'automatic', write: false });
const rendered = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), rendered, rendered.exports);

for (const scope of ['contact', 'owner']) for (const erased of [false, true]) {
  test(`${scope} ${erased ? '无正文保护' : '活动反馈'}可核对目标及合法底层身份`, async () => {
    const f = await fixture(async () => ({ generation: 1, data: profilePayload({
      scope_kind: scope, contact_id: scope === 'owner' ? null : ids.contact, scenarios: [], profile: null,
      feedback: [{ id: ids.other, target_kind: 'scenario', version_id: erased ? null : ids.version,
        item_index: 0, reason: erased ? null : '该总结把计划写成事实。', state: erased ? 'erased_guard' : 'active',
        target_text: erased ? null : '原整理目标是合成课程计划。', basis: [{ memory_id: ids.memory, revision: 2 }] }] }) }));
    try {
      if (scope === 'owner') await f.bridge.readOwnerLayeredMemory({});
      else await f.bridge.readLayeredMemory(f.selection());
      const state = scope === 'owner' ? await f.bridge.getOwnerLayeredMemoryState() : (await f.bridge.getState()).layeredMemory;
      assert.deepEqual(state.value.feedback[0].basis, [{ memoryId: ids.memory, revision: 2 }]);
      const html = rendered.exports.render(state, scope === 'owner');
      assert.match(html, /核对底层记忆/);
      assert.match(html, /版本 2/);
      assert.match(html, /最后一份有效依据删除后清除保护/);
      if (erased) {
        assert.match(html, /原整理内容已清除/);
        assert.doesNotMatch(html, /原整理目标是合成课程计划/);
      } else assert.match(html, /原整理内容：原整理目标是合成课程计划/);
      assert.match(html, scope === 'owner' ? /<h2>关于我<\/h2>/ : /<h2>关于 合成联系人<\/h2>/);
    } finally { f.disconnect(); }
  });
}

for (const leak of ['target_text', 'origin_contact']) {
  test(`无正文保护拒绝意外敏感投影 ${leak}`, async () => {
    const f = await fixture(async () => ({ generation: 1, data: profilePayload({ feedback: [{
      id: ids.other, target_kind: 'scenario', version_id: null, item_index: 0,
      reason: null, state: 'erased_guard', target_text: leak === 'target_text' ? '应删原文' : null,
      basis: [{ memory_id: ids.memory, revision: 2, ...(leak === 'origin_contact' ? { contact_id: ids.contact } : {}) }],
    }] }) }));
    try {
      await f.bridge.readLayeredMemory(f.selection());
      const state = (await f.bridge.getState()).layeredMemory;
      assert.equal(state.phase, 'error');
      assert.equal(state.value, null);
    } finally { f.disconnect(); }
  });
}
