import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const directory = await mkdtemp(path.join(tmpdir(), 'notalone-binding-startup-'));
const result = await build({ stdin: { contents: `export {BindingConsentController} from './src/main/bindings/controller'; export {installBindingConsentBridge} from './src/main/bindings/bridge'; export {createBindingConsentBridge} from './src/preload/binding-consent';`, resolveDir: process.cwd() }, bundle: true,
  platform: 'node', format: 'esm', write: false });
await writeFile(path.join(directory, 'controller.mjs'), result.outputFiles[0].text);
const { BindingConsentController, installBindingConsentBridge, createBindingConsentBridge } = await import(path.join(directory, 'controller.mjs'));
after(() => rm(directory, { recursive: true, force: true }));

function syncReport(enabled) { return { sync_mode: 'cli_background', sync_enabled: enabled, cli_available: false,
  probe_available: false, wechat_in_front: false, cli_sync_phase: enabled ? 'degraded' : 'disabled',
  foreground_phase: enabled ? 'unavailable' : 'sync_disabled', cli_bound_count: 0 }; }

function fixture({ withBinding = false, revokeFails = false, sqlite = false, initiallyEnabled = false,
  enableFails = false, confirmBarrier, lightweightStatus = false, beforeRead } = {}) {
  let snapshotNumber = 0;
  let generation, listener;
  let enabled = initiallyEnabled;
  const calls = [], requests = [];
  const binding = { binding_id: '11111111-1111-4111-8111-111111111111',
    contact_id: '22222222-2222-4222-8222-222222222222',
    conversation_locator: 'wxid_synthetic', display_name: '合成联系人', status: 'active', ...(sqlite ? { selection_generation: '7' } : {}) };
  let active = withBinding ? [binding] : [];
  let revoked = [];
  const backend = {
    getConnectionGeneration: () => generation,
    onStateChanged: (callback) => { listener = callback; },
    async requestJson(request) {
      requests.push(request);
      const { path } = request;
      calls.push(path);
      if (beforeRead) await beforeRead(request);
      if (path === '/api/sync/cli-bindings/revoke') {
        if (revokeFails) throw new Error('合成撤销失败');
        active = []; revoked = [{ ...binding, status: 'revoked' }];
        return { generation, data: revoked[0] };
      }
      if (path === '/api/sync/cli-bindings/confirm') {
        if (confirmBarrier) await confirmBarrier;
        active = [{ ...binding }];
        return { generation, data: { sync_enabled: enabled } };
      }
      if (path === '/api/sync/enable') {
        if (enableFails) throw new Error('合成开启失败');
        enabled = true;
        return { generation, data: syncReport(enabled) };
      }
      const data = path === '/api/setup/status' ? { runtime_owner_configured: true }
        : path === '/api/sync/cli-bindings' ? { bindings: active, revoked_bindings: revoked, ...(sqlite ? { identity_protocol: 'sqlite-selected-v1' } : {}), ...(lightweightStatus ? { sync_enabled: enabled } : {}) }
        : path === '/api/sync/cli-sessions' ? { ...(sqlite ? { snapshot_token: `snapshot-${++snapshotNumber}` } : {}), sessions: [{ username: 'wxid_synthetic', display_name: '合成联系人', last_timestamp: null, bound_contact_id: null, ...(sqlite ? { selection_generation: snapshotNumber === 1 ? '0' : '2', known_contact_id: null } : {}) }] }
        : syncReport(enabled);
      return { generation, data };
    },
  };
  const changes = [];
  const contacts = { getState: () => ({ directoryPhase: 'ready', contacts: [] }), refreshContacts: async () => {} };
  const controller = new BindingConsentController(backend, contacts, () => {
    changes.push('started'); return () => changes.push('settled');
  });
  async function connect(value) {
    generation = value; listener();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { controller, calls, connect, changes, requests };
}

test('启动、重连和新宿主不主动读取微信会话，仍加载已保存授权', async () => {
  for (let restart = 0; restart < 2; restart++) {
    const { controller, calls, connect } = fixture();
    await connect(1);
    await connect(undefined);
    await connect(2);
    assert.equal(calls.filter((path) => path === '/api/sync/cli-sessions').length, 0);
    assert.equal(controller.getState().phase, 'ready');
    assert.equal(controller.getState().syncEnabled, false);
    assert.equal(controller.getState().sessionIssue, 'not-requested');
    assert.equal(calls.filter((path) => path === '/api/sync/cli-bindings').length, 2);
  }
});

test('授权目录携带开关时不读取全量历史报告，明确名单刷新仍保留同意边界', async () => {
  for (const initiallyEnabled of [false, true]) {
    const f = fixture({ sqlite: true, lightweightStatus: true, initiallyEnabled });
    await f.connect(1);
    await f.controller.refreshSaved();
    assert.equal(f.controller.getState().syncEnabled, initiallyEnabled);
    assert.equal(f.calls.filter(path => path === '/api/sync/status').length, 0);
    assert.equal(f.calls.filter(path => path === '/api/sync/cli-sessions').length, 0);
    await f.controller.refresh();
    assert.equal(f.calls.filter(path => path === '/api/sync/status').length, 0);
    assert.equal(f.requests.filter(request => request.path === '/api/sync/cli-sessions' && request.metadataConsent === true).length, 1);
  }
});

test('授权目录非法开关保持失败，不借旧报告猜测或额外查询', async () => {
  for (const initiallyEnabled of [null, 'true', 1]) {
    const f = fixture({ sqlite: true, lightweightStatus: true, initiallyEnabled });
    await f.connect(1);
    assert.equal(f.controller.getState().phase, 'failed');
    assert.equal(f.controller.getState().syncEnabled, null);
    assert.equal(f.calls.filter(path => path === '/api/sync/status').length, 0);
  }
});

test('已保存授权并行读取只合并同代次，重连及明确名单读取不复用旧请求', async t => {
  let hold = false;
  const releases = [];
  const f = fixture({ sqlite: true, lightweightStatus: true, beforeRead: request => {
    if (hold && request.path === '/api/sync/cli-bindings') return new Promise(resolve => releases.push(resolve));
  } });
  t.after(() => { hold = false; for (const release of releases) release(); });
  await f.connect(1);f.calls.length = 0;hold = true;
  const first = f.controller.refreshSaved();await new Promise(resolve => setImmediate(resolve));
  const second = f.controller.refreshSaved();await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 1, '同代次保存状态读取须等待同一请求');
  await f.connect(2);
  assert.equal(releases.length, 2, '重连必须另读新代次');
  const explicit = f.controller.refresh();await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 3, '明确名单刷新不能被保存状态请求吞掉');
  const duringExplicit = f.controller.refreshSaved();await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 3, '后台保存状态刷新不打断用户已同意的名单读取');
  hold = false;releases[2]();await Promise.all([explicit,duringExplicit]);
  const accepted = f.controller.getState();
  releases[0]();releases[1]();await Promise.all([first,second]);await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.controller.getState(), accepted, '迟到旧请求不能覆盖明确名单结果');
  assert.equal(f.calls.filter(path => path === '/api/sync/cli-sessions').length, 1);
});

