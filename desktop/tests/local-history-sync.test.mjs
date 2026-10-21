import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const bundled = await build({ stdin: { contents: `
  import React from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { SyncControlPanel } from './src/renderer/SyncControlPanel';
  import { PrioritySyncStatus } from './src/renderer/PrioritySyncStatus';
  export function render(state, priority = false) {
    globalThis.__localHistoryTestState = state;
    return renderToStaticMarkup(priority
      ? React.createElement(PrioritySyncStatus, { contactId: 'selected', bridge: {} })
      : React.createElement(SyncControlPanel, { bridge: {} }));
  }`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', write: false,
  loader: { '.css': 'empty' }, plugins: [{ name: 'synthetic-session', setup(builder) {
    builder.onResolve({ filter: /\/use-revisioned-session$/ }, () => ({ path: 'session', namespace: 'synthetic' }));
    builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({ contents: `
      export function useRevisionedSession() {
        const state = globalThis.__localHistoryTestState;
        return { state, latest: { current: state }, active: { current: true }, error: '', setError() {} };
      }` }));
  } }] });
const loaded = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
const { render } = loaded.exports;

function state(code, historyState) {
  return { phase: 'ready', busy: null, errorCode: null, scopeRevision: 1, report: {
    enabled: true, backgroundPhase: 'active', confirmedBindingCount: 1, foregroundPhase: 'waiting_foreground',
    backfill: { phase: 'incomplete', failureCode: code, completedContacts: 0, totalContacts: 1,
      pendingContacts: 0, failedContacts: 0, incompleteContacts: 1, messageCount: 0, nonTextCount: 0 },
    priority: { contactId: 'selected', lastSuccessAt: null, lastFailureCode: null, localHistoryState: historyState },
  } };
}

test('已删除与本地无记录均为中性覆盖说明，不误报同步完整或故障', () => {
  for (const [code, historyState] of [['local_history_deleted', 'deleted'], ['local_history_empty', 'empty']]) {
    for (const priority of [false, true]) {
      const html = render(state(code, historyState), priority);
      assert.match(html, /历史覆盖尚未确认/);
      assert.match(html, /收到新消息后会再次检查/);
      assert.doesNotMatch(html, /role="alert"|补齐已完成|补齐失败|本次读取未成功/);
      if (!priority) {
        assert.match(html, /部分已确认会话/);
        assert.doesNotMatch(html, /此会话/);
        const paused = state(code, historyState);
        paused.report.backfill.phase = 'paused';
        const pausedHtml = render(paused);
        assert.doesNotMatch(pausedHtml, /补齐已暂停|暂停补齐|重试补齐/);
        assert.match(pausedHtml, /历史覆盖尚未确认/);
        assert.doesNotMatch(pausedHtml, /role="alert"|补齐失败/);
      } else assert.doesNotMatch(html, /部分已确认会话/);
    }
  }
});

test('本地无记录与真实失败并存时，全局状态仍保留异常提示', () => {
  const mixed = state('local_history_empty', null);
  mixed.report.backfill.failedContacts = 1;
  mixed.report.backfill.phase = 'failed';
  const html = render(mixed);
  assert.match(html, /正在自动重试/);
  assert.doesNotMatch(html, /暂停补齐|重试补齐|已完成.*个会话/);
  assert.doesNotMatch(html, /部分已确认会话/);
});

test('未知CLI错误继续作为异常展示', () => {
  const html = render(state('cli_command_failed', null));
  assert.match(html, /正在自动重试/);
  assert.doesNotMatch(html, /请检查本机服务与CLI后显式重试/);
  assert.doesNotMatch(html, /本地无可读历史/);
});

// 成功和关闭状态不留下独立补齐任务；进行中只保留自动恢复提示。
test('自动补齐与总开关合并，完成或关闭后隐藏进度和手动操作', () => {
  for (const phase of ['not_required', 'complete', 'backfilling', 'gap_detected', 'paused']) {
    const current = state(null, null);
    current.report.backfill.phase = phase;
    current.report.backfill.incompleteContacts = 0;
    const html = render(current);
    assert.doesNotMatch(html, /历史补齐|查看补齐详情与操作|暂停补齐|重试补齐|已写入文字|本轮已检查/);
    if (['backfilling', 'gap_detected', 'paused'].includes(phase)) {
      assert.match(html, /正在自动同步遗漏消息/);
    } else assert.doesNotMatch(html, /aria-label="遗漏消息同步"/);
    current.report.enabled = false;
    assert.doesNotMatch(render(current), /aria-label="遗漏消息同步"/);
  }
});
