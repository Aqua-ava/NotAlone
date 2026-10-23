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

function fixture({ withBinding = false, revokeFails = false } = {}) {
  let generation, listener;
  const calls = [], requests = [];
  const binding = { binding_id: '11111111-1111-4111-8111-111111111111',
    contact_id: '22222222-2222-4222-8222-222222222222',
    conversation_locator: 'wxid_synthetic', display_name: '合成联系人', status: 'active' };
  let active = withBinding ? [binding] : [];
  let revoked = [];
  const backend = {
    getConnectionGeneration: () => generation,
    onStateChanged: (callback) => { listener = callback; },
    async requestJson(request) {
      requests.push(request);
      const { path } = request;
      calls.push(path);
      if (path === '/api/sync/cli-bindings/revoke') {
        if (revokeFails) throw new Error('合成撤销失败');
        active = []; revoked = [{ ...binding, status: 'revoked' }];
        return { generation, data: revoked[0] };
      }
      const data = path === '/api/setup/status' ? { runtime_owner_configured: true }
        : path === '/api/sync/cli-bindings' ? { bindings: active, revoked_bindings: revoked }
        : path === '/api/sync/cli-sessions' ? { sessions: [{ username: 'wxid_synthetic', display_name: '合成联系人', last_timestamp: null, bound_contact_id: null }] }
        : { sync_enabled: false };
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