test('明确刷新才读取微信列表，重连后清除旧列表且不自动再读取', async () => {
  const { controller, calls, connect } = fixture();
  await connect(1);
  calls.length = 0;
  await controller.refresh();
  assert.equal(calls.filter((path) => path === '/api/sync/cli-sessions').length, 1);
  assert.equal(controller.getState().sessions.length, 1);
  assert.equal(controller.getState().sessionIssue, null);
  await connect(undefined);
  await connect(2);
  assert.equal(calls.filter((path) => path === '/api/sync/cli-sessions').length, 1);
  assert.deepEqual(controller.getState().sessions, []);
});

for (const revokeFails of [false, true]) test(`启动后直接撤销${revokeFails ? '失败' : '成功'}仍不读取微信列表`, async () => {
  const { controller, calls, connect } = fixture({ withBinding: true, revokeFails });
  await connect(1);
  const state = controller.getState();
  assert.equal(state.bindings.length, 1);
  await controller.revokeBinding({ scopeRevision: state.scopeRevision,
    contactId: state.bindings[0].contactId, bindingId: state.bindings[0].bindingId });
  assert.equal(calls.filter((path) => path === '/api/sync/cli-sessions').length, 0);
  assert.equal(controller.getState().bindings.length, revokeFails ? 1 : 0);
  assert.equal(controller.getState().sessionIssue, 'not-requested');
});


