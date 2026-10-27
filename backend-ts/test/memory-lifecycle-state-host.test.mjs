import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {lifecycleHost} from './memory-lifecycle-host-support.mjs';

test('正式认证本人状态无需联系人且空资料保持等待，读取不创建执行事实',{timeout:60000},async t=>{
 const host=await lifecycleHost(t);
 const result=await host.request('/api/owner/memory-processing/state');
 assert.equal(result.status,200);
 assert.equal(result.data.scope,'owner');assert.equal(result.data.contact_id,null);
 assert.equal(result.data.current.status,'waiting');
 assert.equal(result.data.current.reason,'暂无待处理资料。');
 assert.deepEqual(result.data.current.actions,[]);
 assert.deepEqual(result.data.history,{entries:[],next_cursor:null});
 assert.equal((await host.request('/api/owner/memory-processing/state',{authenticated:false})).status,401);
 const runtime=await host.request('/api/runtime/status');
 assert.equal(runtime.data.taskWorker.state,'running');
 for(const table of ['background_task','memory_processing_scope','memory_processing_round']){
  assert.equal((await host.client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
 }
 assert.equal((await host.request(`/api/contacts/${randomUUID()}/memory-processing/state`)).status,404);
});

test('范围控制优先于真实失败，当前轮次不受旧历史失败覆盖，五态相互隔离',{timeout:60000},async t=>{
 const contacts={};
 const host=await lifecycleHost(t,async(f,owner)=>{
  for(const [label,status,intent,taskStatus] of [
   ['waiting','waiting','run','queued'],['processing','processing','run','running'],
   ['completed','completed','run','succeeded'],['paused','blocked','pause','failed'],
   ['blocked','processing','run','failed'],
  ]){
   const contact=randomUUID(),scope=randomUUID(),round=randomUUID(),task=randomUUID();contacts[label]={contact,scope,round,task};
   await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成范围')",[contact,owner]);
   await f.client.query('INSERT INTO memory_processing_scope(id,owner_id,contact_id,control_generation,intent) VALUES($1,$2,$3,7,$4)',[scope,owner,contact,intent]);
   await f.client.query('INSERT INTO memory_processing_round(id,scope_id,owner_id,contact_id,round_number,control_generation,status,phase) VALUES($1,$2,$3,$4,1,7,$5,\'topics\')',[round,scope,owner,contact,status]);
   await f.client.query('UPDATE memory_processing_scope SET active_round_id=$1 WHERE id=$2',[round,scope]);
   await f.client.query("INSERT INTO background_task(id,owner_id,contact_id,task_type,status,current_step,last_error_code,message_count) VALUES($1,$2,$3,'layered_memory',$4,'organize_memory',$5,0)",[task,owner,contact,taskStatus,taskStatus==='failed'?'synthetic_contract_error':null]);
   await f.client.query('INSERT INTO memory_processing_round_task(round_id,task_id,owner_id,contact_id) VALUES($1,$2,$3,$4)',[round,task,owner,contact]);
   if(taskStatus==='running')await f.client.query("INSERT INTO background_task_step(task_id,step_name,step_order,status,lease_expires_at) VALUES($1,'organize_memory',1,'running',now()+interval '1 hour')",[task]);
   await f.client.query("INSERT INTO background_task(owner_id,contact_id,task_type,status,current_step,last_error_code,message_count,updated_at) VALUES($1,$2,'observation','failed','extract_memory','old_failure',0,now()-interval '1 year')",[owner,contact]);
  }
 });
 for(const [status,{contact,round}] of Object.entries(contacts)){
  const {data,status:code}=await host.request(`/api/contacts/${contact}/memory-processing/state`);
  assert.equal(code,200);assert.equal(data.current.status,status,status);
  assert.equal(data.current.round_id,round);assert.equal(data.control_generation,7);
  assert.deepEqual(data.current.actions,[]);
 }
 const blocked=(await host.request(`/api/contacts/${contacts.blocked.contact}/memory-processing/state`)).data.current;
 assert.match(blocked.reason,/核验|处理|修复/);
 assert.equal(blocked.reason.includes('synthetic_contract_error'),false);
 const paused=(await host.request(`/api/contacts/${contacts.paused.contact}/memory-processing/state`)).data.current;
 assert.equal(paused.reason_code,'synthetic_contract_error','暂停保留原始阻碍，不能覆盖真实失败');
 assert.equal((await host.request('/api/owner/memory-processing/state')).data.current.status,'waiting');
});

test('当前状态不受历史分页截断影响，历史分页游标绑定本人和联系人范围',{timeout:60000},async t=>{
 const contact=randomUUID(),otherContact=randomUUID(),scope=randomUUID(),round=randomUUID(),latest=randomUUID();
 const host=await lifecycleHost(t,async(f,owner)=>{
  await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$3,'合成一'),($2,$3,'合成二')",[contact,otherContact,owner]);
  await f.client.query('INSERT INTO memory_processing_scope(id,owner_id,contact_id) VALUES($1,$2,$3)',[scope,owner,contact]);
  await f.client.query("INSERT INTO memory_processing_round(id,scope_id,owner_id,contact_id,round_number,control_generation,status) VALUES($1,$2,$3,$4,1,0,'completed')",[round,scope,owner,contact]);
  await f.client.query('UPDATE memory_processing_scope SET active_round_id=$1 WHERE id=$2',[round,scope]);
  for(let i=0;i<45;i++)await f.client.query("INSERT INTO background_task(owner_id,contact_id,task_type,status,current_step,message_count,last_error_code,updated_at) VALUES($1,$2,'layered_memory','failed','organize_memory',0,'old_failed',now()-$3::int*interval '1 second')",[owner,contact,i+1]);
  await f.client.query("INSERT INTO background_task(id,owner_id,contact_id,task_type,status,current_step,message_count) VALUES($1,$2,$3,'layered_memory','succeeded','organize_memory',0)",[latest,owner,contact]);
  await f.client.query('INSERT INTO memory_processing_round_task(round_id,task_id,owner_id,contact_id) VALUES($1,$2,$3,$4)',[round,latest,owner,contact]);
 });
 const first=(await host.request(`/api/contacts/${contact}/memory-processing/state`)).data;
 assert.equal(first.current.status,'completed');assert.equal(first.history.entries.length,20);
 assert.ok(first.history.next_cursor);assert.equal(first.history.entries[0].task_id,latest);
 const second=await host.request(`/api/contacts/${contact}/memory-processing/history?cursor=${first.history.next_cursor}`);
 assert.equal(second.status,200);assert.equal(second.data.entries.length,20);
 const last=(await host.request(`/api/contacts/${contact}/memory-processing/history?cursor=${second.data.next_cursor}`)).data;
 assert.equal(last.entries.length,6);assert.equal(last.next_cursor,null);
 assert.equal(new Set([...first.history.entries,...second.data.entries,...last.entries].map(task=>task.task_id)).size,46);
 assert.equal((await host.request(`/api/contacts/${otherContact}/memory-processing/history?cursor=${first.history.next_cursor}`)).status,400);
 assert.equal((await host.request(`/api/owner/memory-processing/history?cursor=${first.history.next_cursor}`)).status,400);
 assert.deepEqual((await host.request('/api/owner/memory-processing/state')).data.history.entries,[]);
 const foreignOwner=randomUUID(),foreignContact=randomUUID();
 await host.client.query("INSERT INTO owner(id,display_name) VALUES($1,'另一本人')",[foreignOwner]);
 await host.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'他人联系人')",[foreignContact,foreignOwner]);
 assert.equal((await host.request(`/api/contacts/${foreignContact}/memory-processing/state`)).status,404);
});

