import {createHash,randomUUID} from 'node:crypto';
import {StorageFailure,type StorageAction,type StorageRow,type StorageTransaction,type StorageLease} from '../../storage/sqlite/contracts.ts';
import {requireSkillRevision,requireSkillRun} from '../../skills/sqlite/storage.ts';
import type {SkillRunRevision} from '../../skills/sqlite/contracts.ts';
import {requireAttempt,encode,decode} from './requests.ts';
import {requireRuntimeCurrent} from './runtime-actions.ts';
import {identifier} from './actions.ts';
import {sanitizeDiscussionFailure} from './failure.ts';
function fail(code:string):never{throw new StorageFailure(code);}
function context(tx:StorageTransaction,i:any):StorageRow{
 const row=tx.get("SELECT * FROM reply_context WHERE owner_id=? AND id=? AND request_id=? AND attempt_id=? AND contact_id=? AND discussion_id=? AND state='active'",[i.ownerId,i.contextId,i.requestId,i.attemptId,i.contactId,i.discussionId])??fail('discussion_context_invalid');
 return row;
}
function call(tx:StorageTransaction,i:any):StorageRow{
 requireAttempt(tx,i);context(tx,i);
 const row=tx.get(`SELECT c.*,o.commit_forbidden_at,o.reply_request_id,o.state operation_state FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id WHERE c.owner_id=? AND c.id=? AND c.reply_attempt_id=? AND c.reply_context_id=?`,[i.ownerId,i.callId,i.attemptId,i.contextId])??fail('discussion_call_invalid');
 if(row.reply_request_id!==i.requestId||row.commit_forbidden_at!==null||!['prepared','in_flight'].includes(String(row.operation_state))||!['prepared','sending'].includes(String(row.state)))fail('discussion_call_invalidated');
 return row;
}
function revision(tx:StorageTransaction,i:any,run:SkillRunRevision|null):void{
 if(run!==null){requireSkillRun(tx,i.ownerId,run);if(encode(run)!==context(tx,i).skill_run_json)fail('discussion_skill_revision_conflict');}
}
function event(tx:StorageTransaction,i:any,kind:string,payload:unknown):string{
 const id=randomUUID(),next=tx.get('SELECT COALESCE(MAX(event_no),0)+1 n FROM execution_event WHERE owner_id=? AND reply_attempt_id=?',[i.ownerId,i.attemptId])!.n;
 tx.run("INSERT INTO execution_event(owner_id,id,reply_attempt_id,event_no,kind,originated_call_id,payload,created_at) VALUES(?,?,?,?,?,?,?,?)",[i.ownerId,id,i.attemptId,next,kind,i.callId,encode(payload),Date.now()]);
 return id;
}
function inheritSources(tx:StorageTransaction,i:any,eventId:string,withInputs:boolean):void{
 for(const item of tx.all('SELECT * FROM reply_context_item WHERE owner_id=? AND context_id=? ORDER BY item_no',[i.ownerId,i.contextId])){
  if(withInputs)tx.run('INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,reply_context_id,context_item_no) VALUES(?,?,?,?,?,?,?)',[i.ownerId,eventId,item.item_no,item.role,item.presentation_no,i.contextId,item.item_no]);
  if(item.kind==='message')tx.run('INSERT OR IGNORE INTO event_source VALUES(?,?,?,?)',[i.ownerId,eventId,item.source_contact_id,item.record_id]);
  if(item.kind==='entry')for(const source of tx.all('SELECT s.* FROM event_source s JOIN discussion_entry e ON e.owner_id=s.owner_id AND e.origin_event_id=s.event_id WHERE e.owner_id=? AND e.id=?',[i.ownerId,item.entry_id]))tx.run('INSERT OR IGNORE INTO event_source VALUES(?,?,?,?)',[i.ownerId,eventId,source.source_contact_id,source.record_id]);
 }
}
const action=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,i:any,lease:StorageLease)=>unknown):StorageAction=>({name:`discussion.${name}`,mode,retryBusy:mode==='write',execute});
export const discussionModelActions:StorageAction[]=[
 action('unconfirmed','read',(tx,i)=>{
  const ownerId=identifier(i.owner_id),contactId=i.contact_id===null?null:identifier(i.contact_id);
  return tx.all(`SELECT DISTINCT c.request_key FROM model_call c
   JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
   JOIN operation_scope s ON s.owner_id=o.owner_id AND s.operation_id=o.id
   WHERE c.owner_id=? AND o.purpose='discussion' AND c.state IN ('sending','unknown')${contactId===null?'':' AND s.source_contact_id=?'}`,
   contactId===null?[ownerId]:[ownerId,contactId]).map(row=>String(row.request_key));
 }),
 action('recover','write',(tx,i,lease)=>{
  const ownerId=identifier(i.ownerId),attempts=tx.all(`SELECT a.id,a.request_id FROM reply_attempt a
   JOIN reply_request r ON r.owner_id=a.owner_id AND r.id=a.request_id
   WHERE a.owner_id=? AND r.kind='discussion' AND a.state='running'
   AND (a.accepted_runtime_id<>? OR a.accepted_storage_epoch<>?)`,[ownerId,lease.runtimeId,lease.epoch]);
  for(const attempt of attempts){
   // 发送授权事务已经提交时无法证明外部是否收到；重开只保留未知，不能自动重送。
   tx.run("UPDATE model_call SET state='unknown',settlement_state='unknown',error_code='runtime_interrupted' WHERE owner_id=? AND reply_attempt_id=? AND state='sending'",[ownerId,attempt.id]);
   tx.run("UPDATE model_call SET state='failed',settlement_state='settled',error_code='not_dispatched' WHERE owner_id=? AND reply_attempt_id=? AND state='prepared'",[ownerId,attempt.id]);
   for(const call of tx.all('SELECT operation_id,state FROM model_call WHERE owner_id=? AND reply_attempt_id=?',[ownerId,attempt.id])){
    if(call.state!=='unknown'&&call.state!=='failed')continue;
    tx.run("UPDATE model_operation SET state=? WHERE owner_id=? AND id=? AND state<>'sealed'",[call.state,ownerId,call.operation_id]);
    tx.run('UPDATE operation_scope SET state=? WHERE owner_id=? AND operation_id=?',[call.state==='unknown'?'unknown':'released',ownerId,call.operation_id]);
   }
   tx.run("UPDATE reply_attempt SET state='failed',finished_at=COALESCE(finished_at,?),error_code='runtime_interrupted' WHERE owner_id=? AND id=?",[Date.now(),ownerId,attempt.id]);
   tx.run("UPDATE reply_request SET state='cancelled' WHERE owner_id=? AND id=? AND state='running'",[ownerId,attempt.request_id]);
  }
  return attempts.length;
 }),
 action('prepareCall','write',(tx,i)=>{
  requireAttempt(tx,i);context(tx,i);
  if(!/^[a-f0-9]{64}$/.test(i.inputSeal)||typeof i.provider!=='string'||!i.provider||typeof i.requestKey!=='string'||!i.requestKey
   ||typeof i.model!=='string'||!i.model||!/^[a-f0-9]{64}$/.test(i.configurationId)
   ||!Number.isSafeInteger(i.inputCap)||i.inputCap<=0||!Number.isSafeInteger(i.outputCap)||i.outputCap<=0)fail('discussion_call_invalid');
  const old=tx.get('SELECT * FROM model_operation WHERE owner_id=? AND reply_request_id=?',[i.ownerId,i.requestId]);
  if(old)fail('discussion_call_already_reserved');
  tx.run("INSERT INTO model_operation(owner_id,id,purpose,reply_request_id,slot,input_seal,state) VALUES(?,?,'discussion',?,0,?,'prepared')",[i.ownerId,i.operationId,i.requestId,i.inputSeal]);
  tx.run("INSERT INTO model_call(owner_id,id,operation_id,attempt_no,reply_attempt_id,reply_context_id,provider,request_key,state,reserved_budget_units,settlement_state,model,configuration_id,input_cap,output_cap) VALUES(?,?,?,1,?,?,?,?,'prepared',0,'reserved',?,?,?,?)",[i.ownerId,i.callId,i.operationId,i.attemptId,i.contextId,i.provider,i.requestKey,i.model,i.configurationId,i.inputCap,i.outputCap]);
  tx.run("INSERT INTO operation_scope VALUES(?,?,?,'discussion','reserved')",[i.ownerId,i.operationId,i.contactId]);
  return {callId:i.callId,operationId:i.operationId};
 }),
 action('assertSkillCall','read',(tx,i)=>{call(tx,i);revision(tx,i,i.runRevision);return true;}),
 action('skillSelection','write',(tx,i)=>{
  call(tx,i);const frozen=decode<SkillRunRevision>(String(context(tx,i).skill_run_json));revision(tx,i,frozen);
  if(i.selected!==null){requireSkillRevision(tx,i.ownerId,i.selected);if(!frozen.eligible.some(a=>encode(a)===encode(i.selected)))fail('discussion_skill_revision_conflict');}
  event(tx,i,'skill_selection',{selected:i.selected});
 }),
 action('skillInput','write',(tx,i)=>{
  call(tx,i);revision(tx,i,i.runRevision);requireSkillRevision(tx,i.ownerId,i.loaded);
  if(!i.runRevision.eligible.some((a:any)=>encode(a)===encode(i.loaded))||typeof i.text!=='string'||i.text.length>100000||createHash('sha256').update(i.text).digest('hex')!==i.payloadDigest)fail('discussion_skill_input_invalid');
  if(!tx.get("SELECT 1 FROM runtime_context x JOIN runtime_copy r ON r.owner_id=x.owner_id AND r.id=x.copy_id WHERE x.owner_id=? AND x.context_id=? AND x.provenance_state='verified' AND r.state='dirty'",[i.ownerId,i.contextId]))fail('discussion_runtime_unavailable');
  const next=tx.get('SELECT COALESCE(MAX(item_no),0)+1 n FROM reply_context_item WHERE owner_id=? AND context_id=?',[i.ownerId,i.contextId])!.n;
  tx.run("INSERT INTO reply_context_item(owner_id,context_id,item_no,kind,role,presentation_no,package_id,package_revision_no) VALUES(?,?,?,'skill','loaded_skill',?,?,?)",[i.ownerId,i.contextId,next,next,i.loaded.packageId,i.loaded.revisionNo]);
  const id=event(tx,i,'skill_input',{selected:i.selected,loaded:i.loaded,relativePath:i.relativePath,text:i.text,payloadDigest:i.payloadDigest});
  tx.run('INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,reply_context_id,context_item_no) VALUES(?,?,1,?,?,?,?)',[i.ownerId,id,'loaded_skill',next,i.contextId,next]);
 }),
 action('dispatchCall','write',(tx,i)=>{
  const c=call(tx,i);revision(tx,i,i.skillRun);requireRuntimeCurrent(tx,i);
  if(c.state!=='prepared')fail('discussion_call_already_dispatched');
  if(!tx.get("SELECT 1 FROM runtime_context WHERE owner_id=? AND copy_id=? AND context_id=? AND provenance_state='verified'",[i.ownerId,i.copyId,i.contextId]))fail('discussion_runtime_input_missing');
  const b=i.budget;
  if(!b||b.provider!==c.provider||b.model!==c.model||b.maxTokens!==Number(c.output_cap)
   ||!Number.isSafeInteger(b.input_tokens)||b.input_tokens<=0||b.input_tokens>Number(c.input_cap)
   ||!Number.isSafeInteger(b.input_tokens+b.maxTokens)||!Number.isSafeInteger(b.serialized_bytes)||b.serialized_bytes<=0
   ||b.measurement_kind!=='approximate'||typeof b.measurement_id!=='string'||!b.measurement_id||!/^[a-f0-9]{64}$/.test(b.request_sha256))fail('discussion_call_budget_invalid');
  const payload=JSON.stringify(i.requestPayload);if(!payload||payload.length>2_000_000)fail('discussion_call_payload_invalid');
  const id=event(tx,i,'model_request',{format:'dsh-input-v1',request:i.requestPayload});inheritSources(tx,i,id,true);
  tx.run("UPDATE model_call SET state='sending',sent_at=?,reserved_budget_units=?,receipt=? WHERE owner_id=? AND id=?",[Date.now(),b.input_tokens+b.maxTokens,JSON.stringify({format:'dsh-budget-v1',inputBudget:b}),i.ownerId,i.callId]);
  tx.run("UPDATE operation_scope SET state='sent' WHERE owner_id=? AND operation_id=?",[i.ownerId,c.operation_id]);
  tx.run("UPDATE model_operation SET state='in_flight' WHERE owner_id=? AND id=?",[i.ownerId,c.operation_id]);
  return id;
 }),
 action('commitAssistant','write',(tx,i)=>{
  const c=call(tx,i);revision(tx,i,i.skillRun);const runtime=requireRuntimeCurrent(tx,i);
  const e=i.sessionEvent,message=e?.data?.message;
  const text=Array.isArray(message?.content)?message.content.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join(''):null;
  if(c.state!=='sending'||runtime.state!=='dirty'||e.type!=='assistant/message'||e.data.interrupted||text!==i.text||typeof text!=='string'||!text.trim()||message.source?.provider!==c.provider)fail('discussion_assistant_event_invalid');
  const usage=e.data.usage;
  const counters=usage?[usage.inputTokens,usage.outputTokens,usage.cacheReadTokens??0,usage.cacheWriteTokens??0]:null;
  if(counters&&counters.some(n=>!Number.isSafeInteger(n)||n<0))fail('discussion_call_usage_invalid');
  const actual=counters?counters.reduce((sum,n)=>sum+n,0):null;
  if(actual!==null&&!Number.isSafeInteger(actual))fail('discussion_call_usage_invalid');
  tx.run("UPDATE model_call SET state='succeeded',received_at=?,actual_budget_units=?,receipt=?,settlement_state='settled' WHERE owner_id=? AND id=?",[Date.now(),actual,JSON.stringify({format:'dsh-assistant-event-v1',seq:e.seq,usage:usage??null,inputBudget:JSON.parse(String(c.receipt)).inputBudget}),i.ownerId,i.callId]);
  tx.run("UPDATE operation_scope SET state='released' WHERE owner_id=? AND operation_id=?",[i.ownerId,c.operation_id]);
  tx.run("UPDATE model_operation SET state='applied' WHERE owner_id=? AND id=?",[i.ownerId,c.operation_id]);
  const id=event(tx,i,'assistant_message',{text,sessionEvent:e});inheritSources(tx,i,id,true);
  const pos=tx.get('SELECT COALESCE(MAX(position),0)+1 n FROM discussion_entry WHERE owner_id=? AND discussion_id=?',[i.ownerId,i.discussionId])!.n;
  tx.run("INSERT INTO discussion_entry(owner_id,id,contact_id,discussion_id,position,role,body,origin_request_id,origin_call_id,origin_event_id,content_state) VALUES(?,?,?,?,?,'assistant',?,?,?,?,'available')",[i.ownerId,randomUUID(),i.contactId,i.discussionId,pos,text,i.requestId,i.callId,id]);
  tx.run("UPDATE reply_attempt SET state='committed',finished_at=? WHERE owner_id=? AND id=?",[Date.now(),i.ownerId,i.attemptId]);tx.run("UPDATE reply_request SET state='committed' WHERE owner_id=? AND id=?",[i.ownerId,i.requestId]);
  tx.run('UPDATE runtime_copy SET committed_request_id=? WHERE owner_id=? AND id=?',[i.requestId,i.ownerId,i.copyId]);
  return {requestId:i.requestId,callId:i.callId,entryEventId:id};
 }),
 action('failCall','write',(tx,i)=>{
  // 迟到回执只结算已有调用，永远不创建讨论/恢复业务资格，也不写正文。
  const c=tx.get('SELECT * FROM model_call WHERE owner_id=? AND id=? AND reply_attempt_id=?',[i.ownerId,i.callId,i.attemptId]);if(!c)return;
  if(!['prepared','sending'].includes(String(c.state)))return;
  const state=i.dispatched?'unknown':'failed';
  const failure=sanitizeDiscussionFailure(i.failure);
  if(failure)tx.run('UPDATE model_call SET receipt=? WHERE owner_id=? AND id=?',
   [JSON.stringify({...(c.receipt?JSON.parse(String(c.receipt)):{}),failure}),i.ownerId,i.callId]);
  tx.run('UPDATE model_call SET state=?,error_code=?,settlement_state=? WHERE owner_id=? AND id=?',[state,'discussion_call_failed',i.dispatched?'unknown':'settled',i.ownerId,i.callId]);tx.run('UPDATE model_operation SET state=? WHERE owner_id=? AND id=?',[state==='unknown'?'unknown':'failed',i.ownerId,c.operation_id]);
  tx.run('UPDATE operation_scope SET state=? WHERE owner_id=? AND operation_id=?',[i.dispatched?'unknown':'released',i.ownerId,c.operation_id]);
  tx.run("UPDATE reply_attempt SET state='failed',finished_at=?,error_code=? WHERE owner_id=? AND id=? AND state='running'",[Date.now(),'discussion_call_failed',i.ownerId,i.attemptId]);
  tx.run("UPDATE reply_request SET state='cancelled' WHERE owner_id=? AND id=? AND state='running'",[i.ownerId,c.reply_attempt_id?i.requestId:null]);
 }),
];
