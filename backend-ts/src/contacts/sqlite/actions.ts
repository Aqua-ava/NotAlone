import { StorageFailure, type StorageAction, type StorageRow, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { ReadEligibility, SavedContactBinding } from './contracts.ts';
const fail = (code: string): never => { throw new StorageFailure(code); };
const one = (tx: StorageTransaction, sql: string, args: any[]): StorageRow => tx.get(sql,args) ?? fail('identity_not_found');
const text = (value: unknown): string => typeof value==='string' && value.length>0 && value.length<=512 ? value : fail('identity_request_invalid');
const generation = (value: unknown): bigint => typeof value==='string' && /^(0|[1-9][0-9]{0,17})$/.test(value) ? BigInt(value) : fail('identity_request_invalid');
const action = (name: string, mode: 'read'|'write', execute: (tx: StorageTransaction,input: any)=>unknown): StorageAction =>
  ({name,mode,retryBusy:true,execute:(tx,input)=>execute(tx,input)});
function revoke(tx: StorageTransaction, owner: string, contact: string, at: number, reason: string): void {
  const active=tx.get('SELECT id FROM read_grant WHERE owner_id=? AND contact_id=? AND revoked_at IS NULL',[owner,contact]);
  if (!active) return;
  tx.run('UPDATE read_grant SET revoked_at=?,reason=? WHERE owner_id=? AND id=?',[at,reason,owner,active.id]);
  tx.run('UPDATE contact SET selection_generation=selection_generation+1 WHERE owner_id=? AND id=?',[owner,contact]);
}
function invalidateAccount(tx: StorageTransaction, owner: string, account: string, at: number): void {
  const contacts=tx.all(`SELECT b.contact_id FROM conversation_binding b JOIN channel_conversation c ON c.owner_id=b.owner_id AND c.id=b.conversation_id WHERE c.owner_id=? AND c.account_id=?`,[owner,account]);
  for(const c of contacts) revoke(tx,owner,String(c.contact_id),at,'account_changed');
  tx.run("UPDATE channel_account SET identity_state='unavailable',scope_revision=scope_revision+1 WHERE owner_id=? AND id=? AND identity_state='verified'",[owner,account]);
}
function bindings(tx: StorageTransaction, owner: string): SavedContactBinding[] {
 return tx.all(`SELECT b.id AS binding_id,b.contact_id,c.account_id,c.external_key AS conversation_locator,c.display_name,
 CASE WHEN g.id IS NOT NULL AND b.state='verified' AND a.identity_state='verified' THEN 'active' ELSE 'revoked' END AS status,
 p.selection_generation,g.id AS grant_id FROM conversation_binding b
 JOIN channel_conversation c ON c.owner_id=b.owner_id AND c.id=b.conversation_id
 JOIN channel_account a ON a.owner_id=c.owner_id AND a.id=c.account_id
 JOIN contact p ON p.owner_id=b.owner_id AND p.id=b.contact_id
 LEFT JOIN read_grant g ON g.owner_id=b.owner_id AND g.binding_id=b.id AND g.revoked_at IS NULL
 WHERE b.owner_id=? AND p.state='active' ORDER BY b.id`,[owner]).map(row=>({...row,selection_generation:String(row.selection_generation)})) as unknown as SavedContactBinding[];
}
/** 下游必须在接受写入的同一个短事务中调用；令牌不等于单独的读取授权。 */
export function assertReadEligibility(tx: StorageTransaction, token: ReadEligibility): void {
 const current=eligibility(tx,token.owner_id,token.contact_id);
 if(Object.keys(current).some(key=>current[key as keyof ReadEligibility]!==token[key as keyof ReadEligibility])) fail('read_eligibility_stale');
}
function eligibility(tx: StorageTransaction, owner: string, contact: string): ReadEligibility {
 const row=tx.get(`SELECT o.owner_id,p.id AS contact_id,a.id AS account_id,c.id AS conversation_id,b.id AS binding_id,
 g.id AS grant_id,v.id AS verification_id,o.read_epoch,p.selection_generation,p.data_generation,
 b.identity_generation,a.scope_revision,c.barrier_generation,a.source_generation
 FROM owner o JOIN contact p ON p.owner_id=o.owner_id
 JOIN conversation_binding b ON b.owner_id=p.owner_id AND b.contact_id=p.id
 JOIN channel_conversation c ON c.owner_id=b.owner_id AND c.id=b.conversation_id
 JOIN channel_account a ON a.owner_id=c.owner_id AND a.id=c.account_id
 JOIN read_grant g ON g.owner_id=b.owner_id AND g.binding_id=b.id AND g.contact_id=p.id
 JOIN binding_verification v ON v.owner_id=g.owner_id AND v.id=g.verification_id AND v.binding_id=b.id
 WHERE o.owner_id=? AND p.id=? AND o.state='active' AND o.read_enabled=1 AND p.state='active' AND b.state='verified'
 AND a.identity_state='verified' AND a.scope_mode='selected' AND g.revoked_at IS NULL
 AND g.selection_generation=p.selection_generation AND v.identity_generation=b.identity_generation`,[owner,contact]);
 if(!row) return fail('read_not_authorized');
 return Object.fromEntries(Object.entries(row).map(([k,v])=>[k,String(v)])) as unknown as ReadEligibility;
}
export const identityActions: StorageAction[] = [
 action('identity.resolveOwner','write',(tx,i)=>{const owners=tx.all('SELECT owner_id FROM owner');if(owners.length>1)fail('owner_ambiguous');if(owners.length)return owners[0].owner_id;tx.run('INSERT INTO owner(owner_id,created_at) VALUES(?,?)',[text(i.proposedOwnerId),i.at]);return i.proposedOwnerId;}),
 action('identity.initialize','write',(tx,i)=>{text(i.ownerId);tx.run('INSERT INTO owner(owner_id,created_at) VALUES(?,?) ON CONFLICT(owner_id) DO NOTHING',[i.ownerId,i.at]);return i.ownerId;}),
 action('identity.directory','read',(tx,i)=>({contacts:tx.all("SELECT id AS contact_id,display_name,selection_generation,data_generation FROM contact WHERE owner_id=? AND state='active' ORDER BY id",[text(i.ownerId)]).map(c=>({...c,selection_generation:String(c.selection_generation),data_generation:String(c.data_generation),data_status:{message_count:0,source_count:0}})),bindings:bindings(tx,i.ownerId),account:tx.get("SELECT id,external_key,source_generation,scope_revision FROM channel_account WHERE owner_id=? AND identity_state='verified'",[i.ownerId])??null,read_enabled:tx.get('SELECT read_enabled FROM owner WHERE owner_id=?',[i.ownerId])?.read_enabled===1n})),
 action('identity.connect','write',(tx,i)=>{
  one(tx,"SELECT owner_id FROM owner WHERE owner_id=? AND state='active'",[i.ownerId]);
  if(i.evidence.assurance!=='verified') fail('metadata_identity_unverified');
  const current=tx.get("SELECT * FROM channel_account WHERE owner_id=? AND identity_state='verified'",[i.ownerId]);
  const old=tx.get('SELECT * FROM channel_account WHERE owner_id=? AND identity_scheme=? AND external_key=?',[i.ownerId,text(i.evidence.identityScheme),text(i.evidence.externalKey)]);
  if(old && old.source_generation!==i.evidence.sourceGeneration) fail('identity_continuity_unverified');
  if(current?.id===old?.id && old) return String(old.id);
  if(current) invalidateAccount(tx,i.ownerId,String(current.id),i.at);
  if(old) tx.run("UPDATE channel_account SET identity_state='verified',scope_revision=scope_revision+1 WHERE owner_id=? AND id=?",[i.ownerId,old.id]);
  else tx.run("INSERT INTO channel_account(owner_id,id,identity_scheme,external_key,source_generation,identity_state,scope_confirmed_at) VALUES(?,?,?,?,?,'verified',?)",[i.ownerId,i.accountId,i.evidence.identityScheme,i.evidence.externalKey,text(i.evidence.sourceGeneration),i.at]);
  return String(old?.id??i.accountId);
 }),
 action('identity.invalidateAccount','write',(tx,i)=>{invalidateAccount(tx,i.ownerId,i.accountId,i.at);return {invalidated:true};}),
 action('identity.observe','write',(tx,i)=>{
  const account=tx.get("SELECT * FROM channel_account WHERE owner_id=? AND identity_state='verified'",[i.ownerId]);
  if(!account) return {current:false};
  if(i.evidence.assurance!=='verified'||account.external_key!==i.evidence.externalKey||account.identity_scheme!==i.evidence.identityScheme||account.source_generation!==i.evidence.sourceGeneration){invalidateAccount(tx,i.ownerId,String(account.id),i.at);return {current:false};}
  if(i.sessions)for(const session of i.sessions){
   const c=tx.get('SELECT * FROM channel_conversation WHERE owner_id=? AND account_id=? AND external_key=?',[i.ownerId,account.id,session.externalKey]);
   if(!c||c.display_name===session.displayName)continue;
   const b=tx.get("SELECT b.* FROM conversation_binding b JOIN contact p ON p.owner_id=b.owner_id AND p.id=b.contact_id WHERE b.owner_id=? AND b.conversation_id=? AND b.state<>'revoked' AND p.state='active'",[i.ownerId,c.id]);
   if(!b)continue;
   if(b){revoke(tx,i.ownerId,String(b.contact_id),i.at,'display_name_changed');tx.run("UPDATE conversation_binding SET state='needs_confirmation',identity_generation=identity_generation+1 WHERE owner_id=? AND id=?",[i.ownerId,b.id]);}
   tx.run('UPDATE channel_conversation SET display_name=? WHERE owner_id=? AND id=?',[session.displayName,i.ownerId,c.id]);
  }
  return {current:true,accountId:account.id,scopeRevision:String(account.scope_revision)};
 }),
 action('identity.confirm','write',(tx,i)=>{
  const account=one(tx,"SELECT * FROM channel_account WHERE owner_id=? AND id=? AND identity_state='verified'",[i.ownerId,i.accountId]);
  if(String(account.scope_revision)!==i.scopeRevision||account.source_generation!==i.sourceGeneration)fail('account_scope_stale');
  for(const choice of i.choices){
   const c=tx.get('SELECT * FROM channel_conversation WHERE owner_id=? AND account_id=? AND external_key=?',[i.ownerId,i.accountId,choice.locator]);
   let b=c&&tx.get("SELECT * FROM conversation_binding WHERE owner_id=? AND conversation_id=? AND state<>'revoked'",[i.ownerId,c.id]);
   if(c&&!b&&tx.get('SELECT id FROM conversation_binding WHERE owner_id=? AND conversation_id=?',[i.ownerId,c.id]))fail('binding_identity_conflict');
   if(c?.display_name!==undefined&&c.display_name!==choice.observed_display_name)fail('selection_stale');
   let contactId=b?.contact_id??choice.contactId;
   if(choice.contact_id&&choice.contact_id!==contactId)fail('binding_identity_conflict');
   if(b){
    const g=tx.get('SELECT * FROM read_grant WHERE owner_id=? AND binding_id=? AND revoked_at IS NULL',[i.ownerId,b.id]);
    if(g?.verification_id===choice.verificationId)continue;
    if(g)fail('selection_stale');
   }else{
    // 不以名称复用；存在旧绑定或其他渠道时不能把联系人改绑过去。
    if(choice.contact_id||c&&tx.get('SELECT id FROM conversation_binding WHERE owner_id=? AND conversation_id=?',[i.ownerId,c.id]))fail('binding_identity_conflict');
    if(generation(choice.expected_selection_generation)!==0n)fail('selection_stale');
    tx.run('INSERT INTO contact(owner_id,id,display_name) VALUES(?,?,?)',[i.ownerId,contactId,choice.observed_display_name]);
    if(!c)tx.run("INSERT INTO channel_conversation(owner_id,id,account_id,identity_scheme,external_key,display_name) VALUES(?,?,?,'wechat.private.v1',?,?)",[i.ownerId,choice.conversationId,i.accountId,choice.locator,choice.observed_display_name]);
    tx.run("INSERT INTO conversation_binding(owner_id,id,contact_id,conversation_id,state) VALUES(?,?,?,?,'verified')",[i.ownerId,choice.bindingId,contactId,c?.id??choice.conversationId]);
    b=one(tx,'SELECT * FROM conversation_binding WHERE owner_id=? AND id=?',[i.ownerId,choice.bindingId]);
   }
   const contact=one(tx,"SELECT * FROM contact WHERE owner_id=? AND id=? AND state='active'",[i.ownerId,contactId]);
   if(contact.selection_generation!==generation(choice.expected_selection_generation))fail('selection_stale');
   tx.run("UPDATE conversation_binding SET state='verified' WHERE owner_id=? AND id=?",[i.ownerId,b.id]);
   tx.run('UPDATE contact SET selection_generation=selection_generation+1,display_name=? WHERE owner_id=? AND id=?',[choice.observed_display_name,i.ownerId,contactId]);
   tx.run("INSERT INTO binding_verification(owner_id,id,binding_id,identity_generation,method,proof_format,proof,verified_at) VALUES(?,?,?,?,'channel_metadata','identity-metadata-v1',?,?)",[i.ownerId,choice.verificationId,b.id,b.identity_generation,JSON.stringify({support_profile:i.supportProfile,source_generation:i.sourceGeneration,account_id:i.accountId,conversation_id:b.conversation_id}),i.at]);
   tx.run('INSERT INTO read_grant(owner_id,id,contact_id,binding_id,verification_id,selection_generation,granted_at) VALUES(?,?,?,?,?,?,?)',[i.ownerId,choice.grantId,contactId,b.id,choice.verificationId,contact.selection_generation as bigint+1n,i.at]);
  }
  return {bindings:bindings(tx,i.ownerId),sync_enabled:tx.get('SELECT read_enabled FROM owner WHERE owner_id=?',[i.ownerId])?.read_enabled===1n};
 }),
 action('identity.revoke','write',(tx,i)=>{const b=one(tx,'SELECT * FROM conversation_binding WHERE owner_id=? AND contact_id=? AND id=?',[i.ownerId,i.contactId,i.bindingId]);const c=one(tx,'SELECT selection_generation FROM contact WHERE owner_id=? AND id=?',[i.ownerId,i.contactId]);if(String(c.selection_generation)!==i.expectedGeneration){if(!tx.get('SELECT id FROM read_grant WHERE owner_id=? AND binding_id=? AND revoked_at IS NULL',[i.ownerId,b.id]))return {revoked:true};fail('selection_stale');}revoke(tx,i.ownerId,i.contactId,i.at,'user_cancelled');return {revoked:true};}),
 action('identity.setReading','write',(tx,i)=>{if(typeof i.enabled!=='boolean')fail('identity_request_invalid');one(tx,"SELECT owner_id FROM owner WHERE owner_id=? AND state='active'",[i.ownerId]);tx.run('UPDATE owner SET read_enabled=?,read_epoch=read_epoch+1 WHERE owner_id=? AND read_enabled<>?',[i.enabled?1:0,i.ownerId,i.enabled?1:0]);return {sync_enabled:i.enabled};}),
 action('identity.eligibility','read',(tx,i)=>eligibility(tx,text(i.ownerId),text(i.contactId))),
 action('identity.validate','read',(tx,i)=>{assertReadEligibility(tx,i.token);return {valid:true};}),
 action('identity.manualConfirm','write',(tx,i)=>{const c=one(tx,"SELECT data_generation FROM contact WHERE owner_id=? AND id=? AND state='active'",[i.ownerId,i.contactId]);const old=tx.get('SELECT * FROM manual_confirmation WHERE owner_id=? AND context_token=?',[i.ownerId,text(i.contextToken)]);if(old){if(old.contact_id!==i.contactId||old.state!=='active'||old.accepted_data_generation!==c.data_generation)fail('manual_confirmation_stale');return old.id;}tx.run("INSERT INTO manual_confirmation(owner_id,id,contact_id,context_token,accepted_data_generation,confirmed_at,state) VALUES(?,?,?,?,?,?,'active')",[i.ownerId,i.id,i.contactId,i.contextToken,c.data_generation,i.at]);return i.id;})
];
