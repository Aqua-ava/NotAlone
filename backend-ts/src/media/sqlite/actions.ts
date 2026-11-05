import {randomUUID} from 'node:crypto';
import {StorageFailure, type StorageAction, type StorageLease, type StorageRow, type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import {assertReadEligibility} from '../../contacts/sqlite/actions.ts';
import type {ReadEligibility} from '../../contacts/sqlite/contracts.ts';
import {assertSourceEligibility} from '../../history/sqlite/source.ts';
import {planDeletion, requestAllowed} from '../../storage/sqlite/deletion/actions.ts';
import type {DeletionRegistration, ManagedAddress} from '../../storage/sqlite/deletion/contracts.ts';
import type {MediaKind, MediaSnapshot, MediaValidation, MediaAssociationProof, MediaAttemptView} from './contracts.ts';
import {imageReconcilePrefix,imagePreparationVersion,automaticImageGeneration} from './image-refresh.ts';
import {createImageSyncActions} from './image-sync-actions.ts';

const fail=(code:string):never=>{throw new StorageFailure(code);};
const id=(v:unknown):string=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v)?v:fail('media_request_invalid');
const one=(tx:StorageTransaction,sql:string,args:(string|bigint)[],code='media_message_not_found'):StorageRow=>tx.get(sql,args)??fail(code);
export interface AttemptHandle {ownerId:string;contactId:string;messageId:string;attemptId:string;leaseToken:string}
function assertAutomaticImageGeneration(tx:StorageTransaction,i:{ownerId:string;messageId:string;requestKey:string;goal:string}):void{
 const generation=automaticImageGeneration(i.requestKey,i.messageId);if(generation===null)return;
 const head=tx.get('SELECT state,media_generation FROM message_media WHERE owner_id=? AND message_id=?',[i.ownerId,i.messageId]);
 if(!generation||i.goal!=='extract'||head&&head.state!=='active'||generation!==String(head?.media_generation??0))fail('media_execution_stale');
}
function message(tx:StorageTransaction,i:{ownerId:string;contactId:string;messageId:string}):StorageRow {
 const m=one(tx,`SELECT m.* FROM message m JOIN contact p ON p.owner_id=m.owner_id AND p.id=m.contact_id
 JOIN owner o ON o.owner_id=p.owner_id WHERE m.owner_id=? AND m.contact_id=? AND m.id=? AND m.availability='available' AND p.state='active' AND o.state='active'`,[id(i.ownerId),id(i.contactId),id(i.messageId)]);
 if(!['image','voice','video'].includes(String(m.kind)))fail('media_kind_unsupported');
 if(!tx.get("SELECT 1 FROM capture_record WHERE owner_id=? AND contact_id=? AND message_id=? AND state='normalized' AND availability='available'",[i.ownerId,i.contactId,i.messageId]))fail('media_source_unavailable');
 return m;
}
function selected(tx:StorageTransaction,owner:string,contact:string):StorageRow {
 return one(tx,`SELECT p.data_generation,p.selection_generation FROM contact p JOIN owner o ON o.owner_id=p.owner_id
 WHERE p.owner_id=? AND p.id=? AND p.state='active' AND o.state='active' AND EXISTS (
 SELECT 1 FROM read_grant g JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.id=g.binding_id
 WHERE g.owner_id=p.owner_id AND g.contact_id=p.id AND g.revoked_at IS NULL AND g.selection_generation=p.selection_generation AND b.state='verified')`,[owner,contact],'media_contact_not_selected');
}
function source(tx:StorageTransaction,a:StorageRow,seen=new Set<string>()):void {
 const key=String(a.id);if(seen.has(key)||seen.size>32)fail('media_source_cycle');seen.add(key);
 if(a.record_id){assertSourceEligibility(tx,{owner_id:String(a.owner_id),contact_id:String(a.contact_id),record_id:String(a.record_id),message_id:String(a.message_id)});return;}
 const f=one(tx,"SELECT * FROM media_file WHERE owner_id=? AND contact_id=? AND message_id=? AND id=? AND content_state='present'",[String(a.owner_id),String(a.contact_id),String(a.message_id),String(a.input_file_id)],'media_input_unavailable');
 source(tx,one(tx,'SELECT * FROM media_extraction_attempt WHERE owner_id=? AND id=?',[String(a.owner_id),String(f.produced_attempt_id)]),seen);
}
function unfinished(tx:StorageTransaction,i:{ownerId:string;contactId:string;messageId:string}):StorageRow|undefined {
 return tx.get(`SELECT operation_id,state FROM deletion_operation WHERE owner_identity=? AND contact_identity=? AND message_identity=? AND state<>'completed' ORDER BY created_at DESC LIMIT 1`,[i.ownerId,i.contactId,i.messageId]);
}
function assertAttempt(tx:StorageTransaction,i:AttemptHandle,lease:StorageLease,renew=false):StorageRow {
 const a=one(tx,'SELECT * FROM media_extraction_attempt WHERE owner_id=? AND contact_id=? AND message_id=? AND id=?',[id(i.ownerId),id(i.contactId),id(i.messageId),id(i.attemptId)],'media_attempt_not_found');
 if(a.lease_token!==i.leaseToken||a.runtime_id!==lease.runtimeId||!['pending','running'].includes(String(a.state))||a.lease_expires_at===null||BigInt(String(a.lease_expires_at))<BigInt(Date.now())||a.cleanup_operation_id)fail('media_execution_stale');
 const h=one(tx,"SELECT * FROM message_media WHERE owner_id=? AND message_id=? AND state='active'",[i.ownerId,i.messageId],'media_execution_stale');
 const p=selected(tx,i.ownerId,i.contactId);
 if(h.media_generation!==a.accepted_media_generation||h.head_revision!==a.accepted_head_revision||p.data_generation!==a.accepted_data_generation||p.selection_generation!==a.accepted_selection_generation)fail('media_execution_stale');
 message(tx,i);source(tx,a);
 if(a.goal!=='audio_conversion')assertReadEligibility(tx,JSON.parse(String(a.eligibility_json)) as ReadEligibility);
 if(renew)tx.run('UPDATE media_extraction_attempt SET lease_expires_at=? WHERE owner_id=? AND id=?',[Date.now()+120_000,i.ownerId,i.attemptId]);
 return a;
}
// 旧库的 quality_unknown 回执也是已保存可查看的结果，对外按 full 展示。
const outcomeView=(value:unknown):MediaAttemptView['outcome']=>value==='quality_unknown'?'full':value as MediaAttemptView['outcome'];
function attemptView(a:StorageRow):MediaAttemptView {
 return {attemptId:String(a.id),state:a.state as MediaAttemptView['state'],outcome:outcomeView(a.result_outcome),errorCode:a.error_code?String(a.error_code):null};
}
function snapshot(tx:StorageTransaction,i:{ownerId:string;contactId:string;messageId:string}):MediaSnapshot {
 const m=message(tx,i),h=tx.get('SELECT * FROM message_media WHERE owner_id=? AND message_id=?',[i.ownerId,i.messageId]);
 const a=tx.get('SELECT * FROM media_extraction_attempt WHERE owner_id=? AND contact_id=? AND message_id=? ORDER BY attempt_no DESC LIMIT 1',[i.ownerId,i.contactId,i.messageId]);
 const files=h&&['active','invalidated'].includes(String(h.state))?tx.all("SELECT * FROM media_file WHERE owner_id=? AND contact_id=? AND message_id=? AND content_state='present' AND publish_state='current'",[i.ownerId,i.contactId,i.messageId]):[];
 for(const f of files)source(tx,one(tx,'SELECT * FROM media_extraction_attempt WHERE owner_id=? AND id=?',[i.ownerId,String(f.produced_attempt_id)]));
 let local=true,read=true;try{selected(tx,i.ownerId,i.contactId);}catch{local=false;}
 read=local&&!!tx.get(`SELECT 1 FROM owner o JOIN read_grant g ON g.owner_id=o.owner_id
 JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.id=g.binding_id
 JOIN channel_conversation c ON c.owner_id=b.owner_id AND c.id=b.conversation_id
 JOIN channel_account a ON a.owner_id=c.owner_id AND a.id=c.account_id
 JOIN binding_verification v ON v.owner_id=g.owner_id AND v.id=g.verification_id AND v.binding_id=b.id
 JOIN contact p ON p.owner_id=g.owner_id AND p.id=g.contact_id
 WHERE o.owner_id=? AND g.contact_id=? AND o.read_enabled=1 AND g.revoked_at IS NULL
 AND g.selection_generation=p.selection_generation AND b.state='verified' AND a.identity_state='verified'
 AND a.scope_mode='selected' AND v.identity_generation=b.identity_generation`,[i.ownerId,i.contactId]);
 const cleanup=unfinished(tx,i);const busy=!!cleanup||a?.state==='pending'||a?.state==='running';
 return {contactId:i.contactId,messageId:i.messageId,kind:m.kind as MediaKind,state:(h?.state??'available') as MediaSnapshot['state'],generation:String(h?.media_generation??0),headRevision:String(h?.head_revision??0),
 latestAttempt:a?attemptView(a):null,
 files:files.map(f=>({fileId:String(f.id),role:f.role as MediaSnapshot['files'][number]['role'],format:String(f.format),mimeType:String(f.mime_type),byteSize:String(f.byte_size),viewable:f.viewable===1n,playable:f.playable===1n})),
 capabilities:{extract:local&&read&&!busy,audioConversion:local&&!busy&&m.kind==='voice'&&files.some(f=>f.role==='audio_source'),reason:cleanup?'media_cleanup_pending':busy?'media_already_running':!local?'media_contact_not_selected':!read?'read_not_authorized':null},
 cleanup:cleanup?{operationId:String(cleanup.operation_id),state:String(cleanup.state)}:null};
}
function cleanup(tx:StorageTransaction,lease:StorageLease,registration:DeletionRegistration,a:StorageRow):void {
 if(!tx.get("SELECT 1 FROM media_file WHERE owner_id=? AND produced_attempt_id=? AND publish_state<>'current' AND content_state='present'",[a.owner_id,a.id]))return;
 tx.run("UPDATE media_file SET publish_state='cleanup_pending' WHERE owner_id=? AND produced_attempt_id=? AND publish_state<>'current' AND content_state='present'",[a.owner_id,a.id]);
 planDeletion(tx,lease,registration,{ownerId:String(a.owner_id),requestKey:`${a.id}-cleanup`,scope:{kind:'media_result_replace',contactId:String(a.contact_id),messageId:String(a.message_id)}});
}
export function createMediaActions(registration:DeletionRegistration):StorageAction[] {
 const action=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,i:any,lease:StorageLease)=>unknown):StorageAction=>({name:`media.${name}`,mode,retryBusy:mode==='write',execute});
 return [
 action('kind','read',(tx,i)=>message(tx,i).kind),
 action('read','read',(tx,i)=>snapshot(tx,i)),
 action('request','read',(tx,i,lease)=>{
  id(i.ownerId);id(i.contactId);id(i.messageId);id(i.requestKey);
  if(!requestAllowed(tx,lease,i.ownerId,'media.extract',i.requestKey))fail('media_request_revoked');
  const old=tx.get('SELECT * FROM media_extraction_attempt WHERE owner_id=? AND request_key=?',[i.ownerId,i.requestKey]);
  if(old&&(old.contact_id!==i.contactId||old.message_id!==i.messageId||old.goal!==i.goal))fail('media_request_conflict');return old?attemptView(old):null;
 }),
 action('begin','write',(tx,i,lease)=>{
  message(tx,i);id(i.requestKey);if(!['extract','audio_conversion'].includes(i.goal))fail('media_request_invalid');
  const requestedAt=i.requestedAt??Date.now();if(!Number.isSafeInteger(requestedAt)||requestedAt<0)fail('media_request_invalid');
  if(!requestAllowed(tx,lease,i.ownerId,'media.extract',i.requestKey))fail('media_request_revoked');
  const old=tx.get('SELECT * FROM media_extraction_attempt WHERE owner_id=? AND request_key=?',[i.ownerId,i.requestKey]);
  if(old){if(old.contact_id!==i.contactId||old.message_id!==i.messageId||old.goal!==i.goal)fail('media_request_conflict');return {reused:true,attemptId:String(old.id)};}
  assertAutomaticImageGeneration(tx,i);
  if(unfinished(tx,i))fail('media_cleanup_pending');
  const active=tx.get("SELECT * FROM media_extraction_attempt WHERE owner_id=? AND message_id=? AND state IN ('pending','running')",[i.ownerId,i.messageId]);
  if(active){if(active.runtime_id===lease.runtimeId&&BigInt(String(active.lease_expires_at))>=BigInt(Date.now()))fail('media_already_running');
   tx.run("UPDATE media_extraction_attempt SET state='interrupted',lease_token=NULL,lease_expires_at=NULL,finished_at=?,error_code='media_lease_expired' WHERE owner_id=? AND id=?",[Date.now(),i.ownerId,active.id]);cleanup(tx,lease,registration,active);if(unfinished(tx,i))return {reused:false,cleanupRequired:true,attemptId:String(active.id)};}
  const p=selected(tx,i.ownerId,i.contactId),m=message(tx,i);
  // 补查只在消息还没有可查看的已保存图片时进行；已保存的图片不再重复读取。
  if(i.requestKey.startsWith(imageReconcilePrefix)&&(m.kind!=='image'||i.goal!=='extract'||tx.get("SELECT 1 FROM media_file f WHERE f.owner_id=? AND f.contact_id=? AND f.message_id=? AND f.role='image_display' AND f.publish_state='current' AND f.content_state='present' AND f.container_valid=1 AND f.viewable=1",[i.ownerId,i.contactId,i.messageId])))fail('media_refresh_not_required');
  if(i.goal==='audio_conversion'&&m.kind!=='voice')fail('media_goal_invalid');
  let token:ReadEligibility|null=null,record:string|null=null,input:StorageRow|undefined;
  if(i.goal==='audio_conversion'){
   input=one(tx,"SELECT * FROM media_file WHERE owner_id=? AND contact_id=? AND message_id=? AND role='audio_source' AND publish_state='current' AND content_state='present' AND container_valid=1",[i.ownerId,i.contactId,i.messageId],'media_input_unavailable');
   source(tx,one(tx,'SELECT * FROM media_extraction_attempt WHERE owner_id=? AND id=?',[i.ownerId,String(input.produced_attempt_id)]));
  }else{
   token=i.token;assertReadEligibility(tx,token!);if(token!.owner_id!==i.ownerId||token!.contact_id!==i.contactId||token!.binding_id!==m.binding_id)fail('media_read_scope_invalid');
   record=String(one(tx,"SELECT id FROM capture_record WHERE owner_id=? AND contact_id=? AND message_id=? AND state='normalized' AND availability='available' ORDER BY rowid DESC LIMIT 1",[i.ownerId,i.contactId,i.messageId],'media_source_unavailable').id);
   assertSourceEligibility(tx,{owner_id:i.ownerId,contact_id:i.contactId,record_id:record,message_id:i.messageId});
  }
  tx.run("INSERT INTO message_media(owner_id,message_id,contact_id,state,created_at) VALUES(?,?,?,'active',?) ON CONFLICT(owner_id,message_id) DO UPDATE SET state='active'",[i.ownerId,i.messageId,i.contactId,Date.now()]);
  const h=tx.get('SELECT * FROM message_media WHERE owner_id=? AND message_id=?',[i.ownerId,i.messageId])!;
  const attemptId=randomUUID(),leaseToken=randomUUID(),n=tx.get('SELECT COALESCE(MAX(attempt_no),0)+1 n FROM media_extraction_attempt WHERE owner_id=? AND message_id=?',[i.ownerId,i.messageId])!.n;
  tx.run(`INSERT INTO media_extraction_attempt(owner_id,id,contact_id,message_id,request_key,attempt_no,goal,record_id,input_file_id,accepted_media_generation,accepted_head_revision,accepted_data_generation,accepted_read_epoch,accepted_selection_generation,grant_id,binding_verification_id,runtime_token,eligibility_json,runtime_id,state,result_outcome,lease_token,lease_expires_at,requested_at,adapter_version)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending','no_result',?,?,?,?)`,[i.ownerId,attemptId,i.contactId,i.messageId,i.requestKey,n,i.goal,record,input?.id??null,h.media_generation,h.head_revision,p.data_generation,token?BigInt(token.read_epoch):null,p.selection_generation,token?.grant_id??null,token?.verification_id??null,token?lease.runtimeId:null,token?JSON.stringify(token):null,lease.runtimeId,leaseToken,Date.now()+120_000,requestedAt,typeof i.adapterVersion==='string'&&/^[-a-zA-Z0-9_.:]{1,128}$/.test(i.adapterVersion)?i.adapterVersion:fail('media_adapter_version_invalid')]);
  return {reused:false,attemptId,leaseToken,dataGeneration:String(p.data_generation),recordId:record,inputFile:input?{fileId:String(input.id),address:JSON.parse(String(input.managed_address)),byteSize:String(input.byte_size),digest:String(input.content_digest)}:null,token};
 }),
 // 准备失败只是失败回执，不接受来源证明、不建立执行租约，也不能用于发布文件。
 action('imagePreparationFailed','write',(tx,i,lease)=>{
  const m=message(tx,i);id(i.requestKey);if(automaticImageGeneration(i.requestKey,i.messageId)===null||m.kind!=='image')fail('media_request_invalid');
  if(!requestAllowed(tx,lease,i.ownerId,'media.extract',i.requestKey))fail('media_request_revoked');
  if(tx.get('SELECT 1 FROM media_extraction_attempt WHERE owner_id=? AND request_key=?',[i.ownerId,i.requestKey]))return;
  assertAutomaticImageGeneration(tx,i);
  const token=i.token as ReadEligibility;assertReadEligibility(tx,token);
  if(token.owner_id!==i.ownerId||token.contact_id!==i.contactId||token.binding_id!==m.binding_id)fail('media_read_scope_invalid');
  const p=selected(tx,i.ownerId,i.contactId),at=i.requestedAt;
  if(!Number.isSafeInteger(at)||at<0||typeof i.code!=='string'||!/^[-a-z0-9_]{1,80}$/.test(i.code))fail('media_request_invalid');
  if(unfinished(tx,i)||tx.get("SELECT 1 FROM media_extraction_attempt WHERE owner_id=? AND message_id=? AND state IN ('pending','running')",[i.ownerId,i.messageId]))return;
  const record=one(tx,"SELECT id FROM capture_record WHERE owner_id=? AND contact_id=? AND message_id=? AND state='normalized' AND availability='available' ORDER BY rowid DESC LIMIT 1",[i.ownerId,i.contactId,i.messageId],'media_source_unavailable');
  tx.run("INSERT INTO message_media(owner_id,message_id,contact_id,state,created_at) VALUES(?,?,?,'active',?) ON CONFLICT(owner_id,message_id) DO NOTHING",[i.ownerId,i.messageId,i.contactId,at]);
  const h=tx.get('SELECT media_generation,head_revision FROM message_media WHERE owner_id=? AND message_id=?',[i.ownerId,i.messageId])!;
  const n=tx.get('SELECT coalesce(max(attempt_no),0)+1 n FROM media_extraction_attempt WHERE owner_id=? AND message_id=?',[i.ownerId,i.messageId])!.n;
  tx.run(`INSERT INTO media_extraction_attempt(owner_id,id,contact_id,message_id,request_key,attempt_no,goal,record_id,accepted_media_generation,accepted_head_revision,accepted_data_generation,accepted_read_epoch,accepted_selection_generation,grant_id,binding_verification_id,runtime_token,eligibility_json,runtime_id,state,result_outcome,requested_at,finished_at,adapter_version,error_code)
   VALUES(?,?,?,?,?,?,'extract',?,?,?,?,?,?,?,?,?,?,?,'failed','no_result',?,?,?,?)`,[i.ownerId,randomUUID(),i.contactId,i.messageId,i.requestKey,n,record.id,h.media_generation,h.head_revision,p.data_generation,BigInt(token.read_epoch),p.selection_generation,token.grant_id,token.verification_id,lease.runtimeId,JSON.stringify(token),lease.runtimeId,at,at,imagePreparationVersion,i.code]);
 }),
 action('check','write',(tx,i,lease)=>{const a=assertAttempt(tx,i,lease,true);if(a.state==='pending')tx.run("UPDATE media_extraction_attempt SET state='running',started_at=? WHERE owner_id=? AND id=?",[Date.now(),i.ownerId,i.attemptId]);return true;}),
 action('allocate','write',(tx,i,lease)=>{
  const a=assertAttempt(tx,i,lease);const m=message(tx,i);const roles=m.kind==='image'?['image_display']:m.kind==='video'?['video_playback']:['audio_source','audio_playback'];
  if(!roles.includes(i.role)||a.goal==='audio_conversion'&&i.role!=='audio_playback')fail('media_role_invalid');
  if(i.parentFileId){const parent=one(tx,"SELECT id FROM media_file WHERE owner_id=? AND contact_id=? AND message_id=? AND id=? AND content_state='present'",[i.ownerId,i.contactId,i.messageId,id(i.parentFileId)],'media_parent_invalid');if(parent.id===i.fileId)fail('media_parent_invalid');}
  const fileId=randomUUID();const locator=`${fileId}.media`;
  tx.run(`INSERT INTO media_file(owner_id,id,contact_id,message_id,produced_attempt_id,role,image_quality,managed_locator,parent_file_id,content_state,publish_state,created_at) VALUES(?,?,?,?,?,?,?, ?,?,'present','staged',?)`,[i.ownerId,fileId,i.contactId,i.messageId,i.attemptId,i.role,m.kind==='image'?'unknown':'not_applicable',locator,i.parentFileId??null,Date.now()]);
  return {fileId,locator};
 }),
 // 创建后的身份补录只可落在原固定目标；即使已被封禁也只补清理信息，不恢复发布资格。
 action('identify','write',(tx,i,lease)=>{
  const f=one(tx,'SELECT f.*,a.runtime_id,a.lease_token FROM media_file f JOIN media_extraction_attempt a ON a.owner_id=f.owner_id AND a.id=f.produced_attempt_id WHERE f.owner_id=? AND f.id=?',[id(i.ownerId),id(i.fileId)],'media_file_not_found');
  if(f.runtime_id!==lease.runtimeId||f.produced_attempt_id!==i.attemptId||f.content_state!=='present'||f.managed_address||f.managed_locator!==i.address?.locator||i.address?.area!=='media'||i.address?.kind!=='file')fail('media_file_identity_invalid');
  tx.run('UPDATE media_file SET managed_address=?,expected_file_identity=? WHERE owner_id=? AND id=?',[JSON.stringify(i.address),JSON.stringify(i.address.identity),i.ownerId,i.fileId]);return true;
 }),
 action('uncreated','write',(tx,i,lease)=>{
  const a=one(tx,'SELECT runtime_id FROM media_extraction_attempt WHERE owner_id=? AND id=?',[i.ownerId,i.attemptId],'media_attempt_not_found');if(a.runtime_id!==lease.runtimeId)fail('media_execution_stale');
  tx.run("UPDATE media_file SET content_state='erased',managed_locator=NULL WHERE owner_id=? AND id=? AND produced_attempt_id=? AND managed_address IS NULL AND expected_file_identity IS NULL AND publish_state IN ('staged','cleanup_pending')",[i.ownerId,i.fileId,i.attemptId]);
 }),
 action('validated','write',(tx,i,lease)=>{
  assertAttempt(tx,i,lease);const v=i.validation as MediaValidation;
  if(!v||v.containerValid!==true||typeof v.format!=='string'||!/^[-a-zA-Z0-9_]{1,40}$/.test(v.format)||typeof v.mimeType!=='string'||!/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/.test(v.mimeType)||!Number.isSafeInteger(i.byteSize)||i.byteSize<1||!/^[a-f0-9]{64}$/.test(i.digest))fail('media_validation_invalid');
  const f=one(tx,"SELECT * FROM media_file WHERE owner_id=? AND id=? AND produced_attempt_id=? AND publish_state='staged' AND content_state='present' AND managed_address IS NOT NULL",[i.ownerId,id(i.fileId),i.attemptId],'media_file_not_found');
  if(f.role==='image_display'&&!v.viewable||f.role==='video_playback'&&!v.playable||f.role==='audio_playback'&&!v.playable)fail('media_validation_invalid');
  // image_quality 等旧分类列不再写入或读取：图片行保持 allocate 时的占位取值。
  tx.run('UPDATE media_file SET format=?,mime_type=?,byte_size=?,content_digest=?,container_valid=1,viewable=?,playable=? WHERE owner_id=? AND id=?',[v.format,v.mimeType,i.byteSize,i.digest,v.viewable?1:0,v.playable?1:0,i.ownerId,i.fileId]);return true;
 }),
 action('discardPlayback','write',(tx,i,lease)=>{
  const a=assertAttempt(tx,i,lease);if(a.goal!=='extract'||message(tx,i).kind!=='voice')fail('media_failure_mode_invalid');
  const file=one(tx,"SELECT * FROM media_file WHERE owner_id=? AND contact_id=? AND message_id=? AND id=? AND produced_attempt_id=? AND role='audio_playback' AND publish_state='staged'",[i.ownerId,i.contactId,i.messageId,id(i.fileId),i.attemptId],'media_file_not_found');
  if(!tx.get("SELECT 1 FROM media_file WHERE owner_id=? AND produced_attempt_id=? AND id=? AND role='audio_source' AND publish_state='staged' AND content_state='present' AND container_valid=1 AND content_digest IS NOT NULL",[i.ownerId,i.attemptId,file.parent_file_id]))fail('media_audio_source_required');
  tx.run("UPDATE media_file SET publish_state='cleanup_pending' WHERE owner_id=? AND id=?",[i.ownerId,i.fileId]);
  return {discarded:true};
 }),
 action('publish','write',(tx,i,lease)=>{
  const a=assertAttempt(tx,i,lease);const proof=i.association as MediaAssociationProof|null;
  if(a.goal!=='audio_conversion'){
   if(!proof||Object.keys(proof).sort().join(',')!=='messageId,profileId,protocol,recordId,resourceIdentity'||proof.protocol!=='media-association-v1'||proof.recordId!==a.record_id||proof.messageId!==i.messageId||!/^[-a-zA-Z0-9_:.]{1,128}$/.test(proof.resourceIdentity)||!/^[-a-zA-Z0-9_:.]{1,128}$/.test(proof.profileId))fail('media_association_unverified');
  }else if(proof!==null)fail('media_association_invalid');
  const fresh=tx.all("SELECT * FROM media_file WHERE owner_id=? AND produced_attempt_id=? AND publish_state='staged' AND content_state='present'",[i.ownerId,i.attemptId]);
  if(!fresh.length||fresh.some(f=>f.container_valid!==1n||!f.managed_address||!f.content_digest)||new Set(fresh.map(f=>f.role)).size!==fresh.length)fail('media_result_invalid');
  const current=tx.all("SELECT * FROM media_file WHERE owner_id=? AND message_id=? AND publish_state='current' AND content_state='present'",[i.ownerId,i.messageId]);
  const kind=message(tx,i).kind;
  const keep=a.goal==='audio_conversion'?current.filter(f=>f.id===a.input_file_id):[];
  const combination=[...fresh,...keep];
  if(kind==='voice'){const original=combination.find(f=>f.role==='audio_source');const originalId=original?.id??fail('media_audio_source_required');if(combination.some(f=>f.role==='audio_playback'&&f.parent_file_id!==originalId))fail('media_audio_parent_invalid');}
  const full=(files:StorageRow[])=>kind==='image'?files.some(f=>f.role==='image_display'&&f.container_valid===1n&&f.viewable===1n):kind==='video'?files.some(f=>f.role==='video_playback'&&f.playable===1n):files.some(f=>f.role==='audio_source')&&files.some(f=>f.role==='audio_playback'&&f.playable===1n);
  if(full(current)&&!full(combination))fail('media_result_would_degrade');
  const outcome=full(combination)?'full':'limited';
  const keepIds=new Set(keep.map(f=>f.id));
  for(const f of current)if(!keepIds.has(f.id))tx.run("UPDATE media_file SET publish_state='cleanup_pending' WHERE owner_id=? AND id=?",[i.ownerId,f.id]);
  for(const f of fresh)tx.run("UPDATE media_file SET publish_state='current' WHERE owner_id=? AND id=?",[i.ownerId,f.id]);
  tx.run("UPDATE media_extraction_attempt SET state='completed',result_outcome=?,lease_token=NULL,lease_expires_at=NULL,finished_at=?,association_proof_format=?,association_proof=?,error_code=? WHERE owner_id=? AND id=?",[outcome,Date.now(),proof?'media-association-v1':null,proof?JSON.stringify(proof):null,i.errorCode??null,i.ownerId,i.attemptId]);
  tx.run('UPDATE message_media SET head_revision=head_revision+1 WHERE owner_id=? AND message_id=?',[i.ownerId,i.messageId]);
  if(current.some(f=>!keepIds.has(f.id))||tx.get("SELECT 1 FROM media_file WHERE owner_id=? AND message_id=? AND publish_state IN ('retired','cleanup_pending') AND content_state='present'",[i.ownerId,i.messageId]))planDeletion(tx,lease,registration,{ownerId:i.ownerId,requestKey:`${i.attemptId}-replace`,scope:{kind:'media_result_replace',contactId:i.contactId,messageId:i.messageId}});
  return snapshot(tx,i);
 }),
 action('fail','write',(tx,i,lease)=>{
  const a=tx.get('SELECT * FROM media_extraction_attempt WHERE owner_id=? AND id=? AND runtime_id=?',[i.ownerId,i.attemptId,lease.runtimeId]);if(!a)return;
  if(['pending','running'].includes(String(a.state)))tx.run("UPDATE media_extraction_attempt SET state=?,result_outcome='no_result',lease_token=NULL,lease_expires_at=NULL,finished_at=?,error_code=? WHERE owner_id=? AND id=?",[i.interrupted?'interrupted':'failed',Date.now(),/^[-a-z0-9_]{1,80}$/.test(i.code)?i.code:'media_execution_failed',i.ownerId,i.attemptId]);
  cleanup(tx,lease,registration,a);
 }),
 ...createImageSyncActions(),
 action('currentFiles','read',(tx,i)=>tx.all("SELECT contact_id,message_id,id FROM media_file WHERE owner_id=? AND publish_state='current' AND content_state='present'",[id(i.ownerId)]).map(f=>({contactId:String(f.contact_id),messageId:String(f.message_id),fileId:String(f.id)}))),
 action('fileUnavailable','write',(tx,i)=>{
  const current=tx.get("SELECT * FROM media_file WHERE owner_id=? AND contact_id=? AND message_id=? AND id=? AND publish_state='current' AND content_state='present'",[i.ownerId,i.contactId,i.messageId,i.fileId]);
  if(!current||current.managed_address!==JSON.stringify(i.address))return false;
  const files=tx.all("SELECT f.*,a.input_file_id FROM media_file f JOIN media_extraction_attempt a ON a.owner_id=f.owner_id AND a.id=f.produced_attempt_id WHERE f.owner_id=? AND f.message_id=?",[i.ownerId,i.messageId]);
  const unavailable=new Set([String(i.fileId)]);let changed=true;
  while(changed){changed=false;for(const f of files)if(!unavailable.has(String(f.id))&&(unavailable.has(String(f.parent_file_id))||unavailable.has(String(f.input_file_id)))){unavailable.add(String(f.id));changed=true;}}
  for(const fileId of unavailable)tx.run("UPDATE media_file SET publish_state='retired' WHERE owner_id=? AND id=? AND publish_state='current'",[i.ownerId,fileId]);
  tx.run("UPDATE message_media SET state='invalidated',head_revision=head_revision+1 WHERE owner_id=? AND message_id=?",[i.ownerId,i.messageId]);
  tx.run("UPDATE media_extraction_attempt SET error_code='media_saved_file_unavailable' WHERE owner_id=? AND message_id=? AND state='completed'",[i.ownerId,i.messageId]);return true;
 }),
 action('pendingCleanup','read',(tx,i)=>tx.all("SELECT operation_id FROM deletion_operation WHERE owner_identity=? AND scope_kind IN ('media_result_clear','media_result_replace') AND state<>'completed' ORDER BY created_at,operation_id",[id(i.ownerId)]).map(r=>String(r.operation_id))),
 action('recover','write',(tx,i,lease)=>{
  const rows=tx.all("SELECT * FROM media_extraction_attempt WHERE owner_id=? AND state IN ('pending','running') AND runtime_id<>?",[id(i.ownerId),lease.runtimeId]);
  for(const a of rows){tx.run("UPDATE media_extraction_attempt SET state='interrupted',lease_token=NULL,lease_expires_at=NULL,finished_at=?,error_code='media_host_interrupted' WHERE owner_id=? AND id=?",[Date.now(),i.ownerId,a.id]);cleanup(tx,lease,registration,a);}return rows.length;
 }),
 action('file','read',(tx,i)=>{
  message(tx,i);const f=one(tx,"SELECT * FROM media_file WHERE owner_id=? AND contact_id=? AND message_id=? AND id=? AND content_state='present' AND publish_state='current'",[i.ownerId,i.contactId,i.messageId,id(i.fileId)],'media_file_not_found');
  source(tx,one(tx,'SELECT * FROM media_extraction_attempt WHERE owner_id=? AND id=?',[i.ownerId,String(f.produced_attempt_id)]));return {fileId:String(f.id),dataGeneration:String(one(tx,'SELECT data_generation FROM contact WHERE owner_id=? AND id=?',[i.ownerId,i.contactId]).data_generation),generation:String(one(tx,'SELECT media_generation FROM message_media WHERE owner_id=? AND message_id=?',[i.ownerId,i.messageId]).media_generation),address:JSON.parse(String(f.managed_address)) as ManagedAddress,mimeType:String(f.mime_type),byteSize:String(f.byte_size),digest:String(f.content_digest),viewable:f.viewable===1n,playable:f.playable===1n};
 }),
 ];
}