test('联系人页面只刷新已保存状态，保留会话选择缓存与已撤销关联', async () => {
  const { controller, calls, connect } = fixture({ withBinding: true });
  await connect(1);
  await controller.refreshSaved();
  assert.equal(calls.filter((path) => path === '/api/sync/cli-sessions').length, 0);
  await controller.refresh();
  const sessions = controller.getState().sessions;
  calls.length = 0;
  await controller.refreshSaved();
  assert.deepEqual(controller.getState().sessions, sessions);
  assert.equal(calls.filter((path) => path === '/api/sync/cli-sessions').length, 0);
  const state = controller.getState();
  await controller.revokeBinding({ scopeRevision: state.scopeRevision,
    contactId: state.bindings[0].contactId, bindingId: state.bindings[0].bindingId });
  assert.equal(controller.getState().bindings.length, 0);
  assert.equal(controller.getState().knownBindings.length, 1);
  assert.equal(controller.getState().knownBindings[0].status, 'revoked');
  const snapshot = controller.getState();
  snapshot.knownBindings[0].displayName = '不能篡改保存状态';
  assert.equal(controller.getState().knownBindings[0].displayName, '合成联系人');
  await connect(undefined);
  assert.deepEqual(controller.getState().knownBindings, []);
});


for (const reconnect of [false, true]) test(`${reconnect ? '重连' : '启动'}加载未完成时刷新保存状态，撤销仍不读取微信名单`, async () => {
  const { controller, calls, connect } = fixture({ withBinding: true });
  if (reconnect) {
    await connect(1);
    await controller.refresh();
    await connect(undefined);
    calls.length = 0;
  }
  // 不等待连接初始化：页面的保存状态刷新先完成，并淘汰旧加载结果。
  const connecting = connect(reconnect ? 2 : 1);
  await controller.refreshSaved();
  await connecting;
  const state = controller.getState();
  assert.equal(state.phase, 'ready');
  await controller.revokeBinding({ scopeRevision: state.scopeRevision,
    contactId: state.bindings[0].contactId, bindingId: state.bindings[0].bindingId });
  assert.equal(calls.filter((path) => path === '/api/sync/cli-sessions').length, 0);
  assert.equal(controller.getState().sessionIssue, 'not-requested');
});


test('确认新授权前及完成后均使旧读取范围失效', async () => {
  const { controller, connect, changes } = fixture();
  await connect(1); await controller.refresh();
  const state = controller.getState();
  await controller.confirmSelections({ scopeRevision: state.scopeRevision, selections: [{
    locator: 'wxid_synthetic', displayName: '合成联系人', contactId: null,
  }] });
  assert.equal(controller.getState().errorCode, null);
  assert.deepEqual(changes, ['started', 'settled']);
});

test('首次选择只在绑定确认成功后开启原本关闭的同步', async () => {
  const f = fixture(); await f.connect(1); await f.controller.refresh(); f.calls.length = 0;
  await f.controller.confirmSelections({ scopeRevision: f.controller.getState().scopeRevision, startSync: true,
    selections: [{ locator: 'wxid_synthetic', displayName: '合成联系人', contactId: null }] });
  const confirmation = f.calls.indexOf('/api/sync/cli-bindings/confirm');
  const enable = f.calls.indexOf('/api/sync/enable');
  assert.ok(confirmation >= 0 && enable > confirmation);
  assert.equal(f.controller.getState().syncEnabled, true);
});

