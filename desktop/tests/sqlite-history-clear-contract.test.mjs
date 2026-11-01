import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { SqliteHistoryClearHttp } from '../../backend-ts/src/history/sqlite/clear-http.ts';
import { SqliteHistoryRecertifyService } from '../../backend-ts/src/history/sqlite/recertify.ts';
import { fixture, identity, record, waitFor, report, createChannel } from '../../backend-ts/test/sqlite-clear-support.mjs';

async function loadController(t, root) {
  const output = join(root, 'history-clear-controller.mjs');
  await build({ entryPoints: ['src/main/history-clear/controller.ts'], outfile: output, bundle: true, format: 'esm', platform: 'node' });
  t.after(() => rm(output, { force: true }));
  return (await import(pathToFileURL(output).href)).HistoryClearController;
}
class FakeBackend {
  constructor(base) { this.base = base; this.generation = 1; this.listeners = new Set(); this.calls = []; this.dropRecertifyResponse = false; }
  getConnectionGeneration() { return this.generation; }
  onStateChanged(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async requestJson({ method, path, body, signal }) {
    this.calls.push({method,path,body});
    const response = await fetch(this.base + path, { method, signal,
      headers: { authorization: 'Bearer synthetic-clear-token', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new Error(`synthetic_http_${response.status}`);
    const data = await response.json();
    if (this.dropRecertifyResponse && method === 'POST' && path.endsWith('/recertify')) throw new Error('合成认证响应丢失');
    return { generation: this.generation, data };
  }
}
class FakeContacts {
  constructor(contactId) { this.contactId = contactId; this.listeners = new Set(); }
  getState() { return { revision: 1, scopeRevision: 7, directoryPhase: 'ready',
    contacts: [{ contactId: this.contactId }], selectedContactId: this.contactId, draft: '' }; }
  onStateChanged(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}

test('桌面清空控制器消费真实SQLite清空/重读HTTP状态并提示boundary_pending', async t => {
  const root = await mkdtemp(join(tmpdir(), 'notalone-clear-ui-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const HistoryClearController = await loadController(t, root);
  const f = await fixture(t);
  const contact = f.contactA;
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2')];
  f.state.boundaryMembers = [identity('shard-a', '1'), identity('shard-a', '2')];
  await f.current.history.synchronize(contact);
  const http = new SqliteHistoryClearHttp(f.current.clear, f.current.resync, f.current.recertify);
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer synthetic-clear-token') { res.writeHead(401); res.end(); return; }
    if (!await http.handle(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const backend = new FakeBackend(`http://127.0.0.1:${server.address().port}`);
  const controller = new HistoryClearController(backend, new FakeContacts(contact));
  t.after(() => controller.dispose());
  await waitFor(() => controller.getState().phase === 'ready', '桌面控制器首读');
  const initial = controller.getState();
  assert.equal(initial.clear.phase, 'none');
  assert.equal(initial.resync.state, 'none');
  await controller.clear({ contactId: contact, scopeRevision: 7 });
  const cleared = controller.getState();
  assert.equal(cleared.clear.phase, 'completed');
  assert.equal(cleared.clear.completed, true);
  assert.equal(cleared.clear.boundary.state, 'verified');
  assert.equal(cleared.clear.boundary.memberCount, 2);
  assert.equal(cleared.clear.boundaryPending, false);
  assert.equal((await f.current.history.read(contact)).messages.length, 0);
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2'), record('shard-b', '8')];
  await controller.resync({ contactId: contact, scopeRevision: 7, requestKey: 'desktop-resync-1', confirmed: true });
  const restored = controller.getState();
  assert.equal(restored.resync.completed, true);
  assert.equal(restored.resync.messageCount, 3);
  assert.equal((await f.current.history.read(contact)).messages.length, 3);
});

test('桌面清空控制器把未认证边界显示为boundary_pending而非完成', async t => {
  const root = await mkdtemp(join(tmpdir(), 'notalone-clear-ui-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const HistoryClearController = await loadController(t, root);
  const f = await fixture(t);
  const contact = f.contactA;
  f.state.pageRecords = [record('shard-a', '1')];
  f.state.boundaryMembers = [identity('shard-a', '1')];
  await f.current.history.synchronize(contact);
  f.state.boundaryAvailable = false;
  delete f.channel.boundarySnapshot;
  const http = new SqliteHistoryClearHttp(f.current.clear, f.current.resync, f.current.recertify);
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer synthetic-clear-token') { res.writeHead(401); res.end(); return; }
    if (!await http.handle(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const backend = new FakeBackend(`http://127.0.0.1:${server.address().port}`);
  const controller = new HistoryClearController(backend, new FakeContacts(contact));
  t.after(() => controller.dispose());
  await waitFor(() => controller.getState().phase === 'ready', '桌面控制器首读');
  await controller.clear({ contactId: contact, scopeRevision: 7 });
  const state = controller.getState();
  assert.equal(state.clear.phase, 'boundary_pending');
  assert.equal(state.clear.completed, false);
  assert.equal(state.clear.boundaryPending, true);
  assert.equal(state.clear.boundaryReason, 'history_boundary_unverified');
});

test('桌面认证控制器经真实SQLite/HTTP保留旧资料，响应丢失后只查询既有完成操作', async t => {
  const root = await mkdtemp(join(tmpdir(), 'notalone-recertify-ui-'));t.after(() => rm(root, { recursive: true, force: true }));
  const HistoryClearController = await loadController(t, root), f = await fixture(t), contact = f.contactA;
  f.state.pageRecords = [record('shard-a', '1')];await f.current.history.synchronize(contact);
  const old = await f.current.contacts.eligibility(contact);await f.current.storage.execute('history.markContinuityLost', {token:old});
  let channels = 0, releasePage;const pagePending=new Promise(resolve=>{releasePage=resolve;});
  const recertify = new SqliteHistoryRecertifyService(f.current.storage, f.current.contacts, () => {
    channels++;const {channel,state}=createChannel();state.pageRecords=[record('shard-a','1')];state.pageHook=()=>pagePending;
    state.inspectFactory=scope=>({...report,continuity:'same-source-instances-normal-use-v1',accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation});
    channel.guardSession={loss:new Promise(()=>{})};return channel;
  }, f.current.holders, {stopHistory:id=>f.current.history.stop(id)});t.after(()=>recertify.close());
  const http = new SqliteHistoryClearHttp(f.current.clear, f.current.resync, recertify);
  const server=createServer(async(req,res)=>{if(req.headers.authorization!=='Bearer synthetic-clear-token'){res.writeHead(401);res.end();return;}if(!await http.handle(req,res)){res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const backend=new FakeBackend(`http://127.0.0.1:${server.address().port}`),controller=new HistoryClearController(backend,new FakeContacts(contact));t.after(()=>controller.dispose());
  await waitFor(()=>controller.getState().phase==='ready','桌面认证首读');assert.equal(controller.getState().clear.phase,'none');
  backend.dropRecertifyResponse=true;let timer;
  try {
    await Promise.race([controller.recertify({contactId:contact,scopeRevision:7,requestKey:'desktop-recertify-lost-response',confirmed:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('认证接纳不应等待全量历史读取')),2000);})]);
    assert.equal(controller.getState().pendingRecertifyKey,'desktop-recertify-lost-response');assert.notEqual(controller.getState().recertify.completed,true);
    await controller.refresh({contactId:contact,scopeRevision:7});assert.equal(controller.getState().recertify.state,'running');assert.equal(controller.getState().recertify.completed,false);
  } finally {clearTimeout(timer);releasePage();}
  await waitFor(async()=>{await controller.refresh({contactId:contact,scopeRevision:7});return controller.getState().recertify?.completed;},'异步认证稳定完成');const result=controller.getState().recertify;
  assert.equal(result.state,'completed');assert.equal(result.completed,true);assert.equal(result.messageCount,1);assert.equal(result.preservedMessageCount,1);assert.equal(controller.getState().pendingRecertifyKey,null);
  const channelsAfterCompletion=channels;assert.ok(channelsAfterCompletion>0);await controller.refresh({contactId:contact,scopeRevision:7});
  assert.equal(backend.calls.filter(call=>call.method==='POST').length,1);assert.equal(channels,channelsAfterCompletion);assert.notEqual((await f.current.contacts.eligibility(contact)).binding_id,old.binding_id);
  assert.deepEqual(await f.current.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
