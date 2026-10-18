import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const id = '10000000-0000-4000-8000-000000000001';
const bundle = await build({ stdin: { contents: `
 export { installForegroundBridge } from './src/main/foreground/bridge';
 export { createForegroundBridge } from './src/preload/foreground';
 export { ForegroundPanel } from './src/renderer/ForegroundPanel';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
 banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const dir = await mkdtemp(path.join(tmpdir(), 'notalone-manual-resume-'));
await writeFile(path.join(dir, 'ports.mjs'), bundle.outputFiles[0].text);
const ports = await import(path.join(dir, 'ports.mjs'));
test.after(() => rm(dir, { recursive: true }));

function fixture(t) {
 const state = { contacts: [{ contactId: id, displayName: '合成联系人' }], selectedContactId: id,
  scopeRevision: 1, directoryPhase: 'ready', draft: '保留的合成草稿' };
 const handlers = new Map(), roles = new Map(), scheduled = new Map(); let sequence = 0, manual = false;
 let observation;
 const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {},
  confirmManualInput: () => { manual = true; }, clearManualInput: () => { manual = false; },
  requestJson: async request => request.path.endsWith('/manual-confirmation') ? { generation: 1 }
   : observation ? observation(request) : { generation: 1, data: { observation_id: id,
    observed_at: new Date().toISOString(), phase: 'paused', reason: 'wechat_not_in_front',
    probe_available: true, wechat_in_front: false, binding_id: null, contact_id: null } } };
 const contacts = { getState: () => ({ ...state }), onStateChanged: () => () => {},
  selectContact: selection => { assert.equal(selection.contactId, id); return { ...state }; } };
 const foreground = ports.installForegroundBridge({ handle: (name, handler, role) => {
  handlers.set(name, handler); roles.set(name, role); }, publish: () => {} }, backend, contacts);
 // 注入合成时钟，只触发宿主已有调度，不等待或运行原生探针。
 foreground.clock = { schedule: (callback, delay) => { callback.delayMs = delay; const key = ++sequence; scheduled.set(key, callback); return key; },
  cancel: key => scheduled.delete(key) };
 t.after(() => foreground.dispose());
 const bridge = ports.createForegroundBridge({ invoke: async (name, ...args) => handlers.get(name)(...args),
  on: () => {}, removeListener: () => {} });
 const selection = () => ({ contactId: id, contactScopeRevision: 1,
  foregroundRevision: foreground.getState().foregroundRevision });
 const enterManual = () => handlers.get('contacts:confirm-manual')({ contactId: id, scopeRevision: 1 });
 return { foreground, bridge, handlers, roles, scheduled, state, selection, enterManual,
  isManual: () => manual, setObservation: value => { observation = value; } };
}
function buttons(node) {
 if (!node || typeof node !== 'object') return [];
 return [...(node.type === 'button' ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(buttons)];
}

test('手动确认后通过公开恢复按钮退出手动模式，保留草稿与聚焦暂停', async t => {
 const f = fixture(t); f.foreground.startContinuous(); f.foreground.notifyHelperLifecycle('focused');
 await f.enterManual(); assert.equal(f.isManual(), true);
 let pending;
 const session = { state: f.state, resumeForeground: revision => {
  pending = f.bridge.resume({ ...f.selection(), foregroundRevision: revision }); return pending; } };
 const panel = ports.ForegroundPanel({ state: f.foreground.getState(), session, manualInput: false });
 const resume = buttons(panel).find(button => button.props.children === '恢复微信会话识别');
 assert.ok(resume, '回应消息界面应提供可点击恢复入口');
 resume.props.onClick(); await pending;
 assert.equal(f.roles.get('foreground:resume'), 'helper');
 assert.equal(f.foreground.getState().manualInput, false);
 assert.equal(f.foreground.getGenerationBlock(), 'foreground-confirmation-required');
 assert.equal(f.isManual(), false);
 assert.equal(f.state.draft, '保留的合成草稿'); assert.equal(f.state.selectedContactId, id);
 assert.equal(f.scheduled.size, 0, '助手获焦时不能启动观察');
 f.foreground.notifyHelperLifecycle('blurred'); assert.equal(f.scheduled.size, 1);
});

test('受管模式和改写输入均可主动恢复识别，过期确认不得恢复', async t => {
 const f = fixture(t); await f.enterManual();
 for (const options of [{ manualRelease: true }, { manualInput: true }]) {
  const panel = ports.ForegroundPanel({ state: f.foreground.getState(), session: { state: f.state }, ...options });
  assert.equal(buttons(panel).some(button => button.props.children === '恢复微信会话识别'), true);
 }
 for (const change of [{ contactScopeRevision: 0 }, { foregroundRevision: -1 },
   { contactId: '20000000-0000-4000-8000-000000000002' }, { extra: true }]) {
  await assert.rejects(f.bridge.resume({ ...f.selection(), ...change }));
  assert.equal(f.foreground.getState().manualInput, true); assert.equal(f.isManual(), true);
 }
});

test('恢复后丢弃手动确认前的在途观察，不沿用旧生成资格', async t => {
 const f = fixture(t); let resolve;
 f.setObservation(() => new Promise(done => { resolve = done; }));
 const old = f.foreground.observeBeforeShow(); await f.enterManual();
 await f.bridge.resume(f.selection());
 resolve({ generation: 1, data: { observation_id: id, observed_at: new Date().toISOString(),
  phase: 'confirmed', reason: 'confirmed_active_binding', probe_available: true,
  wechat_in_front: true, binding_id: id, contact_id: id } });
 await old;
 assert.equal(f.foreground.getState().manualInput, false);
 assert.equal(f.foreground.getState().recognizedName, null);
 assert.equal(f.foreground.getGenerationBlock(), 'foreground-confirmation-required');
});


test('前台识别说明等待微信或同步关闭，保留切回手动入口', () => {
 const session = {state:{selectedContactId:id, contacts:[]}};
 for (const [reason, expected] of [['wechat_not_in_front', '等待微信切到前台'], ['sync_disabled', '同步总开关已关闭']]) {
  const panel = ports.ForegroundPanel({state:{phase:'paused', reason}, session});
  assert.match(JSON.stringify(panel), new RegExp(expected));
  assert.ok(buttons(panel).some(button => button.props.children === '切换为手动输入'));
 }
});


test('恢复后微信可靠观察授予资格，进入助手暂停采集但仍可使用该联系人', async t => {
 const f = fixture(t); f.foreground.startContinuous(); f.foreground.notifyHelperLifecycle('focused');
 await f.enterManual(); await f.bridge.resume(f.selection());
 let observations = 0;
 f.setObservation(async () => { observations += 1; return { generation: 1, data: {
  observation_id: id, observed_at: new Date().toISOString(), phase: 'confirmed',
  reason: 'confirmed_active_binding', probe_available: true, wechat_in_front: true,
  binding_id: id, contact_id: id } }; });
 f.foreground.notifyHelperLifecycle('blurred');
 const [key, observe] = f.scheduled.entries().next().value; f.scheduled.delete(key);
 await observe();
 assert.equal(observations, 1);
 assert.equal(f.foreground.getState().confirmedContactId, id);
 assert.equal(f.foreground.getGenerationBlock(), null);
 f.foreground.notifyHelperLifecycle('focused');
 assert.equal(f.foreground.getState().reason, 'helper_focused');
 assert.equal(f.foreground.getState().confirmedContactId, id, '正常打开助手必须保留刚确认的联系人');
 assert.equal(f.foreground.getGenerationBlock(), null, '助手暂停采集不应禁用已确认联系人的生成');
 await f.foreground.observeBeforeShow();
 assert.equal(observations, 1, '助手在前台不额外采集微信');
 assert.equal(f.scheduled.size, 0);
});


test('群聊暂停进入助手再离开后立即复查私聊，重复失焦不取消在途观察', async t => {
 const f = fixture(t); f.foreground.startContinuous();
 const response = (phase, reason, contactId) => ({ generation: 1, data: {
  observation_id: id, observed_at: new Date().toISOString(), phase, reason,
  probe_available: true, wechat_in_front: true, binding_id: contactId, contact_id: contactId } });
 f.setObservation(async () => response('paused', 'group_chat_unsupported', null));
 await f.foreground.observeBeforeShow();
 assert.equal(f.foreground.getState().unsupportedConversation, true);
 f.foreground.notifyHelperLifecycle('focused'); f.foreground.notifyHelperLifecycle('blurred');
 const [key, observe] = f.scheduled.entries().next().value;
 assert.equal(observe.delayMs, 0, '真正离开助手时不再多等两秒');
 f.scheduled.delete(key);
 let release; f.setObservation(() => new Promise(resolve => { release = resolve; }));
 const pending = observe();
 f.foreground.notifyHelperLifecycle('blurred');
 release(response('confirmed', 'confirmed_active_binding', id)); await pending;
 assert.equal(f.foreground.getState().unsupportedConversation, false);
 assert.equal(f.foreground.getGenerationBlock(), null);
});


test('真正离开助手也保留技术失败退避与手动模式门禁', async t => {
 const f = fixture(t); f.foreground.startContinuous();
 f.setObservation(async () => ({ generation: 1, data: { observation_id: id,
  observed_at: new Date().toISOString(), phase: 'unavailable', reason: 'probe_timeout',
  probe_available: false, wechat_in_front: false, binding_id: null, contact_id: null } }));
 await f.foreground.observeBeforeShow();
 f.foreground.notifyHelperLifecycle('focused'); f.foreground.notifyHelperLifecycle('blurred');
 assert.equal(f.scheduled.values().next().value.delayMs, 4000);
 f.foreground.notifyHelperLifecycle('focused'); await f.enterManual();
 f.foreground.notifyHelperLifecycle('blurred');
 assert.equal(f.scheduled.size, 0, '手动输入仍不观察');
});


test('离开助手的立即复查等待旧传输结算，不与旧观察并发', async t => {
 const f = fixture(t); f.foreground.startContinuous();
 let release; f.setObservation(() => new Promise(resolve => { release = resolve; }));
 const pending = f.foreground.observeBeforeShow();
 f.foreground.notifyHelperLifecycle('focused'); f.foreground.notifyHelperLifecycle('blurred');
 assert.equal(f.scheduled.size, 0, '旧传输未结算时不能发起新观察');
 release({ generation: 1, data: { observation_id: id, observed_at: new Date().toISOString(),
  phase: 'confirmed', reason: 'confirmed_active_binding', probe_available: true,
  wechat_in_front: true, binding_id: id, contact_id: id } });
 await pending;
 assert.equal(f.foreground.getState().confirmedContactId, null, '迟到结果不得授予资格');
 assert.equal(f.scheduled.values().next().value.delayMs, 0);
});

function observationResponse(phase, reason, contactId = null) {
 return { generation: 1, data: { observation_id: id, observed_at: new Date().toISOString(), phase, reason,
  probe_available: phase !== 'unavailable', wechat_in_front: phase !== 'unavailable', binding_id: contactId, contact_id: contactId } };
}

test('未绑定只限制当轮并明确提示选择，返回可靠绑定私聊无需清除旧人工门', async t => {
 const f = fixture(t);
 f.setObservation(async () => observationResponse('confirmed', 'confirmed_active_binding', id));
 await f.foreground.observeBeforeShow();assert.equal(f.foreground.getGenerationBlock(), null);
 f.setObservation(async () => observationResponse('manual-required', 'unmatched_requires_selection'));
 await f.foreground.observeBeforeShow();
 assert.notEqual(f.foreground.getGenerationBlock(), null, '未绑定当前帧不能使用旧私聊资格');
 const panel = ports.ForegroundPanel({ state: f.foreground.getState(), session: { state: f.state } });

 f.setObservation(async () => observationResponse('paused', 'group_chat_unsupported'));
 await f.foreground.observeBeforeShow();assert.equal(f.foreground.getState().unsupportedConversation, true);
 assert.match(JSON.stringify(ports.ForegroundPanel({ state: f.foreground.getState(), session: { state: f.state } })), /群聊暂不支持/);
 f.setObservation(async () => observationResponse('confirmed', 'confirmed_active_binding', id));
 await f.foreground.observeBeforeShow();
 assert.equal(f.foreground.getState().unsupportedConversation, false);
 assert.equal(f.foreground.getGenerationBlock(), null);
 assert.match(JSON.stringify(panel), /当前会话未匹配到已确认绑定，请在上方选择联系人/);
});

test('低置信度、歧义或技术失败的人工门不会被随后未绑定和群聊抹除', async t => {
 for (const [phase, reason] of [['manual-required', 'ambiguous_requires_selection'],
  ['manual-required', 'quality_unverified'], ['unavailable', 'probe_timeout']]) {
  const f = fixture(t);
  f.setObservation(async () => observationResponse(phase, reason));await f.foreground.observeBeforeShow();
  f.setObservation(async () => observationResponse('manual-required', 'unmatched_requires_selection'));await f.foreground.observeBeforeShow();
  f.setObservation(async () => observationResponse('paused', 'group_chat_suspected'));await f.foreground.observeBeforeShow();
  f.setObservation(async () => observationResponse('confirmed', 'confirmed_active_binding', id));await f.foreground.observeBeforeShow();
  assert.equal(f.foreground.getState().reason, 'manual_confirmation_required');
  assert.notEqual(f.foreground.getGenerationBlock(), null);
 }
});
