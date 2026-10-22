import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { readContactDirectory } from './src/main/contacts/directory';
  export { MemoryReadingController } from './src/main/memory/controller';
  export * from './src/renderer/MemoryPage';
  export { renderToStaticMarkup } from 'react-dom/server';
  export { createElement } from 'react';
`, resolveDir: process.cwd() }, bundle: true, packages: 'external', jsx: 'automatic', platform: 'node', format: 'cjs',
  loader: { '.css': 'empty' }, write: false });
const compiledModule = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
  createRequire(import.meta.url), compiledModule, compiledModule.exports,
);
const ports = compiledModule.exports;

async function withEventFixture(mode, run) {
  assert.equal(process.env.CONDA_DEFAULT_ENV, 'NotAlone', '请先激活 Conda NotAlone，再运行独立 HTTP/PG 三例。');
  assert.ok(process.env.CONDA_PREFIX);
  const child = spawn('python', ['-u', resolve('tests/fixtures/memory_event_updates_fixture.py'), ...mode], {
    cwd: resolve('../backend'), env: { ...process.env, NOTALONE_DISABLE_DOTENV: '1', PYTHON_DOTENV_DISABLED: '1',
      LANGCHAIN_TRACING_V2: 'false', LANGCHAIN_TRACING: 'false', LANGSMITH_TRACING: 'false', PYTHONPATH: resolve('../backend/src') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  const replies = [], readers = [];
  let stderr = '';
  let databaseName;
  child.stderr.on('data', (data) => { stderr += String(data); });
  lines.on('line', (line) => { const data = JSON.parse(line); const reader = readers.shift(); if (reader) reader(data); else replies.push(data); });
  const receive = () => replies.length ? Promise.resolve(replies.shift()) : new Promise((resolve) => readers.push(resolve));
  try {
    const fixture = await Promise.race([receive(), exited.then(([exitCode]) => {
      throw new Error(`事件夹具在就绪前退出（${exitCode}）：${stderr}`);
    })]);
    assert.equal(typeof fixture.url, 'string', stderr);
    assert.match(fixture.databaseName, /^notalone_core_flow_[0-9a-f]{32}_test$/);
    databaseName = fixture.databaseName;
    const backend = { getConnectionGeneration: () => 1, requestJson: async ({ method, path, body, signal }) => {
      const result = await fetch(`${fixture.url}${path}`, { method, signal,
        headers: { Authorization: `Bearer ${fixture.token}`, 'Content-Type': 'application/json' },
        body: method === 'POST' ? JSON.stringify(body) : undefined });
      if (!result.ok) throw new Error(`合成 HTTP ${path} 状态 ${result.status}`);
      return { generation: 1, data: await result.json() };
    } };
    const directory = await ports.readContactDirectory(backend);
    assert.equal(directory.contacts?.find((contact) => contact.contactId === fixture.contactId)?.displayName,
      '合成事件联系人', '正式 setup 状态允许读取当前 owner 的实际联系人目录。');
    const contacts = new ports.ContactSession(() => ports.readContactDirectory(backend));
    contacts.setConnection(1); await contacts.refreshContacts();
    assert.equal(contacts.getState().directoryPhase, 'ready');
    contacts.selectContact({ contactId: fixture.contactId, scopeRevision: contacts.getState().scopeRevision });
    const memory = new ports.MemoryReadingController(backend, contacts);
    const selection = { contactId: fixture.contactId, scopeRevision: contacts.getState().scopeRevision };
    await memory.refresh(selection);
    await run({ fixture, memory, selection });
  } finally {
    if (child.exitCode === null && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify({ operation: 'stop' })}\n`);
    const [exitCode] = await exited;
    assert.equal(exitCode, 0, stderr);
    const cleanup = await receive();
    assert.equal(cleanup.cleanupConfirmed, true);
    process.stdout.write(`memory_event_fixture_cleanup: ${JSON.stringify({ databaseName, cleanupConfirmed: true, childExitCode: exitCode })}\n`);
    lines.close();
  }
}

