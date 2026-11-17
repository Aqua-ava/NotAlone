import {randomUUID} from 'node:crypto';
import {sha256} from '../../../platform/sha256.ts';
import {validateModelLedgerReceipt,type ModelLedgerReceipt} from '../../../platform/models/model-ledger-contract.ts';
import type {StorageAction,StorageLease,StorageRow,StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';
import type {ReplySource} from '../../../reply/sqlite/candidates/contracts.ts';
import {DEFAULT_L2_SCENARIO_BUDGET} from '../../scenarios/document.ts';
import {isRetryableProfileVerificationError,MAX_PROFILE_VERIFICATION_ATTEMPTS,parseProfileVerificationOutput,validateProfile,type L3ProfileEntry} from '../../profiles/document.ts';
import {observedProcessingAction} from '../diagnostics.ts';
import {textId} from '../qualification.ts';
import {preconditions,revisions,task} from './actions.ts';
import {actualInputSources,eligiblePriorMembers,frozenMemories,renderDocuments,sourceStillValid,withDocumentSourceQualifications,withSourceMemo} from './basis.ts';
import {documentActualInputs,type DocumentActualInput} from './inputs.ts';
import type {DocumentClaim} from './stages.ts';
import {sceneVersions} from './publication.ts';

export type VerifiedProfileReplay={completed:true;taskId:string;runId:string}|{completed:false;claim:DocumentClaim;entries:readonly L3ProfileEntry[];verificationEventId:string;profileSaved:boolean;contacts:{contactId:string;generation:string}[]};
interface Packet {call:StorageRow;input:StorageRow;output:StorageRow;actual:DocumentActualInput[];sources:ReplySource[]}
function fail(code:string):never {throw new StorageFailure(code);}
const sourceKey=(source:ReplySource)=>JSON.stringify([source.contactId,source.recordId]);

function knownReceipt(call:StorageRow,ownerId:string,contactId:unknown):void {
 let receipt:ModelLedgerReceipt;
 try{if(typeof call.receipt!=='string')fail('document_replay_receipt_invalid');receipt=JSON.parse(call.receipt);validateModelLedgerReceipt(receipt);}
 catch{fail('document_replay_receipt_invalid');}
 if(receipt.dispatch!=='response_observed'||receipt.outcome!=='succeeded'||receipt.attempt_id!==call.id||receipt.request_id!==call.request_key
  ||receipt.owner_id!==ownerId||receipt.contact_id!==contactId||receipt.provider!==call.provider||receipt.model!==call.model||call.received_at===null)fail('document_replay_receipt_invalid');
}

/** 只认核验请求顶层的完整提案；不递归解释记忆正文中的JSON。 */
function proposalPacket(request:any):any {
 const found:any[]=[];
 for(const message of request?.messages??[])for(const block of message?.content??[]){
  if(block?.type!=='text'||typeof block.text!=='string')continue;
  let value:any;try{value=JSON.parse(block.text);}catch{continue;}
  if(Array.isArray(value?.proposal?.entries)&&Array.isArray(value.memories)&&Array.isArray(value.scenarios))found.push(value);
 }
 if(found.length!==1)fail('document_replay_proposal_invalid');return found[0];
}
function validateBindings(tx:StorageTransaction,ownerId:string,stepId:string,event:StorageRow,actual:DocumentActualInput[],sources:ReplySource[]):void {
 const used=tx.all('SELECT * FROM execution_input WHERE owner_id=? AND event_id=? ORDER BY presentation_no',[ownerId,event.id]);
 if(used.length!==actual.length||used.some((row,index)=>row.planned_step_id!==stepId||row.planned_input_no!==actual[index]?.row.input_no||row.role!==actual[index]?.role||row.presentation_no!==BigInt(index+1)))fail('document_input_incomplete');
 const saved=tx.all('SELECT source_contact_id,record_id FROM event_source WHERE owner_id=? AND event_id=?',[ownerId,event.id]).map(row=>JSON.stringify([row.source_contact_id,row.record_id])).sort();
 if(JSON.stringify(saved)!==JSON.stringify(sources.map(sourceKey).sort()))fail('document_input_incomplete');
}
function copyEvent(tx:StorageTransaction,ownerId:string,attemptId:string,stepId:string,packet:Packet,event:StorageRow):string {
 const eventId=randomUUID(),number=tx.get('SELECT coalesce(max(event_no),0)+1 AS n FROM execution_event WHERE owner_id=? AND step_attempt_id=?',[ownerId,attemptId])!.n;
 tx.run('INSERT INTO execution_event(owner_id,id,step_attempt_id,event_no,kind,originated_call_id,reused_call_id,payload,payload_format,content_state,created_at) VALUES(?,?,?,?,?,NULL,?,?,?,?,?)',
  [ownerId,eventId,attemptId,number,event.kind,packet.call.id,event.payload,event.payload_format,event.content_state,Date.now()]);
 for(const [index,item] of packet.actual.entries())tx.run('INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,planned_step_id,planned_input_no) VALUES(?,?,?,?,?,?,?)',[ownerId,eventId,index+1,item.role,index+1,stepId,item.row.input_no]);
 for(const source of packet.sources)tx.run('INSERT INTO event_source VALUES(?,?,?,?)',[ownerId,eventId,source.contactId,source.recordId]);
 return eventId;
}
function savedReplayEvent(tx:StorageTransaction,ownerId:string,stepId:string,attemptId:string,sourceAttemptId:string,packets:Packet[],verifyCallId:string):string {
 const audits=tx.all("SELECT payload,content_state FROM execution_event WHERE owner_id=? AND step_attempt_id=? AND kind='document_profile_replay'",[ownerId,attemptId]);
 if(audits.length!==1||audits[0]!.content_state!=='present')fail('document_replay_unavailable');
 let audit:any;try{audit=JSON.parse(String(audits[0]!.payload));}catch{fail('document_replay_unavailable');}
 if(audit.sourceAttemptId!==sourceAttemptId||audit.reusedCallCount!==packets.length)fail('document_replay_unavailable');
 const events=tx.all("SELECT * FROM execution_event WHERE owner_id=? AND step_attempt_id=? AND kind IN ('document_input','document_output')",[ownerId,attemptId]);
 if(events.length!==packets.length*2)fail('document_input_incomplete');let verificationEventId:string|undefined;
 for(const packet of packets)for(const original of [packet.input,packet.output]){
  const copied=events.filter(e=>e.kind===original.kind&&e.reused_call_id===packet.call.id);
  if(copied.length!==1||copied[0]!.originated_call_id!==null||copied[0]!.content_state!=='present'||copied[0]!.payload!==original.payload||copied[0]!.payload_format!==original.payload_format)fail('document_input_incomplete');
  validateBindings(tx,ownerId,stepId,copied[0]!,packet.actual,packet.sources);
  if(original.kind==='document_output'&&packet.call.id===verifyCallId)verificationEventId=String(copied[0]!.id);
 }
 if(!verificationEventId)fail('document_input_incomplete');return verificationEventId;
}
/** 同一事务内的纯读取校验；来源记忆缓存必须在下一次写入前销毁。 */
function validateReplayMaterial(tx:StorageTransaction,ownerId:string,taskId:string,t:StorageRow,stepId:string,original:StorageRow,calls:StorageRow[]){
 return withSourceMemo(()=>{
  preconditions(tx,ownerId,t);const current=revisions(tx,ownerId,t);
  if(current.memory_revision!==t.accepted_memory_revision||current.document_revision!==t.accepted_document_revision||current.current_publication_id!==t.accepted_publication_id)fail('document_publication_conflict');
  const memories=frozenMemories(tx,ownerId,stepId);
  for(const row of tx.all("SELECT * FROM step_input WHERE owner_id=? AND step_id=? AND kind='message'",[ownerId,stepId]))sourceStillValid(tx,ownerId,{contactId:String(row.source_contact_id),messageId:String(row.message_id),recordId:String(row.record_id),acceptedRevision:row.accepted_revision as bigint});
  const rendered={scenarios:sceneVersions(tx,ownerId,t,memories),profile:renderDocuments(tx,ownerId,eligiblePriorMembers(tx,ownerId,t),memories).profile};
  const packets:Packet[]=[],sourceCache=new Map<string,ReplySource[]>();let proposal:any,verifyCallId:string|undefined,verificationCount=0;
  for(const call of calls){
   const events=tx.all("SELECT * FROM execution_event WHERE owner_id=? AND step_attempt_id=? AND originated_call_id=? AND kind IN ('document_input','document_output') ORDER BY event_no",[ownerId,original.id,call.id]);
   const inputs=events.filter(e=>e.kind==='document_input'),outputs=events.filter(e=>e.kind==='document_output');
   if(inputs.length!==1||outputs.length!==1||inputs[0]!.content_state!=='present'||outputs[0]!.content_state!=='present')fail('document_input_incomplete');
   const input=inputs[0]!,output=outputs[0]!,request=JSON.parse(String(input.payload));
   if(sha256(JSON.stringify(request))!==call.input_seal)fail('document_input_incomplete');
   const actual=documentActualInputs(tx,ownerId,stepId,request),signature=JSON.stringify(actual.map(item=>[String(item.row.input_no),item.role]));
   let sources=sourceCache.get(signature);if(!sources){sources=actualInputSources(tx,ownerId,actual);sourceCache.set(signature,sources);}
   validateBindings(tx,ownerId,stepId,input,actual,sources);validateBindings(tx,ownerId,stepId,output,actual,sources);
   const blocks=JSON.parse(String(output.payload)).blocks;
   if(!Array.isArray(blocks))fail('document_input_incomplete');packets.push({call,input,output,actual,sources});
   const verifier=Array.isArray(request.tools)&&request.tools.length===1&&request.tools[0]?.name==='ProfileVerificationOutput';
   if(verifier){
    if(verifyCallId||++verificationCount>MAX_PROFILE_VERIFICATION_ATTEMPTS)fail('document_replay_proposal_invalid');
    const packet=proposalPacket(request),expected=memories.map(m=>[m.memory_id,m.revision,m.text]).sort(),received=packet.memories.map((m:any)=>[m.memory_id,m.revision,m.verbatim_text]).sort();
    if(JSON.stringify(expected)!==JSON.stringify(received)||JSON.stringify(packet.scenarios)!==JSON.stringify(rendered.scenarios))fail('document_input_incomplete');
    const candidate=validateProfile(packet.proposal,memories,DEFAULT_L2_SCENARIO_BUDGET);
    if(proposal&&JSON.stringify(candidate)!==JSON.stringify(proposal))fail('document_replay_proposal_invalid');proposal=candidate;
    let checked;
    try{checked=parseProfileVerificationOutput(blocks,proposal.entries,memories);}
    catch(error){if(isRetryableProfileVerificationError(error)&&verificationCount<MAX_PROFILE_VERIFICATION_ATTEMPTS)continue;fail('document_replay_proposal_invalid');}
    if(!checked.results.some((row:any)=>row.supported===false))fail('document_replay_unavailable');verifyCallId=String(call.id);
   }else if(blocks.some((b:any)=>b?.type==='tool-call'&&b.name==='ProfileVerificationOutput'))fail('document_replay_proposal_invalid');
  }
  if(!proposal||!verifyCallId||verifyCallId!==calls.at(-1)?.id)fail('document_replay_proposal_invalid');
  return {memories,rendered,packets,proposal,verifyCallId};
 });
}
function prepareReplay(tx:StorageTransaction,ownerId:string,taskId:string,lease:StorageLease):VerifiedProfileReplay {
 let t=task(tx,ownerId,taskId);const run=tx.get('SELECT * FROM processing_run WHERE owner_id=? AND id=?',[ownerId,t.run_id]);
 if(!run)fail('document_replay_unavailable');
 const published=tx.get("SELECT id FROM document_publication WHERE owner_id=? AND basis_task_id=? AND availability='available'",[ownerId,taskId]);
 if(published){if(revisions(tx,ownerId,t).current_publication_id!==published.id)fail('document_publication_conflict');return {completed:true,taskId,runId:String(t.run_id)};}
 if(run.pause_requested_at!==null||!['failed','incomplete','pending','running'].includes(String(run.state))||t.document_basis_state!=='frozen')fail('document_replay_unavailable');
 const steps=tx.all("SELECT * FROM processing_step WHERE owner_id=? AND task_id=? AND kind='document_profile'",[ownerId,taskId]);
 if(steps.length!==1||!['failed','succeeded'].includes(String(steps[0]!.state)))fail('document_replay_unavailable');const step=steps[0]!,stepId=String(step.id),profileSaved=step.state==='succeeded';
 if(!profileSaved&&run.state==='running')fail('document_replay_unavailable');
 const original=tx.get(`SELECT a.* FROM step_attempt a WHERE a.owner_id=? AND a.step_id=? AND a.state='failed' AND a.error_code='document_profile_unverified'
  AND EXISTS(SELECT 1 FROM model_call c WHERE c.owner_id=a.owner_id AND c.step_attempt_id=a.id) ORDER BY a.attempt_no DESC LIMIT 1`,[ownerId,stepId]);
 if(!original)fail('document_replay_unavailable');
 const laterAttempts=tx.all('SELECT * FROM step_attempt WHERE owner_id=? AND step_id=? AND attempt_no>? ORDER BY attempt_no',[ownerId,stepId,original.attempt_no]);
 const saved=profileSaved?laterAttempts.find(a=>a.id===step.successful_attempt_id&&a.state==='succeeded'):undefined;
 if(profileSaved&&(!saved||laterAttempts.at(-1)?.id!==saved.id))fail('document_replay_unavailable');
 if(laterAttempts.some(a=>(a.id!==saved?.id&&a.state!=='failed')||!tx.get("SELECT 1 FROM execution_event WHERE owner_id=? AND step_attempt_id=? AND kind='document_profile_replay'",[ownerId,a.id])||tx.get('SELECT 1 FROM model_call WHERE owner_id=? AND step_attempt_id=?',[ownerId,a.id])))fail('document_replay_unavailable');
 const contributions=tx.all('SELECT source_contact_id FROM task_contribution WHERE owner_id=? AND task_id=?',[ownerId,taskId]);
 if(!contributions.length)fail('document_scope_stale');
 for(const contribution of contributions){
  if(tx.get(`SELECT 1 FROM operation_scope scope JOIN model_operation op ON op.owner_id=scope.owner_id AND op.id=scope.operation_id
   LEFT JOIN model_call call ON call.owner_id=op.owner_id AND call.operation_id=op.id WHERE scope.owner_id=? AND scope.source_contact_id=?
   AND (scope.state<>'released' OR op.state IN ('prepared','in_flight','unknown') OR call.state IN ('prepared','sending','unknown') OR call.settlement_state IN ('reserved','unknown')) LIMIT 1`,[ownerId,contribution.source_contact_id]))fail('document_model_unknown');
 }
 if(tx.get("SELECT 1 FROM document_effect_scope WHERE owner_id=? AND scope_kind=? AND contact_id IS ? AND state<>'released' LIMIT 1",[ownerId,t.scope_kind,t.contact_id]))fail('document_model_unknown');
 const calls=tx.all(`SELECT c.*,o.input_seal,o.commit_forbidden_at,o.state operation_state,o.memory_step_id FROM model_call c
  JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id WHERE c.owner_id=? AND c.step_attempt_id=?
  ORDER BY (SELECT min(e.event_no) FROM execution_event e WHERE e.owner_id=c.owner_id AND e.step_attempt_id=c.step_attempt_id AND e.originated_call_id=c.id AND e.kind='document_input'),c.id`,[ownerId,original.id]);
 if(!calls.length||calls.some(c=>c.state!=='succeeded'||c.settlement_state!=='settled'||c.commit_forbidden_at!==null||c.memory_step_id!==stepId||!['resolved','applied','failed'].includes(String(c.operation_state))))fail('document_model_unknown');
 const expectedScopes=contributions.map(c=>String(c.source_contact_id)).sort();
 for(const call of calls){
  knownReceipt(call,ownerId,t.contact_id);
  const scopes=tx.all('SELECT source_contact_id,effect_kind,state FROM operation_scope WHERE owner_id=? AND operation_id=?',[ownerId,call.operation_id]);
  const effects=tx.all('SELECT scope_kind,contact_id,effect_kind,state FROM document_effect_scope WHERE owner_id=? AND operation_id=?',[ownerId,call.operation_id]);
  if(JSON.stringify(scopes.map(s=>String(s.source_contact_id)).sort())!==JSON.stringify(expectedScopes)||scopes.some(s=>s.effect_kind!=='document_profile'||s.state!=='released')
   ||effects.length!==1||effects[0]!.scope_kind!==t.scope_kind||effects[0]!.contact_id!==t.contact_id||effects[0]!.effect_kind!=='document_profile'||effects[0]!.state!=='released')fail('document_model_scope_incomplete');
 }
 let policy:any;try{policy=JSON.parse(String(run.policy_config));}catch{fail('document_scope_stale');}
 const later=policy?.intent==='memory_document_later_stage';
 if(later){
  if(policy.stage!=='document_profile'||!Number.isSafeInteger(policy.generation))fail('document_replay_unavailable');
  const schedule=tx.get('SELECT * FROM memory_document_later_schedule WHERE owner_id=? AND scope_key=? AND generation=?',[ownerId,t.scope_kind==='self'?'self':t.contact_id,policy.generation]);
  if(!schedule||schedule.task_id!==taskId||schedule.stage!=='document_profile'||!(profileSaved?['failed','running']:['failed']).includes(String(schedule.state))||tx.get('SELECT 1 FROM memory_document_later_schedule WHERE owner_id=? AND scope_key=? AND generation>?',[ownerId,schedule.scope_key,schedule.generation]))fail('document_replay_unavailable');
 }
 // 显式本地重试恢复运行态；任何后续核验异常由同一写事务整体回滚。
 tx.run("UPDATE processing_run SET state='pending',intent_revision=intent_revision+1 WHERE owner_id=? AND id=?",[ownerId,t.run_id]);
 const {memories,rendered,packets,proposal,verifyCallId}=validateReplayMaterial(tx,ownerId,taskId,t,stepId,original,calls);
 const now=Date.now(),attemptId=saved?String(saved.id):randomUUID();
 let verificationEventId:string|undefined;
 if(saved){
  verificationEventId=savedReplayEvent(tx,ownerId,stepId,attemptId,String(original.id),packets,verifyCallId);
  tx.run('UPDATE processing_task SET error_code=NULL WHERE owner_id=? AND id=?',[ownerId,taskId]);
 }else{
  const number=tx.get('SELECT coalesce(max(attempt_no),0)+1 AS n FROM step_attempt WHERE owner_id=? AND step_id=?',[ownerId,stepId])!.n;
  tx.run('UPDATE processing_task SET control_revision=control_revision+1,resume_no=resume_no+1,error_code=NULL WHERE owner_id=? AND id=?',[ownerId,taskId]);t=task(tx,ownerId,taskId);
  tx.run("UPDATE processing_step SET state='running',successful_attempt_id=NULL WHERE owner_id=? AND id=?",[ownerId,stepId]);
  tx.run("INSERT INTO step_attempt VALUES(?,?,?,?,?,?,?,?,?,'running',?,NULL,NULL)",[ownerId,attemptId,stepId,number,t.resume_no,randomUUID(),now+300_000,t.control_revision,lease.runtimeId,now]);
  for(const packet of packets){copyEvent(tx,ownerId,attemptId,stepId,packet,packet.input);const output=copyEvent(tx,ownerId,attemptId,stepId,packet,packet.output);if(String(packet.call.id)===verifyCallId)verificationEventId=output;}
  const eventNo=tx.get('SELECT coalesce(max(event_no),0)+1 AS n FROM execution_event WHERE owner_id=? AND step_attempt_id=?',[ownerId,attemptId])!.n;
  tx.run('INSERT INTO execution_event(owner_id,id,step_attempt_id,event_no,kind,payload,created_at) VALUES(?,?,?,?,?,?,?)',[ownerId,randomUUID(),attemptId,eventNo,'document_profile_replay',JSON.stringify({sourceAttemptId:String(original.id),reusedCallCount:calls.length}),now]);
 }
 if(later){
  const key=t.scope_kind==='self'?'self':t.contact_id;
  tx.run("UPDATE memory_document_later_schedule SET state='running',error_code=NULL WHERE owner_id=? AND scope_key=? AND generation=? AND task_id=?",[ownerId,key,policy.generation,taskId]);
  tx.run("UPDATE memory_document_later_run_requirement SET outcome='pending',reason=NULL,updated_at=? WHERE owner_id=? AND scope_key=? AND generation=? AND outcome='failed'",[now,ownerId,key,policy.generation]);
 }
 const claim:DocumentClaim={attemptId,stepId,taskId,runId:String(t.run_id),kind:'document_profile',laterStage:later?'document_profile':null,scheduleNow:now,scopeKind:t.scope_kind as 'self'|'contact',contactId:t.contact_id as string|null,
  claim:{task_id:taskId,step_id:stepId,step_name:'document_profile',worker_id:lease.runtimeId,lease_generation:Number(t.resume_no)},memories,scenarios:rendered.scenarios,profile:rendered.profile};
 const contacts=tx.all('SELECT c.id,c.data_generation FROM task_contribution tc JOIN contact c ON c.owner_id=tc.owner_id AND c.id=tc.source_contact_id WHERE tc.owner_id=? AND tc.task_id=?',[ownerId,taskId]).map(c=>({contactId:String(c.id),generation:String(c.data_generation)}));
 return {completed:false,claim,entries:proposal.entries,verificationEventId:verificationEventId!,profileSaved,contacts};
}

/** 只由显式用户恢复调用；不会安装启动钩子或获取模型端口。 */
export const memoryDocumentsReplayActions:StorageAction[]=[observedProcessingAction({name:'memoryDocuments.prepareVerifiedProfileReplay',mode:'write',retryBusy:false,
 execute:(tx,input:any,lease)=>withDocumentSourceQualifications(tx,()=>prepareReplay(tx,textId(input.ownerId),textId(input.taskId),lease))} as StorageAction)];
