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
 export { foregroundObservation } from './src/main/foreground/observation';
 export { BackendRequestFailure } from './src/main/backend/json-client';
 export { ContactSession } from './src/main/contacts/session';
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

test('账号验证失效、识别服务失败和连接中断分别提示真实恢复方式', async t => {
 for (const [failure, reason, expected] of [
  [new ports.BackendRequestFailure('response', 503, 'foreground_scope_unavailable'), 'foreground_scope_unavailable', /微信账号尚未连接或验证已失效.*同步设置/],
  [new ports.BackendRequestFailure('response', 503, 'foreground_observation_unavailable'), 'foreground_observation_unavailable', /微信会话识别服务暂不可用.*重试/],
  [new ports.BackendRequestFailure('response', 504, 'observation_timeout'), 'observation_timeout', /本轮观察超时.*重试/],
  [new ports.BackendRequestFailure('connection'), 'observation_unavailable', /与本机服务的连接中断.*重试/],
 ]) {
  const f = fixture(t);
  f.setObservation(async () => { throw failure; });
  await f.foreground.observeBeforeShow();
  const state = f.foreground.getState();
  assert.equal(state.phase, 'unavailable');
  assert.equal(state.reason, reason);
  assert.notEqual(f.foreground.getGenerationBlock(), null);
  const panel = JSON.stringify(ports.ForegroundPanel({ state, session: { state: f.state } }));
  assert.match(panel, expected);
  assert.doesNotMatch(panel, /请手动选择本次联系人/);
  f.foreground.notifyHelperLifecycle('focused');
  const focused = f.foreground.getState();
  assert.equal(focused.suspendedByHelperFocus, true);
  assert.equal(focused.reason, reason);
  assert.match(JSON.stringify(ports.ForegroundPanel({ state: focused, session: { state: f.state } })), expected);
 }
});

test('未知后端错误仅发布固定识别服务失败，不泄漏任意原因或冒充传输失败', async t => {
 const f = fixture(t);
 f.setObservation(async () => { throw new ports.BackendRequestFailure('response', 503, 'private_internal_error'); });
 await f.foreground.observeBeforeShow();
 assert.equal(f.foreground.getState().reason, 'foreground_observation_unavailable');
 const panel = JSON.stringify(ports.ForegroundPanel({ state: f.foreground.getState() }));
 assert.doesNotMatch(panel, /private_internal_error|传输失败|连接中断/);
});

test('权限恢复在小窗获焦时不采集，显式选人不增加暂停模式', async t => {
 const f=fixture(t),calls=[];
 f.foreground.notifyHelperLifecycle('focused'); await f.enterManual();
 f.setObservation(async request=>{calls.push(request.path);return {generation:1,data:{ok:true}};});
 await f.foreground.screenPermissionRestored();
 assert.deepEqual(calls,['/api/sync/foreground/permission-restored']);
 assert.equal(f.foreground.getState().confirmation,'manual-confirmed');
 assert.equal(Object.hasOwn(f.foreground.getState(),'manualInput'),false);
});

test('显式选择只确认本次联系人，保留草稿并在离开小窗后立即继续观察', async t => {
 const f = fixture(t); f.foreground.startContinuous(); f.foreground.notifyHelperLifecycle('focused');
 await f.enterManual(); assert.equal(f.isManual(), true);
 const panel = ports.ForegroundPanel({ state: f.foreground.getState(), session: { state: f.state } });
 assert.doesNotMatch(JSON.stringify(panel), /手动输入模式|恢复微信会话识别|切换为手动输入/);
 assert.match(JSON.stringify(panel), /本次联系人已由你选择.*切回微信后自动识别/);
 assert.equal(f.foreground.getGenerationBlock(), null);
 assert.equal(f.state.draft, '保留的合成草稿'); assert.equal(f.state.selectedContactId, id);
 assert.equal(f.scheduled.size, 0, '助手获焦时不能启动观察');
 f.foreground.notifyHelperLifecycle('blurred'); assert.equal(f.scheduled.size, 1);
 assert.equal(f.scheduled.values().next().value.delayMs, 0, '无需恢复操作即可立即复查');
 assert.equal(f.roles.has('foreground:resume'), false);
 assert.equal('resume' in f.bridge, false);
});

test('过期或越界的本次联系人选择不能取得资格', async t => {
 for (const change of [{ scopeRevision: 0 }, { contactId: '20000000-0000-4000-8000-000000000002' }, { extra: true }]) {
  const f = fixture(t);
  await assert.rejects(f.handlers.get('contacts:confirm-manual')({ contactId: id, scopeRevision: 1, ...change }));
  assert.notEqual(f.foreground.getGenerationBlock(), null);
  assert.equal(f.isManual(), false);
 }
});

