import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {FirstHistoryCoordinator} from '../src/history/sqlite/coordinator.ts';
import {IncrementalHistoryCoordinator} from '../src/history/sqlite/incremental-coordinator.ts';
import {identityActions} from '../src/contacts/sqlite/actions.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {ContactMetadataLifetime} from '../src/storage/sqlite/deletion/contact-metadata.ts';
import {fixture,owner} from './sqlite-clear-support.mjs';

const bindings=Array.from({length:32},(_,i)=>({contact_id:`contact-${i}`,binding_id:`binding-${i}`,grant_id:`grant-${i}`,selection_generation:'1',status:'active'}));
const complete={phase:'complete',traversalComplete:true,incremental:{phase:'ready',cursorPresent:true}};
function setup(t){
 const calls=[],state={bindings:[...bindings],read_enabled:true,directories:0};
 const directory={directory:async()=>{state.directories++;return state;}};
 const history={coverage:async id=>{calls.push(id);return complete;},synchronize:async()=>{throw Error('unexpected_channel_read');},stop:async()=>{}};
 const coordinator=new FirstHistoryCoordinator(directory,history);t.after(()=>coordinator.close());return {calls,state,coordinator};
}

test('定点wake首次进入及完整扫描之后仅检查指定联系人，全局wake仍覆盖全目录',async t=>{
 const f=setup(t);f.coordinator.wakeContact(bindings[0].contact_id);await f.coordinator.waitForIdle();
 assert.deepEqual(f.calls,[bindings[0].contact_id]);
 f.calls.length=0;f.coordinator.wake();await f.coordinator.waitForIdle();assert.equal(f.calls.length,32);
 f.calls.length=0;f.coordinator.wakeContact(bindings[1].contact_id);await f.coordinator.waitForIdle();
 assert.deepEqual(f.calls,[bindings[1].contact_id]);assert.equal(f.state.directories,3);
});

test('合并多个定点wake不丢联系人，也不重新探测无关complete联系人',async t=>{
 const f=setup(t);f.coordinator.wake();await f.coordinator.waitForIdle();f.calls.length=0;
 for(const index of [3,5,3,7])f.coordinator.wakeContact(bindings[index].contact_id);
 await f.coordinator.waitForIdle();assert.deepEqual(f.calls.sort(),[3,5,7].map(i=>bindings[i].contact_id).sort());
 f.calls.length=0;f.state.bindings=f.state.bindings.filter(row=>row.contact_id!==bindings[3].contact_id);
 f.coordinator.wakeContact(bindings[3].contact_id);await f.coordinator.waitForIdle();assert.deepEqual(f.calls,[]);
 f.state.read_enabled=false;f.coordinator.wakeContact(bindings[5].contact_id);await f.coordinator.waitForIdle();assert.deepEqual(f.calls,[]);
});

