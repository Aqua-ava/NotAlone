import {randomUUID} from 'node:crypto';
import {StorageFailure,type StorageAction,type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import {assertReadEligibility} from '../../contacts/sqlite/actions.ts';
import type {ReadEligibility} from '../../contacts/sqlite/contracts.ts';
import {assertHistoryReadBoundary} from './suppression.ts';
import type {HistoryQuoteContent,MessageSourceReference} from './contracts.ts';
import {assertSourceEligibility} from './source.ts';
import {currentSourcePredicate,currentSourceScopeCTE} from './current-scope.ts';
import {isUuid} from '../../platform/uuid.ts';

const quoteType='244813135921';
export const quoteParserVersion='wechat-quote-v2';
const fail=(code:string):never=>{throw new StorageFailure(code);};
function id(value:unknown):string {if(typeof value!=='string'||!value||value.length>256||/[\x00-\x1f]/.test(value))return fail('history_quote_request_invalid');return value;}
function version(value:unknown):string {if(typeof value!=='string'||value.length<1||value.length>128||/[\x00-\x1f]/.test(value))return fail('history_quote_request_invalid');return value;}
function senderRole(value:unknown):value is HistoryQuoteContent['referencedSenderRole'] {return value==='owner'||value==='contact'||value==='unknown';}
function serverId(value:unknown):value is string|null {
 if(value===null)return true;
 return typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value)&&BigInt(value)<=18446744073709551615n;
}
function content(value:unknown):HistoryQuoteContent {
 const row=value as Partial<HistoryQuoteContent>|null;
 if(!row||typeof row!=='object'||typeof row.replyText!=='string'||!row.replyText.trim()||row.replyText.length>1_000_000
  ||row.referencedText!==null&&typeof row.referencedText!=='string'||typeof row.referencedText==='string'&&row.referencedText.length>1_000_000
  ||row.referencedSender!==null&&typeof row.referencedSender!=='string'||typeof row.referencedSender==='string'&&row.referencedSender.length>255
  ||!senderRole(row.referencedSenderRole)||row.referencedType!==null&&typeof row.referencedType!=='string'
  ||typeof row.referencedType==='string'&&(!row.referencedType||row.referencedType.length>128)
  ||!serverId(row.referencedServerId))return fail('history_quote_content_invalid');
 return {replyText:row.replyText,referencedText:row.referencedText,referencedSender:row.referencedSender,
  referencedSenderRole:row.referencedSenderRole,referencedType:row.referencedType,referencedServerId:row.referencedServerId};
}
function source(tx:StorageTransaction,token:ReadEligibility,recordId:string,messageId:string){
 assertSourceEligibility(tx,{owner_id:token.owner_id,contact_id:token.contact_id,record_id:recordId,message_id:messageId} satisfies MessageSourceReference);
 const row=tx.get(`SELECT r.normalizer_version,r.raw_payload,r.state,r.availability,r.message_id,r.observed_key,m.binding_id,m.kind,m.text_body,m.original_type,
  m.interpretation_revision,m.status_code,g.target_json,g.support_json
  FROM capture_record r JOIN message m ON m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id
  JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
  JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
  WHERE r.owner_id=? AND r.contact_id=? AND r.id=? AND r.message_id=? AND g.binding_id=?
   AND json_extract(g.target_json,'$.sourceGeneration')=?`,
  [token.owner_id,token.contact_id,recordId,messageId,token.binding_id,token.source_generation]);
 if(!row||row.state!=='normalized'||row.availability!=='available'||typeof row.observed_key!=='string'||row.binding_id!==token.binding_id
  ||row.kind!=='other'||row.text_body!==null||row.original_type!==quoteType)return fail('history_quote_source_not_available');
 try{
  const raw=JSON.parse(String(row.raw_payload));
  if(raw?.originalType!==quoteType)return fail('history_quote_source_not_available');
 }catch(error){if(error instanceof StorageFailure)throw error;return fail('history_quote_source_not_available');}
 return row;
}
function targetFor(tx:StorageTransaction,token:ReadEligibility,serverKey:string|null):string|null {
 if(serverKey===null||serverKey==='0')return null;
 const rows=tx.all(`WITH ${currentSourceScopeCTE}
  SELECT DISTINCT m.id FROM message_alias a JOIN message m ON m.owner_id=a.owner_id AND m.contact_id=a.contact_id AND m.id=a.message_id
  JOIN capture_record r ON r.owner_id=m.owner_id AND r.contact_id=m.contact_id AND r.message_id=m.id
  JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
  JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
  WHERE a.owner_id=? AND a.contact_id=? AND a.binding_id=? AND a.scheme='server' AND a.external_key=?
   AND m.binding_id=? AND m.availability='available' AND r.state='normalized' AND r.availability='available'
   AND json_extract(g.support_json,'$.serverAliasSemantics')='verified_within_scope'
   AND NOT EXISTS(SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)
   AND ${currentSourcePredicate('r','g')}`,
  [token.owner_id,token.contact_id,token.contact_id,token.owner_id,token.contact_id,token.binding_id,serverKey,token.binding_id]);
 return rows.length===1?String(rows[0]!.id):null;
}
function targetExcluded(tx:StorageTransaction,token:ReadEligibility,serverKey:string|null):boolean {
 if(serverKey===null||serverKey==='0')return false;
 return Boolean(tx.get(`SELECT 1 FROM history_source_exclusion x JOIN conversation_binding b
  ON b.owner_id=x.owner_id AND b.conversation_id=x.conversation_id
  WHERE x.owner_id=? AND x.conversation_id=? AND x.scheme='server' AND x.external_key=?
   AND b.owner_id=? AND b.contact_id=? AND b.id=? AND b.state='verified'`,
  [token.owner_id,token.conversation_id,serverKey,token.owner_id,token.contact_id,token.binding_id]));
}
function revisions(value:unknown,field:string):number {
 const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed<1)throw new StorageFailure(`history_quote_${field}_invalid`);return parsed;
}
function assertScope(tx:StorageTransaction,token:ReadEligibility):void {
 assertReadEligibility(tx,token);assertHistoryReadBoundary(tx,token);
}
const action=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,input:any)=>unknown):StorageAction=>({name:`history.quote${name}`,mode,retryBusy:mode==='write',execute});

