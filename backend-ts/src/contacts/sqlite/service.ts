import { createHash, randomUUID } from 'node:crypto';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import type { SqliteStorage } from '../../storage/sqlite/client.ts';
import type { AccountEvidence, ContactMetadataPort, ContactSelection, ReadEligibility, SavedContactBinding, WechatVersionCompatibility } from './contracts.ts';
import { WECHAT_METADATA_SUPPORT } from '../../history/wechat/support-profile.ts';
import { normalizeContactAvatar, type ContactAvatar } from './avatar.ts';
import { projectContactSyncStatus } from './sync-status.ts';
import {isUuid as uuid} from '../../platform/uuid.ts';
function fail(code:string):never {throw new StorageFailure(code);}
const identity=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_.@-]{1,255}$/.test(v);
const version=(value:unknown):value is string=>typeof value==='string'&&/^[0-9]{1,3}(\.[0-9]{1,3}){1,3}$/.test(value);
const build=(value:unknown):value is string=>typeof value==='string'&&/^[0-9]{1,12}$/.test(value);
function compatibilityFor(evidence:AccountEvidence):WechatVersionCompatibility|undefined {
 if(evidence.assurance!=='unverified'||!evidence.programVersion||!evidence.build)return undefined;
 return {detected_program_version:evidence.programVersion,detected_build:evidence.build,
  supported_program_version:WECHAT_METADATA_SUPPORT.programVersion,supported_build:WECHAT_METADATA_SUPPORT.build};
}
function assertAccountEvidence(evidence:AccountEvidence):void {if(!identity(evidence.externalKey)||!identity(evidence.identityScheme)||!identity(evidence.sourceGeneration)||!identity(evidence.supportProfile)||!['verified','unverified'].includes(evidence.assurance)||evidence.programVersion!==undefined&&!version(evidence.programVersion)||evidence.build!==undefined&&!build(evidence.build))fail('metadata_identity_unverified');}
interface Directory { contacts: {contact_id:string;display_name:string;selection_generation:string;data_generation:string;avatar_revision:string|null;data_status:{message_count:number;source_count:number}}[]; bindings:SavedContactBinding[];account:{id:string;external_key:string;identity_scheme:string;source_generation:string;scope_revision:bigint}|null;read_enabled:boolean }
interface SourceReconfirmation {accountId:string;sourceGeneration:string;scopeRevision:string}
interface Snapshot {at:number; evidence:AccountEvidence;accountId:string;scopeRevision:string;rows:Map<string,{displayName:string;generation:string;contactId?:string;verificationId:string;grantId:string;bindingId:string;conversationId:string;newContactId:string}>}
/** 所有渠道 I/O 在事务外；身份和提交资格在具名短事务内复验。 */
export class SqliteContactService {
 private candidate?:{token:string;evidence:AccountEvidence;at:number;sourceReconfirmation?:SourceReconfirmation};
 private readonly snapshots=new Map<string,Snapshot>();
 private closed=false;
 private readonly pendingMetadata=new Set<Promise<unknown>>();
 private readonly avatarReads=new Map<AbortController,string>();
 private closing?:Promise<void>;
 private readonly storage:SqliteStorage;
 readonly ownerId:string;
 private readonly metadata:ContactMetadataPort;
 private readonly clock:()=>number;
 constructor(storage:SqliteStorage,ownerId:string,metadata:ContactMetadataPort,clock:()=>number=Date.now){if(!uuid(ownerId))fail('identity_request_invalid');this.storage=storage;this.ownerId=ownerId;this.metadata=metadata;this.clock=clock;}
 private execute<T=any>(name:string,input:object):Promise<T>{if(this.closed)fail('identity_closed');return this.storage.execute(name,{ownerId:this.ownerId,at:this.clock(),...input});}
 initialize(){return this.execute('identity.initialize',{});}
 directory(){return this.execute<Directory>('identity.directory',{});}
 async avatar(contactId:string,_signal?:AbortSignal):Promise<ContactAvatar|null>{
  if(!uuid(contactId))fail('identity_request_invalid');
  return this.execute<ContactAvatar|null>('identity.avatarRead',{contactId});
 }
 avatarRevision(){return this.execute<string>('identity.avatarRevision',{});}
 async syncAvatar(contactId:string,signal?:AbortSignal):Promise<boolean>{
  if(!uuid(contactId))fail('identity_request_invalid');
  if(!this.metadata.avatar||this.closed)return false;
  const controller=new AbortController();this.avatarReads.set(controller,contactId);
  const combined=AbortSignal.any([controller.signal,AbortSignal.timeout(10_000),...(signal?[signal]:[])]);
  try{return await this.readMetadata(async()=>{
   const token=await this.eligibility(contactId);
   const scope=await this.execute<{accountKey:string;identityScheme:string;sourceGeneration:string;conversationKey:string}>('identity.avatarScope',{token});
   combined.throwIfAborted();
   const evidence=await this.metadata.account(combined);
   if(evidence.assurance!=='verified'||evidence.externalKey!==scope.accountKey||evidence.identityScheme!==scope.identityScheme||evidence.sourceGeneration!==scope.sourceGeneration)return false;
   const input=await this.metadata.avatar!(evidence,scope.conversationKey,combined);
   combined.throwIfAborted();if(!input)return false;
   const avatar=await normalizeContactAvatar(input,combined);
   combined.throwIfAborted();if(!avatar)return false;
   await this.execute('identity.avatarSave',{token,base64:avatar.base64,digest:createHash('sha256').update(Buffer.from(avatar.base64,'base64')).digest('hex')});
   combined.throwIfAborted();return true;
  });}catch{return false;}finally{this.avatarReads.delete(controller);}
 }

