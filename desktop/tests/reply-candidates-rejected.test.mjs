import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

Error.stackTraceLimit = 0;

const output = await build({ stdin: { contents: `
  export { ReplyCandidates } from './src/renderer/RewritePanel';
  export { ReplySession } from './src/main/reply/session';
  export { ContactSession } from './src/main/contacts/session';
  export { createElement } from 'react';
  export { renderToStaticMarkup } from 'react-dom/server';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const ports = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);

test('候选全拒绝明确保留输入并提示修改要求，不显示供应商故障或重复请求入口', () => {
  globalThis.window = { notalone: { replies: {} } };
  const contacts = new ports.ContactSession(async () => ({ generation: 1, contacts: [] }));
  const replies = new ports.ReplySession(contacts, {
    getConnectionGeneration: () => 1, onStateChanged: () => () => {},
  }, () => null);
  const state = { ...replies.getState(), phase: 'failed', errorCode: 'candidates_rejected', canRetry: false };
  const markup = ports.renderToStaticMarkup(ports.createElement(ports.ReplyCandidates, { replies: { state } }));
  delete globalThis.window;
  assert.match(markup, /本次候选未通过要求与内容核对/);
  assert.match(markup, /草稿已保留，请调整草稿或本次要求后重新生成/);
  assert.doesNotMatch(markup, /本次生成失败|重试同一次|本机服务后重试/);
});
