import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

const output = await build({ stdin: { contents: `
  export { AssistantSessionPanel } from './src/renderer/AssistantSessionPanel';
  export { createElement } from 'react';
  export { renderToStaticMarkup } from 'react-dom/server';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const ports = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);

const contactId = '943ce8c2-3dce-4c50-a954-e7e378ea1628';

function renderJobs(generationJobs = [], savedSession = undefined) {
  const sessionId = '39b0eaa0-50d2-4a83-bb58-d125517a9e71';
  const state = {
    contactId, scopeRevision: 4, phase: generationJobs.length ? 'waiting' : 'idle',
    exploration: { phase: 'idle', result: null }, sessionDeletion: undefined,
    sessionCatalog: { phase: 'ready', items: [] }, sourceAvailability: undefined,
    savedSession: savedSession === undefined
      ? { phase: 'ready', sessionId, turns: [], inputs: [], currentInputVersionId: null }
      : savedSession,
    generationJobs,
  };
  return ports.renderToStaticMarkup(ports.createElement(ports.AssistantSessionPanel, {
    replies: { state, stopGeneration: () => Promise.resolve() },
  }));
}

function render(job = undefined, savedSession = undefined) {
  return renderJobs(job ? [{
    contactId, sessionId: '39b0eaa0-50d2-4a83-bb58-d125517a9e71', phase: 'generating', ...job,
  }] : [], savedSession);
}

test('生成中的当前会话显示明确可访问的停止入口，空闲时不显示', () => {
  const job = {
    requestKey: 'ae005c08-95d6-4572-a89d-48e0d3ee63f5',
    turnId: 'c47f80c6-c6ac-4627-a098-8b53a6678e12',
    inputVersionId: '5ae0cbda-2888-4361-a996-ac75b0a6d77f',
  };
  const generating = render(job);
  assert.match(generating, /<button[^>]*aria-label="停止本次生成"[^>]*>停止本次生成<\/button>/);
  const stopping = render({ ...job, phase: 'stopping' });
  assert.match(stopping, /正在停止本次生成…/);
  assert.doesNotMatch(stopping, /aria-label="停止本次生成"/);
  const cancelled = render({ ...job, phase: 'cancelled' });
  assert.match(cancelled, /本次生成已由你停止/);
  assert.doesNotMatch(cancelled, /生成失败/);
  assert.doesNotMatch(cancelled, /aria-label="停止本次生成"/);
  assert.doesNotMatch(render(), /停止本次生成/);
});

test('助手会话尚未加载时，当前联系人的唯一运行作业仍可停止', () => {
  const html = render({
    requestKey: 'ae005c08-95d6-4572-a89d-48e0d3ee63f5',
    turnId: 'c47f80c6-c6ac-4627-a098-8b53a6678e12',
    inputVersionId: '5ae0cbda-2888-4361-a996-ac75b0a6d77f',
  }, { phase: 'loading', sessionId: null, turns: [], inputs: [], currentInputVersionId: null });
  const button = html.match(/<button[^>]*aria-label="停止本次生成"[^>]*>/)?.[0];
  assert.ok(button);
  assert.doesNotMatch(button, /disabled/);
});

test('显示另一助手会话时，当前联系人的唯一后台生成仍可停止', () => {
  const html = render({
    sessionId: 'cb1c9305-a01c-48f0-a3b1-87707fd23983',
    requestKey: 'e1110650-207a-4887-877c-f128b98d18a5',
    turnId: '157d7997-92a5-4a94-87fa-a8ed7f560b85',
    inputVersionId: 'f90344f0-3ef2-4374-8adc-143c6254146e',
  }, { phase: 'ready', sessionId: '39b0eaa0-50d2-4a83-bb58-d125517a9e71',
    turns: [], inputs: [], currentInputVersionId: null });
  assert.match(html, /正在另一助手会话中后台生成，结果会保存在原助手会话。/);
  assert.match(html, /<button[^>]*aria-label="停止本次生成"[^>]*>停止本次生成<\/button>/);
});

test('会话未加载时只允许当前联系人的唯一活动作业，其他联系人和歧义作业保持隔离', () => {
  const loading = { phase: 'loading', sessionId: null, turns: [], inputs: [], currentInputVersionId: null };
  const job = (overrides) => ({
    contactId, sessionId: '39b0eaa0-50d2-4a83-bb58-d125517a9e71', phase: 'generating',
    requestKey: 'ae005c08-95d6-4572-a89d-48e0d3ee63f5',
    turnId: 'c47f80c6-c6ac-4627-a098-8b53a6678e12',
    inputVersionId: '5ae0cbda-2888-4361-a996-ac75b0a6d77f', ...overrides,
  });
  const otherContact = renderJobs([job({ contactId: 'ab90ac76-6fb3-4acc-9fbe-dca96712a6ec' })], loading);
  assert.doesNotMatch(otherContact, /aria-label="停止本次生成"/);
  const ambiguous = renderJobs([job({}), job({
    sessionId: 'cb1c9305-a01c-48f0-a3b1-87707fd23983',
    requestKey: 'e1110650-207a-4887-877c-f128b98d18a5',
    inputVersionId: 'f90344f0-3ef2-4374-8adc-143c6254146e',
  })], loading);
  assert.doesNotMatch(ambiguous, /aria-label="停止本次生成"/);
  const ambiguousWithSavedSession = renderJobs([job({}), job({
    sessionId: 'cb1c9305-a01c-48f0-a3b1-87707fd23983',
    requestKey: 'e1110650-207a-4887-877c-f128b98d18a5',
    inputVersionId: 'f90344f0-3ef2-4374-8adc-143c6254146e',
  })], { phase: 'ready', sessionId: '39b0eaa0-50d2-4a83-bb58-d125517a9e71',
    turns: [], inputs: [], currentInputVersionId: null });
  assert.doesNotMatch(ambiguousWithSavedSession, /aria-label="停止本次生成"/);
});