test('显式选择丢弃此前在途观察，不把迟到结果当成新的微信识别', async t => {
 const f = fixture(t); let resolve;
 f.setObservation(() => new Promise(done => { resolve = done; }));
 const old = f.foreground.observeBeforeShow(); await f.enterManual();
 resolve({ generation: 1, data: { observation_id: id, observed_at: new Date().toISOString(),
  phase: 'confirmed', reason: 'confirmed_active_binding', probe_available: true,
  wechat_in_front: true, binding_id: id, contact_id: id } });
 await old;
 assert.equal(f.foreground.getState().recognizedName, null);
 assert.equal(f.foreground.getState().confirmation, 'manual-confirmed');
 assert.equal(f.foreground.getGenerationBlock(), null);
 assert.equal(f.isManual(), true, '迟到的旧观察不得清除用户后来的明确选择');
});

test('等待微信或同步关闭时说明实际状态，不提供模式切换按钮', () => {
 const session = {state:{selectedContactId:id, contacts:[]}};
 for (const [reason, expected] of [['wechat_not_in_front', '等待微信切到前台'], ['sync_disabled', '同步总开关已关闭']]) {
  const panel = ports.ForegroundPanel({state:{phase:'paused', reason}, session});
  assert.match(JSON.stringify(panel), new RegExp(expected));
  assert.doesNotMatch(JSON.stringify(buttons(panel)), /切换为手动输入|恢复微信会话识别/);
 }
});

