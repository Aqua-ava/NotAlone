import type {StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {ReadEligibility} from '../../contacts/sqlite/contracts.ts';
import type {HistorySupportReport,HistoryTarget} from './contracts.ts';
import {legacyProofDigest,legacyTargetDigest,validateLegacyTerminalProof,type LegacyRecallCandidate,type LegacyTerminalProof} from './legacy-terminal-proof.ts';

interface PhysicalScope {ownerId:string;contactId:string;conversationId:string;key:string;terminalReason?:string;target?:HistoryTarget;report?:HistorySupportReport}
function physicalKey(value:string):[string,string,string,string]|undefined {
 try{
  const key=JSON.parse(value);
  if(!Array.isArray(key)||key.length!==4||key.some(part=>typeof part!=='string'||!part||part.length>2048)
   ||JSON.stringify(key)!==value||!/^(0|[1-9][0-9]{0,19})$/.test(key[3])||BigInt(key[3])>18446744073709551615n)return;
  return key as [string,string,string,string];
 }catch{return;}
}

/** 只供删除和旧抑制继承；完成的独立认证证明不构成旧资料读取资格或通用身份别名。 */
export function completedLegacyPhysicalKeys(tx:StorageTransaction,scope:PhysicalScope):string[]{
 const key=physicalKey(scope.key),result=new Set([scope.key]);
 if((scope.target===undefined)!==(scope.report===undefined))return [...result];
 if(!key||!tx.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='history_source_recertification'"))return [...result];
 const operations=tx.all("SELECT * FROM history_source_recertification WHERE owner_id=? AND contact_id=? AND state='completed' AND stage='completed'",[scope.ownerId,scope.contactId]);
 for(const op of operations)try{
  const archived=JSON.parse(String(op.old_fence_json)),audit=archived.legacy_terminal_mapping;
  if(!audit||!Array.isArray(audit.candidates)||audit.digest!==legacyProofDigest({proof:audit.proof,candidates:audit.candidates}))continue;
  const proof=audit.proof as LegacyTerminalProof,candidates=audit.candidates as LegacyRecallCandidate[];
  const old=JSON.parse(String(op.old_token_json)) as ReadEligibility,current=JSON.parse(String(op.token_json)) as ReadEligibility;
  const target=JSON.parse(String(op.target_json)) as HistoryTarget,report=JSON.parse(String(op.support_json)) as HistorySupportReport;
  if(scope.target!==undefined&&(legacyTargetDigest(scope.target)!==legacyTargetDigest(target)||legacyProofDigest(scope.report)!==legacyProofDigest(report)))continue;
  if(op.failure_code!==null||!op.goal_id||!op.new_binding_id||!op.new_grant_id
   ||old.owner_id!==scope.ownerId||old.contact_id!==scope.contactId||old.conversation_id!==scope.conversationId||old.binding_id!==op.old_binding_id
   ||current.owner_id!==old.owner_id||current.contact_id!==old.contact_id||current.account_id!==old.account_id||current.conversation_id!==old.conversation_id
   ||current.binding_id!==op.new_binding_id||current.grant_id!==op.new_grant_id||current.source_generation!==proof.current.scope.sourceGeneration)continue;
  const identity=tx.get(`SELECT a.external_key account_key,c.external_key conversation_key,b.conversation_id FROM conversation_binding b
   JOIN channel_conversation c ON c.owner_id=b.owner_id AND c.id=b.conversation_id
   JOIN channel_account a ON a.owner_id=c.owner_id AND a.id=c.account_id
   WHERE b.owner_id=? AND b.contact_id=? AND b.id=? AND c.account_id=?`,[scope.ownerId,scope.contactId,current.binding_id,old.account_id]);
  if(!identity||identity.conversation_id!==scope.conversationId||identity.account_key!==report.accountKey||identity.conversation_key!==report.conversationKey)continue;
  // 归档候选与证明在写入事务内一起核验并散列；删除种子后不依赖旧capture仍存在。
  validateLegacyTerminalProof({token:old,target,report,candidates},proof,Date.now(),false);
  const oldGeneration=proof.legacy.scope.sourceGeneration,newGeneration=proof.current.scope.sourceGeneration;
  if(![oldGeneration,newGeneration].includes(key[0])||!target.tables.some(table=>table.partition===key[1]&&table.instance===key[2]))continue;
  if(scope.terminalReason!==undefined&&!proof.keys.some(mapping=>mapping.reason===scope.terminalReason&&(mapping.from===scope.key||mapping.to===scope.key)))continue;
  result.add(JSON.stringify([oldGeneration,...key.slice(1)]));result.add(JSON.stringify([newGeneration,...key.slice(1)]));
 }catch{/* 缺失、损坏或不匹配的历史审计不授予跨代删除或抑制等价。 */}
 return [...result];
}
