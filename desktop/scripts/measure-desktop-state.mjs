// 仅合成数据和内存适配器；JSON 字节为传输体量代理，不代表 IPC 延迟或 RSS。
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

const baselineRef = process.argv[2] ?? '681fcc38eab77c8fe149b76705419971f3750a86';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sha = value => createHash('sha256').update(value).digest('hex');
const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const contactId = uuid(1);
const bytes = value => Buffer.byteLength(JSON.stringify(value));
async function compile(ref) {
  const result = await build({ stdin: { contents: `
    export { installContactSessionBridge } from './src/main/contacts/bridge';
    export { ContactSession } from './src/main/contacts/session';
    export { MemoryReadingController } from './src/main/memory/controller';
    export { OwnerLayeredMemoryController } from './src/main/memory/owner-layered';
    export { SkillLearningController } from './src/main/skill-learning/controller';
    export * from './src/shared/contact-session-bridge';
  `, resolveDir: process.cwd() }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false,
    plugins: ref ? [{ name: 'fixed-baseline', setup(builder) {
      builder.onLoad({ filter: /\/src\/.*\.tsx?$/ }, ({ path: file }) => ({
        contents: execFileSync('git', ['show', `${ref}:desktop/${path.relative(process.cwd(), file)}`], { encoding: 'utf8' }), loader: 'ts',
      }));
    } }] : [] });
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
  return loaded.exports;
}
const base = await compile(baselineRef), candidate = await compile();
async function drafts(ports, count) {
  const handlers = new Map();
  let eventBytes = 0, responseBytes = 0, events = 0, state;
  const receive = ports.createContactSessionReceiver?.() ?? ((_previous, next) => next);
  const directory = Array.from({ length: count }, (_, n) => ({ contact_id: uuid(n + 1), display_name: `合成联系人${n}`,
    data_status: { message_count: n, source_count: 1 } }));
  const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {}, requestJson: async ({ path }) => ({ generation: 1,
    data: path === '/api/setup/status' ? { runtime_owner_configured: true } : { contacts: directory } }) };
  const session = ports.installContactSessionBridge({ handle: (name, handler) => handlers.set(name, handler), publish: (_name, update) => {
    if (!state) return;
    state = receive(state, update); eventBytes += 2 * bytes(update); ++events;
  } }, backend);
  await session.refreshContacts();
  state = session.selectContact({ contactId, scopeRevision: session.getState().scopeRevision });
  const selection = { contactId, scopeRevision: state.scopeRevision };
  for (let n = 1; n <= 100; n++) {
    const response = handlers.get('contacts:set-draft')({ ...selection, text: '合成草稿'.repeat(Math.ceil(n / 4)).slice(0, n) });
    responseBytes += bytes(response); state = receive(state, response);
    assert.deepEqual(state, session.getState());
  }
  return { contacts: count, events, eventJsonBytesForTwoWindows: eventBytes, responseJsonBytes: responseBytes,
    totalJsonBytes: eventBytes + responseBytes, everyStateEquivalent: true };
}
const memoryPayload = scope => ({ layered_memory: { schema_version: 2, scope_kind: scope, contact_id: scope === 'owner' ? null : contactId,
  settings_generation: 1, enabled: true, quality_status: 'unknown', runtime_policy: 'verified_items', status: 'ready',
  eligible_count: 0, covered_count: 0, remaining_count: 0, organization_generation: 1, work_id: null, work_revision: 0, current_batch: 0,
  model_calls_used: 0, model_call_limit: 0, maintenance_pending: false, scenario_mappings: [], mapping_cursor: null, mapping_next_cursor: null,
  updated_at: null, error_code: null, purpose: '合成资料', scenarios: [], profile: null,
  budget: { max_memories: 0, max_scenarios: 0, max_paragraphs: 0, max_characters: 0, max_model_calls: 0, model_calls_used: 0, model_calls_remaining: 0 } } });
