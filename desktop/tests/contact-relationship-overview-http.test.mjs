import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: `
  export { withRelationshipOverviewFixture } from './tests/contact-relationship-overview-fixture';
  export { withControllerEnvironment } from './tests/headless/backend-fixture';
  export { BackendHost } from './src/main/backend/host';
  export { StartupDiagnostics } from './src/main/startup/diagnostics';
  export { installContactSessionBridge } from './src/main/contacts/bridge';
  export { installMemoryBridge } from './src/main/memory/bridge';
  export { createMemoryBridge } from './src/preload/memory';
  export { installSourceDeletionBridge } from './src/main/sources/bridge';
  export { createSourceDeletionBridge } from './src/preload/source-deletion';
  export { installTraceBridge } from './src/main/traces/bridge';
  export { createTraceBridge } from './src/preload/traces';
`, resolveDir: process.cwd() }, bundle: true, packages: 'external', jsx: 'automatic', platform: 'node', format: 'cjs',
  loader: { '.css': 'empty' }, write: false });
const compiledModule = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
  createRequire(import.meta.url), compiledModule, compiledModule.exports,
);
const ports = compiledModule.exports;

async function withOverview(run, { selectInitialContact = true } = {}) {
  await ports.withRelationshipOverviewFixture(async (fixture) => ports.withControllerEnvironment(fixture, async (userData) => {
    const prepared = await fixture.command('overview_prepared');
    const diagnostics = new ports.StartupDiagnostics(userData);
    const backend = new ports.BackendHost(userData, (config, canStart) => diagnostics.ensureReady(config, canStart));
    const handlers = new Map(), listeners = new Map();
    const commands = { handle: (name, handler, role) => handlers.set(name, { handler, role }),
      publish: (channel, state) => { for (const listener of listeners.get(channel) ?? []) listener(null, state); } };
    const contacts = ports.installContactSessionBridge(commands, backend);
    const controller = ports.installMemoryBridge(commands, backend, contacts);
    const traces = ports.installTraceBridge(commands, backend, contacts);
    controller.onRecordDeletion((phase) => traces.recordDeletionChanged(phase));
    ports.installSourceDeletionBridge(commands, backend, contacts, async (contactId) => {
      traces.invalidateSource(); await controller.revalidateDeletedSource(contactId);
    });
    const transport = { invoke: (name, ...args) => Promise.resolve().then(() => handlers.get(name).handler(...args)),
      on: (name, listener) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
      removeListener: (name, listener) => listeners.get(name)?.delete(listener) };
    const memory = ports.createMemoryBridge(transport), source = ports.createSourceDeletionBridge(transport);
    const trace = ports.createTraceBridge(transport);
    const selection = () => ({ contactId: contacts.getState().selectedContactId, scopeRevision: contacts.getState().scopeRevision });
    try {
      await backend.connect();
      assert.equal(backend.getState().phase, 'connected');
      await contacts.refreshContacts();
      assert.equal(contacts.getState().directoryPhase, 'ready');
      if (selectInitialContact) {
        contacts.selectContact({ contactId: prepared.contactId, scopeRevision: contacts.getState().scopeRevision });
        await memory.refresh(selection()); await memory.refreshOverview(selection());
      }
      const proof = await fixture.command('runtime_proof');
      assert.equal(proof.environment_verified, true);
      assert.equal(proof.critical_module_count, 8);
      assert.ok(proof.loaded_module_count > 8);
      await run({ prepared, fixture, backend, contacts, controller, memory, source, trace, selection, proof });
      assert.equal((await fixture.command('runtime_proof')).model_calls, proof.model_calls, '概览读取与手动操作不增加模型调用。');
    } finally { diagnostics.cancel(); assert.equal(await backend.stop(), true); }
  }));
}
async function waitFor(read, check) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (check(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('本轮公开状态未在有限时段完成核对。');
}

test('真实HTTP与生产桥返回计划、经历、来源范围和手录；逐项过程可按实际来历回查', { timeout: 90_000 }, async () => {
  await withOverview(async ({ prepared, memory, trace, selection }) => {
    const state = await memory.getState();
    assert.equal(state.overview.phase, 'ready');
    assert.equal(state.overview.value.entries.length, 3);
    const old = state.overview.value.entries.find((entry) => entry.memory.memoryId === prepared.old.memory_id);
    const current = state.overview.value.entries.find((entry) => entry.memory.memoryId === prepared.current.memory_id);
    const manual = state.overview.value.entries.find((entry) => entry.memory.memoryId === prepared.manual.memory_id);
    assert.equal(old.memory.event.stage, 'planned');
    assert.equal(old.isLatest, false);
    assert.equal(old.currentLeaf.memoryId, current.memory.memoryId);
    assert.equal(current.memory.event.stage, 'occurred');
    assert.equal(current.memory.timing.sourceStartedAt, '2026-08-04T10:00:00+08:00');
    assert.equal(current.memory.timing.sourceEndedAt, '2026-08-05T12:00:00+08:00');
    assert.equal(current.memory.event.occurrenceStart, '2026-08-05T00:00:00+08:00');
    assert.deepEqual(new Set(current.provenance.references.map((item) => item.sourceId)),
      new Set([prepared.sourceToDelete, prepared.newSourceId]));
    assert.equal(manual.provenance.kind, 'manual_entry');
    assert.ok(!state.overview.value.entries.some((entry) => entry.memory.text === prepared.other.text));
    await trace.find({ ...selection(), resource: 'memory-traces', kind: 'contact_memory', recordId: current.memory.memoryId });
    assert.equal((await trace.getState()).availability, 'recorded');
    await trace.find({ ...selection(), resource: 'memory-traces', kind: 'contact_memory', recordId: manual.memory.memoryId });
    assert.equal((await trace.getState()).availability, 'not_applicable');
  });
});

test('真实人工修正重建概览，来源删除经原任务核验后清所有依赖版本并保留独立手录', { timeout: 90_000 }, async () => {
  await withOverview(async ({ prepared, memory, source, selection }) => {
    const active = (await memory.getState()).contact.items.find((item) => item.memoryId === prepared.current.memory_id);
    await memory.correct({ ...selection(), level: 'contact', memoryId: active.memoryId, revision: active.revision,
      text: '已参加读书会，并保留这次合成备注。', category: active.category });
    const corrected = await memory.getState();
    assert.equal(corrected.mutation.phase, 'success');
    const leaf = corrected.overview.value.entries.find((entry) => entry.isLatest && entry.memory.text === '已参加读书会，并保留这次合成备注。');
    assert.ok(leaf);
    assert.equal(leaf.memory.adoptionMethod, 'manual');
    assert.notEqual(corrected.overview.value.projectionRevision, prepared.overview.projection_revision);
    await source.refresh(selection());
    await source.delete({ ...selection(), sourceId: prepared.sourceToDelete });
    await waitFor(() => source.getState(), (state) => state.sources.some((entry) => entry.sourceId === prepared.sourceToDelete && entry.task?.status === 'succeeded'));
    const after = await waitFor(() => memory.getState(), (state) => state.overview.phase === 'ready');
    assert.deepEqual(after.overview.value.entries.map((entry) => entry.memory.memoryId), [prepared.manual.memory_id]);
    const afterTexts = after.overview.value.entries.map((entry) => entry.memory.text);
    for (const text of [prepared.old.text, prepared.current.text, leaf.memory.text]) assert.ok(!afterTexts.includes(text));
    assert.ok(afterTexts.includes(prepared.manual.text));
    await memory.refreshOverview(selection());
    assert.deepEqual((await memory.getState()).overview.value.entries.map((entry) => entry.memory.memoryId), [prepared.manual.memory_id]);
  });
});

test('真实联系人FK删除撤下概览；旧子进程清库退出后，新自有进程须重新确认范围', { timeout: 120_000 }, async () => {
  let previousSelection, previousPrepared, previousProof, previousChild;
  await withOverview(async ({ prepared, fixture, contacts, memory, selection, proof }) => {
    previousSelection = selection(); previousPrepared = prepared; previousProof = proof; previousChild = fixture.child;
    const removed = await fixture.command('remove_contact_fixture');
    assert.equal(removed.http_status, 404);
    await contacts.refreshContacts();
    assert.equal(contacts.getState().selectedContactId, null);
    assert.deepEqual((await memory.getState()).overview, { phase: 'idle', value: null });
    await assert.rejects(memory.refreshOverview(previousSelection), /范围已失效/);
  });
  assert.equal(previousChild.exitCode, 0);
  const evidenceDirectory = process.env.NOTALONE_OVERVIEW_TEST_EVIDENCE_DIR;
  assert.match(previousProof.evidence_file, /^overview-runtime-[a-f0-9]{32}\.json$/);
  const cleaned = JSON.parse(await readFile(path.join(evidenceDirectory, previousProof.evidence_file), 'utf8'));
  assert.equal(cleaned.phase, 'cleaned');
  assert.equal(cleaned.cleanup_confirmed, true);
  assert.equal(cleaned.database_remaining, false);

  // 新库、新服务子进程只验证公开投影恢复边界；同库持久投影恢复由后端生命周期场景验证。
  let nextProof, nextChild;
  await withOverview(async ({ prepared, fixture, contacts, memory, selection, proof }) => {
    nextProof = proof; nextChild = fixture.child;
    assert.notEqual(proof.child_pid, previousProof.child_pid);
    assert.notEqual(proof.database_name, previousProof.database_name);
    assert.notEqual(prepared.contactId, previousPrepared.contactId);
    assert.equal(contacts.getState().selectedContactId, null);
    assert.deepEqual((await memory.getState()).overview, { phase: 'idle', value: null });
    await assert.rejects(memory.refreshOverview(previousSelection), /范围已失效/);
    contacts.selectContact({ contactId: prepared.otherContactId, scopeRevision: contacts.getState().scopeRevision });
    await memory.refresh(selection()); await memory.refreshOverview(selection());
    const state = await memory.getState();
    assert.equal(state.overview.value.contactId, prepared.otherContactId);
    assert.deepEqual(state.overview.value.entries.map((entry) => entry.memory.text), [prepared.other.text]);
    const oldIds = new Set([previousPrepared.old.memory_id, previousPrepared.current.memory_id, previousPrepared.manual.memory_id]);
    assert.ok(state.overview.value.entries.every((entry) => !oldIds.has(entry.memory.memoryId)));
    assert.ok(!state.overview.value.entries.some((entry) => [previousPrepared.old.text, previousPrepared.manual.text]
      .includes(entry.memory.text)));
  }, { selectInitialContact: false });
  assert.equal(nextChild.exitCode, 0);
  assert.match(nextProof.evidence_file, /^overview-runtime-[a-f0-9]{32}\.json$/);
  const nextCleaned = JSON.parse(await readFile(path.join(evidenceDirectory, nextProof.evidence_file), 'utf8'));
  assert.equal(nextCleaned.cleanup_confirmed, true);
  assert.equal(nextCleaned.database_remaining, false);
});
