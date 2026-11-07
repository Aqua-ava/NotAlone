import {createHash} from 'node:crypto';
import type {StorageTransaction,StorageRow} from '../contracts.ts';
import type {ReadEligibility} from '../../../contacts/sqlite/contracts.ts';
import type {HistoryTarget,HistorySupportReport} from '../../../history/sqlite/contracts.ts';
import {legacyProofDigest,validateLegacyTerminalProof,type LegacyTerminalProof,type LegacyRecallCandidate} from './history-legacy-proof-v1.ts';

interface Fact {owner_id:string;contact_id:string;conversation_id:string;generation_a:string;generation_b:string;partition_id:string;table_instance:string;local_id:string;kind:'prefix'|'point'}
const reportNotFinished=(op:StorageRow)=>typeof op.finished_at!=='bigint'&&typeof op.finished_at!=='number';
type Reader=Pick<StorageTransaction,'get'|'all'>;
function context(db:Reader,op:StorageRow){
 try{
  if(op.failure_code!==null||reportNotFinished(op)||!op.goal_id||!op.new_binding_id||!op.new_grant_id)return;
  const old=JSON.parse(String(op.old_token_json)) as ReadEligibility,current=JSON.parse(String(op.token_json)) as ReadEligibility;
  const target=JSON.parse(String(op.target_json)) as HistoryTarget,report=JSON.parse(String(op.support_json)) as HistorySupportReport;
  if(target.protocol!=='private-history-v1'||report.protocol!=='private-history-v1'||report.status!=='supported'||report.identity!=='source-table-local-v1'
   ||report.continuity!=='same-source-instances-normal-use-v1'||old.owner_id!==op.owner_id||old.contact_id!==op.contact_id||old.binding_id!==op.old_binding_id
   ||current.owner_id!==old.owner_id||current.contact_id!==old.contact_id||current.account_id!==old.account_id||current.conversation_id!==old.conversation_id
   ||current.binding_id!==op.new_binding_id||current.grant_id!==op.new_grant_id||current.source_generation!==target.sourceGeneration||report.sourceGeneration!==target.sourceGeneration)return;
  const identity=db.get(`SELECT a.external_key account_key,c.external_key conversation_key,b.conversation_id FROM conversation_binding b
   JOIN channel_conversation c ON c.owner_id=b.owner_id AND c.id=b.conversation_id JOIN channel_account a ON a.owner_id=c.owner_id AND a.id=c.account_id
   JOIN contact p ON p.owner_id=b.owner_id AND p.id=b.contact_id
   WHERE b.owner_id=? AND b.contact_id=? AND b.id=? AND c.account_id=? AND p.state<>'deleted'`,[op.owner_id as string,op.contact_id as string,current.binding_id,old.account_id]);
  if(!identity||identity.conversation_id!==old.conversation_id||identity.account_key!==report.accountKey||identity.conversation_key!==report.conversationKey)return;
  return {old,current,target,report};
 }catch{return;}
}
function key(value:unknown):string[]|undefined{
 try{const k=JSON.parse(String(value));if(!Array.isArray(k)||k.length!==4||k.some(v=>typeof v!=='string'||!v||v.length>2048)||JSON.stringify(k)!==value||!/^(0|[1-9][0-9]{0,19})$/.test(k[3])||BigInt(k[3])>18446744073709551615n)return;return k;}catch{return;}
}
/** 只读旧审计和关系键。无效或未完成审计不生成任何新删除等价事实，不读取外部来源。 */
export function historicalDeletionEquivalences(db:Reader):Fact[]{
 const facts=new Map<string,Fact>();
 for(const op of db.all("SELECT * FROM history_source_recertification WHERE state='completed' AND stage='completed'")){
  try{
   const c=context(db,op);if(!c)continue;const archive=JSON.parse(String(op.old_fence_json));
   const base={owner_id:String(op.owner_id),contact_id:String(op.contact_id),conversation_id:c.old.conversation_id};
   const remember=(fact:Fact)=>facts.set(JSON.stringify(fact),fact);
   const independent=archive.legacy_terminal_mapping;
   if(independent&&Array.isArray(independent.candidates)&&independent.digest===legacyProofDigest({proof:independent.proof,candidates:independent.candidates})){
    try{
     const proof=independent.proof as LegacyTerminalProof;
     validateLegacyTerminalProof({token:c.old,target:c.target,report:c.report,candidates:independent.candidates as LegacyRecallCandidate[]},proof,Date.now(),false);
     if(c.current.source_generation===proof.current.scope.sourceGeneration)for(const table of c.target.tables)remember({...base,generation_a:proof.legacy.scope.sourceGeneration,generation_b:proof.current.scope.sourceGeneration,partition_id:table.partition,table_instance:table.instance,local_id:'',kind:'prefix'});
    }catch{/* 独立证明损坏不扩大为整表等价。 */}
   }
   const covered=archive.covered_terminal_mapping;
   if(!covered||!Array.isArray(covered.mappings)||covered.digest!==legacyProofDigest({format:'notalone-current-recall-coverage-v1',mappings:covered.mappings}))continue;
   for(const mapping of covered.mappings){
    const from=key(mapping?.from),to=key(mapping?.to);
    if(mapping?.reason!=='source_recalled'||!from||!to||from[0]===to[0]||to[0]!==c.current.source_generation||from.slice(1).some((p,i)=>p!==to[i+1])
     ||!c.target.partitions.includes(from[1])||!c.target.tables.some(t=>t.partition===from[1]&&t.instance===from[2]))continue;
    remember({...base,generation_a:from[0],generation_b:to[0],partition_id:from[1],table_instance:from[2],local_id:from[3],kind:'point'});
   }
  }catch{/* 旧数据不能解析时仅丢弃认证能力，不猜测证明。 */}
 }
 return [...facts.values()];
}