test('旧提取失败不能被画像成功掩盖，旧停止没有可信控制记录时不能冒充持续暂停',{timeout:60000},async t=>{
 const contact=randomUUID(),stopped=randomUUID();
 const host=await lifecycleHost(t,async(f,owner)=>{
  await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$3,'合成失败'),($2,$3,'合成停止')",[contact,stopped,owner]);
  await f.client.query("INSERT INTO background_task(owner_id,contact_id,task_type,status,current_step,message_count,last_error_code) VALUES($1,$2,'observation','failed','extract_memory',100,'source_contract_failure'),($1,$2,'layered_memory','succeeded','organize_memory',5,NULL),($1,$3,'layered_memory','cancelled','organize_memory',1,'task_cancelled')",[owner,contact,stopped]);
 });
 const failed=(await host.request(`/api/contacts/${contact}/memory-processing/state`)).data;
 assert.equal(failed.current.status,'blocked');assert.match(failed.current.reason,/旧|归属|核对/);
 assert.equal(failed.current.round_id,null);assert.equal(failed.current.total_count,null);
 assert.equal(failed.history.entries.length,2);assert.ok(failed.history.entries.every(task=>task.attribution==='legacy'));
 const cancelled=(await host.request(`/api/contacts/${stopped}/memory-processing/state`)).data;
 assert.equal(cancelled.current.status,'blocked');assert.match(cancelled.current.reason,/归属|旧/);
 assert.deepEqual(cancelled.current.actions,[]);
});