test('后续添加沿用原有关闭状态，不隐式开启总开关', async () => {
  const f = fixture(); await f.connect(1); await f.controller.refresh(); f.calls.length = 0;
  await f.controller.confirmSelections({ scopeRevision: f.controller.getState().scopeRevision,
    selections: [{ locator: 'wxid_synthetic', displayName: '合成联系人', contactId: null }] });
  assert.ok(f.calls.includes('/api/sync/cli-bindings/confirm'));
  assert.equal(f.calls.includes('/api/sync/enable'), false);
  assert.equal(f.controller.getState().syncEnabled, false);
});

test('首次选择同步已开启时不重复发送开启命令', async () => {
  const f = fixture({ initiallyEnabled: true }); await f.connect(1); await f.controller.refresh(); f.calls.length = 0;
  await f.controller.confirmSelections({ scopeRevision: f.controller.getState().scopeRevision, startSync: true,
    selections: [{ locator: 'wxid_synthetic', displayName: '合成联系人', contactId: null }] });
  assert.equal(f.calls.includes('/api/sync/enable'), false);
  assert.equal(f.controller.getState().syncEnabled, true);
});

test('同步开启失败保留已保存绑定并报告可恢复状态', async () => {
  const f = fixture({ enableFails: true }); await f.connect(1); await f.controller.refresh(); f.calls.length = 0;
  await f.controller.confirmSelections({ scopeRevision: f.controller.getState().scopeRevision, startSync: true,
    selections: [{ locator: 'wxid_synthetic', displayName: '合成联系人', contactId: null }] });
  const state = f.controller.getState();
  assert.equal(state.notice, 'confirmed');
  assert.equal(state.errorCode, 'sync-start-failed');
  assert.equal(state.syncEnabled, false);
  assert.equal(state.bindings.length, 1);
  assert.equal(f.calls.filter(path => path === '/api/sync/cli-bindings/confirm').length, 1);
  assert.ok(f.calls.includes('/api/sync/status'));
});

test('确认绑定期间切换 backend generation 不会在新连接开启同步', async () => {
  let releaseConfirm;
  const confirmBarrier = new Promise(resolve => { releaseConfirm = resolve; });
  const f = fixture({ confirmBarrier }); await f.connect(1); await f.controller.refresh(); f.calls.length = 0;
  const confirmation = f.controller.confirmSelections({ scopeRevision: f.controller.getState().scopeRevision, startSync: true,
    selections: [{ locator: 'wxid_synthetic', displayName: '合成联系人', contactId: null }] });
  for (let i = 0; i < 30 && !f.calls.includes('/api/sync/cli-bindings/confirm'); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.calls.includes('/api/sync/cli-bindings/confirm'));
  await f.connect(undefined); await f.connect(2);
  releaseConfirm();
  await confirmation;
  assert.equal(f.calls.includes('/api/sync/enable'), false);
});

for (const historyAuthorized of [undefined, false, true]) test(`所选会话历史选择${historyAuthorized}明确传至HTTP，旧调用默认false`, async () => {
  const f = fixture(); await f.connect(1); await f.controller.refresh();
  await f.controller.confirmSelections({ scopeRevision: f.controller.getState().scopeRevision,
    selections: [{locator:'wxid_synthetic',displayName:'合成联系人',contactId:null}],
    ...(historyAuthorized === undefined ? {} : {historyAuthorized}) });
  const request = f.requests.find(request => request.path === '/api/sync/cli-bindings/confirm');
  assert.equal(request.body.history_authorized, historyAuthorized ?? false);
  assert.equal(request.body.selections.length, 1);
});
test('非法历史选择在重新读取列表或写入前被拒绝', async () => {
  const f = fixture(); await f.connect(1); await f.controller.refresh();
  const count = f.requests.length;
  for(const historyAuthorized of ['true', null, 1, undefined]) {
    await assert.rejects(f.controller.confirmSelections({scopeRevision:f.controller.getState().scopeRevision,
      selections:[{locator:'wxid_synthetic',displayName:'合成联系人',contactId:null}],historyAuthorized}));
  }
  assert.equal(f.requests.length,count);
});

