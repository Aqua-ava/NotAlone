import {invalidHistoryDiscussionImpact} from './deletion.ts';
import {currentSourceScopeCTE,currentSourcePredicate} from '../../history/sqlite/current-scope.ts';
import {StorageFailure,type StorageAction,type StorageRow,type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {Discussion,DiscussionScope,RuntimeCopy} from './contracts.ts';
const fail=(code:string):never=>{throw new StorageFailure(code);};
export const identifier=(value:unknown):string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)?value:fail('discussion_input_invalid');
export function requireDiscussionContact(tx:StorageTransaction,ownerId:string,contactId:string):StorageRow {
 const c=tx.get("SELECT c.* FROM contact c JOIN owner o ON o.owner_id=c.owner_id WHERE c.owner_id=? AND c.id=? AND c.state='active' AND o.state='active'",[identifier(ownerId),identifier(contactId)])??fail('discussion_unavailable');
 if(tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed' AND (scope_kind='account' OR (contact_identity=? AND scope_kind IN ('contact','contact_history')))",[ownerId,contactId]))fail('discussion_deletion_pending');
 return c;
}
export function requireDiscussion(tx:StorageTransaction,scope:DiscussionScope):StorageRow {
 requireDiscussionContact(tx,scope.ownerId,scope.contactId);
 return tx.get("SELECT * FROM assistant_discussion WHERE owner_id=? AND contact_id=? AND id=? AND state='active'",[scope.ownerId,scope.contactId,identifier(scope.discussionId)])??fail('discussion_unavailable');
}
export const discussionView=(r:StorageRow):Discussion=>({id:String(r.id),contactId:String(r.contact_id),state:r.state as Discussion['state'],generation:r.generation as bigint,currentRuntimeId:r.current_runtime_id as string|null,createdAt:r.created_at as bigint,lastActivityAt:r.last_activity_at as bigint,isCurrent:r.is_current===1n});
export const runtimeView=(r:StorageRow):RuntimeCopy=>({ownerId:String(r.owner_id),contactId:String(r.contact_id),discussionId:String(r.discussion_id),id:String(r.id),sdkInstanceId:String(r.sdk_instance_id),managedLocator:String(r.managed_locator),address:r.address_json?JSON.parse(String(r.address_json)):null,writeGeneration:r.write_generation as bigint,dataGeneration:r.accepted_data_generation as bigint,sourceRevision:r.source_revision as bigint,state:r.state as RuntimeCopy['state'],committedRequestId:r.committed_request_id as string|null,eventBoundary:r.committed_event_boundary as string|null,configurationDigest:r.configuration_digest as string|null,cleanupOperationId:r.cleanup_operation_id as string|null,manifestComplete:r.manifest_complete===1n});
const at=(value:unknown):number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:fail('discussion_input_invalid');
const action=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,i:any)=>unknown):StorageAction=>({name:`discussion.${name}`,mode,retryBusy:mode==='write',execute});
function create(tx:StorageTransaction,i:any):StorageRow {
 requireDiscussionContact(tx,i.ownerId,i.contactId);identifier(i.id);at(i.at);
 tx.run('UPDATE assistant_discussion SET is_current=0 WHERE owner_id=? AND contact_id=?',[i.ownerId,i.contactId]);
 tx.run("INSERT INTO assistant_discussion(owner_id,id,contact_id,state,is_current,created_at,last_activity_at) VALUES(?,?,?,'active',1,?,?)",[i.ownerId,i.id,i.contactId,i.at,i.at]);
 return requireDiscussion(tx,{...i,discussionId:i.id});
}
export function selectDiscussionForRequest(tx:StorageTransaction,i:any):{row:StorageRow;segmented:boolean}{
 requireDiscussionContact(tx,i.ownerId,i.contactId);at(i.at);
 let row=tx.get("SELECT * FROM assistant_discussion WHERE owner_id=? AND contact_id=? AND state='active' AND is_current=1",[i.ownerId,i.contactId]);
 if(i.expectedDiscussionId!==undefined&&row?.id!==i.expectedDiscussionId)throw new StorageFailure('discussion_explicit_continue_required');
 const segmented=!!row&&BigInt(i.at)-(row.last_activity_at as bigint)>43_200_000n;
 if(!row||segmented)row=create(tx,i);else tx.run('UPDATE assistant_discussion SET last_activity_at=? WHERE owner_id=? AND id=?',[i.at,i.ownerId,row.id]);
 return {row:requireDiscussion(tx,{...i,discussionId:String(row.id)}),segmented};
}
export const discussionActions:StorageAction[]=[
 action('list','read',(tx,i)=>{requireDiscussionContact(tx,i.ownerId,i.contactId);const rows=tx.all("SELECT * FROM assistant_discussion WHERE owner_id=? AND contact_id=? AND state='active' ORDER BY created_at DESC,id",[i.ownerId,i.contactId]);return {currentDiscussionId:rows.find(r=>r.is_current===1n)?.id??null,discussions:rows.map(discussionView)};}),
 action('view','read',(tx,i)=>{const discussion=requireDiscussion(tx,i),affected=invalidHistoryDiscussionImpact(tx,i.ownerId);return {discussion:discussionView(discussion),entries:tx.all("SELECT e.id,e.position,e.role,CASE WHEN r.state='invalidated' THEN NULL ELSE e.body END body,e.origin_request_id,e.origin_call_id,CASE WHEN r.state='invalidated' THEN 'cleared' ELSE e.content_state END content_state FROM discussion_entry e JOIN reply_request r ON r.owner_id=e.owner_id AND r.id=e.origin_request_id WHERE e.owner_id=? AND e.contact_id=? AND e.discussion_id=? ORDER BY e.position",[i.ownerId,i.contactId,i.discussionId]).map(e=>e.role==='assistant'&&affected.requests.has(String(e.origin_request_id))?{...e,body:null,content_state:'cleared'}:e)};}),
 action('messages','read',(tx,i)=>{requireDiscussion(tx,i);if(!Array.isArray(i.messageIds)||i.messageIds.length>32||new Set(i.messageIds).size!==i.messageIds.length)throw new StorageFailure('discussion_context_invalid');if(!i.messageIds.length)return [];
  const ids=i.messageIds.map(identifier),sources=tx.all(`WITH ${currentSourceScopeCTE} SELECT m.id,m.text_body,m.sender_role,m.interpretation_revision,r.id record_id
   FROM message m JOIN capture_record r ON r.owner_id=m.owner_id AND r.contact_id=m.contact_id AND r.message_id=m.id
   JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id
   WHERE m.owner_id=? AND m.contact_id=? AND m.id IN (${ids.map(()=>'?').join(',')}) AND m.kind='text' AND m.availability='available'
   AND r.state='normalized' AND r.availability='available' AND ${currentSourcePredicate()}
   AND NOT EXISTS (SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id) ORDER BY r.id`,[i.ownerId,i.contactId,i.contactId,i.ownerId,i.contactId,...ids]);
  return ids.map((id:string)=>{const row=sources.find(source=>source.id===id);if(!row)throw new StorageFailure('discussion_source_unavailable');return row;});}),
 action('trace','read',(tx,i)=>{requireDiscussion(tx,i);if(invalidHistoryDiscussionImpact(tx,i.ownerId).requests.has(String(i.requestId)))throw new StorageFailure('discussion_unavailable');const request=tx.get("SELECT id,state FROM reply_request WHERE owner_id=? AND contact_id=? AND discussion_id=? AND id=? AND state<>'invalidated'",[i.ownerId,i.contactId,i.discussionId,i.requestId]);if(!request)throw new StorageFailure('discussion_unavailable');return {request,events:tx.all('SELECT e.id,e.event_no,e.kind,e.originated_call_id,e.payload FROM execution_event e JOIN reply_attempt a ON a.owner_id=e.owner_id AND a.id=e.reply_attempt_id WHERE a.owner_id=? AND a.request_id=? ORDER BY e.event_no',[i.ownerId,i.requestId]),calls:tx.all('SELECT c.id,c.provider,c.state,c.attempt_no,c.actual_budget_units,c.settlement_state,c.receipt FROM model_call c JOIN reply_attempt a ON a.owner_id=c.owner_id AND a.id=c.reply_attempt_id WHERE a.owner_id=? AND a.request_id=? ORDER BY c.attempt_no',[i.ownerId,i.requestId])};}),
 action('new','write',(tx,i)=>discussionView(create(tx,i))),
 action('forRequest','write',(tx,i)=>{const selected=selectDiscussionForRequest(tx,i);return {discussion:discussionView(selected.row),segmented:selected.segmented};}),
 action('continue','write',(tx,i)=>{requireDiscussion(tx,i);at(i.at);tx.run('UPDATE assistant_discussion SET is_current=0 WHERE owner_id=? AND contact_id=?',[i.ownerId,i.contactId]);tx.run('UPDATE assistant_discussion SET is_current=1,last_activity_at=? WHERE owner_id=? AND id=?',[i.at,i.ownerId,i.discussionId]);return discussionView(requireDiscussion(tx,i));}),
];
