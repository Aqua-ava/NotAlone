import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {HostStorage,HostStorageError} from '../src/host-storage.ts';
import {SyncIncrementalStore} from '../src/sync-incremental-store.ts';
import {BindingService} from '../src/binding-service.ts';
import {normalizeCliEvents} from '../src/sync-incremental-normalize.ts';
import {createStorageFixture} from './host-storage-fixture.mjs';
async function fixture(t){
  const f=await createStorageFixture(),storage=await HostStorage.open(f.options),owner=randomUUID();
  t.after(async()=>{await storage.close();await f.close();});
  await f.client.query('INSERT INTO public.owner(id,display_name) VALUES($1,$2)',[owner,'合成本人']);
  await f.client.query("INSERT INTO public.owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic_account','合成本人')",[owner]);
  const bindings=new BindingService({storage,ownerId:owner,channel:'wechat',accountScope:'synthetic_account',sessions:async()=>['synthetic_a','synthetic_b'].map(username=>({username,display_name:'合成联系人',chat_type:'private'}))});
  const rows=await bindings.confirm([{locator:'synthetic_a'},{locator:'synthetic_b'}]);await bindings.close();
  const options={storage,ownerId:owner,accountScope:'synthetic_account'},store=new SyncIncrementalStore(options);
  await store.setEnabled(true);
  return {...f,storage,owner,options,store,a:rows[0],b:rows[1]};
}
function message(binding,id='5',time=42){return normalizeCliEvents([{message_id:{local_id:id,talker:binding.conversation_locator,server_id_str:null},text:'合成增量消息',kind:'text',sender:null,sender_wxid:null,is_from_me:false,create_time:time,time:null,time_iso:null}])[0];}
async function input(f,b=f.a,{id='5',cursor='opaque_a',time=42,nonText=false}={}){
  const position=await f.store.readPosition(b),messages=nonText?[]:[message(b,id,time)];
  return {binding:b,page:{events:[],cursor,last_local_id:id,event_count:1,non_text_count:nonText?1:0,freshness_confirmed:true,filtered_records:[],has_more:false,local_history_state:null},messages,
    since_cursor:position.cursor?.last_cursor??null,since_local_id:position.cursor?.last_local_id??null,position_token:position.position_token,cli_version:'synthetic-v1'};
}
const count=async(f,table)=>(await f.client.query(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0].n;

test('同事务保存UUID来源、原文、追踪、派生回执，重放不重复；不依赖模型配置',async t=>{
  const f=await fixture(t),i=await input(f),saved=await f.store.save(i);
  assert.equal(saved.source_created,true);assert.equal(saved.created_message_ids.length,1);
  assert.equal(await count(f,'message'),1);assert.equal(await count(f,'memory_extraction_receipt'),1);
  assert.equal((await f.client.query('SELECT pending_count FROM public.memory_extraction_schedule')).rows[0].pending_count,1);
  const ref=(await f.client.query('SELECT source_locator,raw_payload FROM public.message_source_ref')).rows[0];assert.equal(ref.source_locator,'cli:v2:5:42');assert.equal(ref.raw_payload.text,'合成增量消息');
  const repeated=await f.store.save(i);assert.equal(repeated.observation_id,saved.observation_id);assert.deepEqual(repeated.created_message_ids,[]);assert.equal(await count(f,'message_source_ref'),1);
  assert.equal((await f.client.query('SELECT payload FROM public.source_processing_record ORDER BY position LIMIT 1')).rows[0].payload.model_read_status,'not_claimed');
});
test('不透明cursor允许local_id下降，跨来源重复消息仍复用；同ID不同时间独立',async t=>{
  const f=await fixture(t);const first=await f.store.save(await input(f));
  await f.store.save(await input(f,f.a,{id:'2',cursor:'opaque_b'}));
  const dup=await f.store.save(await input(f,f.a,{id:'5',cursor:'opaque_c'}));assert.equal(dup.message_ids[0],first.message_ids[0]);assert.deepEqual(dup.created_message_ids,[null]);
  await f.store.save(await input(f,f.a,{id:'5',cursor:'opaque_d',time:43}));
  assert.equal(await count(f,'message'),3);assert.equal(await count(f,'message_source_ref'),4);
  const pos=await f.store.readPosition(f.a);assert.equal(pos.cursor.last_cursor,'opaque_d');
});
test('起点并发CAS、跨联系人和空文字页水位分别隔离',async t=>{
  const f=await fixture(t),one=await input(f),stale=await input(f,f.a,{id:'6',cursor:'stale'});
  await f.store.save(one);await assert.rejects(f.store.save(stale),{code:'observation_position_stale'});
  await f.store.save(await input(f,f.b));assert.equal(await count(f,'message'),2);
  await f.store.save(await input(f,f.a,{id:'7',cursor:'media_only',nonText:true}));
  assert.equal((await f.store.readPosition(f.a)).cursor.last_cursor,'media_only');assert.equal(await count(f,'message'),2);
});
test('停读、撤销、账号变化和history占用在提交前拒绝；显式active绑定不被自动发现排除覆盖',async t=>{
  const f=await fixture(t),i=await input(f);await f.store.setEnabled(false);await assert.rejects(f.store.save(i),{code:'sync_disabled'});await f.store.setEnabled(true);
  await f.client.query('INSERT INTO public.wechat_binding_history_authorization(owner_id,contact_id,binding_id,version,authorized_at) VALUES($1,$2,$3,1,now())',[f.owner,f.a.contact_id,f.a.binding_id]);
  assert.equal((await f.store.readPosition(f.a)).history_busy,true);await assert.rejects(f.store.save(i),{code:'sync_history_busy'});
  await f.client.query('DELETE FROM public.wechat_binding_history_authorization WHERE binding_id=$1',[f.a.binding_id]);
  await f.client.query("INSERT INTO public.wechat_sync_exclusion(owner_id,channel,account_scope,locator_hash) VALUES($1,'wechat','synthetic_account',sha256(convert_to($2,'UTF8')))",[f.owner,f.a.conversation_locator]);
  await f.store.save(i);
  await f.client.query("UPDATE public.conversation_binding SET status='revoked',revoked_at=now() WHERE id=$1",[f.a.binding_id]);await assert.rejects(f.store.save(i),{code:'sync_binding_invalid'});
  await f.client.query("UPDATE public.owner_channel_identity SET status='revoked' WHERE owner_id=$1",[f.owner]);await assert.rejects(f.store.listBindings(),{code:'cli_account_changed'});
});
test('追踪墓碑、在途来源删除变化和迟到取消使消息/游标/调度整体回滚',async t=>{
  const f=await fixture(t),i=await input(f);
  await f.client.query('INSERT INTO public.source_processing_capture_tombstone(owner_id,contact_id,capture_record_id) VALUES($1,$2,$3)',[f.owner,f.a.contact_id,i.messages[0].processing_record.record_id]);
  await assert.rejects(f.store.save(i),{code:'source_processing_write_failed'});assert.equal(await count(f,'message'),0);assert.equal(await count(f,'wechat_observation_cursor'),0);
  const fresh=await input(f),saved=await f.store.save(fresh),late=await input(f,f.a,{id:'6',cursor:'late'});
  await f.client.query('DELETE FROM public.local_wechat_observation WHERE id=$1',[saved.observation_id]);await assert.rejects(f.store.save(late),{code:'observation_position_stale'});
  const next=await input(f,f.b);let cancelled=false;
  const storage={businessTransaction:operation=>f.storage.businessTransaction(client=>operation(new Proxy(client,{get(target,key){if(key==='query')return async(...args)=>{const r=await target.query(...args);if(String(args[0]).startsWith('INSERT INTO public.source_processing_record'))cancelled=true;return r;};return Reflect.get(target,key);}})))};
  const store=new SyncIncrementalStore({...f.options,storage});await assert.rejects(store.save(next,()=>{if(cancelled)throw new HostStorageError('runtime_stopping');}),{code:'runtime_stopping'});
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM public.message WHERE contact_id=$1',[f.b.contact_id])).rows[0].n,0);
});
test('baseline不前移、游标缺失从可靠来源恢复、错位CAS修复保留可靠UUID',async t=>{
  const f=await fixture(t),p=await f.store.readPosition(f.a);assert.equal((await f.store.readPosition(f.a)).baseline_at,p.baseline_at);
  const saved=await f.store.save(await input(f));
  await f.client.query('DELETE FROM public.wechat_observation_cursor WHERE owner_id=$1 AND contact_id=$2',[f.owner,f.a.contact_id]);
  assert.equal((await f.store.readPosition(f.a)).cursor.last_cursor,'opaque_a');
  await f.store.save(await input(f,f.a,{id:'3',cursor:'opaque_b'}));
  await f.client.query("UPDATE public.wechat_observation_cursor SET last_cursor='uncommitted' WHERE owner_id=$1 AND contact_id=$2",[f.owner,f.a.contact_id]);
  assert.equal((await f.store.readPosition(f.a)).cursor.last_cursor,'opaque_b');
  assert.equal((await f.client.query('SELECT id FROM public.local_wechat_observation WHERE id=$1',[saved.observation_id])).rows[0].id,saved.observation_id);
});
test('大整数ID与缺失create_time稳定去重，原旧版来源locator重放不迁移',async t=>{
  const f=await fixture(t),i=await input(f,f.a,{id:'9007199254740993',time:null}),first=await f.store.save(i);
  await f.client.query("UPDATE public.message_source_ref SET source_locator='cli:9007199254740993' WHERE observation_id=$1",[first.observation_id]);
  await f.store.save(i);
  assert.equal((await f.client.query('SELECT external_local_id,source_create_time FROM public.wechat_message_metadata')).rows[0].external_local_id,'9007199254740993');
  assert.equal((await f.client.query('SELECT source_locator FROM public.message_source_ref')).rows[0].source_locator,'cli:9007199254740993');
  assert.equal(await count(f,'message'),1);
});
test('损坏输入仅保存无正文失败追踪且不写游标/消息，不能夹带原文',async t=>{
  const f=await fixture(t),record={record_id:randomUUID(),locator:'cli_event:1',payload_json:JSON.stringify({capture_layer:'metadata_only',record_text:null,parsed:null,outcome:'input_rejected',error_code:'cli_output_invalid'})};
  await f.store.recordInputFailure(f.a,record);
  const batch=(await f.client.query('SELECT status,source_id FROM public.source_processing_batch')).rows[0];assert.equal(batch.status,'failed');assert.equal(batch.source_id,null);
  assert.equal(await count(f,'message'),0);assert.equal(await count(f,'wechat_observation_cursor'),0);
  await assert.rejects(f.store.recordInputFailure(f.a,{...record,payload_json:JSON.stringify({capture_layer:'metadata_only',record_text:'敏感原文',parsed:null})}),{code:'observation_failure_record_invalid'});
});
test('处理回执按输入位置排序并记录实际执行文件哈希与时间',async t=>{
  const {createHash}=await import('node:crypto'),{readFileSync}=await import('node:fs');
  const f=await fixture(t),i=await input(f),record=i.messages[0].processing_record;
  record.payload_json=JSON.stringify({...JSON.parse(record.payload_json),input_position:2});
  const filtered={record_id:randomUUID(),locator:'cli:1',payload_json:JSON.stringify({input_position:1,capture_layer:'metadata_only',record_text:null,outcome:'non_text_filtered'})};
  i.processing_records=[record,filtered];await f.store.save(i);
  const rows=(await f.client.query('SELECT locator,payload FROM public.source_processing_record ORDER BY position')).rows;
  assert.deepEqual(rows.map(r=>r.locator),['cli:1','cli:5']);
  const execution=rows[1].payload.persistence.execution;
  assert.equal(execution.rule_version,createHash('sha256').update(readFileSync(new URL('../src/sync-incremental-store-write.ts',import.meta.url))).digest('hex'));
  assert.ok(Date.parse(execution.finished_at)>=Date.parse(execution.started_at));
});
test('已取消提取任务不会因新消息重新领取旧回执，仅新目标进入调度',async t=>{
  const f=await fixture(t),first=await f.store.save(await input(f)),task=randomUUID();
  await f.client.query("INSERT INTO public.background_task(id,owner_id,contact_id,task_type,status,current_step,message_count) VALUES($1,$2,$3,'observation','cancelled','extract_memory',0)",[task,f.owner,f.a.contact_id]);
  const second=await f.store.save(await input(f,f.a,{id:'6',cursor:'next'}));
  const rows=(await f.client.query('SELECT message_id,task_id FROM public.memory_extraction_receipt')).rows;
  assert.equal(rows.find(r=>r.message_id===first.message_ids[0]).task_id,task);
  assert.equal(rows.find(r=>r.message_id===second.message_ids[0]).task_id,null);
  assert.equal((await f.client.query('SELECT pending_count,threshold FROM public.memory_extraction_schedule')).rows[0].pending_count,1);
});

test('提交后事件丢失可由原Python持久调度恢复且重复扫描不重复目标',async t=>{
  const f=await fixture(t);await f.store.save(await input(f));
  const {execFileSync}=await import('node:child_process'),{homedir}=await import('node:os'),{join}=await import('node:path');
  const script=`import json,sys\nfrom uuid import UUID\nfrom notalone.persistence.background_tasks import PostgresBackgroundTaskRepository\nfrom notalone.persistence.extraction_schedule import recover_due\nname=sys.argv[1]\nassert name.startswith('notalone_ts_host_') and name.endswith('_test')\nr=PostgresBackgroundTaskRepository('host=/tmp dbname='+name)\na=recover_due(r,owner_id=UUID(sys.argv[2]))\nb=recover_due(r,owner_id=UUID(sys.argv[2]))\nprint(json.dumps({'first':len(a),'same':set(a)==set(b)}))\n`;
  const result=JSON.parse(execFileSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',script,f.client.database,f.owner],{encoding:'utf8',timeout:15000,env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',NOTALONE_MANAGED_USER_DATA:f.directory,PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname}}));
  assert.deepEqual(result,{first:1,same:true});
  assert.equal(await count(f,'memory_processing_target'),1);
  assert.equal(await count(f,'background_task'),1);
  assert.ok((await f.client.query('SELECT task_id FROM public.memory_extraction_receipt')).rows[0].task_id);
});