test('绑定IPC与预加载拒绝非布尔历史字段，保留旧缺省调用', async () => {
  const handlers = new Map();
  installBindingConsentBridge({handle:(name, fn)=>handlers.set(name,fn),publish(){}},
    {getConnectionGeneration:()=>undefined,onStateChanged:()=>{}}, {getState:()=>({contacts:[]})});
  const calls=[];const preload=createBindingConsentBridge({invoke:async(...args)=>calls.push(args)});
  const request={scopeRevision:1,selections:[{locator:'synthetic',displayName:'合成',contactId:null}]};
  for(const historyAuthorized of ['true',null,1,undefined]) {
    assert.throws(()=>handlers.get('bindings:confirm-selections')({...request,historyAuthorized}));
    await assert.rejects(preload.confirmSelections({...request,historyAuthorized}));
  }
  assert.throws(()=>handlers.get('bindings:confirm-selections')({...request,historyAuthorized:true,ownerId:'injected'}));
  assert.deepEqual(calls,[]);
  for(const value of [request,{...request,historyAuthorized:false},{...request,historyAuthorized:true}]) {
    await preload.confirmSelections(value);
    await assert.rejects(handlers.get('bindings:confirm-selections')(value),/本次授权选择已失效/);
  }
  assert.deepEqual(calls.map(call=>call[1]),[request,{...request,historyAuthorized:false},{...request,historyAuthorized:true}]);
});

test('绑定IPC与预加载只接受显式布尔 startSync，并保留旧调用', async () => {
  const handlers = new Map();
  installBindingConsentBridge({handle:(name, fn)=>handlers.set(name,fn),publish(){}},
    {getConnectionGeneration:()=>undefined,onStateChanged:()=>{}}, {getState:()=>({contacts:[]})});
  const calls=[];const preload=createBindingConsentBridge({invoke:async(...args)=>calls.push(args)});
  const request={scopeRevision:1,selections:[{locator:'synthetic',displayName:'合成',contactId:null}]};
  for(const startSync of ['true',null,1,undefined]) {
    const value={...request,startSync};
    assert.throws(()=>handlers.get('bindings:confirm-selections')(value));
    await assert.rejects(preload.confirmSelections(value));
  }
  for(const value of [request,{...request,startSync:false},{...request,startSync:true}]) {
    await preload.confirmSelections(value);
    await assert.rejects(handlers.get('bindings:confirm-selections')(value),/本次授权选择已失效/);
  }
  assert.deepEqual(calls.map(call=>call[1]),[request,{...request,startSync:false},{...request,startSync:true}]);
});
test('SQLite确认保留用户勾选时的名单代次，不把提交前刷新自动升级成新授权',async()=>{
 const f=fixture({sqlite:true});await f.connect(1);await f.controller.refresh();
 await f.controller.confirmSelections({scopeRevision:f.controller.getState().scopeRevision,historyAuthorized:true,selections:[{locator:'wxid_synthetic',displayName:'合成联系人',contactId:null}]});
 const request=f.requests.find(r=>r.path==='/api/sync/cli-bindings/confirm');
 assert.equal(request.body.snapshot_token,'snapshot-1');
 assert.equal(request.body.selections[0].expected_selection_generation,'0');
 assert.equal(f.requests.filter(r=>r.path==='/api/sync/cli-sessions').every(r=>r.metadataConsent===true),true);
});
test('SQLite撤销携带持久授权代次，直接撤销不补读微信列表',async()=>{
 const f=fixture({sqlite:true,withBinding:true});await f.connect(1);const state=f.controller.getState();
 await f.controller.revokeBinding({scopeRevision:state.scopeRevision,contactId:state.bindings[0].contactId,bindingId:state.bindings[0].bindingId});
 const request=f.requests.find(r=>r.path==='/api/sync/cli-bindings/revoke');assert.equal(request.body.expected_selection_generation,'7');
 assert.equal(f.requests.some(r=>r.path==='/api/sync/cli-sessions'),false);
});