test('当前提取只展示真实消息计划计数，不把画像记忆或任务步骤相加',{timeout:60000},async t=>{
 const contact=randomUUID(),scope=randomUUID(),round=randomUUID(),task=randomUUID(),source=randomUUID();
 const host=await lifecycleHost(t,async(f,owner)=>{
  await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成计数')",[contact,owner]);
  await f.client.query('INSERT INTO memory_processing_scope(id,owner_id,contact_id) VALUES($1,$2,$3)',[scope,owner,contact]);
  await f.client.query("INSERT INTO memory_processing_round(id,scope_id,owner_id,contact_id,round_number,control_generation,status,phase,target_unit,target_count) VALUES($1,$2,$3,$4,1,0,'processing','extraction','messages',3)",[round,scope,owner,contact]);
  await f.client.query('UPDATE memory_processing_scope SET active_round_id=$1 WHERE id=$2',[round,scope]);
  await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,3)",[source,owner,contact,'c'.repeat(64)]);
  await f.client.query("INSERT INTO background_task(id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count) VALUES($1,$2,$3,$4,'import','running','extract_memory',3)",[task,owner,contact,source]);
  await f.client.query("INSERT INTO background_task_step(task_id,step_name,step_order,status,processed_count,total_count,lease_expires_at) VALUES($1,'extract_memory',1,'running',999,999,now()+interval '1 hour')",[task]);
  await f.client.query('INSERT INTO memory_processing_round_task(round_id,task_id,owner_id,contact_id) VALUES($1,$2,$3,$4)',[round,task,owner,contact]);
  await f.client.query('INSERT INTO memory_processing_plan(task_id,owner_id,contact_id) VALUES($1,$2,$3)',[task,owner,contact]);
  for(let i=0;i<3;i++){
   const message=randomUUID();
   await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content) VALUES($1,$2,$3,'user','text','合成资料')",[message,owner,contact]);
   await f.client.query("INSERT INTO memory_processing_target(task_id,message_id,owner_id,contact_id,completed_at,outcome) VALUES($1,$2,$3,$4,CASE WHEN $5 THEN now() ELSE NULL END,CASE WHEN $5 THEN 'succeeded' ELSE NULL END)",[task,message,owner,contact,i===0]);
  }
 });
 const {data}=await host.request(`/api/contacts/${contact}/memory-processing/state`);
 assert.equal(data.current.status,'processing');assert.equal(data.current.phase,'extraction');
 assert.equal(data.current.processed_count,1);assert.equal(data.current.total_count,3);assert.equal(data.current.unit,'messages');
});

test('历史读取异常不覆盖权威当前状态，状态读取异常不制造业务失败或执行事实',{timeout:60000},async t=>{
 const host=await lifecycleHost(t);
 await host.client.query('DROP TABLE memory_processing_round_task');
 const current=await host.request('/api/owner/memory-processing/state');
 assert.equal(current.status,200);assert.equal(current.data.current.status,'waiting');
 assert.match(current.data.history.error,/历史暂不可用/);
 assert.equal((await host.request('/api/owner/memory-processing/history')).status,503);
 await host.client.query('ALTER TABLE memory_processing_scope RENAME TO unavailable_processing_scope');
 const failed=await host.request('/api/owner/memory-processing/state');
 assert.deepEqual(failed,{status:503,data:{error:'memory_processing_unavailable'}});
 assert.equal((await host.client.query('SELECT count(*)::int AS n FROM background_task')).rows[0].n,0);
});

test('受阻主卡按安全错误类别给中文原因与下一步，未知技术原文只留详情',{timeout:60000},async t=>{
 const cases=[['source_unavailable','来源资料'],['model_call_outcome_unknown','调用回执'],
  ['model_configuration_unavailable','配置'],['verification_contract_invalid','核验'],['model_call_budget_exhausted','预算']];
 const contacts=[];
 const host=await lifecycleHost(t,async(f,owner)=>{
  for(const [code] of cases){
   const contact=randomUUID(),scope=randomUUID(),round=randomUUID(),task=randomUUID();contacts.push(contact);
   await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成错误类别')",[contact,owner]);
   await f.client.query('INSERT INTO memory_processing_scope(id,owner_id,contact_id) VALUES($1,$2,$3)',[scope,owner,contact]);
   await f.client.query("INSERT INTO memory_processing_round(id,scope_id,owner_id,contact_id,round_number,control_generation,status) VALUES($1,$2,$3,$4,1,0,'blocked')",[round,scope,owner,contact]);
   await f.client.query('UPDATE memory_processing_scope SET active_round_id=$1 WHERE id=$2',[round,scope]);
   await f.client.query("INSERT INTO background_task(id,owner_id,contact_id,task_type,status,current_step,message_count,last_error_code) VALUES($1,$2,$3,'layered_memory','failed','organize_memory',0,$4)",[task,owner,contact,code]);
   await f.client.query('INSERT INTO memory_processing_round_task(round_id,task_id,owner_id,contact_id) VALUES($1,$2,$3,$4)',[round,task,owner,contact]);
  }
 });
 for(let i=0;i<cases.length;i++){
  const current=(await host.request(`/api/contacts/${contacts[i]}/memory-processing/state`)).data.current;
  assert.equal(current.status,'blocked');assert.ok(current.reason.includes(cases[i][1]),cases[i][0]);
  assert.equal(current.reason.includes(cases[i][0]),false);assert.deepEqual(current.actions,[]);
 }
});
