import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const built = await build({ stdin: { contents: `
 export { ContactSession } from './src/main/contacts/session';
 export { SyncControlController } from './src/main/sync/controller';
 export { installSyncControlBridge } from './src/main/sync/bridge';
 export { createSyncControlBridge } from './src/preload/sync-control';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const ports = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const flush = async () => { for (let i=0;i<20;i++) await Promise.resolve(); };
function report(extra = {}) {
 return { sync_mode:'cli_background',sync_enabled:true,cli_available:true,probe_available:true,wechat_in_front:false,
  cli_sync_phase:'active',foreground_phase:'waiting_foreground',cli_bound_count:1,cli_failure_code:null,foreground_failure_code:null,
  cli_backfill_phase:'not_required',cli_backfill_failure_code:null,
  ...Object.fromEntries(['total_contacts','completed_contacts','succeeded_contacts','skipped_contacts','failed_contacts',
   'incomplete_contacts','pending_contacts','total_message_count','total_non_text_count'].map(key=>[`cli_backfill_${key}`,0])), ...extra };
}
function fixture(t, extra = {}, sharedContacts) {
 t.mock.timers.enable({ apis:['setTimeout'] });
 let generation=1; const listeners=new Set(), requests=[], refreshes=[];
 const control={data:report(extra),barrier:null};
 const backend={getConnectionGeneration:()=>generation,onStateChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
  async requestJson(request){ requests.push(request); const captured=generation;
   if(control.barrier)await control.barrier;
   if(request.path==='/api/sync/scope')control.data={...control.data,sync_scope:request.body.mode,sync_scope_failure_code:null};
   return {generation:captured,data:control.data}; }};
 const state={directoryPhase:'ready',scopeRevision:1,contacts:[]};
 const contacts=sharedContacts ?? {getState:()=>state,onStateChanged:()=>()=>{},refreshContactsInBackground:async()=>{refreshes.push(true);return true;}};
 const handlers=new Map();
 const sync=ports.installSyncControlBridge({handle:(name,handler)=>handlers.set(name,handler),publish(){}},backend,contacts);
 t.after(()=>sync.dispose());
 return {sync,handlers,requests,refreshes,control,state,connect(value){generation=value;for(const listener of listeners)listener();}};
}

test('同步范围只在明确操作后写入全部私聊模式，保持总开关并兼容旧状态',async t=>{
 const f=fixture(t);await flush();
 assert.equal(f.sync.getState().report.syncScope,'selected');
 assert.ok(f.requests.every(request=>request.method==='GET'));
 await f.sync.setScope({scopeRevision:1,mode:'all_private',confirmed:true});
 assert.deepEqual(f.requests.at(-1).body,{mode:'all_private',confirmed:true});
 assert.equal(f.requests.at(-1).path,'/api/sync/scope');
 assert.equal(f.sync.getState().report.syncScope,'all_private');
 assert.equal(f.sync.getState().report.enabled,true);
 await f.sync.setScope({scopeRevision:1,mode:'selected',confirmed:true});
 assert.equal(f.sync.getState().report.syncScope,'selected');
 assert.equal(f.sync.getState().report.enabled,true);
});

test('全部私聊后台快照增加联系人时刷新共享目录，数量不变不循环刷新',async t=>{
 const f=fixture(t,{sync_scope:'all_private',sync_scope_failure_code:null});await flush();
 const baseline=f.refreshes.length;
 f.control.data.cli_bound_count=3;
 t.mock.timers.tick(3000);await flush();
 assert.equal(f.refreshes.length,baseline+1);
 assert.equal(f.sync.getState().report.confirmedBindingCount,3);
 t.mock.timers.tick(3000);await flush();
 assert.equal(f.refreshes.length,baseline+1);
 assert.ok(f.requests.every(request=>request.method==='GET'));
});

test('范围命令严格校验确认、修订和模式，不接受额外字段或旧页面命令',async t=>{
 const f=fixture(t);await flush();const command=f.handlers.get('sync-control:set-scope');
 for(const args of [[],[{}],[{scopeRevision:1,mode:'all_private'}],[{scopeRevision:1,mode:'all_private',confirmed:false}],
  [{scopeRevision:1,mode:'all',confirmed:true}],[{scopeRevision:1,mode:'all_private',confirmed:true,ownerId:'injected'}],
  [{scopeRevision:1,mode:'all_private',confirmed:true},{}],[{scopeRevision:-1,mode:'all_private',confirmed:true}]]) {
  assert.throws(()=>command(...args));
 }
 await assert.rejects(command({scopeRevision:0,mode:'all_private',confirmed:true}));
 assert.ok(f.requests.every(request=>request.method==='GET'));
 const calls=[];const preload=ports.createSyncControlBridge({invoke:async(...args)=>calls.push(args)});
 await preload.setScope({scopeRevision:1,mode:'all_private',confirmed:true});
 assert.deepEqual(calls,[['sync-control:set-scope',{scopeRevision:1,mode:'all_private',confirmed:true}]]);
 await assert.rejects(preload.setScope());
});

test('新范围报告拒绝非法值，保留合法失败原因供界面重试',async t=>{
 const f=fixture(t);await flush();
 for(const extra of [{sync_scope:'all'},{sync_scope:null},{sync_scope:'all_private',sync_scope_failure_code:'<unsafe>'}]){
  f.control.data=report(extra);await f.sync.refresh();assert.equal(f.sync.getState().phase,'failed');
 }
 f.control.data=report({sync_scope:'all_private',sync_scope_failure_code:'identity_conflict'});await f.sync.refresh();
 assert.equal(f.sync.getState().report.syncScopeFailureCode,'identity_conflict');
});

test('范围写入的迟到旧连接响应不能覆盖新的连接状态',async t=>{
 const f=fixture(t);await flush();let release;
 f.control.barrier=new Promise(resolve=>{release=resolve;});
 const writing=f.sync.setScope({scopeRevision:1,mode:'all_private',confirmed:true});
 await flush();f.connect(undefined);release();await writing;
 assert.equal(f.sync.getState().phase,'offline');assert.equal(f.sync.getState().report,null);
});

async function directoryFixture(t) {
 const rows=['synthetic-a','synthetic-b','synthetic-c'].map(contactId=>({contactId,displayName:contactId,messageCount:0,sourceCount:0}));
 const directory={rows:rows.slice(0,2),fail:false,barrier:null,reads:0};
 const contacts=new ports.ContactSession(async()=>{
  directory.reads++;
  if(directory.barrier)await directory.barrier;
  if(directory.fail)throw new Error('synthetic temporary outage');
  return {generation:1,contacts:directory.rows};
 });
 contacts.setConnection(1);await flush();
 const f=fixture(t,{sync_scope:'all_private',sync_scope_failure_code:null,cli_bound_count:2},contacts);await flush();
 contacts.selectContact({contactId:rows[0].contactId,scopeRevision:contacts.getState().scopeRevision});
 contacts.setDraft({contactId:rows[0].contactId,scopeRevision:contacts.getState().scopeRevision,text:'合成草稿'});
 return {...f,contacts,directory,rows};
}

test('自动目录刷新暂时失败保留联系人与草稿，下次相同数量快照会重试至应用成功',async t=>{
 const f=await directoryFixture(t);const before=f.contacts.getState();
 f.directory.rows=f.rows;f.directory.fail=true;f.control.data.cli_bound_count=3;
 t.mock.timers.tick(3000);await flush();
 assert.equal(f.contacts.getState().directoryPhase,'ready');
 assert.equal(f.contacts.getState().selectedContactId,before.selectedContactId);
 assert.equal(f.contacts.getState().draft,before.draft);
 assert.equal(f.contacts.getState().scopeRevision,before.scopeRevision);
 assert.equal(f.sync.getState().phase,'ready');
 const failedReads=f.directory.reads;f.directory.fail=false;
 t.mock.timers.tick(3000);await flush();
 assert.equal(f.directory.reads,failedReads+1);assert.equal(f.contacts.getState().contacts.length,3);
 assert.equal(f.contacts.getState().draft,before.draft);
 t.mock.timers.tick(3000);await flush();assert.equal(f.directory.reads,failedReads+1);
});

test('自动目录读取期间切换联系人不会丢失新联系人，也不会覆盖新草稿',async t=>{
 const f=await directoryFixture(t);let release;
 f.directory.rows=f.rows;f.directory.barrier=new Promise(resolve=>{release=resolve;});
 f.control.data.cli_bound_count=3;t.mock.timers.tick(3000);await flush();
 assert.equal(f.contacts.getState().directoryPhase,'ready');
 const pendingReads=f.directory.reads;t.mock.timers.tick(3000);await flush();
 assert.equal(f.directory.reads,pendingReads);
 f.contacts.selectContact({contactId:f.rows[1].contactId,scopeRevision:f.contacts.getState().scopeRevision});
 f.contacts.setDraft({contactId:f.rows[1].contactId,scopeRevision:f.contacts.getState().scopeRevision,text:'切换后的合成草稿'});
 f.directory.barrier=null;release();await flush();
 t.mock.timers.tick(3000);await flush();
 assert.equal(f.contacts.getState().contacts.length,3);
 assert.equal(f.contacts.getState().selectedContactId,f.rows[1].contactId);
 assert.equal(f.contacts.getState().draft,'切换后的合成草稿');
 const reads=f.directory.reads;t.mock.timers.tick(3000);await flush();assert.equal(f.directory.reads,reads);
});