function sharedReadFixture() {
  let generation = 1, listener, hold;
  const calls = [];
  const binding = { binding_id: '11111111-1111-4111-8111-111111111111', contact_id: '22222222-2222-4222-8222-222222222222', conversation_locator: 'wxid_synthetic', display_name: '合成联系人', status: 'active' };
  let active = [binding], revoked = [];
  const backend = { getConnectionGeneration: () => generation, onStateChanged: fn => { listener = fn; }, async requestJson(request) {
    const acceptedGeneration = generation; calls.push(request.path);
    const data = request.path === '/api/setup/status' ? {runtime_owner_configured:true}
      : request.path === '/api/sync/cli-bindings' ? {bindings:structuredClone(active),revoked_bindings:structuredClone(revoked)}
      : request.path === '/api/sync/cli-sessions' ? {sessions:[]}
      : request.path === '/api/sync/cli-bindings/revoke' ? (active=[],revoked=[{...binding,status:'revoked'}],revoked[0])
      : {sync_enabled:false};
    if(hold && request.path === '/api/sync/status') { const wait=hold;hold=undefined;wait.entered();await wait.promise; }
    return {generation:acceptedGeneration,data};
  }};
  const controller = new BindingConsentController(backend,{getState:()=>({directoryPhase:'ready',contacts:[]}),refreshContacts:async()=>{}});
  listener();
  return {controller,calls,binding,holdNextStatus(){let release,entered;const waiting=new Promise(resolve=>{entered=resolve;});hold={promise:new Promise(resolve=>{release=resolve;}),entered};return {waiting,release};},disconnect(){generation=undefined;listener();},connect(value){generation=value;listener();}};
}

test('同身份已保存关联并发读取复用三个请求，不重启同一轮核对', async () => {
  const f=sharedReadFixture();await f.controller.refreshSaved();f.calls.length=0;
  const held=f.holdNextStatus(),first=f.controller.refreshSaved();await held.waiting;
  const second=f.controller.refreshSaved();await new Promise(resolve=>setImmediate(resolve));
  console.log(`已保存关联同负载并发读取：${f.calls.length} GET`);
  assert.equal(f.calls.length,3,'两个读取者应共用 setup、bindings、status 三个GET');
  held.release();await Promise.all([first,second]);assert.equal(f.controller.getState().phase,'ready');
});


test('已保存关联与明确微信名单读取不同意图，不能共享旧快照', async () => {
  const f=sharedReadFixture();await f.controller.refreshSaved();f.calls.length=0;
  const held=f.holdNextStatus(),saved=f.controller.refreshSaved();await held.waiting;
  await f.controller.refresh();
  assert.equal(f.calls.filter(path=>path==='/api/sync/cli-sessions').length,1);
  assert.equal(f.calls.filter(path=>path==='/api/setup/status').length,2);
  held.release();await saved;
  assert.equal(f.controller.getState().sessionIssue,null);
});

test('已保存关联断线立即撤下，新代次自动与页面读取共享且不复用旧请求', async () => {
  const f=sharedReadFixture();await f.controller.refreshSaved();f.calls.length=0;
  const held=f.holdNextStatus(),old=f.controller.refreshSaved();await held.waiting;
  f.disconnect();assert.equal(f.controller.getState().phase,'offline');assert.equal(f.controller.getState().bindings.length,0);
  f.connect(2);await f.controller.refreshSaved();
  assert.equal(f.calls.length,6,'旧代次三请求和新代次三请求，页面复用新代次自动读取');
  held.release();await old;
  assert.equal(f.controller.getState().phase,'ready');assert.equal(f.controller.getState().bindings.length,1);
});

test('撤销写入后不复用写入前的关联读取，旧回包不能恢复绑定', async () => {
  const f=sharedReadFixture();await f.controller.refreshSaved();
  const held=f.holdNextStatus(),old=f.controller.refreshSaved();await held.waiting;
  await f.controller.revokeBinding({scopeRevision:f.controller.getState().scopeRevision,contactId:f.binding.contact_id,bindingId:f.binding.binding_id});
  assert.equal(f.controller.getState().bindings.length,0);
  const before=f.calls.length;await f.controller.refreshSaved();
  assert.equal(f.calls.length-before,3,'已结算写入后的读取必须重新获取当前授权');
  held.release();await old;assert.equal(f.controller.getState().bindings.length,0);
  assert.equal(f.controller.getState().knownBindings[0].status,'revoked');
});