const canonical=(value:unknown):string=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
/** 冻结的迁移校验：只有可归属本次用户删除的旧目标才能退役，随后必须重新收集新事实。 */
export function retiredDeletionOperations(db:Reader):string[]{
 const operations=new Set<string>();
 for(const row of db.all(`SELECT t.*,o.owner_identity,o.contact_identity,o.scope_kind,o.state operation_state FROM deletion_target t
  JOIN deletion_operation o ON o.operation_id=t.operation_id WHERE o.state<>'completed' AND t.row_kind IN
  ('history_source_recertification','history_source_recertification_cancel','history_superseded_cleanup','superseded_message')`)){
  const invalid=()=>{throw Error('history_retired_deletion_target_invalid');};
  if(row.scope_kind==='superseded_history')continue;
  if(row.storage_kind!=='row'||row.domain!=='history'||!['account','contact'].includes(String(row.scope_kind))||row.row_kind==='superseded_message')invalid();
  if(row.state==='cleared'&&row.row_key_snapshot===null&&row.target_payload===null&&row.expected_identity===null){operations.add(String(row.operation_id));continue;}
  try{
   const kind=String(row.row_kind),field=kind==='history_source_recertification'?'id':kind==='history_source_recertification_cancel'?'request_key':'contact_id';
   const key=JSON.parse(String(row.row_key_snapshot)) as Record<string,string>,target=JSON.parse(String(row.target_payload));
   if(canonical(Object.keys(key).sort())!==canonical(['owner_id',field].sort())||key.owner_id!==row.owner_identity||Object.values(key).some(v=>typeof v!=='string'||!v||v.length>256))invalid();
   const identity=createHash('sha256').update(JSON.stringify([kind,Object.keys(key).sort().map(k=>[k,key[k]])])).digest('hex');
   if(Object.keys(target).sort().join(',')!=='domain,holderKeys,identity,key,kind,rowKind'||target.kind!=='row'||target.domain!=='history'||target.rowKind!==kind||canonical(target.key)!==canonical(key)||target.identity!==identity
    ||!Array.isArray(target.holderKeys)||target.holderKeys.some((k:unknown)=>typeof k!=='string'||!/^history:[a-zA-Z0-9_-]{1,128}$/.test(k))
    ||row.expected_identity!==canonical(identity)||row.target_key!==digest([kind,key,identity]))invalid();
   const source=db.get(`SELECT contact_id FROM ${kind} WHERE owner_id=? AND ${field}=?`,[key.owner_id,key[field]]);
   if(!source&&row.state!=='cleared'||source&&row.scope_kind!=='account'&&source.contact_id!==row.contact_identity)invalid();
   operations.add(String(row.operation_id));
  }catch{invalid();}
 }
 return [...operations];
}
