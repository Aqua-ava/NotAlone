import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {watch} from 'node:fs';
import {join} from 'node:path';
import {HostStorage} from '../src/host-storage.ts';
import {SyncScopeService} from '../src/sync-scope.ts';
import {createSyncIncrementalApi,isSyncIncrementalRoute} from '../src/sync-incremental-api.ts';
import {createStorageFixture} from './host-storage-fixture.mjs';
const prefix='/api/runtime/sync-incremental/';
async function fixture(t,{connected=true,owner=true}={}){
 const f=await createStorageFixture();let storage,api;t.after(async()=>{await api?.close();await storage?.close();await f.close();});
 storage=await HostStorage.open(f.options);const ownerId=owner?(await storage.initializeOwner('合成用户')).owner_id:null;
 if(connected&&owner)await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-account','合成账号')",[ownerId]);
 const executable=join(f.directory,'synthetic-cli'),log=join(f.directory,'commands.jsonl'),control=join(f.directory,'control.json');
 await writeFile(log,'');await writeFile(control,'{}');
 await writeFile(executable,`#!${process.execPath}
import fs from 'node:fs';
const a=process.argv.slice(2),control=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');const emit=data=>console.log(JSON.stringify({ok:true,data}));
if(a[0]==='--version')emit({version:'synthetic-1'});
else if(a[0]==='status')emit({status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:'synthetic-account'}}});
else if(a[0]==='sessions')emit({sessions:[{username:'friend-a',display_name:'合成联系人',chat_type:'private',last_timestamp:1}]});
else if(a[0]==='resolve-chat')emit({candidates:[{username:a[1],display_name:'合成联系人',chat_type:'private'}]});
else if(a.includes('--mode'))setInterval(()=>{},1000);
else if(a[0]==='tail'){fs.writeFileSync(${JSON.stringify(join(f.directory,'started'))},'1');if(control.hang)setInterval(()=>{},1000);else{const events=a.includes('--cursor')?[]:[{type:'message',cursor:'opaque-11',message:{id:{local_id:11,talker:a[1]},kind:'text',text:'合成消息',is_from_me:false,create_time:1792803601}}];emit({events,cursor:events.length?'opaque-11':null,freshness:{message_source:'live_message_db'},query:{chat:a[1],has_more:false}});}}
else process.exit(2);`,{mode:0o700});
 const events=[];api=await createSyncIncrementalApi({storage,executable,environment:{},publish:async batch=>events.push(...batch)});
 const internal={owner_id:ownerId,channel:'wechat',account_scope:'synthetic-account'};
 return {...f,storage,api,ownerId,events,internal,log,control,async call(command,extra={},signal){return api.execute('POST',prefix+command,{...internal,...extra},()=>{},signal??new AbortController().signal);},async bind(){const scope=new SyncScopeService({storage,ownerId,accountScope:'synthetic-account'});await scope.setMode({mode:'all_private',confirmed:true});await f.client.query('INSERT INTO front_sync_state(owner_id,enabled,enabled_at) VALUES($1,true,now())',[ownerId]);await scope.enroll([{username:'friend-a',display_name:'合成联系人',chat_type:'private'}]);await scope.setMode({mode:'selected',confirmed:true});return (await f.client.query('SELECT contact_id FROM conversation_binding WHERE owner_id=$1',[ownerId])).rows[0].contact_id;}};
}
test('未初始化运行身份时失败关闭，路由仅接收内部POST',async t=>{
 const f=await fixture(t,{owner:false,connected:false});
 assert.equal(isSyncIncrementalRoute(prefix+'cycle'),true);assert.equal(isSyncIncrementalRoute('/api/sync/status'),false);
 assert.deepEqual(await f.call('cycle'),{status:503,body:{error:'sync_unavailable'}});
 assert.equal((await f.api.execute('GET',prefix+'status',{},()=>{},new AbortController().signal)).status,404);
});
test('固定账号范围、UUID和操作字段严格校验且不读取CLI',async t=>{
 const f=await fixture(t);
 for(const extra of [{owner_id:'bad'},{channel:'other'},{account_scope:'other'}])assert.equal((await f.call('cycle',extra)).status,409);
 for(const extra of [{max_bindings:0},{max_bindings:33},{max_bindings:1.5},{max_bindings:'1'},{extra:true},{priority_contact_id:'bad'},{priority_requested_at:-1},{priority_requested_at:Infinity},{priority_requested_at:'2026-01-01'}])assert.equal((await f.call('cycle',extra)).status,400);
 assert.equal((await f.call('status',{max_bindings:1})).status,400);
 assert.equal((await f.call('priority')).status,400);
 assert.equal((await f.call('priority',{priority_contact_id:null,priority_requested_at:null})).status,200);
 assert.equal((await f.api.execute('POST',prefix+'status',JSON.stringify(f.internal).replace('"channel":"wechat"','"channel":"wechat","channel":"wechat"'))).status,400);
 assert.equal((await f.api.execute('POST',prefix+'status','x'.repeat(17000))).status,413);
 assert.equal(await readFile(f.log,'utf8'),'');
});
test('无模型配置经确定性cycle写入，重放去重，控制开关与stop不新增计时器',async t=>{
 const f=await fixture(t);const contactId=await f.bind();
 const first=await f.call('cycle',{priority_contact_id:contactId.toUpperCase(),priority_requested_at:1,max_bindings:1});assert.equal(first.status,200);assert.equal(first.body.priority_contact_id,contactId);assert.equal(f.events.length,1,JSON.stringify(first));
 assert.equal(f.events.length,1);await f.call('cycle');assert.equal(f.events.length,1);
 const saved=(await f.client.query('SELECT text_content FROM message WHERE owner_id=$1',[f.ownerId])).rows;
 assert.deepEqual(saved,[{text_content:'合成消息'}]);
 assert.equal((await f.call('disable')).body.enabled,false);
 const count=(await readFile(f.log,'utf8')).length;await f.call('cycle');assert.equal((await readFile(f.log,'utf8')).length,count);
 assert.equal((await f.call('enable')).body.enabled,true);
 await f.call('stop');const stopped=(await readFile(f.log,'utf8')).length;await f.call('cycle');assert.equal((await readFile(f.log,'utf8')).length,stopped);
 await f.call('resume');await f.call('check');await f.call('retry');assert.equal((await f.call('cycle')).status,200);
 assert.equal(f.events.length,1);
 await f.api.close();assert.equal((await f.call('status')).status,503);
 assert.equal((await f.storage.businessTransaction(c=>c.query('SELECT 1 AS n'))).rows[0].n,1);
});
async function waitForTail(f){
 let watcher,timer;const promise=new Promise((resolve,reject)=>{watcher=watch(f.directory,(_event,name)=>{if(String(name)==='started'){clearTimeout(timer);watcher.close();resolve();}});timer=setTimeout(()=>{watcher.close();reject(new Error('合成tail未开始'));},5000);});
 return {promise,close(){clearTimeout(timer);watcher.close();}};
}
test('请求取消和关闭中断实际CLI并阻止迟到保存，close保留共享storage',async t=>{
 const f=await fixture(t);await f.bind();await writeFile(f.control,JSON.stringify({hang:true}));
 const first=await waitForTail(f);t.after(()=>first.close());const controller=new AbortController();const work=f.call('cycle',{},controller.signal);await first.promise;controller.abort();
 assert.deepEqual(await work,{status:503,body:{error:'runtime_stopping'}});assert.equal(f.events.length,0);
 const second=await waitForTail(f);t.after(()=>second.close());await f.call('check');const again=f.call('cycle');await second.promise;await f.api.close();
 assert.equal((await again).status,503);assert.equal(f.events.length,0);
 assert.equal((await f.storage.businessTransaction(c=>c.query('SELECT count(*)::int AS n FROM message'))).rows[0].n,0);
});
test('assertCurrent失效拒绝执行且账号变更不能复用旧装配',async t=>{
 const f=await fixture(t);await f.bind();
 const error=Object.assign(new Error('停止'),{code:'runtime_stopping'});
 assert.equal((await f.api.execute('POST',prefix+'cycle',f.internal,()=>{throw error;})).status,503);
 assert.equal(await readFile(f.log,'utf8'),'');
 await f.client.query("UPDATE owner_channel_identity SET external_id='new-account' WHERE owner_id=$1",[f.ownerId]);
 assert.deepEqual(await f.call('status'),{status:409,body:{error:'cli_account_changed'}});
});
test('旧follow诊断控制保持兼容，pause/check/retry不新增自主读取',async t=>{
 const f=await fixture(t);await f.bind();
 assert.equal((await f.call('follow-status')).status,200);
 assert.equal((await f.call('follow-disable')).body.enabled,false);
 assert.equal((await f.call('follow-enable')).body.enabled,true);
 assert.deepEqual(await f.call('follow-interrupt'),{status:409,body:{error:'cli_follow_inactive'}});
 assert.equal((await f.call('pause')).status,200);
 await f.call('check');await f.call('retry');assert.equal(await readFile(f.log,'utf8'),'');
 assert.equal((await f.call('follow-disable',{confirmed:true})).status,400);
});
test('关闭后暂停仅更新补齐元数据，不读取CLI或改变baseline和cursor',async t=>{
 const f=await fixture(t);await f.bind();await f.call('cycle');
 await f.client.query("UPDATE cli_backfill_state SET phase='backfilling',completed_at=NULL WHERE owner_id=$1",[f.ownerId]);
 await f.call('disable');const before=await readFile(f.log,'utf8');
 const watermarks=async()=>({cursor:(await f.client.query('SELECT * FROM wechat_observation_cursor WHERE owner_id=$1',[f.ownerId])).rows,baseline:(await f.client.query('SELECT * FROM wechat_observation_baseline WHERE owner_id=$1',[f.ownerId])).rows});
 const saved=await watermarks();const paused=await f.call('pause');assert.equal(paused.status,200);assert.equal(paused.body.enabled,false);
 assert.equal((await f.client.query('SELECT phase FROM cli_backfill_state WHERE owner_id=$1',[f.ownerId])).rows[0].phase,'paused');
 await f.call('cycle');await f.call('resume');await f.call('cycle');
 assert.equal(await readFile(f.log,'utf8'),before);assert.deepEqual(await watermarks(),saved);
});
test('stop等待在途暂停数据库事务排空，旧暂停不能提交或恢复读取',async t=>{
 const f=await fixture(t);const contactId=await f.bind();await f.call('cycle');
 await f.client.query("UPDATE cli_backfill_state SET phase='backfilling',completed_at=NULL WHERE owner_id=$1",[f.ownerId]);
 await f.client.query('BEGIN');
 await f.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${f.ownerId}:${contactId}`]);
 let paused,stopped,premature;
 try{
  const pausing=f.call('pause');
  let waiting=false;
  for(let attempt=0;attempt<50;attempt++){
   await f.client.query('SELECT pg_stat_clear_snapshot()');
   waiting=(await f.client.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='advisory') AS waiting")).rows[0].waiting;
   if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(waiting,true,'暂停已进入真实PG锁等待');
  let settled=false;const stopping=f.call('stop').then(result=>{settled=true;return result;});
  await new Promise(resolve=>setTimeout(resolve,40));premature=settled;
  await f.client.query('COMMIT');[paused,stopped]=await Promise.all([pausing,stopping]);
 }finally{await f.client.query('ROLLBACK');}
 assert.equal(premature,false,'stop不得在暂停事务尚未排空时确认成功');assert.equal(stopped.status,200);assert.equal(paused.status,503);
 assert.equal((await f.client.query('SELECT phase FROM cli_backfill_state WHERE owner_id=$1',[f.ownerId])).rows[0].phase,'backfilling');
 const before=await readFile(f.log,'utf8');await f.call('cycle');assert.equal(await readFile(f.log,'utf8'),before);
});
test('关闭后暂停跳过完整历史占用，不创建baseline或修改历史补齐状态',async t=>{
 const f=await fixture(t);const contactId=await f.bind();
 const {id:bindingId}=(await f.client.query('SELECT id FROM conversation_binding WHERE owner_id=$1',[f.ownerId])).rows[0];
 await f.client.query("INSERT INTO cli_backfill_state(owner_id,contact_id,binding_id,phase,trigger_at) VALUES($1,$2,$3,'backfilling',now())",[f.ownerId,contactId,bindingId]);
 await f.client.query('INSERT INTO wechat_binding_history_authorization(owner_id,contact_id,binding_id,version,authorized_at) VALUES($1,$2,$3,1,now())',[f.ownerId,contactId,bindingId]);
 await f.client.query('DELETE FROM wechat_observation_baseline WHERE binding_id=$1',[bindingId]);
 await f.call('disable');assert.equal((await f.call('pause')).status,200);
 assert.equal((await f.client.query('SELECT phase FROM cli_backfill_state WHERE binding_id=$1',[bindingId])).rows[0].phase,'backfilling');
 assert.equal((await f.client.query('SELECT count(*)::int AS n FROM wechat_observation_baseline WHERE binding_id=$1',[bindingId])).rows[0].n,0);
 assert.equal(await readFile(f.log,'utf8'),'');
});

test('撤销迟到回执不能覆盖已完成stop，显式resume仍可恢复',async t=>{
 const f=await fixture(t);await f.bind();
 const lease=await f.api.invalidateAndDrain('scope_revoke');
 assert.equal((await f.call('stop')).status,200);
 await f.call('cycle');assert.equal(await readFile(f.log,'utf8'),'');
 // 与host撤销回调相同：等待下游期间另一stop已完成，随后迟到回执直接resume。
 f.api.resume(lease);await f.call('cycle');
 assert.equal(await readFile(f.log,'utf8'),'');
 assert.equal((await f.client.query('SELECT count(*)::int AS n FROM message')).rows[0].n,0);
 assert.equal((await f.call('resume')).status,200);await f.call('cycle');
 assert.notEqual(await readFile(f.log,'utf8'),'');
 assert.equal((await f.client.query('SELECT count(*)::int AS n FROM message')).rows[0].n,1);
});
