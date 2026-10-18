import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test, after } from 'node:test';
import { build } from 'esbuild';

const built = await build({ stdin: { contents: `
 export { SyncControlController } from './src/main/sync/controller';
 export { NativeHeaderChangeSource } from './src/main/foreground/native-change-source';
 export { ForegroundController } from './src/main/foreground/controller';
 export { ContactSession } from './src/main/contacts/session';
 export { readContactDirectory } from './src/main/contacts/directory';
 export { JsonClient } from './src/main/backend/json-client';
 export { readConnection } from './src/main/backend/connection';
 export { withContinuousForegroundFixture } from './tests/foreground-backend-fixture';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
 banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const directory = await mkdtemp(path.join(tmpdir(), 'notalone-change-http-'));
await writeFile(path.join(directory, 'production.mjs'), built.outputFiles[0].text);
const ports = await import(path.join(directory, 'production.mjs'));
after(() => rm(directory, { recursive: true, force: true }));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i=0;i<10;i++) await new Promise(resolve=>setImmediate(resolve)); };

test('变化取消正常空等，在途仅合并一轮；技术失败仍退避且停止后拒绝提示', async () => {
 await ports.withContinuousForegroundFixture(async fixture => {
  await fixture.setCli({ sessions: [], messages: {} });
  assert.equal((await fixture.request('/api/sync/enable', {})).status, 200);
  const client = new ports.JsonClient(await ports.readConnection(fixture.infoPath));
  let received = 0, hold;
  const backend = { getConnectionGeneration:()=>1, onStateChanged:()=>()=>{},
   async requestJson(request) {
    const response = await client.perform(request);
    if (request.path.endsWith('/observe')) { received++; if (hold) { const held=hold; hold=undefined; held.received.resolve(); await held.release.promise; } }
    return {...response,generation:1};
   } };
  const contacts = new ports.ContactSession(()=>ports.readContactDirectory(backend));
  contacts.setConnection(1); await contacts.refreshContacts();
  const scheduled=new Map(); let token=0;
  const clock={schedule(callback,delay){const id=++token;scheduled.set(id,{callback,delay});return id;},cancel(id){scheduled.delete(id);}};
  const foreground = new ports.ForegroundController(backend,contacts,clock);
  const next = async()=>{assert.equal(scheduled.size,1);const [id,task]=scheduled.entries().next().value;scheduled.delete(id);await task.callback();};
  const waitCount=async(count)=>{const end=Date.now()+3000;while(received<count&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.equal(received,count);await flush();};
  try {
   await writeFile(path.join(fixture.directory,'probe-state.json'),JSON.stringify({capture_version:'automatic-header-v3',display_name:'变化合成会话'}));
   foreground.startContinuous(); await next();
   assert.equal(scheduled.values().next().value.delay,2000);
   foreground.notifyForegroundChange(); await waitCount(2);
   assert.equal(foreground.getState().recognizedName,'变化合成会话');
   const held={received:deferred(),release:deferred()}; hold=held;
   foreground.notifyForegroundChange(); await held.received.promise;
   for(let i=0;i<20;i++)foreground.notifyForegroundChange();
   assert.equal(scheduled.size,0);
   held.release.resolve(); await waitCount(4);
   assert.equal(scheduled.size,1);
   await writeFile(path.join(fixture.directory,'probe-state.json'),JSON.stringify({wechat_in_front:false}));
   const paused={received:deferred(),release:deferred()};hold=paused;
   foreground.notifyForegroundChange();await paused.received.promise;
   foreground.notifyForegroundChange();paused.release.resolve();await waitCount(5);
   assert.equal(foreground.getState().wechatInFront,false);
   assert.equal(scheduled.values().next().value.delay,2000,'离开微信丢弃在途合并提示，只保留周期复验');
   await writeFile(path.join(fixture.directory,'probe-state.json'),JSON.stringify({error:'screen_capture_permission_missing'}));
   await next(); const failedCount=received;
   assert.equal(scheduled.values().next().value.delay,4000);
   for(let i=0;i<20;i++)foreground.notifyForegroundChange();await flush();
   assert.equal(received,failedCount);assert.equal(scheduled.values().next().value.delay,4000);
   await next();assert.equal(scheduled.values().next().value.delay,8000);
   foreground.stopContinuous();foreground.notifyForegroundChange();await flush();
   assert.equal(scheduled.size,0);assert.equal(received,failedCount+1);
  } finally {foreground.dispose();client.cancelPending();}
 });
});


test('变化源仅在已确认enabled且范围／代际有效时运行，关闭开始及助手获焦立即停源', async()=>{
 await ports.withContinuousForegroundFixture(async fixture=>{
  await fixture.setCli({sessions:[],messages:{}});
  assert.equal((await fixture.request('/api/sync/enable',{})).status,200);
  const client=new ports.JsonClient(await ports.readConnection(fixture.infoPath));
  let generation=1;const listeners=new Set();let delayDisable;
  const backend={getConnectionGeneration:()=>generation,onStateChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
   async requestJson(request){if(request.path==='/api/sync/disable'&&delayDisable){const held=delayDisable;delayDisable=undefined;held.received.resolve();await held.release.promise;}
    return{...await client.perform(request),generation};}};
  const contacts=new ports.ContactSession(()=>ports.readContactDirectory(backend));
  contacts.setConnection(1);await contacts.refreshContacts();
  const tasks=new Map();let id=0;const clock={schedule(callback,delay){tasks.set(++id,{callback,delay});return id;},cancel(handle){tasks.delete(handle);}};
  const foreground=new ports.ForegroundController(backend,contacts,clock);
  const permits=[];let deliver;
  foreground.attachChangeSource({update(permit,listener){permits.push(permit);deliver=listener;},dispose(){permits.push(undefined);}});
  const sync=new ports.SyncControlController(backend,contacts,()=>foreground.beginReadingScopeChange());
  const unsubscribe=sync.onStateChanged(state=>foreground.setSyncControlState(state));
  foreground.setSyncControlState(sync.getState());
  const next=async()=>{assert.equal(tasks.size,1);const [handle,task]=tasks.entries().next().value;tasks.delete(handle);await task.callback();};
  const waitReady=async()=>{const end=Date.now()+3000;while(sync.getState().phase!=='ready'&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.equal(sync.getState().phase,'ready');};
  try{
   foreground.startContinuous();assert.equal(permits.at(-1),undefined,'前台未经观察不能开始');
   await waitReady();assert.equal(permits.at(-1),undefined);
   await writeFile(path.join(fixture.directory,'probe-state.json'),JSON.stringify({capture_version:'automatic-header-v3',display_name:'许可合成会话'}));
   await next();assert.ok(permits.at(-1));
   const oldDelivery=deliver;
   foreground.notifyHelperLifecycle('focused');assert.equal(permits.at(-1),undefined);assert.equal(tasks.size,0);
   oldDelivery('changed');await flush();assert.equal(tasks.size,0,'旧源提示不能恢复暂停调度');
   foreground.notifyHelperLifecycle('blurred');await next();assert.ok(permits.at(-1));
   const held={received:deferred(),release:deferred()};delayDisable=held;
   const disabling=sync.disable({scopeRevision:contacts.getState().scopeRevision});await held.received.promise;
   assert.equal(permits.at(-1),undefined,'关闭请求未完成时已停源');
   held.release.resolve();await disabling;assert.equal(permits.at(-1),undefined);
   await sync.enable({scopeRevision:contacts.getState().scopeRevision});await next();assert.ok(permits.at(-1));
   generation=undefined;for(const listener of listeners)listener();assert.equal(permits.at(-1),undefined);
  }finally{unsubscribe();foreground.dispose();client.cancelPending();}
 });
});

test('自动切人保留采集许可与全局同步报告，在途变化只提交最新联系人', async () => {
 await ports.withContinuousForegroundFixture(async fixture => {
  const [a,b] = fixture.data.contact_ids;
  const names = ['合成切换甲','合成切换乙'];
  await fixture.setCli({sessions:[a,b].map((contact,i)=>({username:`wxid_synthetic_${i?'b':'a'}`,display_name:names[i],chat_type:'private',last_timestamp:1700000000})).concat([{username:'wxid_synthetic_unbound',display_name:'合成未绑定旧会话',chat_type:'private',last_timestamp:1700000000}]),messages:{}});
  await fixture.request('/api/sync/cli-bindings/confirm',{selections:[{locator:'wxid_synthetic_a',contact_id:a},{locator:'wxid_synthetic_b',contact_id:b}]});
  await fixture.request('/api/sync/enable',{});
  const client = new ports.JsonClient(await ports.readConnection(fixture.infoPath));
  let statuses=0, hold, disableHold;
  const backend={getConnectionGeneration:()=>1,onStateChanged:()=>()=>{},async requestJson(request){
   if(request.path==='/api/sync/status')statuses++;
   if(request.path==='/api/sync/disable'&&disableHold){disableHold.received.resolve();await disableHold.release.promise;}
   const result=await client.perform(request);
   if(request.path.endsWith('/observe')&&hold){const waiting=hold;hold=undefined;waiting.received.resolve();await waiting.release.promise;}
   return {...result,generation:1};
  }};
  const contacts=new ports.ContactSession(()=>ports.readContactDirectory(backend));contacts.setConnection(1);await contacts.refreshContacts();
  const tasks=new Map();let key=0;const clock={schedule(callback,delay){tasks.set(++key,{callback,delay});return key;},cancel(handle){tasks.delete(handle);}};
  const foreground=new ports.ForegroundController(backend,contacts,clock);
  const permits=[];foreground.attachChangeSource({update(permit){permits.push(permit);},dispose(){}});
  const sync=new ports.SyncControlController(backend,contacts,()=>foreground.beginReadingScopeChange());
  const unsubscribe=sync.onStateChanged(state=>foreground.setSyncControlState(state));
  const setName=name=>writeFile(path.join(fixture.directory,'probe-state.json'),JSON.stringify({capture_version:'automatic-header-v3',display_name:name}));
  try {
   const deadline=Date.now()+3000;while(sync.getState().phase!=='ready'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
   foreground.setSyncControlState(sync.getState());foreground.startContinuous();
   await setName(names[0]);await foreground.observeBeforeShow();await flush();
   const readyEnd=Date.now()+3000;while(sync.getState().phase!=='ready'&&Date.now()<readyEnd)await new Promise(r=>setTimeout(r,10));
   const scope=permits.at(-1)?.scope;assert.ok(scope);const statusCount=statuses;permits.length=0;
   await setName(names[1]);await foreground.observeBeforeShow();await flush();
   assert.equal(contacts.getState().selectedContactId,b);
   assert.equal(statuses,statusCount,'自动切人不能重新读取全局同步状态');
   assert.ok(permits.length>0&&permits.every(permit=>permit?.scope===scope),'切人不能撤销或重建采集许可');
   const selected=[];const stop=contacts.onStateChanged(state=>selected.push(state.selectedContactId));
   const waiting={received:deferred(),release:deferred()};hold=waiting;
   await setName(names[0]);const pending=foreground.observeBeforeShow();await waiting.received.promise;
   await setName(names[1]);foreground.notifyForegroundChange();
   assert.equal(foreground.getGenerationBlock(),'foreground-confirmation-required','新顶部未核验前不能沿用旧联系人生成');
   waiting.release.resolve();await pending;
   const end=Date.now()+3000;while(foreground.getGenerationBlock()!==null&&Date.now()<end)await new Promise(r=>setTimeout(r,10));
   await flush();stop();assert.ok(!selected.includes(a),'已有更新提示时旧联系人不能短暂覆盖界面');
   assert.equal(contacts.getState().selectedContactId,b);
   assert.equal(foreground.getGenerationBlock(),null,'最新正式观察重新授予资格');
   for(const obsoleteName of ['合成未绑定旧会话','合成不存在旧会话']) {
    const obsolete={received:deferred(),release:deferred()};hold=obsolete;
    const oldStates=[];const stopStates=foreground.onStateChanged(state=>oldStates.push(state));
    await setName(obsoleteName);const obsoletePending=foreground.observeBeforeShow();await obsolete.received.promise;
    await setName(names[0]);foreground.notifyForegroundChange();obsolete.release.resolve();await obsoletePending;
    const latestEnd=Date.now()+3000;while(foreground.getGenerationBlock()!==null&&Date.now()<latestEnd)await new Promise(r=>setTimeout(r,10));
    stopStates();
    assert.equal(contacts.getState().selectedContactId,a,'过时未绑定或歧义观察不能阻止最新可靠联系人自动确认');
    assert.equal(foreground.getState().confirmation,'verified-binding');
    assert.ok(oldStates.every(state=>state.phase!=='manual-required'&&state.recognizedName!==obsoleteName),'过时名称和建议不得发布');
    await setName(names[1]);await foreground.observeBeforeShow();
   }
   const staleScope=contacts.getState().scopeRevision;
   contacts.selectContact({contactId:a,scopeRevision:staleScope});
   assert.equal(permits.at(-1),undefined,'人工切换撤销旧观察许可');
   await assert.rejects(sync.disable({scopeRevision:staleScope}));
   await setName(names[0]);await foreground.observeBeforeShow();
   const afterManual=permits.at(-1)?.scope;assert.ok(afterManual&&afterManual!==scope);
   foreground.confirm({contactId:a,contactScopeRevision:contacts.getState().scopeRevision,
    foregroundRevision:foreground.getState().foregroundRevision});
   assert.equal(permits.at(-1),undefined,'同联系人显式确认也不能续用旧采集证据');
   await foreground.observeBeforeShow();

   const finishBinding=foreground.beginReadingScopeChange();
   assert.equal(permits.at(-1),undefined,'绑定修改开始立即停源');finishBinding();
   assert.equal(permits.at(-1),undefined,'绑定修改结束不能沿用旧观察');
   await foreground.observeBeforeShow();assert.notEqual(permits.at(-1)?.scope,afterManual);
   disableHold={received:deferred(),release:deferred()};
   const disabling=sync.disable({scopeRevision:contacts.getState().scopeRevision});await disableHold.received.promise;
   assert.equal(permits.at(-1),undefined);
   contacts.selectContact({contactId:b,scopeRevision:contacts.getState().scopeRevision});
   disableHold.release.resolve();await disabling;
   assert.equal(sync.getState().phase,'ready');assert.equal(sync.getState().report.enabled,false,'关闭跨切人仍须完成');
   assert.equal(permits.at(-1),undefined);
   contacts.setConnection(undefined);assert.equal(sync.getState().report,null,'目录失效必须丢弃全局授权状态');

  } finally {unsubscribe();foreground.dispose();client.cancelPending();}
 });
});
