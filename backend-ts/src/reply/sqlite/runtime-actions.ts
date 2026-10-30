import {createHash} from 'node:crypto';
import {StorageFailure,type StorageAction,type StorageRow,type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {ManagedAddress} from '../../storage/sqlite/deletion/contracts.ts';
import {requireSkillRun} from '../../skills/sqlite/storage.ts';
import type {SkillRunRevision} from '../../skills/sqlite/contracts.ts';
import {requireDiscussion,requireDiscussionContact,runtimeView,identifier} from './actions.ts';
import {requireAttempt,decode} from './requests.ts';
import {quarantinedDiscussionImpact} from './deletion.ts';
const fail=(code:string):never=>{throw new StorageFailure(code);};
const action=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,i:any)=>unknown):StorageAction=>({name:`runtime.${name}`,mode,retryBusy:mode==='write',execute});
function copy(tx:StorageTransaction,i:any):StorageRow{return tx.get('SELECT * FROM runtime_copy WHERE owner_id=? AND contact_id=? AND discussion_id=? AND id=?',[identifier(i.ownerId),identifier(i.contactId),identifier(i.discussionId),identifier(i.copyId)])??fail('discussion_runtime_unavailable');}
export function requireRuntimeCurrent(tx:StorageTransaction,i:any):StorageRow{
 const row=copy(tx,i),d=requireDiscussion(tx,i),c=requireDiscussionContact(tx,i.ownerId,i.contactId);
 if(quarantinedDiscussionImpact(tx,i.ownerId).copies.has(String(row.id)))fail('discussion_runtime_invalidated');
 if(row.state!=='preparing'&&d.current_runtime_id!==row.id||!['dirty','ready','preparing'].includes(String(row.state))||row.write_generation!==d.generation||row.accepted_data_generation!==c.data_generation||row.source_revision!==c.source_revision||row.cleanup_operation_id!==null)fail('discussion_runtime_invalidated');
 for(const context of tx.all('SELECT c.*,r.provenance_state FROM runtime_context r JOIN reply_context c ON c.owner_id=r.owner_id AND c.id=r.context_id WHERE r.owner_id=? AND r.copy_id=?',[i.ownerId,i.copyId])){
  if(context.provenance_state!=='verified'||context.state!=='active')fail('discussion_runtime_invalidated');
  requireSkillRun(tx,i.ownerId,decode<SkillRunRevision>(String(context.skill_run_json)));
  const owner=tx.get('SELECT * FROM owner WHERE owner_id=?',[i.ownerId])!;
  if(context.preference_revision!==owner.preference_revision||context.owner_memory_revision!==owner.memory_revision||context.contact_memory_revision!==c.memory_revision)fail('discussion_runtime_invalidated');
  for(const item of tx.all("SELECT * FROM reply_context_item WHERE owner_id=? AND context_id=? AND kind='message'",[i.ownerId,context.id]))if(!tx.get("SELECT 1 FROM capture_record r JOIN message m ON m.owner_id=r.owner_id AND m.id=r.message_id AND m.contact_id=r.contact_id WHERE r.owner_id=? AND r.contact_id=? AND r.id=? AND r.message_id=? AND r.availability='available' AND m.availability='available' AND m.interpretation_revision=?",[i.ownerId,item.source_contact_id,item.record_id,item.message_id,item.accepted_revision]))fail('discussion_runtime_invalidated');
  for(const item of tx.all("SELECT * FROM reply_context_item WHERE owner_id=? AND context_id=? AND kind='entry'",[i.ownerId,context.id]))if(!tx.get("SELECT 1 FROM discussion_entry e JOIN reply_request r ON r.owner_id=e.owner_id AND r.id=e.origin_request_id WHERE e.owner_id=? AND e.id=? AND e.content_state='available' AND r.state<>'invalidated'",[i.ownerId,item.entry_id]))fail('discussion_runtime_invalidated');
 }
 return row;
}
function address(value:ManagedAddress,row:StorageRow,root=false):void{
 if(!value||value.area!=='runtime'||(root?value.locator!==row.managed_locator||value.kind!=='directory':value.locator!==row.managed_locator&&!value.locator.startsWith(`${row.managed_locator}/`)))fail('discussion_runtime_identity_conflict');
 const parts=value.locator.split('/');
 if(!parts.every(p=>/^[a-zA-Z0-9_.-]{1,128}$/.test(p)&&p!=='.'&&p!=='..')||value.ancestors.length!==parts.length)fail('discussion_runtime_identity_conflict');
 for(const id of [value.identity,...value.ancestors])if(!id||!['dev','ino','birthtimeNs','uid'].every(k=>/^\d+$/.test((id as any)[k])))fail('discussion_runtime_identity_conflict');
}
export const runtimeActions:StorageAction[]=[
 action('inventory','read',(tx,i)=>tx.all("SELECT * FROM runtime_copy WHERE owner_id=? AND state<>'deleted'",[identifier(i.ownerId)]).map(runtimeView)),
 action('inspect','read',(tx,i)=>runtimeView(requireRuntimeCurrent(tx,i))),
 action('prepare','write',(tx,i)=>{
  requireAttempt(tx,i);const d=requireDiscussion(tx,i),c=requireDiscussionContact(tx,i.ownerId,i.contactId);
  identifier(i.copyId);identifier(i.sdkInstanceId);
  if(i.locator!==i.copyId||!/^[a-f0-9]{64}$/.test(i.configurationDigest))fail('discussion_input_invalid');
  tx.run(`INSERT INTO runtime_copy(owner_id,id,contact_id,discussion_id,sdk_instance_id,managed_locator,write_generation,accepted_data_generation,source_revision,state,configuration_digest,preparing_attempt_id) VALUES(?,?,?,?,?,?,?,?,?,'preparing',?,?)`,[i.ownerId,i.copyId,i.contactId,i.discussionId,i.sdkInstanceId,i.locator,d.generation,c.data_generation,c.source_revision,i.configurationDigest,i.attemptId]);
  return runtimeView(copy(tx,i));
 }),
 action('attach','write',(tx,i)=>{
  const row=copy(tx,i);address(i.address,row,true);
  if(row.address_json!==null&&row.address_json!==JSON.stringify(i.address))fail('discussion_runtime_identity_conflict');
  if(row.state==='preparing'&&i.cleanupOnly===true){tx.run("UPDATE runtime_copy SET address_json=?,state='blocked' WHERE owner_id=? AND id=?",[JSON.stringify(i.address),i.ownerId,i.copyId]);}
  else if(row.state==='preparing'){requireAttempt(tx,i);if(row.preparing_attempt_id!==i.attemptId)fail('discussion_runtime_preparation_stale');requireRuntimeCurrent(tx,i);tx.run("UPDATE runtime_copy SET address_json=?,state='dirty' WHERE owner_id=? AND id=?",[JSON.stringify(i.address),i.ownerId,i.copyId]);tx.run('UPDATE assistant_discussion SET current_runtime_id=? WHERE owner_id=? AND id=?',[i.copyId,i.ownerId,i.discussionId]);}
  else if(['deleting','blocked'].includes(String(row.state)))tx.run('UPDATE runtime_copy SET address_json=? WHERE owner_id=? AND id=?',[JSON.stringify(i.address),i.ownerId,i.copyId]);
  else fail('discussion_runtime_state_conflict');
  return runtimeView(copy(tx,i));
 }),
 action('manifest','write',(tx,i)=>{
  const row=copy(tx,i);
  if(!Array.isArray(i.files)||i.files.length>10000||row.state==='deleted')fail('discussion_runtime_manifest_invalid');
  if(i.rootAbsent){if(row.address_json!==null||i.files.length)fail('discussion_runtime_identity_conflict');}
  else{
   if(!row.address_json)fail('discussion_runtime_identity_conflict');
   if(!i.files.some((a:ManagedAddress)=>JSON.stringify(a)===row.address_json))fail('discussion_runtime_manifest_invalid');
  }
  const locators=new Set();
  for(const a of i.files){address(a,row);if(locators.has(a.locator))fail('discussion_runtime_manifest_invalid');locators.add(a.locator);}
  // 每次官方close后替换工程身份索引；05已有计划中的身份永不覆盖。
  if(row.cleanup_operation_id!==null&&tx.get('SELECT 1 FROM deletion_target WHERE operation_id=? AND domain=\'discussion\' AND storage_kind=\'file\'',[row.cleanup_operation_id])){
   for(const a of i.files){const old=tx.all('SELECT address_json FROM runtime_file WHERE owner_id=? AND copy_id=?',[i.ownerId,i.copyId]).find(f=>JSON.parse(String(f.address_json)).locator===a.locator);if(old&&old.address_json!==JSON.stringify(a))fail('discussion_runtime_identity_conflict');}
  }else tx.run('DELETE FROM runtime_file WHERE owner_id=? AND copy_id=?',[i.ownerId,i.copyId]);
  for(const a of i.files){const fileId=createHash('sha256').update(JSON.stringify([i.copyId,a])).digest('hex');tx.run('INSERT OR IGNORE INTO runtime_file(owner_id,copy_id,file_id,address_json) VALUES(?,?,?,?)',[i.ownerId,i.copyId,fileId,JSON.stringify(a)]);}
  tx.run('UPDATE runtime_copy SET manifest_complete=1 WHERE owner_id=? AND id=?',[i.ownerId,i.copyId]);
 }),
 action('dirty','write',(tx,i)=>{requireAttempt(tx,i);const row=requireRuntimeCurrent(tx,i);if(row.state!=='ready')fail('discussion_runtime_recovery_blocked');tx.run('DELETE FROM runtime_file WHERE owner_id=? AND copy_id=?',[i.ownerId,i.copyId]);tx.run("UPDATE runtime_copy SET state='dirty',manifest_complete=0 WHERE owner_id=? AND id=?",[i.ownerId,i.copyId]);}),
 action('incorporate','write',(tx,i)=>{
  requireAttempt(tx,i);const row=requireRuntimeCurrent(tx,i);if(row.state!=='dirty')fail('discussion_runtime_state_conflict');
  if(!tx.get("SELECT 1 FROM reply_context WHERE owner_id=? AND id=? AND contact_id=? AND discussion_id=? AND attempt_id=? AND request_id=? AND state='active'",[i.ownerId,i.contextId,i.contactId,i.discussionId,i.attemptId,i.requestId]))fail('discussion_context_invalid');
  const next=tx.get('SELECT COALESCE(MAX(incorporation_no),0)+1 n FROM runtime_context WHERE owner_id=? AND copy_id=?',[i.ownerId,i.copyId])!.n;
  tx.run("INSERT INTO runtime_context VALUES(?,?,?,?,NULL,NULL,'verified')",[i.ownerId,i.copyId,next,i.contextId]);
 }),
 action('ready','write',(tx,i)=>{
  requireAttempt(tx,i,true);const row=requireRuntimeCurrent(tx,i);let boundary;
  try{boundary=JSON.parse(i.eventBoundary);}catch{fail('discussion_runtime_boundary_invalid');}
  if(row.state!=='dirty'||row.manifest_complete!==1n||row.committed_request_id!==i.requestId||row.configuration_digest!==i.configurationDigest||boundary.formatVersion!==4||!Number.isSafeInteger(boundary.eventCount)||boundary.eventCount<1||!/^[a-f0-9]{64}$/.test(boundary.eventSha256))fail('discussion_runtime_boundary_invalid');
  tx.run("UPDATE runtime_copy SET state='ready',committed_event_boundary=? WHERE owner_id=? AND id=?",[i.eventBoundary,i.ownerId,i.copyId]);
  return runtimeView(copy(tx,i));
 }),
];
