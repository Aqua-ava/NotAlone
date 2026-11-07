import {randomUUID} from 'node:crypto';
import {registry as base} from './recertify-registry.mjs';
import {createDeletionActions} from '../../../src/storage/sqlite/deletion/actions.ts';
import {createInstalledDeletionRegistration} from '../../../src/storage/sqlite/deletion/registration.ts';
import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';

// 批次大小由测试经环境变量传入（worker 继承环境），默认与产品一致。
const batch=Number(process.env.SYNTHETIC_SUPERSEDED_BATCH??1000);
const replaced=new Map(createDeletionActions(createInstalledDeletionRegistration({supersededBatchSize:batch})).map(action=>[action.name,action]));
const tables=['message','message_alias','capture_record','sync_capture','history_quote','history_quote_attempt','message_media','media_extraction_attempt','media_file',
 'processing_item','memory_required_message','memory_citation','reply_context_item','reply_candidate_input_source','history_message_quarantine'];
const actions=[
 {name:'fixture.mediaHead',mode:'write',retryBusy:false,execute(tx,i){tx.run("INSERT INTO message_media(owner_id,contact_id,message_id,media_generation,head_revision,state,created_at) VALUES(?,?,?,0,0,'active',?)",[i.ownerId,i.contactId,i.messageId,Date.now()]);}},
 // 全表计数与按绑定的消息清单，供断言“只删未引用、引用方不变”。
 {name:'fixture.supersededSnapshot',mode:'read',retryBusy:false,execute(tx,i){
  const count=table=>Number(tx.get(`SELECT count(*) n FROM ${table} WHERE owner_id=?`,[i.ownerId]).n);
  const messages=tx.all('SELECT id,binding_id,kind,display_no FROM message WHERE owner_id=? AND contact_id=? ORDER BY display_no',[i.ownerId,i.contactId]).map(r=>({id:String(r.id),binding:String(r.binding_id),kind:String(r.kind)}));
  return {counts:Object.fromEntries(tables.map(t=>[t,count(t)])),messages,
   bindings:tx.all('SELECT id,state FROM conversation_binding WHERE owner_id=? AND contact_id=? ORDER BY rowid',[i.ownerId,i.contactId]).map(r=>({id:String(r.id),state:String(r.state)})),
   marker:Number(tx.get('SELECT count(*) n FROM history_superseded_cleanup WHERE owner_id=?',[i.ownerId]).n),
   fences:Number(tx.get('SELECT count(*) n FROM history_deletion_fence WHERE owner_id=?',[i.ownerId]).n),
   exclusions:Number(tx.get('SELECT count(*) n FROM history_source_exclusion WHERE owner_id=?',[i.ownerId]).n),
   cutoffs:Number(tx.get('SELECT count(*) n FROM history_cutoff WHERE owner_id=?',[i.ownerId]).n),
   terminals:Number(tx.get('SELECT count(*) n FROM history_source_terminal WHERE owner_id=?',[i.ownerId]).n),
   contact:tx.get('SELECT data_generation,state FROM contact WHERE owner_id=? AND id=?',[i.ownerId,i.contactId]),
   grants:Number(tx.get('SELECT count(*) n FROM read_grant WHERE owner_id=?',[i.ownerId]).n),
   operations:tx.all("SELECT operation_id,state,scope_kind FROM deletion_operation WHERE owner_identity=? ORDER BY created_at",[i.ownerId]).map(r=>({id:String(r.operation_id),state:String(r.state),scope:String(r.scope_kind)}))};
 }},
 {name:'fixture.supersededMessageRecords',mode:'read',retryBusy:false,execute(tx,i){
  return tx.all('SELECT id FROM capture_record WHERE owner_id=? AND contact_id=? AND message_id=? ORDER BY id',[i.ownerId,i.contactId,i.messageId]).map(r=>String(r.id));
 }},
 // 合成派生引用：最小行集满足外键与检查约束，不经过模型或回复生成。
 {name:'fixture.supersededReference',mode:'write',retryBusy:false,execute(tx,i){
  const {ownerId,contactId,messageId,kind}=i,recordId=tx.get('SELECT id FROM capture_record WHERE owner_id=? AND contact_id=? AND message_id=? ORDER BY id LIMIT 1',[ownerId,contactId,messageId]).id;
  if(kind==='processing_item')tx.run("INSERT INTO processing_item(owner_id,id,contact_id,message_id,purpose,extraction_state,pipeline_state,completion_attempt_id) VALUES(?,?,?,?, 'memory_extraction','pending','pending',NULL)",[ownerId,randomUUID(),contactId,messageId]);
  else if(kind==='memory'){
   const candidate=randomUUID();
   // 合成记忆引用不经过真实模型产出；仅本夹具库移除“候选必须有真实产出”的触发器，清理逻辑的判定与它无关。
   tx.run('DROP TRIGGER IF EXISTS candidate_real_producer');
   tx.run("INSERT INTO memory_candidate(owner_id,id,scope_kind,contact_id,proposed_body,produced_attempt_id,event_id,output_no,state,state_revision) VALUES(?,?, 'contact',?,NULL,NULL,NULL,1,'deleted',0)",[ownerId,candidate,contactId]);
   tx.run('INSERT INTO memory_required_message(owner_id,id,candidate_id,memory_id,version_no,source_contact_id,message_id) VALUES(?,?,?,NULL,NULL,?,?)',[ownerId,randomUUID(),candidate,contactId,messageId]);
   tx.run("INSERT INTO memory_citation(owner_id,id,candidate_id,memory_id,version_no,source_contact_id,message_id,record_id,accepted_revision,span_start,span_end,explanation) VALUES(?,?,?,NULL,NULL,?,?,?,1,0,1,NULL)",[ownerId,randomUUID(),candidate,contactId,messageId,recordId]);
  }else if(kind==='reply'){
   const discussion=randomUUID(),context=randomUUID();
   tx.run("INSERT INTO assistant_discussion(owner_id,id,contact_id,title,state,current_runtime_id,generation,is_current,created_at,last_activity_at) VALUES(?,?,?,NULL,'active',NULL,0,0,?,?)",[ownerId,discussion,contactId,Date.now(),Date.now()]);
   tx.run("INSERT INTO reply_context(owner_id,id,contact_id,discussion_id,origin_kind,attempt_id,request_id,preference_revision,skill_revision,owner_memory_revision,contact_memory_revision,skill_run_json,frozen_at,state) VALUES(?,?,?,?, 'rebuild',NULL,NULL,0,0,0,0,'{}',?, 'active')",[ownerId,context,contactId,discussion,Date.now()]);
   tx.run("INSERT INTO reply_context_item(owner_id,context_id,item_no,kind,role,presentation_no,source_contact_id,message_id,record_id,accepted_revision) VALUES(?,?,1,'message','context',1,?,?,?,1)",[ownerId,context,contactId,messageId,recordId]);
   tx.run("INSERT INTO reply_candidate_input(owner_id,context_id,item_no,kind,identity_json,text_body) VALUES(?,?,1,'message','{}','合成')",[ownerId,context]);
   tx.run('INSERT INTO reply_candidate_input_source(owner_id,context_id,item_no,source_contact_id,record_id,message_id,accepted_revision) VALUES(?,?,1,?,?,?,1)',[ownerId,context,contactId,recordId,messageId]);
  }else if(kind==='quarantine')tx.run('INSERT INTO history_message_quarantine VALUES(?,?,?,?)',[ownerId,contactId,messageId,'source_recalled']);
  else throw new Error(`unknown reference ${kind}`);
  return true;
 }},
 // 引用：载体消息引用目标消息（合成行，满足外键）。
 {name:'fixture.supersededQuote',mode:'write',retryBusy:false,execute(tx,i){
  const {ownerId,contactId,carrierId,targetId}=i,carrier=tx.get('SELECT binding_id FROM message WHERE owner_id=? AND id=?',[ownerId,carrierId]);
  const record=tx.get('SELECT id FROM capture_record WHERE owner_id=? AND contact_id=? AND message_id=? ORDER BY id LIMIT 1',[ownerId,contactId,carrierId]).id;
  tx.run(`INSERT INTO history_quote(owner_id,id,contact_id,message_id,binding_id,source_record_id,source_generation,version,reply_text,referenced_text,referenced_sender,referenced_sender_role,referenced_type,referenced_server_id,target_message_id,state,proof_digest,source_revision,interpretation_revision,carrier_interpretation_revision,source_key)
   VALUES(?,?,?,?,?,?,'source-1','wechat-quote-v2','合成回复','合成被引','甲','contact','1',NULL,?,'resolved',?,1,1,1,'')`,[ownerId,randomUUID(),contactId,carrierId,carrier.binding_id,record,targetId,'a'.repeat(64)]);
  return true;
 }},
 {name:'fixture.deletionFailures',mode:'read',retryBusy:false,execute(tx,i){return tx.all("SELECT domain,row_kind,state,attempts,last_error_code FROM deletion_target WHERE operation_id=? AND state<>'cleared' LIMIT 10",[i.operationId]).map(r=>({domain:r.domain,kind:r.row_kind,state:r.state,code:r.last_error_code}));}},
 {name:'fixture.supersededMarker',mode:'write',retryBusy:false,execute(tx,i){tx.run('DELETE FROM history_superseded_cleanup WHERE owner_id=?',[i.ownerId]);return true;}},
];
// 合成夹具的 SQL 失败通常是外键或检查约束；工作线程会把它统一映射成 storage_invalid，这里保留细节便于定位。
const detailed=actions.map(action=>({...action,execute(tx,i){try{return action.execute(tx,i);}catch(error){throw new StorageFailure(`fixture_sql_${String(error?.message??error).replace(/[^a-z0-9]+/gi,'_').slice(0,100)}`);}}}));
export const registry={...base,actions:[...base.actions.map(action=>replaced.get(action.name)??action),...detailed]};
