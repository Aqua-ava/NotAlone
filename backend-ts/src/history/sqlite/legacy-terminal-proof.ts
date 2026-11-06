import {sha256} from '../../platform/sha256.ts';
import {StorageFailure,type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {ReadEligibility} from '../../contacts/sqlite/contracts.ts';
import type {HistorySupportReport,HistoryTarget} from './contracts.ts';
import type {ResolvedWechatScope,WechatSchemaInspection} from '../wechat/native-client.ts';

const fail=():never=>{throw new StorageFailure('history_recertify_legacy_proof_invalid');};
const canonical=(v:any):string=>JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)
 ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)):typeof value==='bigint'?String(value):value);
export const legacyProofDigest=(proof:unknown)=>sha256(canonical(proof));
const physical=(target:HistoryTarget)=>canonical({generation:target.sourceGeneration,partitions:[...target.partitions].sort(),
 tables:target.tables.map(t=>[t.partition,t.instance]).sort(),checked:target.checkedPartitions?[...target.checkedPartitions].sort():null});
export const legacyTargetDigest=(target:HistoryTarget)=>legacyProofDigest(physical(target));
const selected=(target:HistoryTarget)=>canonical({partitions:[...target.partitions].sort(),tables:target.tables.map(t=>[t.partition,t.instance]).sort()});
const rawTable=(table:any)=>({...Object.fromEntries(Object.entries(table).filter(([k])=>!['target','partition','schemaVersion','indexes'].includes(k))),
 indexes:table.indexes.map((index:any)=>Object.fromEntries(Object.entries(index).filter(([k])=>k!=='id'))).map(canonical).sort()});
export interface LegacyRecallCandidate {key:string;target:HistoryTarget;report:HistorySupportReport;token:ReadEligibility}
export interface LegacyReaderEvidence {scope:ResolvedWechatScope;schema:WechatSchemaInspection;report:HistorySupportReport;target:HistoryTarget}
export interface LegacyTerminalProof {format:'notalone-legacy-recall-mapping-v1';token:ReadEligibility;observedAt:number;
 legacy:LegacyReaderEvidence;current:LegacyReaderEvidence;keys:{from:string;to:string;reason:'source_recalled'}[]}
export interface LegacyProofContext {token:ReadEligibility;report:HistorySupportReport;target:HistoryTarget;candidates:LegacyRecallCandidate[]}

/** 只返回真实旧撤回来源的无正文证据；额外未知终态仍由原认证抑制检查拒绝。 */
export function legacyRecallCandidates(tx:StorageTransaction,token:ReadEligibility):LegacyRecallCandidate[]{
 const rows=tx.all(`SELECT DISTINCT r.observed_key,g.target_json,g.support_json,g.eligibility_json FROM capture_record r
  JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id
  JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.id=g.binding_id
  WHERE r.owner_id=? AND r.contact_id=? AND b.conversation_id=? AND r.observed_scheme='source-table-local-v1' AND r.state='excluded' AND r.reason_code='source_recalled'`,
 [token.owner_id,token.contact_id,token.conversation_id]);
 const result=new Map<string,LegacyRecallCandidate>();
 for(const row of rows){const key=JSON.parse(String(row.observed_key));if(key[0]===token.source_generation)continue;
  const candidate={key:String(row.observed_key),target:JSON.parse(String(row.target_json)),report:JSON.parse(String(row.support_json)),token:JSON.parse(String(row.eligibility_json))};
  const prior=result.get(candidate.key);if(prior&&canonical(prior)!==canonical(candidate))fail();result.set(candidate.key,candidate);
 }
 return [...result.values()].sort((a,b)=>a.key.localeCompare(b.key));
}