export interface SaveHistoryQuoteInput {
 token:ReadEligibility;recordId:string;messageId:string;version:string;content:HistoryQuoteContent;proofDigest:string;
}
export interface FailHistoryQuoteInput {
 token:ReadEligibility;recordId:string;messageId:string;version:string;errorCode:string;
}
/** Storage action 与正常同步共用这段事务逻辑，确保联系人、来源删除和目标排除规则一致。 */
export function saveHistoryQuoteInTransaction(tx:StorageTransaction,input:SaveHistoryQuoteInput){
 const token=input.token,recordId=id(input.recordId),messageId=id(input.messageId),expectedVersion=version(input.version),quote=content(input.content);
 if(!isUuid(recordId)||!isUuid(messageId)||typeof input.proofDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.proofDigest))fail('history_quote_request_invalid');
 assertScope(tx,token);const sourceRow=source(tx,token,recordId,messageId),excludedTarget=targetExcluded(tx,token,quote.referencedServerId);
 const savedContent:HistoryQuoteContent=excludedTarget?{...quote,referencedText:null,referencedSender:null,referencedSenderRole:'unknown',
  referencedType:null,referencedServerId:null}:quote;
 const targetMessageId=excludedTarget?null:targetFor(tx,token,savedContent.referencedServerId);
 const state=targetMessageId?'resolved':savedContent.referencedText!==null||savedContent.referencedServerId!==null?'unresolved':'unavailable';
 const prior=tx.get('SELECT * FROM history_quote WHERE owner_id=? AND contact_id=? AND message_id=?',[token.owner_id,token.contact_id,messageId]);
 const sourceChanged=Boolean(prior&&(prior.source_key!==sourceRow.observed_key||prior.source_generation!==token.source_generation));
 const contentChanged=!prior||sourceChanged||prior.reply_text!==savedContent.replyText||prior.referenced_text!==savedContent.referencedText
  ||prior.referenced_sender!==savedContent.referencedSender||prior.referenced_sender_role!==savedContent.referencedSenderRole
  ||prior.referenced_type!==savedContent.referencedType||prior.referenced_server_id!==savedContent.referencedServerId
  ||prior.target_message_id!==targetMessageId||prior.state!==state
  ||String(prior.carrier_interpretation_revision)!==String(sourceRow.interpretation_revision);
 const sourceRevision=prior?revisions(prior.source_revision,'source_revision')+(sourceChanged?1:0):1;
 const interpretationRevision=prior?revisions(prior.interpretation_revision,'interpretation_revision')+(contentChanged?1:0):1;
 const changed=!prior||contentChanged||prior.version!==expectedVersion||prior.proof_digest!==input.proofDigest
  ||prior.source_record_id!==recordId||prior.source_key!==sourceRow.observed_key||prior.source_generation!==token.source_generation;
 const quoteValues=[savedContent.replyText,savedContent.referencedText,savedContent.referencedSender,savedContent.referencedSenderRole,
  savedContent.referencedType,savedContent.referencedServerId,targetMessageId,state,input.proofDigest];
 if(!prior){
  tx.run(`INSERT INTO history_quote(owner_id,id,contact_id,message_id,binding_id,source_record_id,source_key,source_generation,version,reply_text,
   referenced_text,referenced_sender,referenced_sender_role,referenced_type,referenced_server_id,target_message_id,state,proof_digest,
   source_revision,interpretation_revision,carrier_interpretation_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
   [token.owner_id,randomUUID(),token.contact_id,messageId,token.binding_id,recordId,sourceRow.observed_key,token.source_generation,expectedVersion,...quoteValues,sourceRevision,interpretationRevision,sourceRow.interpretation_revision]);
 }else if(changed){
  tx.run(`UPDATE history_quote SET source_record_id=?,source_key=?,source_generation=?,version=?,reply_text=?,referenced_text=?,referenced_sender=?,referenced_sender_role=?,referenced_type=?,referenced_server_id=?,target_message_id=?,state=?,proof_digest=?,source_revision=?,interpretation_revision=?,carrier_interpretation_revision=? WHERE owner_id=? AND contact_id=? AND message_id=?`,
   [recordId,sourceRow.observed_key,token.source_generation,expectedVersion,savedContent.replyText,savedContent.referencedText,savedContent.referencedSender,
    savedContent.referencedSenderRole,savedContent.referencedType,savedContent.referencedServerId,targetMessageId,state,input.proofDigest,sourceRevision,
    interpretationRevision,sourceRow.interpretation_revision,token.owner_id,token.contact_id,messageId]);
 }
 tx.run(`INSERT INTO history_quote_attempt(owner_id,id,contact_id,message_id,binding_id,record_id,source_key,source_generation,version,carrier_interpretation_revision,carrier_status,outcome,error_code)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,'saved',NULL) ON CONFLICT(owner_id,contact_id,message_id,source_generation,source_key,version,carrier_interpretation_revision,carrier_status)
  DO UPDATE SET outcome='saved',error_code=NULL WHERE outcome<>'saved' OR error_code IS NOT NULL`,
  [token.owner_id,randomUUID(),token.contact_id,messageId,token.binding_id,recordId,sourceRow.observed_key,token.source_generation,expectedVersion,sourceRow.interpretation_revision,sourceRow.status_code===null?'':String(sourceRow.status_code)]);
 return {saved:true,changed,targetMessageId,state,sourceRevision,interpretationRevision};
}
export function failHistoryQuoteInTransaction(tx:StorageTransaction,input:FailHistoryQuoteInput){
 const token=input.token,recordId=id(input.recordId),messageId=id(input.messageId),expectedVersion=version(input.version),errorCode=id(input.errorCode);
 if(!isUuid(recordId)||!isUuid(messageId)||!/^[a-z][a-z0-9_]{0,79}$/.test(errorCode))fail('history_quote_request_invalid');
 assertScope(tx,token);const sourceRow=source(tx,token,recordId,messageId),carrierStatus=sourceRow.status_code===null?'':String(sourceRow.status_code);
 const existing=tx.get('SELECT outcome,error_code FROM history_quote_attempt WHERE owner_id=? AND contact_id=? AND message_id=? AND source_key=? AND source_generation=? AND version=? AND carrier_interpretation_revision=? AND carrier_status=?',
  [token.owner_id,token.contact_id,messageId,sourceRow.observed_key,token.source_generation,expectedVersion,sourceRow.interpretation_revision,carrierStatus]);
 if(existing?.outcome==='saved')return {failed:false,alreadySaved:true,changed:false};
 if(existing?.outcome==='failed'&&existing.error_code===errorCode)return {failed:true,unchanged:true,changed:false};
 tx.run(`INSERT INTO history_quote_attempt(owner_id,id,contact_id,message_id,binding_id,record_id,source_key,source_generation,version,carrier_interpretation_revision,carrier_status,outcome,error_code)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,'failed',?) ON CONFLICT(owner_id,contact_id,message_id,source_generation,source_key,version,carrier_interpretation_revision,carrier_status)
  DO UPDATE SET outcome='failed',error_code=excluded.error_code`,
  [token.owner_id,randomUUID(),token.contact_id,messageId,token.binding_id,recordId,sourceRow.observed_key,token.source_generation,expectedVersion,sourceRow.interpretation_revision,carrierStatus,errorCode]);
 return {failed:true,changed:true};
}

export const historyQuoteActions:StorageAction[]=[
 action('Candidates','read',(tx,i)=>{
  const token=i.token as ReadEligibility,expectedVersion=version(i.version),limit=i.limit;
  assertScope(tx,token);
  if(!Number.isSafeInteger(limit)||limit<1||limit>50)fail('history_quote_request_invalid');
  const rows=tx.all(`WITH ${currentSourceScopeCTE}, ranked AS (
   SELECT m.id message_id,r.id record_id,row_number() OVER(PARTITION BY m.id ORDER BY coalesce(c.acceptance_no,0) DESC,r.item_no DESC,r.id DESC) rank_no
   FROM message m JOIN capture_record r ON r.owner_id=m.owner_id AND r.contact_id=m.contact_id AND r.message_id=m.id
   JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
   JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
   WHERE m.owner_id=? AND m.contact_id=? AND m.binding_id=? AND m.kind='other' AND m.text_body IS NULL AND m.original_type=?
    AND m.availability='available' AND r.state='normalized' AND r.availability='available' AND r.message_id IS NOT NULL
    AND r.normalizer_version IN ('1','2') AND json_valid(r.raw_payload) AND json_extract(r.raw_payload,'$.originalType')=?
    AND g.binding_id=? AND json_extract(g.target_json,'$.sourceGeneration')=?
    AND NOT EXISTS(SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)
    AND EXISTS(SELECT 1 FROM source_proof f WHERE f.owner_id=m.owner_id AND f.contact_id=m.contact_id AND f.state='ok')
    AND ${currentSourcePredicate('r','g')}
    AND NOT EXISTS(SELECT 1 FROM history_quote_attempt a WHERE a.owner_id=m.owner_id AND a.contact_id=m.contact_id AND a.message_id=m.id
     AND a.source_key=r.observed_key AND a.source_generation=? AND a.version=?
     AND a.carrier_interpretation_revision=m.interpretation_revision AND a.carrier_status=coalesce(m.status_code,''))
  ) SELECT message_id,record_id FROM ranked WHERE rank_no=1 ORDER BY message_id LIMIT ?`,
   [token.owner_id,token.contact_id,token.contact_id,token.owner_id,token.contact_id,token.binding_id,quoteType,quoteType,
    token.binding_id,token.source_generation,token.source_generation,expectedVersion,limit]);
  // 候选只包含受当前授权、删除围栏、绑定、来源代次及稳定来源键约束的元数据。
  // 本机候选沿用持久来源事实；原生读取前再建立本次易失守卫，不因进程重启撤销既有来源资格。
  return rows.map(row=>({messageId:String(row.message_id),recordId:String(row.record_id)}));
 }),
 action('Save','write',(tx,i)=>{const {changed:_changed,...result}=saveHistoryQuoteInTransaction(tx,i as SaveHistoryQuoteInput);return result;}),
 action('Fail','write',(tx,i)=>{const {changed:_changed,...result}=failHistoryQuoteInTransaction(tx,i as FailHistoryQuoteInput);return result;}),
];

/** 受控存储门面；解析期间 token 由 HistoryService.withChannel 绑定，候选也自行重验当前资格。 */
export class SqliteQuoteStore {
 private readonly storage:SqliteStorage;private readonly ownerId:string;
 constructor(storage:SqliteStorage,ownerId:string){this.storage=storage;this.ownerId=id(ownerId);}
 async candidates(contactId:string,versionValue:string,limit=10):Promise<{messageId:string;recordId:string}[]> {
  const contact=id(contactId);if(!isUuid(contact)||!Number.isSafeInteger(limit)||limit<1||limit>50)fail('history_quote_request_invalid');
  const token=await this.storage.execute<ReadEligibility>('identity.eligibility',{ownerId:this.ownerId,contactId:contact});
  return this.storage.execute('history.quoteCandidates',{token,version:version(versionValue),limit});
 }
 save(input:{token:ReadEligibility;recordId:string;messageId:string;version:string;content:HistoryQuoteContent;proofDigest:string}):Promise<unknown> {
  if(input.token.owner_id!==this.ownerId)fail('read_not_authorized');
  return this.storage.execute('history.quoteSave',input);
 }
 fail(input:{token:ReadEligibility;recordId:string;messageId:string;version:string;errorCode:string}):Promise<unknown> {
  if(input.token.owner_id!==this.ownerId)fail('read_not_authorized');
  return this.storage.execute('history.quoteFail',input);
 }
}
