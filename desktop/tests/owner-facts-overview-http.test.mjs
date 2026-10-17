import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: `
  export { withOwnerFactsOverviewFixture } from './tests/owner-facts-overview-fixture';
  export { withControllerEnvironment } from './tests/headless/backend-fixture';
  export { BackendHost } from './src/main/backend/host';
  export { StartupDiagnostics } from './src/main/startup/diagnostics';
  export { installContactSessionBridge } from './src/main/contacts/bridge';
  export { installMemoryBridge } from './src/main/memory/bridge';
  export { createMemoryBridge } from './src/preload/memory';
  export { installSourceDeletionBridge } from './src/main/sources/bridge';
  export { createSourceDeletionBridge } from './src/preload/source-deletion';
  export * from './src/renderer/MemoryPage';
  export { renderToStaticMarkup } from 'react-dom/server';
  export { createElement } from 'react';
`, resolveDir: process.cwd() }, bundle: true, packages: 'external', jsx: 'automatic', platform: 'node', format: 'cjs',
  loader: { '.css': 'empty' }, write: false });
const compiledModule = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), compiledModule, compiledModule.exports);
const ports = compiledModule.exports;

async function withOverview(run, { selectInitialContact = true } = {}) {
  let proof, child;
  await ports.withOwnerFactsOverviewFixture(async (fixture) => ports.withControllerEnvironment(fixture, async (userData) => {
    const prepared = await fixture.command('owner_overview_prepared');
    const diagnostics = new ports.StartupDiagnostics(userData);
    const backend = new ports.BackendHost(userData, (config, canStart) => diagnostics.ensureReady(config, canStart));
    const handlers = new Map(), listeners = new Map();
    const commands = { handle: (name, handler, role) => handlers.set(name, { handler, role }),
      publish: (channel, state) => { for (const listener of listeners.get(channel) ?? []) listener(null, state); } };
    const contacts = ports.installContactSessionBridge(commands, backend);
    const controller = ports.installMemoryBridge(commands, backend, contacts);
    ports.installSourceDeletionBridge(commands, backend, contacts, (contactId) => controller.revalidateDeletedSource(contactId));
    const transport = { invoke: (name, ...args) => Promise.resolve().then(() => handlers.get(name).handler(...args)),
      on: (name, listener) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
      removeListener: (name, listener) => listeners.get(name)?.delete(listener) };
    const memory = ports.createMemoryBridge(transport), source = ports.createSourceDeletionBridge(transport);
    const selection = () => ({ contactId: contacts.getState().selectedContactId, scopeRevision: contacts.getState().scopeRevision });
    try {
      await backend.connect(); assert.equal(backend.getState().phase, 'connected');
      await contacts.refreshContacts(); assert.equal(contacts.getState().directoryPhase, 'ready');
      if (selectInitialContact) {
        contacts.selectContact({ contactId: prepared.contactId, scopeRevision: contacts.getState().scopeRevision });
        await memory.refresh(selection()); await memory.refreshOwnerOverview(selection());
      }
      proof = await fixture.command('runtime_proof'); child = fixture.child;
      assert.equal(proof.environment_verified, true); assert.equal(proof.critical_module_count, 9);
      assert.ok(proof.loaded_module_count > 9);
      await run({ prepared, fixture, backend, contacts, controller, memory, source, selection, proof });
      assert.equal((await fixture.command('runtime_proof')).model_calls, proof.model_calls);
    } finally { diagnostics.cancel(); assert.equal(await backend.stop(), true); }
  }));
  assert.equal(child.exitCode, 0);
  assert.match(proof.evidence_file, /^owner-overview-runtime-[a-f0-9]{32}\.json$/);
  const cleaned = JSON.parse(await readFile(path.join(process.env.NOTALONE_OWNER_OVERVIEW_TEST_EVIDENCE_DIR, proof.evidence_file), 'utf8'));
  assert.equal(cleaned.phase, 'cleaned'); assert.equal(cleaned.cleanup_confirmed, true); assert.equal(cleaned.database_remaining, false);
}
function render(state, contactId) {
  return ports.renderToStaticMarkup(ports.createElement(ports.OwnerFactsOverview, {
    overview: state.ownerOverview, memories: state.owner, contactId, refresh: async () => {}, openVersions: async () => {}, trace: () => {},
  }));
}
async function waitFor(read, check) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const value = await read(); if (check(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('本人公开状态未在有限时段完成核对。');
}

test('真实HTTP与生产桥只汇集SELF和独立本人手录，逐项原关系来源可在明确选择后核对', { timeout: 90_000 }, async () => {
  await withOverview(async ({ prepared, memory, source, contacts, selection }) => {
    const state = await memory.getState();
    assert.equal(state.ownerOverview.phase, 'ready'); assert.equal(state.ownerOverview.value.scopeKind, 'owner');
    assert.equal(state.ownerOverview.value.contactId, null); assert.equal(state.ownerOverview.value.entries.length, 4);
    const self = state.ownerOverview.value.entries.find((entry) => entry.memory.memoryId === prepared.self.memory_id);
    const otherSelf = state.ownerOverview.value.entries.find((entry) => entry.memory.memoryId === prepared.otherSelf.memory_id);
    assert.equal(self.memory.sourceCandidateId, prepared.self.source_candidate_id);
    assert.equal(self.provenance.references[0].contactId, prepared.contactId);
    assert.equal(self.provenance.references[0].locator, null);
    assert.equal(otherSelf.provenance.references[0].contactId, prepared.otherContactId);
    const html = render(state, prepared.contactId);
    assert.ok(!html.includes(prepared.privateContactText)); assert.ok(!html.includes(prepared.excludedText));
    assert.ok(html.includes(`查看本人概览提取过程：${prepared.self.text}`));
    assert.ok(!html.includes(`查看本人概览提取过程：${prepared.otherSelf.text}`));
    await source.refresh(selection());
    assert.ok((await source.getState()).sources.some((entry) => entry.sourceId === prepared.sourceToDelete));
    assert.ok(!(await source.getState()).sources.some((entry) => entry.sourceId === prepared.otherSourceId));
    contacts.selectContact({ contactId: prepared.otherContactId, scopeRevision: selection().scopeRevision });
    await memory.refresh(selection()); await memory.refreshOwnerOverview(selection()); await source.refresh(selection());
    assert.ok((await source.getState()).sources.some((entry) => entry.sourceId === prepared.otherSourceId));
    const after = render(await memory.getState(), prepared.otherContactId);
    assert.ok(!after.includes(`查看本人概览提取过程：${prepared.self.text}`));
    assert.ok(after.includes(`查看本人概览提取过程：${prepared.otherSelf.text}`));
    await memory.openVersions({ ...selection(), level: 'owner', memoryId: prepared.self.memory_id, revision: prepared.self.revision });
    assert.equal((await memory.getState()).history.items[0].memoryId, prepared.self.memory_id);
  });
});

test('真实本人修正保留来源与历史，资料删除及来源删除两序与重复操作均无法复活正文', { timeout: 120_000 }, async () => {
  for (const order of ['memory-first', 'source-first']) await withOverview(async ({ prepared, memory, source, fixture, selection }) => {
    await memory.correct({ ...selection(), level: 'owner', memoryId: prepared.self.memory_id, revision: prepared.self.revision,
      text: '本人明确更正为合成凉茶。', category: 'preference' });
    const corrected = await memory.getState(); assert.equal(corrected.mutation.phase, 'success');
    const current = corrected.owner.items.find((item) => item.text === '本人明确更正为合成凉茶。'); assert.ok(current);
    assert.notEqual(corrected.ownerOverview.value.projectionRevision, prepared.overview.projection_revision);
    await memory.openVersions({ ...selection(), level: 'owner', memoryId: current.memoryId, revision: current.revision });
    assert.deepEqual((await memory.getState()).history.items.map((item) => item.text), ['本人明确更正为合成凉茶。', prepared.self.text]);
    if (order === 'memory-first') {
      await memory.remove({ ...selection(), level: 'owner', memoryId: current.memoryId, revision: current.revision });
      assert.equal((await memory.getState()).mutation.phase, 'success');
      const repeatedBeforeSource = await fixture.request(`/api/memories/owner/${current.memoryId}/delete`, {});
      assert.equal(repeatedBeforeSource.status, 200);
    }
    await source.refresh(selection()); await source.delete({ ...selection(), sourceId: prepared.sourceToDelete });
    await waitFor(() => source.getState(), (state) => state.sources.some((entry) => entry.sourceId === prepared.sourceToDelete && entry.task?.status === 'succeeded'));
    await waitFor(() => memory.getState(), (state) => state.ownerOverview.phase === 'ready');
    await memory.refreshOwnerOverview(selection());
    const after = await memory.getState();
    const html = render(after, prepared.contactId);
    assert.ok(!html.includes(prepared.self.text)); assert.ok(!html.includes(current.text));
    assert.ok(html.includes(prepared.manualFact.text)); assert.ok(html.includes(prepared.manualPreference.text)); assert.ok(html.includes(prepared.otherSelf.text));
    await assert.rejects(memory.remove({ ...selection(), level: 'owner', memoryId: current.memoryId, revision: current.revision }), /版本已失效/);
    const repeated = await fixture.request(`/api/memories/owner/${current.memoryId}/delete`, {});
    // 来源清理会物理清除依赖的无正文删除记录；不能把资料删除的重复成功外推到已清库的旧ID。
    assert.equal(repeated.status, 404);
    await memory.refreshOwnerOverview(selection()); assert.ok(!render(await memory.getState(), prepared.contactId).includes(current.text));
  });
});

test('真实目录移除和断连恢复清本人缓存，新自有进程不恢复旧投影或旧管理范围', { timeout: 120_000 }, async () => {
  let previousSelection, previousPrepared, previousProof;
  await withOverview(async ({ prepared, fixture, memory, contacts, selection, proof }) => {
    previousSelection = selection(); previousPrepared = prepared; previousProof = proof;
    assert.equal((await fixture.command('remove_contact_fixture')).http_status, 404);
    await contacts.refreshContacts(); assert.equal(contacts.getState().selectedContactId, null);
    assert.deepEqual((await memory.getState()).ownerOverview, { phase: 'idle', value: null });
    await assert.rejects(memory.refreshOwnerOverview(previousSelection), /范围已失效/);
  });
  // 新库、新子进程只验证界面恢复；同库持久恢复由后端公开生命周期方法承担。
  await withOverview(async ({ prepared, memory, contacts, selection, proof }) => {
    assert.notEqual(proof.child_pid, previousProof.child_pid); assert.notEqual(proof.database_name, previousProof.database_name);
    assert.equal(contacts.getState().selectedContactId, null);
    assert.deepEqual((await memory.getState()).ownerOverview, { phase: 'idle', value: null });
    await assert.rejects(memory.refreshOwnerOverview(previousSelection), /范围已失效/);
    contacts.selectContact({ contactId: prepared.otherContactId, scopeRevision: selection().scopeRevision });
    await memory.refresh(selection()); await memory.refreshOwnerOverview(selection());
    const oldIds = new Set([previousPrepared.self.memory_id, previousPrepared.otherSelf.memory_id, previousPrepared.manualFact.memory_id, previousPrepared.manualPreference.memory_id]);
    assert.ok((await memory.getState()).ownerOverview.value.entries.every((entry) => !oldIds.has(entry.memory.memoryId)));
  }, { selectInitialContact: false });
});