test('选人后微信可靠观察授予资格，进入助手暂停采集但仍可使用该联系人', async t => {
 const f = fixture(t); f.foreground.startContinuous(); f.foreground.notifyHelperLifecycle('focused');
 await f.enterManual();
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


test('真正离开助手保留技术失败退避，显式选人不停止后续观察', async t => {
 const f = fixture(t); f.foreground.startContinuous();
 f.setObservation(async () => ({ generation: 1, data: { observation_id: id,
  observed_at: new Date().toISOString(), phase: 'unavailable', reason: 'probe_timeout',
  probe_available: false, wechat_in_front: false, binding_id: null, contact_id: null } }));
 await f.foreground.observeBeforeShow();
 f.foreground.notifyHelperLifecycle('focused'); f.foreground.notifyHelperLifecycle('blurred');
 assert.equal(f.scheduled.values().next().value.delayMs, 4000);
 f.foreground.notifyHelperLifecycle('focused'); await f.enterManual();
 f.foreground.notifyHelperLifecycle('blurred');
 assert.equal(f.scheduled.size, 1, '显式选人后仍安排观察');
 assert.equal(f.scheduled.values().next().value.delayMs, 4000, '选人不绕过已有技术失败退避');
});

test('OCR预热只暂缓本轮，不留下人工确认门', async t => {
 for (const reason of ['probe_warming', 'probe_warmup_timeout']) {
  const f = fixture(t);
  f.setObservation(async () => observationResponse('unavailable', reason));
  await f.foreground.observeBeforeShow();
  assert.equal(f.foreground.getState().reason, reason);
  assert.equal(f.foreground.getState().confirmedContactId, null);
  f.setObservation(async () => observationResponse('confirmed', 'confirmed_active_binding', id));
  await f.foreground.observeBeforeShow();
  assert.equal(f.foreground.getState().phase, 'confirmed');
  assert.equal(f.foreground.getState().confirmedContactId, id);
  assert.equal(f.foreground.getGenerationBlock(), null);
 }
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

test('公开观察解析允许名单匹配成功和旧表情核验，不能接受其他成功原因', () => {
 for (const reason of ['confirmed_active_binding_name_match', 'confirmed_active_binding_emoji_fallback']) {
  const response = observationResponse('confirmed', reason, id);
  Object.assign(response.data, { recognized_name: '合成學', recognition_confidence: 0.3 });
  const parsed = ports.foregroundObservation(response.data);
  assert.equal(parsed.reason, reason);
  assert.equal(parsed.contactId, id);
  assert.equal(parsed.recognitionConfidence, 0.3);
  assert.throws(() => ports.foregroundObservation({ ...response.data, binding_id: null }));
 }
 assert.throws(() => ports.foregroundObservation(observationResponse('confirmed', 'unmatched_requires_selection', id).data));
});

test('探针超时后新的低分唯一绑定匹配自动恢复确认', async t => {
 const f = fixture(t);
 f.setObservation(async () => observationResponse('unavailable', 'probe_timeout'));
 await f.foreground.observeBeforeShow();
 assert.notEqual(f.foreground.getGenerationBlock(), null);
 const response = observationResponse('confirmed', 'confirmed_active_binding_name_match', id);
 Object.assign(response.data, { recognized_name: '合成甲', recognition_confidence: Math.fround(0.3) });
 f.setObservation(async () => response);
 await f.foreground.observeBeforeShow();
 assert.equal(f.foreground.getGenerationBlock(), null);
 assert.equal(f.foreground.getState().confirmation, 'verified-binding');
 assert.equal(f.foreground.getState().confirmedContactId, id);
 assert.equal(f.foreground.getState().suggestedContactId, null);
 assert.equal(f.foreground.getState().recognitionConfidence, Math.fround(0.3));
});

test('名单核验可恢复单纯质量门且兼容旧表情证据，原始低分仍展示', async t => {
 for (const reason of ['confirmed_active_binding_name_match', 'confirmed_active_binding_emoji_fallback']) {
  const f = fixture(t);
  f.setObservation(async () => observationResponse('manual-required', 'quality_unverified'));
  await f.foreground.observeBeforeShow(); await f.foreground.observeBeforeShow();
  const response = observationResponse('confirmed', reason, id);
  Object.assign(response.data, { recognized_name: '合成學', recognition_confidence: 0.3 });
  f.setObservation(async () => response); await f.foreground.observeBeforeShow();
  assert.equal(f.foreground.getGenerationBlock(), null);
  assert.equal(f.foreground.getState().recognitionConfidence, 0.3);
  const panel = JSON.stringify(ports.ForegroundPanel({ state: f.foreground.getState(), session: { state: f.state } }));
  assert.match(panel, /低分本身不阻止名单中的唯一匹配/);
  assert.match(panel, /原始 OCR 分数/);
 }
});

test('当前完整绑定核验成功可恢复歧义、超时和不可用的混合历史', async t => {
 const quality = ['manual-required', 'quality_unverified'];
 const failures = [['manual-required', 'ambiguous_requires_selection'], ['unavailable', 'probe_timeout'],
  ['unavailable', 'binding_verification_unavailable']];
 for (const confirmedReason of ['confirmed_active_binding', 'confirmed_active_binding_name_match', 'confirmed_active_binding_emoji_fallback']) {
  for (const failure of failures) {
   for (const prior of [[failure], [quality, failure], [failure, quality]]) {
    const f = fixture(t);
    f.setObservation(async () => observationResponse('confirmed', confirmedReason, id));
    await f.foreground.observeBeforeShow();
    assert.equal(f.foreground.getGenerationBlock(), null);
    for (const [phase, reason] of prior) {
     f.setObservation(async () => observationResponse(phase, reason)); await f.foreground.observeBeforeShow();
     assert.notEqual(f.foreground.getGenerationBlock(), null, '当前失败必须撤销旧确认资格');
    }
    f.setObservation(async () => observationResponse('confirmed', confirmedReason, id));
    await f.foreground.observeBeforeShow();
    assert.equal(f.foreground.getState().reason, confirmedReason);
    assert.equal(f.foreground.getState().confirmedContactId, id);
    assert.equal(f.foreground.getGenerationBlock(), null);
   }
  }
 }
});

test('显式选人不停止微信识别，新鲜成功自动接管同一联系人的归属', async t => {
 for (const confirmedReason of ['confirmed_active_binding', 'confirmed_active_binding_name_match', 'confirmed_active_binding_emoji_fallback']) {
  const f = fixture(t); await f.enterManual();
  let calls = 0; f.setObservation(async () => { ++calls; return observationResponse('confirmed', confirmedReason, id); });
  await f.foreground.observeBeforeShow();
  assert.equal(calls, 1, '选过联系人后仍须读取新的正式观察');
  assert.equal(f.foreground.getState().confirmation, 'verified-binding');
  assert.equal(f.foreground.getGenerationBlock(), null);
  assert.equal(f.isManual(), false, '自动成功后不继续携带手动确认通道标记');
  assert.equal(Object.hasOwn(f.foreground.getState(), 'manualInput'), false);
 }
});

test('未绑定只限制当轮并明确提示选择，返回可靠绑定私聊自动恢复', async t => {
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

test('失败后经过未绑定和群聊仍阻止生成，新的可靠私聊绑定才恢复', async t => {
 for (const [phase, reason] of [['manual-required', 'ambiguous_requires_selection'],
  ['manual-required', 'quality_unverified'], ['unavailable', 'probe_timeout']]) {
  const f = fixture(t);
  f.setObservation(async () => observationResponse(phase, reason));await f.foreground.observeBeforeShow();
  f.setObservation(async () => observationResponse('manual-required', 'unmatched_requires_selection'));await f.foreground.observeBeforeShow();
  assert.notEqual(f.foreground.getGenerationBlock(), null);
  f.setObservation(async () => observationResponse('paused', 'group_chat_suspected'));await f.foreground.observeBeforeShow();
  assert.notEqual(f.foreground.getGenerationBlock(), null);
  assert.equal(f.foreground.getState().unsupportedConversation, true);
  f.setObservation(async () => observationResponse('confirmed', 'confirmed_active_binding', id));await f.foreground.observeBeforeShow();
  assert.equal(f.foreground.getState().reason, 'confirmed_active_binding');
  assert.equal(f.foreground.getState().unsupportedConversation, false);
  assert.equal(f.foreground.getGenerationBlock(), null);
 }
});

test('离开群聊后等待重新识别时不再把旧群聊当成当前会话', async t => {
 const f = fixture(t);
 f.setObservation(async () => observationResponse('paused', 'group_chat_suspected'));
 await f.foreground.observeBeforeShow();
 f.setObservation(async () => observationResponse('paused', 'wechat_not_in_front'));
 await f.foreground.observeBeforeShow();
 const state = f.foreground.getState();
 assert.equal(state.unsupportedConversation, true, '未确认新私聊前仍阻止生成');
 assert.notEqual(f.foreground.getGenerationBlock(), null);
 const panel = JSON.stringify(ports.ForegroundPanel({ state, session: { state: f.state } }));
 assert.match(panel, /等待微信切到前台/);
 assert.doesNotMatch(panel, /群聊暂不支持/);
});


test('显式选人后的识别失败撤销本次资格与宿主标记，后续新鲜成功可恢复', async t => {
 for (const [phase, reason] of [['unavailable', 'probe_timeout'], ['manual-required', 'ambiguous_requires_selection'], ['paused', 'group_chat_unsupported'], ['paused', 'sync_disabled']]) {
  const f=fixture(t); await f.enterManual();
  f.setObservation(async()=>observationResponse(phase,reason));
  await f.foreground.observeBeforeShow();
  assert.notEqual(f.foreground.getGenerationBlock(),null,reason);
  assert.equal(f.isManual(),false,reason);
  f.setObservation(async()=>observationResponse('confirmed','confirmed_active_binding',id));
  await f.foreground.observeBeforeShow();
  assert.equal(f.foreground.getState().confirmation,'verified-binding');
  assert.equal(f.foreground.getGenerationBlock(),null);
 }
});

test('真实联系人会话在显式选人后继续跟随，旧观察不覆盖新选择或留下其他人的确认标记', async t => {
 const otherId='20000000-0000-4000-8000-000000000002';
 const contacts=new ports.ContactSession(async()=>({generation:1,contacts:[id,otherId].map(contactId=>({contactId,displayName:'合成联系人',messageCount:0,sourceCount:0}))}));
 contacts.setConnection(1); await contacts.refreshContacts();
 const manual=new Set(),handlers=new Map(); let read;
 const backend={getConnectionGeneration:()=>1,onStateChanged:()=>()=>{},
  confirmManualInput:contactId=>manual.add(contactId),clearManualInput:contactId=>manual.delete(contactId),
  requestJson:async request=>request.path.endsWith('/manual-confirmation')?{generation:1}:read()};
 const foreground=ports.installForegroundBridge({handle:(name,handler)=>handlers.set(name,handler),publish(){}},backend,contacts);
 t.after(()=>foreground.dispose());
 const choose=contactId=>handlers.get('contacts:confirm-manual')({contactId,scopeRevision:contacts.getState().scopeRevision});
 await choose(id); assert.deepEqual([...manual],[id]);
 let release; read=()=>new Promise(resolve=>{release=resolve;});
 const old=foreground.observeBeforeShow();
 await choose(otherId);
 assert.deepEqual([...manual],[otherId],'切换明确选择时清除前一人的通道标记');
 release(observationResponse('confirmed','confirmed_active_binding',id)); await old;
 assert.equal(contacts.getState().selectedContactId,otherId);
 assert.equal(foreground.getState().confirmation,'manual-confirmed');
 read=async()=>observationResponse('confirmed','confirmed_active_binding',id);
 await foreground.observeBeforeShow();
 assert.equal(contacts.getState().selectedContactId,id,'下一轮新鲜微信观察自动更新联系人');
 assert.equal(foreground.getState().confirmation,'verified-binding');
 assert.deepEqual([...manual],[],'自动切换后不能保留任一旧选择的通道标记');
 await choose(otherId);
 const finish=foreground.beginReadingScopeChange(); finish();
 assert.equal(foreground.getGenerationBlock(),'foreground-confirmation-required');
 assert.deepEqual([...manual],[],'读取范围失效同步清除宿主标记');
});
