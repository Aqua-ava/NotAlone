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

function render(job = undefined) {
  const contactId = '943ce8c2-3dce-4c50-a954-e7e378ea1628';
  const sessionId = '39b0eaa0-50d2-4a83-bb58-d125517a9e71';
  const state = {
    contactId, scopeRevision: 4, phase: job ? 'waiting' : 'idle',
    exploration: { phase: 'idle', result: null }, sessionDeletion: undefined,
    sessionCatalog: { phase: 'ready', items: [] }, sourceAvailability: undefined,
    savedSession: { phase: 'ready', sessionId, turns: [], inputs: [], currentInputVersionId: null },
    generationJobs: job ? [{ contactId, sessionId, phase: 'generating', ...job }] : [],
  };
  return ports.renderToStaticMarkup(ports.createElement(ports.AssistantSessionPanel, {
    replies: { state, stopGeneration: () => Promise.resolve() },
  }));
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
