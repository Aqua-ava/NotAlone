import {randomUUID} from 'node:crypto';
import {sha256} from '../../platform/sha256.ts';
import {StorageFailure,type StorageAction,type StorageRow,type StorageTransaction,type StorageLease} from '../../storage/sqlite/contracts.ts';
import {requireSkillRevision,requireSkillRun} from '../../skills/sqlite/storage.ts';
import type {SkillRunRevision} from '../../skills/sqlite/contracts.ts';
import {requireAttempt,encode,decode} from './requests.ts';
import {requireRuntimeCurrent} from './runtime-actions.ts';
import {identifier} from './actions.ts';
import {sanitizeDiscussionFailure,sanitizeDiscussionErrorCode} from './failure.ts';
import {dropSkillContext} from './skill-fallback.ts';
function fail(code:string):never{throw new StorageFailure(code);}
function context(tx:StorageTransaction,i:any):StorageRow{
 const row=tx.get("SELECT * FROM reply_context WHERE owner_id=? AND id=? AND request_id=? AND attempt_id=? AND contact_id=? AND discussion_id=? AND state='active'",[i.ownerId,i.contextId,i.requestId,i.attemptId,i.contactId,i.discussionId])??fail('discussion_context_invalid');
 return row;
}
function call(tx:StorageTransaction,i:any):StorageRow{
 const row=tx.get(`SELECT c.*,o.commit_forbidden_at,o.reply_request_id,o.state operation_state FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id WHERE c.owner_id=? AND c.id=? AND c.reply_attempt_id=? AND c.reply_context_id=?`,[i.ownerId,i.callId,i.attemptId,i.contextId]);
 if(row&&row.reply_request_id===i.requestId&&row.commit_forbidden_at!==null)fail('discussion_call_invalidated');
 requireAttempt(tx,i);context(tx,i);
 if(!row)fail('discussion_call_invalid');
 if(row.reply_request_id!==i.requestId||row.commit_forbidden_at!==null||!['prepared','in_flight'].includes(String(row.operation_state))||!['prepared','sending'].includes(String(row.state)))fail('discussion_call_invalidated');
 return row;
}
export {call as requireDiscussionCall};
function revision(tx:StorageTransaction,i:any,run:SkillRunRevision|null):void{
 if(run!==null){requireSkillRun(tx,i.ownerId,run);if(encode(run)!==context(tx,i).skill_run_json)fail('discussion_skill_revision_conflict');}
}
function event(tx:StorageTransaction,i:any,kind:string,payload:unknown):string{
 const id=randomUUID(),next=tx.get('SELECT COALESCE(MAX(event_no),0)+1 n FROM execution_event WHERE owner_id=? AND reply_attempt_id=?',[i.ownerId,i.attemptId])!.n;
 tx.run("INSERT INTO execution_event(owner_id,id,reply_attempt_id,event_no,kind,originated_call_id,payload,created_at) VALUES(?,?,?,?,?,?,?,?)",[i.ownerId,id,i.attemptId,next,kind,i.callId,encode(payload),Date.now()]);
 return id;
}
function usageUnits(usage:any):number|null{
 if(usage===null||usage===undefined)return null;
 const values=[usage.inputTokens,usage.outputTokens,usage.cacheReadTokens??0,usage.cacheWriteTokens??0];
 if(values.some(n=>!Number.isSafeInteger(n)||n<0))fail('discussion_call_usage_invalid');
 const total=values.reduce((sum,n)=>sum+n,0);
 if(!Number.isSafeInteger(total))fail('discussion_call_usage_invalid');
 return total;
}
function inheritSources(tx:StorageTransaction,i:any,eventId:string,withInputs:boolean):void{
 if(tx.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reply_candidate_input'")){
  for(const item of tx.all('SELECT item_no FROM reply_candidate_input WHERE owner_id=? AND context_id=?',[i.ownerId,i.contextId]))if(withInputs)tx.run('INSERT INTO reply_execution_input VALUES(?,?,?,?)',[i.ownerId,eventId,i.contextId,item.item_no]);
  for(const s of tx.all('SELECT DISTINCT source_contact_id,record_id FROM reply_candidate_input_source WHERE owner_id=? AND context_id=?',[i.ownerId,i.contextId]))tx.run('INSERT OR IGNORE INTO event_source VALUES(?,?,?,?)',[i.ownerId,eventId,s.source_contact_id,s.record_id]);
 }

 for(const item of tx.all('SELECT * FROM reply_context_item WHERE owner_id=? AND context_id=? ORDER BY item_no',[i.ownerId,i.contextId])){
  if(withInputs)tx.run('INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,reply_context_id,context_item_no) VALUES(?,?,?,?,?,?,?)',[i.ownerId,eventId,item.item_no,item.role,item.presentation_no,i.contextId,item.item_no]);
  if(item.kind==='message')tx.run('INSERT OR IGNORE INTO event_source VALUES(?,?,?,?)',[i.ownerId,eventId,item.source_contact_id,item.record_id]);
  if(item.kind==='entry')for(const source of tx.all('SELECT s.* FROM event_source s JOIN discussion_entry e ON e.owner_id=s.owner_id AND e.origin_event_id=s.event_id WHERE e.owner_id=? AND e.id=?',[i.ownerId,item.entry_id]))tx.run('INSERT OR IGNORE INTO event_source VALUES(?,?,?,?)',[i.ownerId,eventId,source.source_contact_id,source.record_id]);
 }
}
/** 本机调用已结束后封存未知结果；保留回执与未知成本，禁止迟到提交。 */
function abandonUnknown(tx:StorageTransaction,ownerId:string,operationId:string,now:number):void{
 // 存量也可能在尝试终止后留下 sending；已收到的物理回执不能改成未知。
 tx.run("UPDATE model_call SET state='succeeded' WHERE owner_id=? AND operation_id=? AND state='sending' AND settlement_state='settled' AND json_extract(receipt,'$.format')='dsh-physical-step-v1'",[ownerId,operationId]);
 tx.run("UPDATE model_call SET state='unknown',settlement_state='unknown' WHERE owner_id=? AND operation_id=? AND state='sending'",[ownerId,operationId]);
 tx.run("UPDATE model_call SET state='failed',error_code='unknown_abandoned' WHERE owner_id=? AND operation_id=? AND state='unknown'",[ownerId,operationId]);
 tx.run("UPDATE model_operation SET state='sealed',commit_forbidden_at=COALESCE(commit_forbidden_at,?) WHERE owner_id=? AND id=?",[now,ownerId,operationId]);
 tx.run("UPDATE operation_scope SET state='released' WHERE owner_id=? AND operation_id=?",[ownerId,operationId]);
}
const action=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,i:any,lease:StorageLease)=>unknown):StorageAction=>({name:`discussion.${name}`,mode,retryBusy:mode==='write',execute});
/** 候选入口必须先通过自己的正式知识reader；这里继续复验共同的调用与来源。 */
export function dropSkillForCurrentCall(tx:StorageTransaction,i:any){
 call(tx,i);const result=dropSkillContext(tx,i,context(tx,i));
 event(tx,i,'skill_unavailable',{message:'回复策略暂不可用'});
 return result;
}
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
   WHERE a.owner_id=? AND r.kind IN ('discussion','reply') AND a.state='running'
   AND (a.accepted_runtime_id<>? OR a.accepted_storage_epoch<>?)`,[ownerId,lease.runtimeId,lease.epoch]);
  for(const attempt of attempts){
   // 已有逐次真实回执的首行只因逻辑任务未提交而仍是sending；崩溃不能抹掉其已结算事实。
   tx.run("UPDATE model_call SET state='succeeded' WHERE owner_id=? AND reply_attempt_id=? AND state='sending' AND settlement_state='settled' AND json_extract(receipt,'$.format')='dsh-physical-step-v1'",[ownerId,attempt.id]);
   // 旧运行时已不在途；发送事实与成本仍未知，随后封存而不重送。
   tx.run("UPDATE model_call SET state='unknown',settlement_state='unknown',error_code='runtime_interrupted' WHERE owner_id=? AND reply_attempt_id=? AND state='sending'",[ownerId,attempt.id]);
   tx.run("UPDATE model_call SET state='failed',settlement_state='settled',error_code='not_dispatched' WHERE owner_id=? AND reply_attempt_id=? AND state='prepared'",[ownerId,attempt.id]);
   for(const operation of tx.all('SELECT DISTINCT operation_id FROM model_call WHERE owner_id=? AND reply_attempt_id=?',[ownerId,attempt.id])){
    const unknown=!!tx.get("SELECT 1 FROM model_call WHERE owner_id=? AND operation_id=? AND state='unknown'",[ownerId,operation.operation_id]);
    if(unknown)abandonUnknown(tx,ownerId,String(operation.operation_id),Date.now());
    else{
     tx.run("UPDATE model_operation SET state='failed' WHERE owner_id=? AND id=? AND state<>'sealed'",[ownerId,operation.operation_id]);
     tx.run("UPDATE operation_scope SET state='released' WHERE owner_id=? AND operation_id=?",[ownerId,operation.operation_id]);
    }
   }
   tx.run("UPDATE reply_attempt SET state='failed',finished_at=COALESCE(finished_at,?),error_code='runtime_interrupted' WHERE owner_id=? AND id=?",[Date.now(),ownerId,attempt.id]);
   tx.run("UPDATE reply_request SET state='cancelled' WHERE owner_id=? AND id=? AND state='running'",[ownerId,attempt.request_id]);
  }
  // 升级前已终止的未知调用也需释放；当前运行时仍在执行的请求不可越过。
  for(const operation of tx.all(`SELECT o.id FROM model_operation o
   WHERE o.owner_id=? AND o.purpose='discussion' AND o.state IN ('in_flight','unknown')
   AND o.commit_forbidden_at IS NULL AND o.reply_request_id IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM reply_attempt a WHERE a.owner_id=o.owner_id AND a.request_id=o.reply_request_id
    AND a.state='running' AND a.accepted_runtime_id=? AND a.accepted_storage_epoch=?)`,[ownerId,lease.runtimeId,lease.epoch])){
   abandonUnknown(tx,ownerId,String(operation.id),Date.now());
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
 action('skillUnavailable','write',(tx,i)=>{call(tx,i);return event(tx,i,'skill_unavailable',{message:'回复策略暂不可用'});}),
 action('dropSkill','write',(tx,i)=>{
  if(tx.get('SELECT kind FROM reply_request WHERE owner_id=? AND id=?',[i.ownerId,i.requestId])?.kind!=='discussion')fail('discussion_skill_fallback_scope');
  return dropSkillForCurrentCall(tx,i);
 }),
 action('skillSelection','write',(tx,i)=>{
  call(tx,i);const frozen=decode<SkillRunRevision>(String(context(tx,i).skill_run_json));revision(tx,i,frozen);
  if(i.selected!==null){requireSkillRevision(tx,i.ownerId,i.selected);if(!frozen.eligible.some(a=>encode(a)===encode(i.selected)))fail('discussion_skill_revision_conflict');}
  const name=i.name===undefined?null:i.name,preload=i.preload===undefined?null:i.preload;
  if(name!==null&&(typeof name!=='string'||!name||name.length>4096)
   ||preload!==null&&(!preload||!['explicit','auto_preload'].includes(preload.origin)||typeof preload.catalogRevision!=='string'||!preload.catalogRevision||preload.catalogRevision.length>65536))fail('discussion_skill_trace_invalid');
  event(tx,i,'skill_selection',{selected:i.selected,...(name===null?{}:{name}),preload});
 }),
 action('skillInput','write',(tx,i)=>{
  call(tx,i);revision(tx,i,i.runRevision);requireSkillRevision(tx,i.ownerId,i.loaded);
  if(!i.runRevision.eligible.some((a:any)=>encode(a)===encode(i.loaded))||typeof i.text!=='string'||Buffer.byteLength(i.text,'utf8')>1024*1024||sha256(i.text)!==i.payloadDigest)fail('discussion_skill_input_invalid');
  if(i.name!==undefined&&(typeof i.name!=='string'||!i.name||i.name.length>4096))fail('discussion_skill_input_invalid');
  if(i.preload!==undefined&&(!i.preload||!['explicit','auto_preload'].includes(i.preload.origin)||typeof i.preload.catalogRevision!=='string'||!i.preload.catalogRevision||i.preload.catalogRevision.length>65536))fail('discussion_skill_input_invalid');
  if(!tx.get("SELECT 1 FROM runtime_context x JOIN runtime_copy r ON r.owner_id=x.owner_id AND r.id=x.copy_id WHERE x.owner_id=? AND x.context_id=? AND x.provenance_state='verified' AND r.state='dirty'",[i.ownerId,i.contextId]))fail('discussion_runtime_unavailable');
  const next=tx.get('SELECT COALESCE(MAX(item_no),0)+1 n FROM reply_context_item WHERE owner_id=? AND context_id=?',[i.ownerId,i.contextId])!.n;
  tx.run("INSERT INTO reply_context_item(owner_id,context_id,item_no,kind,role,presentation_no,package_id,package_revision_no) VALUES(?,?,?,'skill','loaded_skill',?,?,?)",[i.ownerId,i.contextId,next,next,i.loaded.packageId,i.loaded.revisionNo]);
  const id=event(tx,i,'skill_input',{selected:i.selected,loaded:i.loaded,relativePath:i.relativePath,text:i.text,payloadDigest:i.payloadDigest,...(i.name===undefined?{}:{name:i.name}),...(i.preload===undefined?{}:{preload:i.preload})});
  tx.run('INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,reply_context_id,context_item_no) VALUES(?,?,1,?,?,?,?)',[i.ownerId,id,'loaded_skill',next,i.contextId,next]);
 }),
 action('skillPreload','write',(tx,i)=>{
  call(tx,i);const frozen=decode<SkillRunRevision>(String(context(tx,i).skill_run_json));revision(tx,i,frozen);
  const preload=i.preload,entries=Array.isArray(i.entries)?i.entries:[];
  if(!preload||!['explicit','auto_preload'].includes(preload.origin)||typeof preload.catalogRevision!=='string'||!preload.catalogRevision||preload.catalogRevision.length>65536)fail('discussion_skill_trace_invalid');
  if(!entries.length||entries.length>256||entries.length!==frozen.eligible.length)fail('discussion_skill_preload_invalid');
  const expected=frozen.eligible.map(anchor=>encode(anchor)).sort(),actual=entries.map((entry:any)=>encode(entry?.loaded)).sort();
  if(JSON.stringify(expected)!==JSON.stringify(actual))fail('discussion_skill_revision_conflict');
  for(const entry of entries){
   if(!entry||encode(entry.selected)!==encode(entry.loaded)||entry.relativePath!=='SKILL.md'
    ||typeof entry.name!=='string'||!entry.name||entry.name.length>4096
    ||typeof entry.text!=='string'||Buffer.byteLength(entry.text,'utf8')>1024*1024
    ||typeof entry.payloadDigest!=='string'||sha256(entry.text)!==entry.payloadDigest)fail('discussion_skill_input_invalid');
   requireSkillRevision(tx,i.ownerId,entry.loaded);
  }
  if(!tx.get("SELECT 1 FROM runtime_context x JOIN runtime_copy r ON r.owner_id=x.owner_id AND r.id=x.copy_id WHERE x.owner_id=? AND x.context_id=? AND x.provenance_state='verified' AND r.state='dirty'",[i.ownerId,i.contextId]))fail('discussion_runtime_unavailable');
  for(const entry of entries)event(tx,i,'skill_selection',{selected:entry.selected,name:entry.name,preload});
  let next=tx.get('SELECT COALESCE(MAX(item_no),0) n FROM reply_context_item WHERE owner_id=? AND context_id=?',[i.ownerId,i.contextId])!.n as bigint;
  for(const entry of entries){
   next+=1n;
   tx.run("INSERT INTO reply_context_item(owner_id,context_id,item_no,kind,role,presentation_no,package_id,package_revision_no) VALUES(?,?,?,'skill','loaded_skill',?,?,?)",[i.ownerId,i.contextId,next,next,entry.loaded.packageId,entry.loaded.revisionNo]);
   const id=event(tx,i,'skill_input',{selected:entry.selected,loaded:entry.loaded,relativePath:entry.relativePath,text:entry.text,payloadDigest:entry.payloadDigest,name:entry.name,preload});
   tx.run('INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,reply_context_id,context_item_no) VALUES(?,?,1,?,?,?,?)',[i.ownerId,id,'loaded_skill',next,i.contextId,next]);
  }
 }),
 action('dispatchCall','write',(tx,i)=>{
  const c=call(tx,i);revision(tx,i,i.skillRun);requireRuntimeCurrent(tx,i);
  const physicalCallId=identifier(i.physicalCallId??i.callId),first=physicalCallId===i.callId;
  if(first&&c.state!=='prepared')fail('discussion_call_already_dispatched');
  if(!first){
   if(c.state!=='sending'||c.settlement_state!=='settled')fail('discussion_step_not_settled');
   const previous=tx.all('SELECT id,state,settlement_state FROM model_call WHERE owner_id=? AND operation_id=? ORDER BY attempt_no',[i.ownerId,c.operation_id]);
   if(previous.length>=5)fail('discussion_call_limit');
   if(previous.some(p=>p.id===physicalCallId))fail('discussion_call_already_dispatched');
   if(previous.some(p=>p.id!==i.callId&&(p.state!=='succeeded'||p.settlement_state!=='settled')))fail('discussion_step_not_settled');
   tx.run("INSERT INTO model_call(owner_id,id,operation_id,attempt_no,reply_attempt_id,reply_context_id,provider,request_key,state,reserved_budget_units,settlement_state,model,configuration_id,input_cap,output_cap) VALUES(?,?,?,?,?,?,?,?,'prepared',0,'reserved',?,?,?,?)",[i.ownerId,physicalCallId,c.operation_id,previous.length+1,i.attemptId,i.contextId,c.provider,physicalCallId,c.model,c.configuration_id,c.input_cap,c.output_cap]);
  }
  if(!tx.get("SELECT 1 FROM runtime_context WHERE owner_id=? AND copy_id=? AND context_id=? AND provenance_state='verified'",[i.ownerId,i.copyId,i.contextId]))fail('discussion_runtime_input_missing');
  const b=i.budget;
  if(!b||b.provider!==c.provider||b.model!==c.model||b.maxTokens!==Number(c.output_cap)
   ||!Number.isSafeInteger(b.input_tokens)||b.input_tokens<=0||b.input_tokens>Number(c.input_cap)
   ||!Number.isSafeInteger(b.input_tokens+b.maxTokens)||!Number.isSafeInteger(b.serialized_bytes)||b.serialized_bytes<=0
   ||b.measurement_kind!=='approximate'||typeof b.measurement_id!=='string'||!b.measurement_id||!/^[a-f0-9]{64}$/.test(b.request_sha256))fail('discussion_call_budget_invalid');
  const payload=JSON.stringify(i.requestPayload);if(!payload||Buffer.byteLength(payload,'utf8')>16*1024*1024)fail('discussion_call_payload_invalid');
  const id=event(tx,{...i,callId:physicalCallId},'model_request',{format:'dsh-input-v1',request:i.requestPayload});inheritSources(tx,i,id,true);
  tx.run("UPDATE model_call SET state='sending',sent_at=?,reserved_budget_units=?,receipt=? WHERE owner_id=? AND id=?",[Date.now(),b.input_tokens+b.maxTokens,JSON.stringify({format:'dsh-budget-v1',inputBudget:b}),i.ownerId,physicalCallId]);
  tx.run("UPDATE operation_scope SET state='sent' WHERE owner_id=? AND operation_id=?",[i.ownerId,c.operation_id]);
  tx.run("UPDATE model_operation SET state='in_flight' WHERE owner_id=? AND id=?",[i.ownerId,c.operation_id]);
  return id;
 }),
 action('settleStep','write',(tx,i)=>{
  const base=call(tx,i),physicalCallId=identifier(i.physicalCallId??i.callId);
  const physical=tx.get("SELECT * FROM model_call WHERE owner_id=? AND id=? AND operation_id=? AND reply_attempt_id=? AND reply_context_id=? AND state='sending'",[i.ownerId,physicalCallId,base.operation_id,i.attemptId,i.contextId])??fail('discussion_call_invalid');
  if(physical.settlement_state!=='reserved'||!['stop','tool-calls'].includes(i.reason)||i.seq!==undefined&&i.seq!==null&&(!Number.isSafeInteger(i.seq)||i.seq<0))fail('discussion_step_receipt_invalid');
  const actual=usageUnits(i.usage),receipt={format:'dsh-physical-step-v1',seq:i.seq??null,reason:i.reason,usage:i.usage??null,inputBudget:JSON.parse(String(physical.receipt)).inputBudget};
  // 首行同时是本轮资格锚点；物理用量已结算，但其sending只在业务提交时关闭。
  tx.run('UPDATE model_call SET state=?,received_at=?,actual_budget_units=?,receipt=?,settlement_state=\'settled\' WHERE owner_id=? AND id=?',[physicalCallId===i.callId?'sending':'succeeded',Date.now(),actual,JSON.stringify(receipt),i.ownerId,physicalCallId]);
  event(tx,{...i,callId:physicalCallId},'model_step_receipt',{physicalCallId,usage:i.usage??null,reason:i.reason,seq:i.seq??null});
  return true;
 }),
 action('commitAssistant','write',(tx,i)=>{
  const c=call(tx,i);revision(tx,i,i.skillRun);const runtime=requireRuntimeCurrent(tx,i);
  const e=i.sessionEvent,message=e?.data?.message;
  const text=Array.isArray(message?.content)?message.content.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join(''):null;
  if(c.state!=='sending'||runtime.state!=='dirty'||e.type!=='assistant/message'||e.data.interrupted||text!==i.text||typeof text!=='string'||!text.trim()||message.source?.provider!==c.provider)fail('discussion_assistant_event_invalid');
  if(tx.get("SELECT 1 FROM model_call WHERE owner_id=? AND operation_id=? AND id<>? AND (state<>'succeeded' OR settlement_state<>'settled')",[i.ownerId,c.operation_id,i.callId]))fail('discussion_step_not_settled');
  const receipt=JSON.parse(String(c.receipt)),physicalSettled=receipt.format==='dsh-physical-step-v1';
  const physicalCallId=identifier(i.physicalCallId??i.callId);
  if(i.physicalCallId!==undefined||physicalSettled){
   const physical=tx.get('SELECT * FROM model_call WHERE owner_id=? AND id=? AND operation_id=? AND reply_context_id=? AND reply_attempt_id=?',[i.ownerId,physicalCallId,c.operation_id,i.contextId,i.attemptId]);
   const finalReceipt=physical?.receipt?JSON.parse(String(physical.receipt)):null;
   if(!physical||physical.settlement_state!=='settled'||finalReceipt?.format!=='dsh-physical-step-v1'||finalReceipt.reason!=='stop'
    ||finalReceipt.seq!==null&&finalReceipt.seq!==e.seq
    ||tx.get('SELECT 1 FROM model_call WHERE owner_id=? AND operation_id=? AND attempt_no>?',[i.ownerId,c.operation_id,physical.attempt_no]))fail('discussion_assistant_event_invalid');
  }
  const usage=physicalSettled?receipt.usage:e.data.usage,actual=usageUnits(usage);
  tx.run("UPDATE model_call SET state='succeeded',received_at=COALESCE(received_at,?),actual_budget_units=?,receipt=?,settlement_state='settled' WHERE owner_id=? AND id=?",[Date.now(),actual,JSON.stringify(physicalSettled?receipt:{format:'dsh-assistant-event-v1',seq:e.seq,usage:usage??null,inputBudget:receipt.inputBudget}),i.ownerId,i.callId]);
  tx.run("UPDATE operation_scope SET state='released' WHERE owner_id=? AND operation_id=?",[i.ownerId,c.operation_id]);
  tx.run("UPDATE model_operation SET state='applied' WHERE owner_id=? AND id=?",[i.ownerId,c.operation_id]);
  const id=event(tx,{...i,callId:physicalCallId},'assistant_message',{text,sessionEvent:e});inheritSources(tx,i,id,true);
  const pos=tx.get('SELECT COALESCE(MAX(position),0)+1 n FROM discussion_entry WHERE owner_id=? AND discussion_id=?',[i.ownerId,i.discussionId])!.n;
  tx.run("INSERT INTO discussion_entry(owner_id,id,contact_id,discussion_id,position,role,body,origin_request_id,origin_call_id,origin_event_id,content_state) VALUES(?,?,?,?,?,'assistant',?,?,?,?,'available')",[i.ownerId,randomUUID(),i.contactId,i.discussionId,pos,text,i.requestId,physicalCallId,id]);
  tx.run("UPDATE reply_attempt SET state='committed',finished_at=? WHERE owner_id=? AND id=?",[Date.now(),i.ownerId,i.attemptId]);tx.run("UPDATE reply_request SET state='committed' WHERE owner_id=? AND id=?",[i.ownerId,i.requestId]);
  tx.run('UPDATE runtime_copy SET committed_request_id=? WHERE owner_id=? AND id=?',[i.requestId,i.ownerId,i.copyId]);
  return {requestId:i.requestId,callId:i.callId,entryEventId:id};
 }),
 action('failCall','write',(tx,i)=>{
  // 迟到回执只结算已有调用，永远不创建讨论/恢复业务资格，也不写正文。
  const c=tx.get('SELECT * FROM model_call WHERE owner_id=? AND id=? AND reply_attempt_id=?',[i.ownerId,i.callId,i.attemptId]);if(!c)return;
  if(!['prepared','sending'].includes(String(c.state)))return;
  const failure=sanitizeDiscussionFailure(i.failure);
  const errorCode=sanitizeDiscussionErrorCode(i.code);
  let unknown=false;
  for(const physical of tx.all("SELECT * FROM model_call WHERE owner_id=? AND operation_id=? AND state IN ('prepared','sending')",[i.ownerId,c.operation_id])){
   const receipt=physical.receipt?JSON.parse(String(physical.receipt)):{};
   const settled=physical.settlement_state==='settled'&&receipt.format==='dsh-physical-step-v1';
   const state=settled?'succeeded':physical.state==='sending'&&i.dispatched?'unknown':'failed';unknown||=state==='unknown';
   if(failure&&!settled)tx.run('UPDATE model_call SET receipt=? WHERE owner_id=? AND id=?',[JSON.stringify({...receipt,failure}),i.ownerId,physical.id]);
   tx.run('UPDATE model_call SET state=?,error_code=?,settlement_state=? WHERE owner_id=? AND id=?',[state,settled?null:errorCode,state==='unknown'?'unknown':'settled',i.ownerId,physical.id]);
  }
  if(unknown)abandonUnknown(tx,i.ownerId,String(c.operation_id),Date.now());
  else{
   tx.run("UPDATE model_operation SET state='failed' WHERE owner_id=? AND id=?",[i.ownerId,c.operation_id]);
   tx.run("UPDATE operation_scope SET state='released' WHERE owner_id=? AND operation_id=?",[i.ownerId,c.operation_id]);
  }
  tx.run("UPDATE reply_attempt SET state='failed',finished_at=?,error_code=? WHERE owner_id=? AND id=? AND state='running'",[Date.now(),errorCode,i.ownerId,i.attemptId]);
  tx.run("UPDATE reply_request SET state='cancelled' WHERE owner_id=? AND id=? AND state='running'",[i.ownerId,c.reply_attempt_id?i.requestId:null]);
 }),
];
