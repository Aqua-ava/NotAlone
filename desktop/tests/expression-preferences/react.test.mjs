import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withPreferencePanels } from './react-support.mjs';

test('当前 React 面板明确区分长期保存与本次指令，并展示用户可选择的输入范围', async () => {
  const before = globalThis.window;
  try {
    globalThis.window = { notalone: { expressionPreferences: {} } };
    await withPreferencePanels(async ({ ExpressionPreferences }) => {
      const markup = renderToStaticMarkup(React.createElement(ExpressionPreferences, { replies: { state: { contactId: null, scopeRevision: 0 } } }));
      assert.match(markup, /长期表达偏好/);
      assert.match(markup, /明确长期保存/);
      assert.match(markup, /type="checkbox"/);
      assert.doesNotMatch(markup, /checked=""/);
      assert.match(markup, /本人全局/);
      assert.match(markup, /当前联系人/);
      assert.match(markup, /适用输入模式/);
      assert.match(markup, /本次指令、选择、复制和表达样本不会自动保存为长期偏好/);
      const contactId = '11111111-1111-4111-8111-111111111111';
      const preferenceId = '22222222-2222-4222-8222-222222222222';
      const receipt = { preferenceId, text: '生成时保存的旧要求：保留称呼。',
        scope: { contactId, replyMode: 'rewrite_draft' }, revision: 1 };
      const render = (state) => renderToStaticMarkup(React.createElement(ExpressionPreferences,
        { replies: { state: { contactId, scopeRevision: 1, ...state } } }));
      const active = render({ result: { expressionPreferences: [receipt] } });
      assert.match(active, /生成时保存的旧要求：保留称呼。/);
      assert.match(active, /当前联系人 · 改写草稿 · 生成时版本1/);
      assert.doesNotMatch(active, new RegExp(preferenceId));
      const recovered = render({ result: null, savedSession: { phase: 'ready', turns: [
        { state: 'completed', reply: { expressionPreferences: [receipt] } },
      ] } });
      assert.match(recovered, /生成时保存的旧要求：保留称呼。/);
      assert.match(recovered, /当前联系人 · 改写草稿 · 生成时版本1/);
      const erased = render({ result: null, savedSession: { phase: 'ready', turns: [{ state: 'redacted', reply: null }] } });
      assert.doesNotMatch(erased, /生成时保存的旧要求/);
    });
  } finally { globalThis.window = before; }
});