/** 只承认同一当前物理所选表的独立旧/新读取器证据；不宣称恢复旧来源连续性。 */
export function validateLegacyTerminalProof(context:LegacyProofContext,proof:LegacyTerminalProof,now:number,requireFresh=true):void{
 try{
  if(!proof||proof.format!=='notalone-legacy-recall-mapping-v1'||canonical(proof.token)!==canonical(context.token)
   ||!Number.isSafeInteger(proof.observedAt)||requireFresh&&(proof.observedAt>now+1000||proof.observedAt<now-120000)
   ||Buffer.byteLength(canonical(proof))>262144||context.candidates.length<1||context.candidates.length>1024||proof.keys.length!==context.candidates.length||new Set(context.candidates.map(c=>c.key)).size!==context.candidates.length)fail();
  const {legacy,current}=proof,oldGeneration=legacy.scope.sourceGeneration;
  if(oldGeneration===context.token.source_generation||current.scope.sourceGeneration!==context.token.source_generation
   ||legacy.scope.accountKey!==current.scope.accountKey||legacy.scope.conversationKey!==current.scope.conversationKey
   ||legacy.report.artifactSha256===current.report.artifactSha256
   ||physical(current.target)!==physical(context.target)||canonical(current.report)!==canonical(context.report))fail();
  for(const reader of [legacy,current]){
   const {scope,report,target,schema}=reader;
   // 旧制品的target尚不投影清单；它的独立inspect仍须声明完整清单，新认证目标继续要求显式清单。
   const targetChecked=target.checkedPartitions??(reader===legacy?schema.checkedPartitions:undefined);
   if(report.status!=='supported'||report.continuity!=='same-source-instances-normal-use-v1'||report.accountKey!==scope.accountKey
    ||report.conversationKey!==scope.conversationKey||report.sourceGeneration!==scope.sourceGeneration||target.sourceGeneration!==scope.sourceGeneration
    ||schema.sourceGeneration!==scope.sourceGeneration||!schema.checkedPartitions?.length||!targetChecked?.length
    ||canonical([...schema.checkedPartitions].sort())!==canonical([...targetChecked].sort())
    ||new Set(schema.checkedPartitions).size!==schema.checkedPartitions.length
    ||target.partitions.some(p=>!schema.checkedPartitions.includes(p))
    ||['normalHistory','snapshotBarrier','partitionCoverage'].some(k=>report.capabilities?.[k]!=='supported'))fail();
   if(new Set(schema.tables.map(t=>t.partition)).size!==schema.tables.length||schema.tables.length!==target.tables.length
    ||target.tables.some(t=>!schema.tables.some(s=>s.partition===t.partition&&s.target===t.instance)))fail();
  }
  if(canonical([...legacy.target.partitions].sort())!==canonical([...current.target.partitions].sort()))fail();
  for(const table of legacy.schema.tables){const other=current.schema.tables.find(t=>t.partition===table.partition);if(!other||canonical(rawTable(table))!==canonical(rawTable(other)))fail();}
  const seen=new Set<string>();
  for(const mapping of proof.keys){
   const old=JSON.parse(mapping.from),next=JSON.parse(mapping.to),candidate=context.candidates.find(c=>c.key===mapping.from);
   if(seen.has(mapping.from)||mapping.reason!=='source_recalled'||!candidate||!Array.isArray(old)||old.length!==4||old[0]!==oldGeneration
    ||typeof old[3]!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(old[3])||BigInt(old[3])>18446744073709551615n
    ||mapping.from!==JSON.stringify(old)||mapping.to!==JSON.stringify([context.token.source_generation,...old.slice(1)])
    ||canonical(next)!==canonical([context.token.source_generation,...old.slice(1)])
    ||!current.target.tables.some(t=>t.partition===old[1]&&t.instance===old[2])||selected(candidate.target)!==selected(current.target)
    ||candidate.report.status!=='supported'||candidate.report.identity!=='source-table-local-v1'
    ||candidate.target.sourceGeneration!==oldGeneration||candidate.report.sourceGeneration!==oldGeneration
    ||candidate.token.source_generation!==oldGeneration||candidate.report.artifactSha256!==legacy.report.artifactSha256
    ||['profileId','programVersion','build','adapterVersion','identity','statusSemantics','serverAliasSemantics','continuity'].some(k=>(candidate.report as any)[k]!==(legacy.report as any)[k])
    ||candidate.report.accountKey!==current.scope.accountKey||candidate.report.conversationKey!==current.scope.conversationKey
    ||['owner_id','contact_id','account_id','conversation_id','binding_id'].some(k=>(candidate.token as any)[k]!==(context.token as any)[k]))fail();
   seen.add(mapping.from);
  }
 }catch{fail();}
}
