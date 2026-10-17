import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { installMemoryBridge } from './src/main/memory/bridge';
  export { createMemoryBridge } from './src/preload/memory';
  export { BackendRequestFailure } from './src/main/backend/json-client';
`, resolveDir: process.cwd() }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false });
const compiledModule = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), compiledModule, compiledModule.exports);
const ports = compiledModule.exports;
export const BackendRequestFailure = ports.BackendRequestFailure;
export const ids = { contact: '11111111-1111-4111-8111-111111111111', other: '99999999-9999-4999-8999-999999999999',
  scenario: '22222222-2222-4222-8222-222222222222', version: '33333333-3333-4333-8333-333333333333', memory: '44444444-4444-4444-8444-444444444444' };
export function payload(overrides = {}) {
  return { layered_memory: { schema_version: 1, scope_kind: 'contact', contact_id: ids.contact,
    settings_generation: 0, enabled: false, quality_status: 'unknown', status: 'disabled',
    eligible_count: 3, covered_count: 0, remaining_count: 3, organization_generation: 0,
    updated_at: null, error_code: null, purpose: '从本联系人合法已采纳记忆整理主题背景，供核对及后续回复使用。',
    budget: { max_memories: 0, max_scenarios: 0, max_paragraphs: 0, max_characters: 0, max_model_calls: 0 }, scenarios: [], ...overrides } };
}
export async function fixture(requestJson) {
  let generation = 1;
  const backendListeners = new Set();
  const backend = { getConnectionGeneration: () => generation, requestJson,
    onStateChanged: (listener) => { backendListeners.add(listener); return () => backendListeners.delete(listener); } };
  const contacts = new ports.ContactSession(async () => ({ generation,
    contacts: [ids.contact, ids.other].map((contactId) => ({ contactId, displayName: '合成主题联系人', messageCount: 0, sourceCount: 0 })) }));
  contacts.setConnection(generation); await contacts.refreshContacts();
  contacts.selectContact({ contactId: ids.contact, scopeRevision: contacts.getState().scopeRevision });
  const handlers = new Map(), listeners = new Map();
  const controller = ports.installMemoryBridge({ handle: (name, handler, role) => handlers.set(name, { handler, role }),
    publish: (channel, state) => { for (const listener of listeners.get(channel) ?? []) listener(null, state); } }, backend, contacts);
  const bridge = ports.createMemoryBridge({ invoke: (name, ...args) => Promise.resolve().then(() => handlers.get(name).handler(...args)),
    on: (name, listener) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeListener: (name, listener) => listeners.get(name)?.delete(listener) });
  const selection = () => ({ contactId: contacts.getState().selectedContactId, scopeRevision: contacts.getState().scopeRevision });
  return { controller, contacts, bridge, handlers, selection, disconnect: () => { generation = undefined;
    contacts.setConnection(undefined); for (const listener of backendListeners) listener({}); } };
}

export function readyPayload(overrides = {}) {
  return payload({ enabled: true, settings_generation: 1, quality_status: 'synthetic', status: 'ready',
    covered_count: 2, remaining_count: 1, organization_generation: 1, updated_at: '2026-10-17T10:00:00+08:00',
    budget: { max_memories: 2, max_scenarios: 2, max_paragraphs: 3, max_characters: 500, max_model_calls: 2 },
    scenarios: [{ scenario_id: ids.scenario, version_id: ids.version, title: '合成读书计划', hint: '讨论中的长期读书安排', system_generated: true,
      updated_at: '2026-10-17T10:00:00+08:00', paragraphs: [{ text: '曾计划参加合成读书会，当前是否成行尚未核实。', references: [{
        memory_id: ids.memory, revision: 1, provenance_kind: 'manual_entry', timing: { recorded_at: '2026-10-16T10:00:00+08:00',
          source_started_at: null, source_ended_at: null, source_time_complete: false,
          current_status: 'current_unverified', current_status_reason: '旧安排没有新的来源核实。' },
      }] }] }], ...overrides });
}
