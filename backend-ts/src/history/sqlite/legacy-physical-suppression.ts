import type {StorageTransaction,StorageRow} from '../../storage/sqlite/contracts.ts';
import type {ReadEligibility} from '../../contacts/sqlite/contracts.ts';
import type {HistorySupportReport,HistoryTarget} from './contracts.ts';
import {legacyProofDigest,legacyTargetDigest,validateLegacyTerminalProof,legacyRecallCandidates,
 type LegacyRecallCandidate,type LegacyTerminalProof} from './legacy-terminal-proof.ts';

interface PhysicalScope {ownerId:string;contactId:string;conversationId:string;key:string;terminalReason?:string;target?:HistoryTarget;report?:HistorySupportReport}
type PhysicalKey=[string,string,string,string];
/** 当前代次独立撤回记录对旧代次键的同一物理位置覆盖；只保存键，不保存正文、时间或昵称。 */
export interface RecallCoverageMapping {from:string;to:string;reason:'source_recalled'}
export const recallCoverageDigest=(mappings:readonly RecallCoverageMapping[]):string=>legacyProofDigest({format:'notalone-current-recall-coverage-v1',mappings});
function physicalKey(value:string):PhysicalKey|undefined {
 try{
  const key=JSON.parse(value);
  if(!Array.isArray(key)||key.length!==4||key.some(part=>typeof part!=='string'||!part||part.length>2048)
   ||JSON.stringify(key)!==value||!/^(0|[1-9][0-9]{0,19})$/.test(key[3])||BigInt(key[3])>18446744073709551615n)return;
  return key as PhysicalKey;
 }catch{return;}
}
/** 只接受与当前目标、当前代次及同一[分片,表实例,行号]一致的覆盖条目；不据别名、正文或时间推断。 */
function mappingMatch(mapping:unknown,key:PhysicalKey,target:HistoryTarget,currentGeneration:string,terminalReason:string|undefined,scopeKey:string):{fromKey:string;toKey:string}|undefined {
 if(!mapping||typeof mapping!=='object')return;
 const entry=mapping as Partial<RecallCoverageMapping>,from=physicalKey(String(entry.from)),to=physicalKey(String(entry.to));
 if(entry.reason!=='source_recalled'||!from||!to||from[0]===to[0]||to[0]!==currentGeneration)return;
 if(from.slice(1).some((part,index)=>part!==to[index+1]))return;
 if(!target.partitions.includes(from[1])||!target.tables.some(table=>table.partition===from[1]&&table.instance===from[2]))return;
 if(![from[0],to[0]].includes(key[0])||key[1]!==from[1]||key[2]!==from[2]||key[3]!==from[3])return;
 const fromKey=JSON.stringify([from[0],...key.slice(1)]),toKey=JSON.stringify([to[0],...key.slice(1)]);
 if(terminalReason!==undefined&&(entry.reason!==terminalReason||fromKey!==scopeKey&&toKey!==scopeKey))return;
 return {fromKey,toKey};
}
/** 核验时当前位置已由当前代次按同一读取契约独立记录撤回的旧键，映射到当前代次同一键；未覆盖返回 undefined。 */
export function coveredRecallKey(tx:StorageTransaction,scope:{ownerId:string;contactId:string;conversationId:string;key:string;target:HistoryTarget;report:HistorySupportReport}):string|undefined {
 const key=physicalKey(scope.key);
 if(!key||key[0]===scope.target.sourceGeneration||!scope.target.partitions.includes(key[1])
  ||!scope.target.tables.some(table=>table.partition===key[1]&&table.instance===key[2]))return;
 const expected=JSON.stringify([scope.target.sourceGeneration,...key.slice(1)]);
 // 覆盖证据还须来自同一账号、会话和读取契约（身份、连续性、状态语义）以及包含该物理位置的目标。
 return tx.get(`SELECT 1 FROM capture_record r
  JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
  JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
  JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.contact_id=g.contact_id AND b.id=g.binding_id
  JOIN channel_conversation cc ON cc.owner_id=b.owner_id AND cc.id=b.conversation_id
  JOIN channel_account a ON a.owner_id=cc.owner_id AND a.id=cc.account_id
  WHERE r.owner_id=? AND r.contact_id=? AND b.conversation_id=? AND r.state='excluded' AND r.reason_code='source_recalled'
   AND r.observed_scheme='source-table-local-v1' AND r.observed_key=?
   AND json_valid(g.support_json) AND json_extract(g.support_json,'$.status')='supported'
   AND json_extract(g.support_json,'$.identity')=? AND json_extract(g.support_json,'$.sourceGeneration')=?
   AND json_extract(g.support_json,'$.continuity')=? AND json_extract(g.support_json,'$.statusSemantics')=?
   AND a.external_key=? AND cc.external_key=?
   AND json_valid(g.target_json)
   AND EXISTS(SELECT 1 FROM json_each(g.target_json,'$.tables') target_table WHERE json_extract(target_table.value,'$.partition')=? AND json_extract(target_table.value,'$.instance')=?)
   AND EXISTS(SELECT 1 FROM json_each(g.target_json,'$.partitions') target_partition WHERE target_partition.value=?)
   LIMIT 1`,[scope.ownerId,scope.contactId,scope.conversationId,expected,scope.report.identity,scope.target.sourceGeneration,scope.report.continuity,scope.report.statusSemantics,scope.report.accountKey,scope.report.conversationKey,key[1],key[2],key[1]])?expected:undefined;
}
/** 已归档覆盖映射只按同一物理位置复用；审计摘要由调用方校验。 */
export function auditedCoverageKey(mappings:readonly unknown[]|undefined,keyValue:string,target:HistoryTarget,currentGeneration:string,terminalReason?:string):string|undefined {
 const key=physicalKey(keyValue);
 if(!key||!Array.isArray(mappings))return;
 for(const mapping of mappings){const matched=mappingMatch(mapping,key,target,currentGeneration,terminalReason,keyValue);if(matched)return matched.toKey;}
}
/** 未覆盖的旧撤回候选仍需维护证明；已由当前代次同位置撤回记录覆盖的候选不再要求。 */
export function uncoveredLegacyRecallCandidates(tx:StorageTransaction,token:ReadEligibility,target:HistoryTarget,report:HistorySupportReport):LegacyRecallCandidate[]{
 return legacyRecallCandidates(tx,token).filter(candidate=>!coveredRecallKey(tx,{ownerId:token.owner_id,contactId:token.contact_id,conversationId:token.conversation_id,key:candidate.key,target,report}));
}
/** 同一跨代次来源出现还需要固定的操作、token与绑定身份；两条映射分支共用。 */
interface CompletedLegacyContext {old:ReadEligibility;current:ReadEligibility;target:HistoryTarget;report:HistorySupportReport}
function completedLegacyContext(tx:StorageTransaction,scope:PhysicalScope,op:StorageRow):CompletedLegacyContext|undefined {
 try{
  if(op.failure_code!==null&&op.failure_code!==undefined||!op.goal_id||!op.new_binding_id||!op.new_grant_id)return;
  const old=JSON.parse(String(op.old_token_json)) as ReadEligibility,current=JSON.parse(String(op.token_json)) as ReadEligibility;
  const target=JSON.parse(String(op.target_json)) as HistoryTarget,report=JSON.parse(String(op.support_json)) as HistorySupportReport;
  if(!old||!current||!target||!report)return;
  if(old.owner_id!==scope.ownerId||old.contact_id!==scope.contactId||old.conversation_id!==scope.conversationId||old.binding_id!==op.old_binding_id
   ||current.owner_id!==old.owner_id||current.contact_id!==old.contact_id||current.account_id!==old.account_id||current.conversation_id!==old.conversation_id
   ||current.binding_id!==op.new_binding_id||current.grant_id!==op.new_grant_id)return;
  if(scope.target!==undefined&&(legacyTargetDigest(scope.target)!==legacyTargetDigest(target)||legacyProofDigest(scope.report)!==legacyProofDigest(report)))return;
  const identity=tx.get(`SELECT a.external_key account_key,c.external_key conversation_key,b.conversation_id FROM conversation_binding b
   JOIN channel_conversation c ON c.owner_id=b.owner_id AND c.id=b.conversation_id
   JOIN channel_account a ON a.owner_id=c.owner_id AND a.id=c.account_id
   WHERE b.owner_id=? AND b.contact_id=? AND b.id=? AND c.account_id=?`,[scope.ownerId,scope.contactId,current.binding_id,old.account_id]);
  if(!identity||identity.conversation_id!==scope.conversationId||identity.account_key!==report.accountKey||identity.conversation_key!==report.conversationKey)return;
  return {old,current,target,report};
 }catch{return;}
}
/** ADR-161：只有归档的独立旧/新读取器证明才扩展旧、新代次的同一物理出现。 */
function legacyProofKeys(scope:PhysicalScope,context:CompletedLegacyContext,archived:unknown):string[] {
 try{
  const audit=(archived as {legacy_terminal_mapping?:{digest?:unknown;proof?:unknown;candidates?:unknown}}|null)?.legacy_terminal_mapping;
  if(!audit||!Array.isArray(audit.candidates)||audit.digest!==legacyProofDigest({proof:audit.proof,candidates:audit.candidates}))return [];
  const proof=audit.proof as LegacyTerminalProof,candidates=audit.candidates as LegacyRecallCandidate[],key=physicalKey(scope.key)!;
  if(context.current.source_generation!==proof.current.scope.sourceGeneration)return [];
  validateLegacyTerminalProof({token:context.old,target:context.target,report:context.report,candidates},proof,Date.now(),false);
  const oldGeneration=proof.legacy.scope.sourceGeneration,newGeneration=proof.current.scope.sourceGeneration;
  if(![oldGeneration,newGeneration].includes(key[0])||!context.target.tables.some(table=>table.partition===key[1]&&table.instance===key[2]))return [];
  if(scope.terminalReason!==undefined&&!proof.keys.some(mapping=>mapping.reason===scope.terminalReason&&(mapping.from===scope.key||mapping.to===scope.key)))return [];
  return [JSON.stringify([oldGeneration,...key.slice(1)]),JSON.stringify([newGeneration,...key.slice(1)])];
 }catch{return [];}
}
/** 独立撤回覆盖：只按已记录的旧→当前同位置键扩展，不重复验证读取器证明。 */
function coverageKeys(scope:PhysicalScope,context:CompletedLegacyContext,archived:unknown):string[] {
 const key=physicalKey(scope.key),audit=(archived as {covered_terminal_mapping?:{digest?:unknown;mappings?:unknown}}|null)?.covered_terminal_mapping;
 if(!key||!audit||!Array.isArray(audit.mappings)||audit.digest!==recallCoverageDigest(audit.mappings as RecallCoverageMapping[]))return [];
 const result:string[]=[];
 for(const mapping of audit.mappings){const matched=mappingMatch(mapping,key,context.target,context.current.source_generation,scope.terminalReason,scope.key);if(matched)result.push(matched.fromKey,matched.toKey);}
 return result;
}
/** 只供删除、旧抑制继承和旧撤回候选判重；完成的独立认证证明不构成旧资料读取资格或通用身份别名。 */
export function completedLegacyPhysicalKeys(tx:StorageTransaction,scope:PhysicalScope):string[]{
 const key=physicalKey(scope.key),result=new Set([scope.key]);
 if((scope.target===undefined)!==(scope.report===undefined))return [...result];
 if(!key||!tx.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='history_source_recertification'"))return [...result];
 const operations=tx.all("SELECT * FROM history_source_recertification WHERE owner_id=? AND contact_id=? AND state='completed' AND stage='completed'",[scope.ownerId,scope.contactId]);
 for(const op of operations){
  let candidates:string[]=[];
  try{
   const archived=JSON.parse(String(op.old_fence_json)),context=completedLegacyContext(tx,scope,op);
   if(!context)continue;
   candidates=[...legacyProofKeys(scope,context,archived),...coverageKeys(scope,context,archived)];
  }catch{/* 缺失、损坏或不匹配的历史审计不授予跨代删除或抑制等价。 */}
  for(const candidate of candidates)result.add(candidate);
 }
 return [...result];
}
