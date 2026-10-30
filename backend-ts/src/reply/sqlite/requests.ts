import {quarantinedDiscussionImpact} from './deletion.ts';
import {randomUUID} from 'node:crypto';
import {StorageFailure,type StorageAction,type StorageRow,type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import {requireSkillRun} from '../../skills/sqlite/storage.ts';
import type {SkillRunRevision} from '../../skills/sqlite/contracts.ts';
import {requestAllowed} from '../../storage/sqlite/deletion/actions.ts';
import {requireDiscussion,requireDiscussionContact,identifier,discussionView,selectDiscussionForRequest} from './actions.ts';
import type {DiscussionAttempt} from './contracts.ts';
const fail=(code:string):never=>{throw new StorageFailure(code);};
export const encode=(v:unknown)=>JSON.stringify(v,(_key,value)=>typeof value==='bigint'?{$integer:String(value)}:value);
export const decode=<T>(v:string):T=>JSON.parse(v,(_key,value)=>value&&typeof value==='object'&&Object.keys(value).length===1&&typeof value.$integer==='string'?BigInt(value.$integer):value);
const body=(v:unknown):string=>typeof v==='string'&&v.trim()&&v.length<=100_000?v:fail('discussion_input_invalid');
function requireIdentity(tx:StorageTransaction,ownerId:string,contactId:string,requestKey:string,proof:any,dataGeneration:bigint):void{
 if(proof?.kind==='manual'){
  if(!tx.get("SELECT 1 FROM manual_confirmation WHERE owner_id=? AND id=? AND contact_id=? AND context_token=? AND accepted_data_generation=? AND state='active' AND revoked_at IS NULL",[ownerId,identifier(proof.confirmationId),contactId,requestKey,dataGeneration]))fail('discussion_identity_required');
 }else if(proof?.kind==='binding'){
  if(!tx.get(`SELECT 1 FROM conversation_binding b
   JOIN binding_verification v ON v.owner_id=b.owner_id AND v.binding_id=b.id
   JOIN channel_conversation s ON s.owner_id=b.owner_id AND s.id=b.conversation_id
   JOIN channel_account a ON a.owner_id=s.owner_id AND a.id=s.account_id
   JOIN contact c ON c.owner_id=b.owner_id AND c.id=b.contact_id
   JOIN read_grant g ON g.owner_id=b.owner_id AND g.binding_id=b.id AND g.contact_id=b.contact_id
   WHERE b.owner_id=? AND b.contact_id=? AND b.id=? AND b.state='verified' AND v.id=?
   AND v.identity_generation=b.identity_generation AND v.method='foreground_confirmation'
   AND a.identity_state='verified' AND g.revoked_at IS NULL AND g.selection_generation=c.selection_generation
   AND json_extract(v.proof,'$.source_generation')=a.source_generation`,[ownerId,contactId,identifier(proof.bindingId),identifier(proof.verificationId)]))fail('discussion_identity_required');
 }else fail('discussion_identity_required');
}
export function requireAttempt(tx:StorageTransaction,i:DiscussionAttempt,committed=false):StorageRow{
 const instance=tx.get('SELECT runtime_id,epoch FROM database_instance WHERE slot=1')!;
 const d=requireDiscussion(tx,i),c=requireDiscussionContact(tx,i.ownerId,i.contactId);
 const row=tx.get(`SELECT a.*,r.discussion_id,r.contact_id,r.state request_state,r.request_key,r.identity_origin,r.confirmation_id,r.binding_id,r.verification_id FROM reply_attempt a JOIN reply_request r ON r.owner_id=a.owner_id AND r.id=a.request_id WHERE a.owner_id=? AND a.id=? AND r.contact_id=? AND r.discussion_id=?`,[i.ownerId,identifier(i.attemptId),i.contactId,i.discussionId])??fail('discussion_request_stale');
 if(row.accepted_runtime_id!==instance.runtime_id||row.accepted_storage_epoch!==instance.epoch||row.request_id!==i.requestId||row.lease_token!==i.leaseToken||row.accepted_data_generation!==c.data_generation||row.accepted_discussion_generation!==d.generation||row.accepted_source_revision!==c.source_revision||row.accepted_data_generation!==i.dataGeneration||row.accepted_discussion_generation!==i.discussionGeneration||row.accepted_source_revision!==i.sourceRevision
 || !(row.state==='running'&&row.request_state==='running'||committed&&row.state==='committed'&&row.request_state==='committed'))fail('discussion_request_stale');
 requireIdentity(tx,i.ownerId,i.contactId,String(row.request_key),row.identity_origin==='manual'?{kind:'manual',confirmationId:row.confirmation_id}:{kind:'binding',bindingId:row.binding_id,verificationId:row.verification_id},c.data_generation as bigint);
 return row;
}
function attemptView(row:StorageRow,request:StorageRow):DiscussionAttempt{return {ownerId:String(row.owner_id),contactId:String(request.contact_id),discussionId:String(request.discussion_id),requestId:String(row.request_id),attemptId:String(row.id),leaseToken:String(row.lease_token),dataGeneration:row.accepted_data_generation as bigint,discussionGeneration:row.accepted_discussion_generation as bigint,sourceRevision:row.accepted_source_revision as bigint};}
const action=(name:string,execute:(tx:StorageTransaction,i:any,lease:any)=>unknown):StorageAction=>({name:`discussion.${name}`,mode:'write',retryBusy:true,execute});
export const discussionRequestActions:StorageAction[]=[
 action('begin',(tx,i,lease)=>{
  requireDiscussionContact(tx,i.ownerId,i.contactId);identifier(i.requestKey);body(i.text);
  if(!requestAllowed(tx,lease,i.ownerId,'discussion.begin',i.requestKey))fail('discussion_request_deleted');
  const old=tx.get('SELECT * FROM reply_request WHERE owner_id=? AND request_key=?',[i.ownerId,i.requestKey]);
  if(old){
   if(old.contact_id!==i.contactId||!['running','committed'].includes(String(old.state)))fail('discussion_request_stale');
   const entry=tx.get('SELECT body FROM discussion_entry WHERE owner_id=? AND id=?',[i.ownerId,old.trigger_entry_id]);
   if(entry?.body!==i.text)fail('discussion_request_conflict');
   const a=tx.get('SELECT * FROM reply_attempt WHERE owner_id=? AND request_id=? ORDER BY attempt_no DESC LIMIT 1',[i.ownerId,old.id])!;
   return {attempt:attemptView(a,old),replayed:true,segmented:false};
  }
  if(tx.get("SELECT 1 FROM model_operation o JOIN reply_request r ON r.owner_id=o.owner_id AND r.id=o.reply_request_id WHERE r.owner_id=? AND r.contact_id=? AND o.state IN ('in_flight','unknown') AND o.commit_forbidden_at IS NULL",[i.ownerId,i.contactId]))fail('discussion_call_unknown');
  const selected=selectDiscussionForRequest(tx,{...i,id:i.discussionId}),d=selected.row,segmented=selected.segmented;
  const contact=requireDiscussionContact(tx,i.ownerId,i.contactId);
  const proof=i.identity;
  requireIdentity(tx,i.ownerId,i.contactId,i.requestKey,proof,contact.data_generation as bigint);
  tx.run("INSERT INTO reply_request VALUES(?,?,?,?,?,?,?,?,?,?,?, 'running')",[i.ownerId,i.requestId,i.contactId,d.id,i.requestKey,i.entryId,i.kind==='reply'?'reply':'discussion',proof.kind,proof.kind==='binding'?proof.bindingId:null,proof.kind==='binding'?proof.verificationId:null,proof.kind==='manual'?proof.confirmationId:null]);
  const pos=tx.get('SELECT COALESCE(MAX(position),0)+1 n FROM discussion_entry WHERE owner_id=? AND discussion_id=?',[i.ownerId,d.id])!.n;
  tx.run("INSERT INTO discussion_entry(owner_id,id,contact_id,discussion_id,position,role,body,origin_request_id,content_state) VALUES(?,?,?,?,?,'user',?,?,'available')",[i.ownerId,i.entryId,i.contactId,d.id,pos,i.text,i.requestId]);
  tx.run("INSERT INTO reply_attempt(owner_id,id,request_id,attempt_no,state,lease_token,accepted_data_generation,accepted_discussion_generation,accepted_source_revision,started_at,accepted_runtime_id,accepted_storage_epoch) VALUES(?,?,?,1,'running',?,?,?,?,?,?,?)",[i.ownerId,i.attemptId,i.requestId,i.leaseToken,contact.data_generation,d.generation,contact.source_revision,i.at,lease.runtimeId,lease.epoch]);
  tx.run('UPDATE assistant_discussion SET last_activity_at=? WHERE owner_id=? AND id=?',[i.at,i.ownerId,d.id]);
  const request=tx.get('SELECT * FROM reply_request WHERE owner_id=? AND id=?',[i.ownerId,i.requestId])!;
  return {attempt:attemptView(tx.get('SELECT * FROM reply_attempt WHERE owner_id=? AND id=?',[i.ownerId,i.attemptId])!,request),discussion:discussionView(d),replayed:false,segmented};
 }),
 action('freezeContext',(tx,i)=>{
  requireAttempt(tx,i);requireSkillRun(tx,i.ownerId,i.skillRun);
  const owner=tx.get('SELECT * FROM owner WHERE owner_id=?',[i.ownerId])!,c=requireDiscussionContact(tx,i.ownerId,i.contactId);
  tx.run("INSERT INTO reply_context VALUES(?,?,?,?,'request',?,?,?,?,?,?,?,?,'active')",[i.ownerId,i.contextId,i.contactId,i.discussionId,i.attemptId,i.requestId,owner.preference_revision,owner.skill_revision,owner.memory_revision,c.memory_revision,encode(i.skillRun),i.at]);
  if(!Array.isArray(i.items)||i.items.length>1000)fail('discussion_context_invalid');
  for(const [index,item] of i.items.entries()){
   const values=[i.ownerId,i.contextId,index+1,item.kind,'context',index+1];
   if(item.kind==='message'){
    if(item.sourceContactId!==i.contactId||!tx.get("SELECT 1 FROM capture_record r JOIN message m ON m.owner_id=r.owner_id AND m.id=r.message_id AND m.contact_id=r.contact_id WHERE r.owner_id=? AND r.contact_id=? AND r.id=? AND r.message_id=? AND r.availability='available' AND m.availability='available' AND m.interpretation_revision=? AND NOT EXISTS (SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)",[i.ownerId,item.sourceContactId,item.recordId,item.messageId,item.acceptedRevision]))fail('discussion_source_unavailable');
    tx.run('INSERT INTO reply_context_item VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)',[...values,item.sourceContactId,item.messageId,item.recordId,item.acceptedRevision]);
   }else if(item.kind==='entry'){
    const entry=tx.get("SELECT e.role,e.origin_request_id FROM discussion_entry e JOIN reply_request r ON r.owner_id=e.owner_id AND r.id=e.origin_request_id WHERE e.owner_id=? AND e.contact_id=? AND e.discussion_id=? AND e.id=? AND e.content_state='available' AND r.state<>'invalidated'",[i.ownerId,i.contactId,i.discussionId,item.entryId]);
    if(!entry||entry.role==='assistant'&&quarantinedDiscussionImpact(tx,i.ownerId).requests.has(String(entry.origin_request_id)))fail('discussion_source_unavailable');
    tx.run('INSERT INTO reply_context_item VALUES(?,?,?,?,?,?,NULL,NULL,NULL,NULL,?,NULL,NULL)',[...values,item.entryId]);
   }else if(item.kind==='skill'){
    if(!i.skillRun.eligible.some((a:any)=>a.packageId===item.packageId&&a.revisionNo===item.packageRevisionNo))fail('discussion_source_unavailable');
    tx.run('INSERT INTO reply_context_item VALUES(?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,?,?)',[...values,item.packageId,item.packageRevisionNo]);
   }else fail('discussion_context_invalid');
  }
  return i.contextId;
 }),
 action('cancel',(tx,i)=>{requireAttempt(tx,i);tx.run("UPDATE reply_attempt SET state='cancelled',finished_at=? WHERE owner_id=? AND id=?",[i.at,i.ownerId,i.attemptId]);tx.run("UPDATE reply_request SET state='cancelled' WHERE owner_id=? AND id=?",[i.ownerId,i.requestId]);}),
];