async function memory(ports, scope) {
  const saved = { setTimeout, clearTimeout }, timers = new Set();
  globalThis.setTimeout = fn => { const timer = { fn, unref() {} }; timers.add(timer); return timer; };
  globalThis.clearTimeout = timer => timers.delete(timer);
  try {
    let requests = 0, publishes = 0, jsonBytes = 0;
    const backend = { getConnectionGeneration: () => 1, requestJson: async () => { ++requests; return { generation: 1, data: memoryPayload(scope) }; } };
    const contacts = new ports.ContactSession(async () => ({ generation: 1,
      contacts: [{ contactId, displayName: '合成联系人', messageCount: 0, sourceCount: 0 }] }));
    contacts.setConnection(1); await contacts.refreshContacts();
    contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
    const selection = { contactId, scopeRevision: contacts.getState().scopeRevision };
    const publish = state => { ++publishes; jsonBytes += bytes(state); };
    const controller = scope === 'owner' ? new ports.OwnerLayeredMemoryController(backend, publish, () => {})
      : new ports.MemoryReadingController(backend, contacts);
    if (scope === 'contact') controller.onStateChanged(publish);
    const read = () => scope === 'owner' ? controller.read({}) : controller.readLayeredMemory(selection);
    await read();
    if (scope === 'owner') controller.releaseView?.(); else controller.releaseLayeredMemory?.(selection);
    requests = publishes = jsonBytes = 0;
    for (let i = 0; i < 60; i++) {
      const due = [...timers]; timers.clear(); for (const timer of due) timer.fn();
      for (let turn = 0; turn < 30; turn++) await Promise.resolve();
    }
    const hidden = { requests, publishes, jsonBytes, pendingTimers: timers.size };
    await read();
    const afterReentry = controller.getState(); delete afterReentry.revision;
    return { hidden, afterReentry };
  } finally { Object.assign(globalThis, saved); }
}
const skill = (n, changed) => ({ skill_id: uuid(n + 100), name: '合成方法', status: 'active', revision: 1,
  current_version_id: uuid(n * 10 + 200), versions: Array.from({ length: 5 }, (_, j) => ({ version_id: uuid(n * 10 + 200 + j),
    version_number: j + 1, document: '合成方法正文。'.repeat(160) + (changed ? '变更' : ''), is_current: j === 0, enabled: true,
    scope: { kind: 'contact', contact_id: contactId, scene: null }, methods: [], source_dependency_count: 1 })) });
async function learning(ports, mode) {
  let changed = false, failed = false, requests = 0, publishes = 0, jsonBytes = 0;
  const contacts = { onStateChanged: () => () => {}, getState: () => ({ selectedContactId: contactId, scopeRevision: 1,
    directoryPhase: 'ready', contacts: [{ contactId }] }) };
  const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {}, requestJson: async request => {
    ++requests; if (failed) throw new Error('合成断连');
    return { generation: 1, data: request.path.endsWith('/skills') ? { skills: Array.from({ length: 25 }, (_, n) => skill(n, changed)) }
      : { enabled: false, scope_revision: 1, drafts: [], task: null, recent_outcomes: [] } };
  } };
  const controller = new ports.SkillLearningController(backend, contacts), selection = { contactId, scopeRevision: 1 };
  await controller.refresh(selection); await controller.openHistory(selection);
  controller.onStateChanged(state => { ++publishes; jsonBytes += bytes(state); }); requests = 0;
  const states = [];
  for (let i = 0; i < 20; i++) {
    if (i === 10 && mode === 'changed') changed = true;
    if (i === 10 && mode === 'failed') failed = true;
    await controller.poll(selection);
    const state = controller.getState(); delete state.revision; states.push(state);
  }
  return { requests, publishes, jsonBytes, states };
}
const result = { baseline: git('rev-parse', baselineRef), candidateHead: git('rev-parse', 'HEAD'), node: process.version,
  inputSummary: { drafts: '10/100/1000联系人，每组100次1–100字符输入，双窗口事件加invoke回包', memory: 'contact/owner各60轮模拟调度',
    learning: '25个Skill各5版本，每份1120字符，20轮复验；第11轮（索引10）变化或失败' }, drafts: [], memory: [], learning: [] };
result.inputSha256 = sha(JSON.stringify(result.inputSummary));
const files = ['src/main/contacts/session.ts', 'src/main/contacts/bridge.ts', 'src/shared/contact-session-bridge.ts',
  'src/main/memory/controller.ts', 'src/main/memory/owner-layered.ts', 'src/main/skill-learning/controller.ts'];
result.sourceSha256 = Object.fromEntries(files.map(file => [file, { baseline: sha(execFileSync('git', ['show', `${baselineRef}:desktop/${file}`])),
  candidate: sha(readFileSync(file)) }]));
for (const count of [10, 100, 1000]) result.drafts.push({ before: await drafts(base, count), after: await drafts(candidate, count) });
for (const scope of ['contact', 'owner']) {
  const before = await memory(base, scope), after = await memory(candidate, scope);
  assert.deepEqual(before.afterReentry, after.afterReentry);
  result.memory.push({ scope, before: before.hidden, after: after.hidden, reentryEquivalent: true });
}
for (const mode of ['stable', 'changed', 'failed']) {
  const before = await learning(base, mode), after = await learning(candidate, mode);
  assert.deepEqual(before.states, after.states);
  result.learning.push({ mode, before: { ...before, states: undefined }, after: { ...after, states: undefined }, everyStateEquivalent: true });
}
result.limitations = ['未启动实际App/微信/数据库或外部模型', '模拟调度次数和JSON字节不等于延迟、CPU或RSS',
  '联系人主进程内部订阅仍可克隆完整目录；Skill后端GET次数保持不变'];
console.log(JSON.stringify(result, null, 2));