 syncDirectory(){return this.execute<Pick<Directory,'read_enabled'|'bindings'>>('identity.syncDirectory',{});}
 async syncSnapshot(){
  const directory=await this.syncDirectory();
  const status=projectContactSyncStatus(directory,await this.avatarRevision());
  return {directory,status};
 }
 foregroundSnapshot(){return this.execute<import('../../foreground/sqlite-foreground.ts').ForegroundSnapshot>('identity.foregroundSnapshot',{});}
 private readMetadata<T>(read:()=>Promise<T>):Promise<T>{
  if(this.closed)fail('identity_closed');
  const pending=Promise.resolve().then(()=>{if(this.closed)fail('identity_closed');return read();})
   .finally(()=>{this.pendingMetadata.delete(pending);});
  this.pendingMetadata.add(pending);return pending;
 }
 private async account(signal?:AbortSignal):Promise<AccountEvidence>{
  if(this.closed)fail('identity_closed');
  let evidence:AccountEvidence;
  try { evidence=await this.readMetadata(()=>this.metadata.account(signal)); } catch(error) {
   if(signal?.aborted||this.closed)fail('identity_cancelled');
   const saved=await this.directory();
   if(saved.account&&!signal?.aborted)await this.execute('identity.invalidateAccount',{accountId:saved.account.id});
   throw error;
  }
  if(signal?.aborted||this.closed)fail('identity_cancelled');
  assertAccountEvidence(evidence);
  const saved=await this.directory();
  if(saved.account&&(evidence.assurance!=='verified'||saved.account.external_key!==evidence.externalKey||saved.account.identity_scheme!==evidence.identityScheme||saved.account.source_generation!==evidence.sourceGeneration))await this.execute('identity.invalidateAccount',{accountId:saved.account.id});
  return evidence;
 }
 async detectAccount(signal?:AbortSignal){
  const evidence=await this.account(signal);
  const sourceReconfirmation=evidence.assurance==='verified'?await this.execute<SourceReconfirmation|undefined>('identity.sourceReconfirmation',{evidence}):undefined;
  if(this.closed)fail('identity_closed');
  this.candidate={token:randomUUID(),evidence,at:this.clock(),sourceReconfirmation};
  const compatibility=compatibilityFor(evidence);
  return {account_id:evidence.externalKey,candidate_token:this.candidate.token,verified:evidence.assurance==='verified',failure_code:evidence.assurance==='unverified'?evidence.unverifiedReason??'metadata_identity_unverified':null,...(sourceReconfirmation?{source_reconfirmation_required:true}:{}),...(compatibility?{wechat_compatibility:compatibility}:{})};
 }
 async confirmAccount(token:string,signal?:AbortSignal,sourceReconfirmed=false){
  const c=this.candidate;if(!c||c.token!==token||this.clock()-c.at>120_000)fail('account_candidate_stale');
  if(sourceReconfirmed&&!c.sourceReconfirmation)fail('identity_request_invalid');
  // 重确认只读回候选证据，较晚选中的其他账号必须留给写事务核验，不能先撤销。
  let evidence:AccountEvidence;
  try { evidence=sourceReconfirmed?await this.readMetadata(()=>this.metadata.account(signal)):await this.account(signal); }
  catch(error){if(signal?.aborted||this.closed)fail('identity_cancelled');throw error;}
  if(signal?.aborted||this.closed)fail('identity_cancelled');
  if(sourceReconfirmed)assertAccountEvidence(evidence);
  if(this.candidate!==c||this.clock()-c.at>120_000||JSON.stringify(evidence)!==JSON.stringify(c.evidence))fail('account_candidate_stale');
  if(evidence.assurance!=='verified')fail('metadata_identity_unverified');
  return this.execute<string>('identity.connect',{evidence,accountId:randomUUID(),...(sourceReconfirmed?{sourceReconfirmation:c.sourceReconfirmation}:{})});
 }
 private async observe(evidence:AccountEvidence,sessions?:{externalKey:string;displayName:string}[]){
  const current=await this.execute<{current:boolean;accountId:string;scopeRevision:string}>('identity.observe',{evidence,sessions});
  if(!current.current)fail('account_identity_changed');return current;
 }
 async candidates(consent:boolean,signal?:AbortSignal){
  if(consent!==true)fail('metadata_consent_required');
  const evidence=await this.account(signal);const account=await this.observe(evidence);
  if(evidence.assurance!=='verified')fail('metadata_identity_unverified');
  let rows:{externalKey:string;displayName:string}[];
  try {
  const raw=await this.readMetadata(()=>this.metadata.sessions(evidence,signal));
  if(signal?.aborted||this.closed)fail('identity_cancelled');
  if(!Array.isArray(raw)||raw.length>5000)fail('metadata_invalid');
  const known=await this.directory();
  if(raw.some(row=>row&&row.kind!=='private'&&known.bindings.some(b=>b.account_id===account.accountId&&b.conversation_locator===row.externalKey)))fail('metadata_identity_conflict');
  const seen=new Set<string>();
  // 只投影必要身份和名称；丢弃上游夹带摘要、正文和媒体字段。
  rows=raw.filter(row=>row.kind==='private').map(row=>{if(row.identityAssurance!=='verified')fail('metadata_identity_unverified');if(!identity(row.externalKey)||typeof row.displayName!=='string'||!row.displayName.trim()||row.displayName.length>255||seen.has(row.externalKey))fail('metadata_identity_conflict');seen.add(row.externalKey);return {externalKey:row.externalKey,displayName:row.displayName};});
  } catch(error) {
   // 无法核验整份名单时先撤销旧资格，不能只拒绝新候选而继续接受旧结果。
   if(!signal?.aborted&&!this.closed)await this.execute('identity.invalidateAccount',{accountId:account.accountId});throw error;
  }
  const after=await this.account(signal);
  if(JSON.stringify(evidence)!==JSON.stringify(after)){await this.observe(after);fail('account_identity_changed');}
  await this.observe(after,rows);
  const directory=await this.directory();
  const token=randomUUID();
  const map=new Map(rows.map(row=>{const bound=directory.bindings.find(b=>b.conversation_locator===row.externalKey&&b.account_id===account.accountId);
   return [row.externalKey,{displayName:row.displayName,generation:bound?.selection_generation??'0',contactId:bound?.contact_id,verificationId:randomUUID(),grantId:randomUUID(),bindingId:randomUUID(),conversationId:randomUUID(),newContactId:randomUUID()}] as const;}));
  if(this.closed)fail('identity_closed');
  this.snapshots.set(token,{at:this.clock(),evidence,accountId:account.accountId,scopeRevision:account.scopeRevision,rows:map});
  for(const [key,snapshot]of this.snapshots)if(this.clock()-snapshot.at>120_000||this.snapshots.size>32)this.snapshots.delete(key);
  return {snapshot_token:token,sessions:rows.map(row=>{const b=directory.bindings.find(b=>b.conversation_locator===row.externalKey&&b.account_id===account.accountId&&b.status==='active');return {username:row.externalKey,display_name:row.displayName,last_timestamp:null,bound_contact_id:b?.contact_id??null,known_contact_id:map.get(row.externalKey)?.contactId??null,selection_generation:map.get(row.externalKey)!.generation};})};
 }
 async confirm(token:string,selections:ContactSelection[],signal?:AbortSignal){
  const snapshot=this.snapshots.get(token);
  if(!snapshot||this.clock()-snapshot.at>120_000)fail('selection_stale');
  if(!Array.isArray(selections)||!selections.length||selections.length>5000||new Set(selections.map(s=>s.locator)).size!==selections.length)fail('identity_request_invalid');
  const evidence=await this.account(signal);
  if(JSON.stringify(evidence)!==JSON.stringify(snapshot.evidence)){await this.observe(evidence);fail('account_identity_changed');}
  await this.observe(evidence);
  const live=await this.candidates(true,signal);
  for(const choice of selections)if(!live.sessions.some(row=>row.username===choice.locator&&row.display_name===choice.observed_display_name))fail('selection_stale');
  const choices=selections.map(s=>{const row=snapshot.rows.get(s.locator);if(!row||row.displayName!==s.observed_display_name||s.expected_selection_generation!==row.generation||s.contact_id&&s.contact_id!==row.contactId)fail('selection_stale');return {...s,contactId:row.contactId??row.newContactId,verificationId:row.verificationId,grantId:row.grantId,bindingId:row.bindingId,conversationId:row.conversationId};});
  if(signal?.aborted||this.closed)fail('identity_cancelled');
  return this.execute<{bindings:SavedContactBinding[];sync_enabled:boolean}>('identity.confirm',{accountId:snapshot.accountId,scopeRevision:snapshot.scopeRevision,sourceGeneration:evidence.sourceGeneration,supportProfile:evidence.supportProfile,choices});
 }
 revoke(contactId:string,bindingId:string,expectedGeneration:string){if(!uuid(contactId)||!uuid(bindingId))fail('identity_request_invalid');for(const [read,id] of this.avatarReads)if(id===contactId)read.abort();return this.execute('identity.revoke',{contactId,bindingId,expectedGeneration});}
 setReading(enabled:boolean){if(!enabled)for(const read of this.avatarReads.keys())read.abort();return this.execute('identity.setReading',{enabled});}
 eligibility(contactId:string){return this.execute<ReadEligibility>('identity.eligibility',{contactId});}
 validate(token:ReadEligibility){if(token.owner_id!==this.ownerId)fail('read_not_authorized');return this.execute('identity.validate',{token});}
 manualConfirm(contactId:string,contextToken:string){if(!uuid(contactId))fail('identity_request_invalid');return this.execute<string>('identity.manualConfirm',{contactId,contextToken,id:randomUUID()});}
 close():Promise<void>{
  this.closed=true;this.snapshots.clear();this.candidate=undefined;
  for(const read of this.avatarReads.keys())read.abort();
  return this.closing??=(async()=>{
   await this.metadata.close?.();
   // 端口close/abort返回不证明读取已结算；未结束的读取继续阻止删除完成。
   await Promise.allSettled([...this.pendingMetadata]);
  })().catch(error=>{this.closing=undefined;throw error;});
 }
}