test('目录查询在途新增的定点wake保留到下一扫描，不并入全量覆盖重算',async t=>{
 let resume,entered;const gate=new Promise(resolve=>{resume=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const calls=[];let reads=0;
 const directory={directory:async()=>{if(++reads===1){entered();await gate;}return {read_enabled:true,bindings};}};
 const coordinator=new FirstHistoryCoordinator(directory,{coverage:async id=>{calls.push(id);return complete;},stop:async()=>{}});t.after(()=>coordinator.close());
 coordinator.wakeContact(bindings[0].contact_id);await started;coordinator.wakeContact(bindings[1].contact_id);resume();await coordinator.waitForIdle();
 assert.deepEqual(calls,[bindings[0].contact_id,bindings[1].contact_id]);assert.equal(reads,2);
});

for(const order of ['focused-first','global-first'])test(`全局与定点wake交错${order}仍处理整个合法目录`,async t=>{
 const f=setup(t);
 if(order==='focused-first'){f.coordinator.wakeContact(bindings[0].contact_id);f.coordinator.wake();}
 else{f.coordinator.wake();f.coordinator.wakeContact(bindings[0].contact_id);}
 await f.coordinator.waitForIdle();assert.deepEqual(new Set(f.calls),new Set(bindings.map(row=>row.contact_id)));
});

test('定点扫描在途接到全局wake仍处理其他联系人',async t=>{
 let resume,entered;const gate=new Promise(resolve=>{resume=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const calls=[];let reads=0;
 const coordinator=new FirstHistoryCoordinator({directory:async()=>{if(++reads===1){entered();await gate;}return {read_enabled:true,bindings};}},
  {coverage:async id=>{calls.push(id);return complete;},stop:async()=>{}});t.after(()=>coordinator.close());
 coordinator.wakeContact(bindings[0].contact_id);await started;coordinator.wake();resume();await coordinator.waitForIdle();
 assert.deepEqual(new Set(calls),new Set(bindings.map(row=>row.contact_id)));assert.equal(reads,2);
});

test('定点唤醒仍全量核对在途读取，撤销另一联系人后排空并撤下旧状态',{timeout:3000},async t=>{
 let entered;const started=new Promise(resolve=>{entered=resolve;}),stops=[],calls=[];
 const state={read_enabled:true,bindings:[bindings[0],bindings[1]]};
 const history={coverage:async id=>{calls.push(id);return id===bindings[0].contact_id?{phase:'incomplete'}:complete;},
  synchronize:async(id,signal)=>{entered();return new Promise(resolve=>signal.addEventListener('abort',()=>resolve({phase:'stopped'}),{once:true}));},stop:async id=>{stops.push(id);}};
 const coordinator=new FirstHistoryCoordinator({directory:async()=>state},history);t.after(()=>coordinator.close());
 coordinator.wakeContact(bindings[0].contact_id);let timer;
 try{await Promise.race([started,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('缺少首次历史 synchronize 请求，未进入撤销检查')),1000);})]);}
 finally{clearTimeout(timer);}
 state.bindings=[bindings[1]];
 coordinator.wakeContact(bindings[1].contact_id);await coordinator.waitForIdle();
 assert.ok(stops.includes(bindings[0].contact_id));assert.equal(calls.filter(id=>id===bindings[0].contact_id).length,1);
 assert.equal(coordinator.getState().contacts.find(row=>row.contactId===bindings[0].contact_id),undefined);
 assert.equal(coordinator.getState().contacts.find(row=>row.contactId===bindings[1].contact_id).phase,'complete');
 assert.equal(coordinator.getState().lastError,null);
});

test('定点瞬时重试重取当前绑定与grant，其他complete联系人不被额外重扫',{timeout:2000},async t=>{
 let retried;const done=new Promise(resolve=>{retried=resolve;}),calls=[],state={read_enabled:true,bindings:[bindings[0],bindings[1]]};let runs=0;
 const history={coverage:async id=>{calls.push(id);return id===bindings[0].contact_id?{phase:'incomplete'}:complete;},
  synchronize:async()=>{if(++runs===1){state.bindings=[{...bindings[0],binding_id:'replacement',grant_id:'replacement-grant',selection_generation:'2'},bindings[1]];throw new StorageFailure('history_native_timeout');}retried();return complete;},stop:async()=>{}};
 const coordinator=new FirstHistoryCoordinator({directory:async()=>state},history,{retryMinMs:5,retryMaxMs:5});t.after(()=>coordinator.close());
 coordinator.wakeContact(bindings[0].contact_id);await done;await coordinator.waitForIdle();
 assert.equal(runs,2);assert.deepEqual(calls,[bindings[0].contact_id,bindings[0].contact_id]);assert.equal(coordinator.getState().lastError,null);
});