test('用户从生产控制器查看版本历史并撤销自动更新，保留仍合法的旧资料', { timeout: 30_000 }, async () => {
  await withEventFixture([], async ({ fixture, memory, selection }) => {
    const active = memory.getState().contact.items[0];
    await memory.openVersions({ ...selection, level: 'contact', memoryId: active.memoryId, revision: active.revision });
    const history = memory.getState().history;
    assert.equal(history.phase, 'ready');
    assert.deepEqual(history.items.map((item) => item.text), [fixture.current.text, fixture.old.text]);
    assert.equal(history.items[0].canRevertAutoUpdate, true);
    await memory.revertAutoUpdate({ ...selection, level: 'contact', memoryId: active.memoryId, revision: active.revision });
    const after = memory.getState();
    assert.equal(after.mutation.phase, 'success');
    assert.equal(after.history.phase, 'idle');
    assert.equal(after.contact.items.length, 1);
    assert.equal(after.contact.items[0].text, fixture.old.text);
    assert.equal(after.contact.items[0].adoptionMethod, 'auto');
  });
});

test('历史人工审核保留待确认的新进展，用户可选择旧计划并明确应用手动版本', { timeout: 30_000 }, async () => {
  await withEventFixture(['--default'], async ({ fixture, memory, selection }) => {
    const before = memory.getState();
    assert.equal(before.contact.items.length, 1);
    assert.equal(before.contact.items[0].adoptionMethod, 'manual');
    assert.equal(before.contact.items[0].text, '计划参加这次读书会。');
    const candidate = before.pending.items[0];
    assert.equal(candidate.text, '已参加完这次读书会。');
    assert.equal(candidate.event.stage, 'occurred');
    assert.equal(candidate.event.stageVerified, true);
    assert.equal(candidate.event.occurrenceVerified, true);
    assert.equal(before.contact.items[0].event.stage, 'planned');
    const html = ports.renderToStaticMarkup(ports.createElement(ports.PendingMemoryUpdate, {
      candidate, memories: before.contact, apply: async () => {},
    }));
    assert.match(html, /选择要更新的当前资料/);
    assert.match(html, /计划参加这次读书会。/);
    assert.match(html, /旧版保留在历史中/);
    assert.match(html, /确认应用为新版本/);
    const previous = before.contact.items[0];
    await memory.applyCandidateUpdate({ ...selection, candidateId: candidate.candidateId,
      previousMemoryId: previous.memoryId, expectedRevision: previous.revision });
    const after = memory.getState();
    assert.equal(after.mutation.phase, 'success');
    assert.equal(after.pending.items.length, 0);
    assert.deepEqual(after.contact.items.map((item) => item.text), ['已参加完这次读书会。']);
    assert.equal(after.contact.items[0].adoptionMethod, 'manual');
    assert.equal(after.contact.items[0].event.stage, 'occurred');
    const current = after.contact.items[0];
    await memory.openVersions({ ...selection, level: 'contact', memoryId: current.memoryId, revision: current.revision });
    assert.deepEqual(memory.getState().history.items.map((item) => item.text), ['已参加完这次读书会。', fixture.old.text]);
  });
});

test('本人待确认候选可从当前 React 控制器更新独立手录资料并查看两版来源', { timeout: 30_000 }, async () => {
  await withEventFixture(['--owner-entry'], async ({ fixture, memory, selection }) => {
    const before = memory.getState();
    assert.equal(before.contact.items.length, 0);
    const previous = before.owner.items[0];
    const candidate = before.pending.items[0];
    assert.equal(candidate.subject, 'self');
    assert.equal(candidate.event.stage, 'occurred');
    const html = ports.renderToStaticMarkup(ports.createElement(ports.PendingMemoryUpdate, {
      candidate, memories: before.owner, apply: async () => {},
    }));
    assert.match(html, /我计划参加这次读书会。/);
    await memory.applyCandidateUpdate({ ...selection, candidateId: candidate.candidateId,
      previousMemoryId: previous.memoryId, expectedRevision: previous.revision });
    const after = memory.getState();
    assert.equal(after.mutation.phase, 'success');
    assert.equal(after.pending.items.length, 0);
    assert.equal(after.contact.items.length, 0);
    assert.deepEqual(after.owner.items.map((entry) => entry.text), ['我已参加完这次读书会。']);
    const current = after.owner.items[0];
    await memory.openVersions({ ...selection, level: 'owner', memoryId: current.memoryId, revision: current.revision });
    const history = memory.getState().history;
    assert.deepEqual(history.items.map((entry) => entry.text), [current.text, fixture.old.text]);
    assert.deepEqual(history.items[1].sourceIds, fixture.old.source_ids);
    assert.equal(history.items[1].adoptionMethod, 'manual');
  });
});
