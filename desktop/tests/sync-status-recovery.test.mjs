import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const built = await build({ stdin: { contents: `
 export { SyncControlController } from './src/main/sync/controller';
 export { ContactDeletionQuiet } from './src/main/contacts/deletion-quiet';
 export { ForegroundController } from './src/main/foreground/controller';
 export { BackendRequestFailure } from './src/main/backend/json-client';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const ports = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const id = '10000000-0000-4000-8000-000000000001';
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function report() {
 return { sync_mode:'cli_background',sync_enabled:true,cli_available:true,probe_available:true,wechat_in_front:true,
  cli_sync_phase:'active',foreground_phase:'active',cli_bound_count:1,cli_failure_code:null,foreground_failure_code:null,
  cli_backfill_phase:'not_required',cli_backfill_failure_code:null,
  ...Object.fromEntries(['total_contacts','completed_contacts','succeeded_contacts','skipped_contacts','failed_contacts',
   'incomplete_contacts','pending_contacts','total_message_count','total_non_text_count'].map(key=>[`cli_backfill_${key}`,0])) };
}
function fixture(t, failures = 1, priority = false, quiet) {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const control = { failures, failureCode:'sync_status_unavailable', mutationFailure:false, barrier:undefined,
  extra:priority?{cli_priority_contact_id:id,cli_priority_last_success_at:'2026-10-19T06:00:00+00:00',
   cli_priority_last_duration_ms:100,cli_priority_last_cli_duration_ms:70,cli_priority_last_store_duration_ms:20,
   cli_priority_last_failure_code:null,cli_priority_queue_wait_ms:10}:{} };
 let generation=1; const listeners=new Set(), requests=[];
 const backend = { getConnectionGeneration:()=>generation,
  onStateChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
  async requestJson(request) {
   requests.push(request); const captured=generation;
   if(request.path.endsWith('/observe')) return {generation:captured,data:{observation_id:id,observed_at:new Date().toISOString(),
    phase:'confirmed',reason:'confirmed_active_binding',probe_available:true,wechat_in_front:true,binding_id:id,contact_id:id}};
   if(request.method==='POST'&&control.mutationFailure) throw new ports.BackendRequestFailure('response',503,'sync_status_unavailable');
   if(control.barrier) await control.barrier;
   if(control.failures>0){control.failures--;throw new ports.BackendRequestFailure('response',503,control.failureCode);}
   return {generation:captured,data:{...report(),...control.extra}};
  } };
 const contact={directoryPhase:'ready',scopeRevision:1,selectedContactId:id,contacts:[{contactId:id}]};
 const contactListeners=new Set();
 const contacts={getState:()=>contact,onStateChanged:listener=>{contactListeners.add(listener);return()=>contactListeners.delete(listener);},
  selectContact:()=>contact};
 const foreground=new ports.ForegroundController(backend,contacts,{schedule:()=>1,cancel:()=>{}});
 const permits=[];foreground.attachChangeSource({update:permit=>permits.push(permit),dispose(){}});
 const sync=new ports.SyncControlController(backend,contacts,undefined,quiet);
 const unsubscribe=sync.onStateChanged(state=>foreground.setSyncControlState(state));
 foreground.setSyncControlState(sync.getState());foreground.startContinuous();
 const connect=value=>{generation=value;for(const listener of listeners)listener();};
 t.after(()=>{connect(undefined);sync.dispose();unsubscribe();foreground.dispose();});
 return {sync,foreground,permits,control,requests,connect,contacts,contactListeners,contact};
}

test('启动首次状态503后自动恢复ready，既有前台观察取得加速许可', async t=>{
 const f=fixture(t);await flush();await f.foreground.observeBeforeShow();
 assert.equal(f.sync.getState().phase,'unavailable');assert.equal(f.permits.at(-1),undefined);
 t.mock.timers.tick(999);await flush();assert.equal(f.requests.filter(r=>r.path==='/api/sync/status').length,1);
 t.mock.timers.tick(1);await flush();
 assert.equal(f.sync.getState().phase,'ready');assert.ok(f.permits.at(-1));
});

test('连续启动503按1/2/4/8秒退避且单flight，联系人变化不新增状态请求',async t=>{
 const f=fixture(t,20);await flush();
 for(const [i,delay] of [1000,2000,4000,8000,8000].entries()){
  f.contact.scopeRevision++;for(const listener of f.contactListeners)listener(f.contact);
  t.mock.timers.tick(delay-1);await flush();assert.equal(f.requests.length,i+1);
  t.mock.timers.tick(1);await flush();assert.equal(f.requests.length,i+2);
 }
 let release;f.control.barrier=new Promise(resolve=>{release=resolve;});
 t.mock.timers.tick(8000);await flush();const count=f.requests.length;
 t.mock.timers.tick(32000);await f.sync.refresh();assert.equal(f.requests.length,count);
 release();await flush();
});

test('断连取消等待，旧代际迟到结果不能恢复ready或重复调度',async t=>{
 const f=fixture(t);await flush();f.connect(undefined);t.mock.timers.tick(10000);await flush();
 assert.equal(f.requests.length,1);assert.equal(f.sync.getState().phase,'offline');
 let release;f.control.barrier=new Promise(resolve=>{release=resolve;});f.connect(2);await flush();
 f.connect(undefined);release();await flush();t.mock.timers.tick(20000);await flush();
 assert.equal(f.requests.length,2);assert.equal(f.sync.getState().phase,'offline');
});

test('手动刷新立即恢复并取消旧等待，写操作失败绝不自动重放',async t=>{
 const f=fixture(t);await flush();await f.sync.refresh();assert.equal(f.sync.getState().phase,'ready');
 t.mock.timers.tick(16000);await flush();assert.equal(f.requests.length,2);
 f.control.mutationFailure=true;await f.sync.disable({scopeRevision:1});
 assert.equal(f.sync.getState().errorCode,'operation-unconfirmed');
 t.mock.timers.tick(32000);await flush();assert.equal(f.requests.length,3);
});

test('未配置同步宿主不作为启动快照暂缺重试',async t=>{
 const f=fixture(t,20);f.control.failureCode='sync_unavailable';await flush();
 // 首次异步请求已读默认错误；显式读取验证配置缺失不会再安排自动请求。
 await f.sync.refresh();const count=f.requests.length;
 t.mock.timers.tick(32000);await flush();assert.equal(f.requests.length,count);
});


test('释放控制器取消恢复定时与订阅，不阻止退出且不再发请求',async t=>{
 const f=fixture(t,20);await flush();f.sync.dispose();
 f.connect(2);t.mock.timers.tick(32000);await flush();
 await f.sync.refresh();assert.equal(f.requests.length,1);
});

test('优先读取指标自动只读更新，刷新期间保留有效报告且单flight',async t=>{
 const f=fixture(t,0,true);await flush();
 assert.equal(f.sync.getState().phase,'ready');
 const original=f.sync.getState().report;
 let release;f.control.barrier=new Promise(resolve=>{release=resolve;});
 t.mock.timers.tick(3000);await flush();
 assert.equal(f.requests.filter(request=>request.path==='/api/sync/status').length,2);
 assert.equal(f.sync.getState().phase,'ready');
 assert.deepEqual(f.sync.getState().report,original);
 t.mock.timers.tick(9000);await flush();assert.equal(f.requests.length,2);
 f.control.extra.cli_priority_last_success_at='2026-10-19T06:00:03+00:00';
 release();await flush();
 assert.equal(f.sync.getState().report.priority.lastSuccessAt,'2026-10-19T06:00:03+00:00');
 assert.ok(f.requests.every(request=>request.method==='GET'));
});

test('用户关闭同步可取消在途只读轮询，迟到结果不能恢复轮询',async t=>{
 const f=fixture(t,0,true);await flush();
 let release;f.control.barrier=new Promise(resolve=>{release=resolve;});
 t.mock.timers.tick(3000);await flush();
 const poll=f.requests.at(-1);
 f.control.barrier=undefined;f.control.extra.sync_enabled=false;
 try {
  await f.sync.disable({scopeRevision:1});
  assert.equal(poll.signal.aborted,true);
  assert.equal(f.sync.getState().report.enabled,false);
 } finally {release();}
 await flush();t.mock.timers.tick(12000);await flush();
 assert.equal(f.requests.filter(request=>request.path==='/api/sync/disable').length,1);
 assert.equal(f.requests.filter(request=>request.path==='/api/sync/status').length,2);
 assert.equal(f.sync.getState().report.enabled,false);
});

test('删除期间暂停同步状态读取，结束后静默补读一次并保留报告', async t=>{
 const quiet=new ports.ContactDeletionQuiet();
 const f=fixture(t,0,false,quiet);await flush();
 assert.equal(f.sync.getState().phase,'ready');
 const before=f.sync.getState();
 const reads=f.requests.filter(request=>request.path==='/api/sync/status').length;
 const finish=quiet.begin();
 await f.sync.refresh();await flush();
 assert.equal(f.requests.filter(request=>request.path==='/api/sync/status').length,reads,'删除窗口内不读取同步状态');
 assert.deepEqual(f.sync.getState(),before,'窗口内保留上一次成功报告');
 finish();await flush();
 assert.equal(f.requests.filter(request=>request.path==='/api/sync/status').length,reads+1,'窗口结束后静默补读一次');
 assert.equal(f.sync.getState().phase,'ready');
 assert.deepEqual(f.sync.getState().report,before.report);
 assert.equal(f.sync.getState().errorCode,null);
});

test('删除期间自动只读轮询暂停，结束后补读一次', async t=>{
 const quiet=new ports.ContactDeletionQuiet();
 const f=fixture(t,0,true,quiet);await flush();
 assert.equal(f.sync.getState().phase,'ready');
 const reads=f.requests.filter(request=>request.path==='/api/sync/status').length;
 const finish=quiet.begin();
 t.mock.timers.tick(3000);await flush();
 assert.equal(f.requests.filter(request=>request.path==='/api/sync/status').length,reads,'窗口内不发起只读轮询');
 assert.equal(f.sync.getState().phase,'ready');
 finish();await flush();
 assert.equal(f.requests.filter(request=>request.path==='/api/sync/status').length,reads+1,'窗口结束后仅补读一次');
 assert.equal(f.sync.getState().phase,'ready');
});

test('删除窗口内在途只读刷新失败保留上一次报告，不显示读取失败', async t=>{
 const quiet=new ports.ContactDeletionQuiet();
 const f=fixture(t,0,true,quiet);await flush();
 const before=f.sync.getState();
 let release;
 f.control.barrier=new Promise(resolve=>{release=resolve;});
 f.control.failures=1;
 t.mock.timers.tick(3000);await flush();
 assert.equal(f.requests.filter(request=>request.path==='/api/sync/status').length,2,'只读快照已发出并在等回执');
 const finish=quiet.begin();
 release();await flush();
 assert.equal(f.sync.getState().phase,'ready');
 assert.deepEqual(f.sync.getState().report,before.report);
 finish();await flush();
 assert.equal(f.sync.getState().phase,'ready');
 assert.equal(f.sync.getState().errorCode,null);
 assert.equal(f.requests.filter(request=>request.path==='/api/sync/status').length,3,'窗口结束后补读一次');
});

test('删除结束补读仍失败时保留旧态并继续原有退避恢复', async t=>{
 const quiet=new ports.ContactDeletionQuiet();
 const f=fixture(t,20,false,quiet);await flush();
 const reads=()=>f.requests.filter(request=>request.path==='/api/sync/status').length;
 assert.equal(f.sync.getState().phase,'unavailable');
 assert.equal(reads(),1);
 const finish=quiet.begin();
 t.mock.timers.tick(1000);await flush();
 assert.equal(reads(),1,'窗口内到的恢复定时不发起读取');
 assert.equal(f.sync.getState().phase,'unavailable');
 finish();await flush();
 assert.equal(reads(),2,'窗口结束补读一次');
 assert.equal(f.sync.getState().phase,'unavailable','补读失败保留旧态');
 t.mock.timers.tick(1000);await flush();
 assert.equal(reads(),3,'补读失败后继续按原有退避自动恢复');
});

test('删除结束补读成功清除上一次读取错误码', async t=>{
 const quiet=new ports.ContactDeletionQuiet();
 const f=fixture(t,1,false,quiet);await flush();
 assert.equal(f.sync.getState().phase,'unavailable');
 assert.equal(f.sync.getState().errorCode,'status-unconfirmed');
 const finish=quiet.begin();
 await f.sync.refresh();await flush();
 assert.equal(f.sync.getState().phase,'unavailable','窗口内失败不改变旧态');
 assert.equal(f.sync.getState().errorCode,'status-unconfirmed');
 finish();await flush();
 assert.equal(f.sync.getState().phase,'ready');
 assert.equal(f.sync.getState().errorCode,null,'补读成功后不再显示旧读取错误');
 assert.ok(f.sync.getState().report);
});
