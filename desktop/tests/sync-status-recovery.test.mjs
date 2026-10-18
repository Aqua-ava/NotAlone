import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const built = await build({ stdin: { contents: `
 export { SyncControlController } from './src/main/sync/controller';
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
function fixture(t, failures = 1) {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const control = { failures, failureCode:'sync_status_unavailable', mutationFailure:false, barrier:undefined };
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
   return {generation:captured,data:report()};
  } };
 const contact={directoryPhase:'ready',scopeRevision:1,selectedContactId:id,contacts:[{contactId:id}]};
 const contactListeners=new Set();
 const contacts={getState:()=>contact,onStateChanged:listener=>{contactListeners.add(listener);return()=>contactListeners.delete(listener);},
  selectContact:()=>contact};
 const foreground=new ports.ForegroundController(backend,contacts,{schedule:()=>1,cancel:()=>{}});
 const permits=[];foreground.attachChangeSource({update:permit=>permits.push(permit),dispose(){}});
 const sync=new ports.SyncControlController(backend,contacts);
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