test('定点wake发现另一位排队联系人的绑定换代，替换旧队列且继续该人历史',{timeout:2000},async t=>{
 let started,release,scanned;const active=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;}),secondScan=new Promise(resolve=>{scanned=resolve;});
 const state={read_enabled:true,bindings:bindings.slice(0,3)},runs=[];let directories=0;
 const coordinator=new FirstHistoryCoordinator({directory:async()=>{if(++directories===2)scanned();return state;}},
  {coverage:async()=>({phase:'incomplete'}),synchronize:async id=>{runs.push(id);if(runs.length===2)started();if(id!==bindings[2].contact_id)await gate;return complete;},stop:async()=>{}});t.after(()=>coordinator.close());
 coordinator.wake();await active;state.bindings=[bindings[0],bindings[1],{...bindings[2],binding_id:'new-binding',grant_id:'new-grant',selection_generation:'2'}];
 coordinator.wakeContact(bindings[0].contact_id);await secondScan;release();await coordinator.waitForIdle();
 assert.deepEqual(new Set(runs),new Set(state.bindings.map(row=>row.contact_id)));
});

test('两个协调器经宿主轻量目录适配不查询正文统计',async t=>{
 let reads=0;
 const directory={directory:async()=>{throw Error('expensive_directory_forbidden');},syncDirectory:async()=>{reads++;return {read_enabled:true,bindings:[bindings[0]]};}};
 const history={coverage:async()=>complete,synchronize:async()=>complete,synchronizeIncremental:async()=>complete,stop:async()=>{}};
 const adapter={directory:()=>directory.syncDirectory()};
 const first=new FirstHistoryCoordinator(adapter,history),incremental=new IncrementalHistoryCoordinator(adapter,history,{intervalMs:0});
 t.after(async()=>{await incremental.close();await first.close();});first.wake();incremental.wake();await first.waitForIdle();await incremental.waitForIdle();
 assert.equal(reads,2);assert.equal(first.getState().lastError,null);assert.equal(incremental.getState().lastError,null);
});

test('轻量目录与正式目录授权字段相同，无正文计数查询且owner隔离与停读状态即时生效',async t=>{
 const f=await fixture(t),full=await f.current.contacts.directory();
 assert.deepEqual(await f.current.contacts.syncDirectory(),{read_enabled:full.read_enabled,bindings:full.bindings});
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{readOnly:true});db.exec('PRAGMA query_only=ON');t.after(()=>db.close());
 const queries=[],all=(sql,values=[])=>{queries.push(sql);assert.doesNotMatch(sql,/\b(message|capture_record|read_goal)\b/);const q=db.prepare(sql);q.setReadBigInts(true);return q.all(...values);};
 const tx={all,get:(sql,values)=>all(sql,values)[0],run:()=>{throw Error('write_forbidden');}};
 const action=identityActions.find(row=>row.name==='identity.syncDirectory');
 assert.deepEqual(action.execute(tx,{ownerId:owner},{}),await f.current.contacts.syncDirectory());assert.equal(queries.length,2);
 const other=new SqliteContactService(f.current.storage,'00000000-0000-4000-8000-000000000002',{});t.after(()=>other.close());await other.initialize();
 assert.deepEqual(await other.syncDirectory(),{read_enabled:false,bindings:[]});
 const a=full.bindings.find(row=>row.contact_id===f.contactA);
 await f.current.contacts.revoke(f.contactA,a.binding_id,a.selection_generation);assert.equal((await f.current.contacts.syncDirectory()).bindings.find(row=>row.contact_id===f.contactA).status,'revoked');
 await f.current.contacts.setReading(false);assert.equal((await f.current.contacts.syncDirectory()).read_enabled,false);
});

test('宿主生命周期的轻量目录沿current门禁，关闭后不绕过元数据停读',async t=>{
 const f=await fixture(t),lifetime=new ContactMetadataLifetime(f.current.storage,owner,f.current.holders,()=>({}));t.after(()=>lifetime.close());
 await lifetime.initialize();assert.deepEqual(await lifetime.syncDirectory(),await f.current.contacts.syncDirectory());
 await lifetime.close();await assert.rejects(lifetime.syncDirectory(),{code:'history_contact_gateway_unavailable'});
});
