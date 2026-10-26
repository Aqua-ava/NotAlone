/** 已核验记忆的裁决与自动发布；模型只裁决，范围、来源和事务仍由业务代码控制。 */
import {createHash, randomUUID} from 'node:crypto';
import type pg from 'pg';
import {activeRef, canonicalJSON, captureSnapshot, digest, validateFrozen} from '../overview/evidence/sources.ts';
import {candidateDigest, dimensionSourcesCurrent} from '../overview/evidence/dimensions.ts';
import {normalizeEvolution} from '../overview/projection/metadata.ts';
import {overviewRecordDigest} from '../overview/projection/memory.ts';
import {candidateVersionEvidence} from '../records/mutations/candidate-versions.ts';
import {bumpMemoryRevision, ensureMemorySources, protectCandidate, type MemoryRow} from '../records/mutations/protection.ts';
import {eraseLayeredReplies} from '../records/mutations/erasure.ts';
import type {EvidenceFact} from '../extraction/verification/evidence.ts';
import {hybridCandidates, type EmbedTexts} from '../../retrieval/retrieval-hybrid.ts';

type Transaction=<T>(work:(client:pg.Client)=>Promise<T>)=>Promise<T>;
export type AdoptionAction='add'|'update'|'noop'|'keep'|'merge';
export type EvolutionKind='supplement'|'state_change'|'error_correction'|'historical_supplement'|'unresolved_conflict'|'independent';
export interface AdoptionScope {owner_id:string;contact_id:string}
export interface AdoptionFact extends Omit<EvidenceFact,'dimension_evidence'> {
 dimension_evidence:Record<string,unknown>|null;
}
export interface AdoptionFactInput {fact:AdoptionFact;candidate_trace_id?:string|null}
export interface ModelUsage {
 call_id?:string|null;
 model_name?:string|null;
 input_tokens?:number|null;
 output_tokens?:number|null;
 purpose?:'adjudication'|'relation_verification'|'merge_verification';
}
export interface AdjudicationRelation {
 kind:EvolutionKind;
 related_memory_ids:string[];
 explanation:string;
 evidence:{message_id:string;quote:string}[];
 claim_changed:boolean;
 condition_changed:boolean;
}
export interface AdjudicationDecision {
 candidate_index:number;
 action:AdoptionAction;
 replaced_memory_id?:string|null;
 merged_memory_ids?:string[];
 merged_text?:string|null;
 duplicate_memory_id?:string|null;
 relation?:AdjudicationRelation|null;
 usage?:ModelUsage|null;
}
export interface RelationVerification {
 candidate_index:number;
 supported:boolean;
 source_receipt:string;
 evidence:{message_id:string;quote:string}[];
 claim_changed:boolean;
 condition_changed:boolean;
 usage?:ModelUsage|null;
}
export interface MergeVerification {
 candidate_index:number;
 supported:boolean;
 text:string;
 source_message_ids:string[];
 source_receipt:string;
 evidence:{message_id:string;quote:string}[];
 usage?:ModelUsage|null;
}
export interface SimilarMemory {
 memory_id:string;
 revision:number;
 text:string;
 category:string;
 topic:string;
 subject:string;
 adoption_method:'auto'|'manual';
 source_message_ids:string[];
 source_texts:{message_id:string;text:string;occurred_at:string|null}[];
 statement_time:string|null;
 valid_at:string|null;
 invalid_at:string|null;
 event:MemoryRow|null;
 conditions:MemoryRow|null;
 source_receipt:string|null;
 source_dependency_mode:'any'|'all';
 requires_all_sources:boolean;
}
export interface AdjudicationItem {
 candidate_index:number;
 candidate:AdoptionFact;
 candidate_source_receipt:string;
 candidate_source_texts:{message_id:string;text:string;occurred_at:string|null}[];
 relation_source_receipt:string;
 similar:SimilarMemory[];
}
export interface AdjudicationRuntime {
 adjudicate(items:readonly AdjudicationItem[],signal:AbortSignal):Promise<readonly AdjudicationDecision[]>;
 verifyRelations(items:readonly AdjudicationItem[],decisions:readonly AdjudicationDecision[],signal:AbortSignal):Promise<readonly RelationVerification[]>;
 verifyMerge(item:AdjudicationItem,decision:AdjudicationDecision,source_ids:readonly string[],source_receipt:string,signal:AbortSignal):Promise<MergeVerification>;
}
export interface AdoptionBatchInput {
 contact_id:string;
 trace_id?:string|null;
 batch_key?:string|null;
 facts:readonly AdoptionFactInput[];
 signal:AbortSignal;
}
export type AdoptionDisposition='adopted'|'updated'|'merged'|'pending'|'skipped_duplicate'|'skipped_deleted'|'skipped_noop'|'failed';
export interface AdoptionResult {
 candidate_index:number;
 disposition:AdoptionDisposition;
 candidate_id:string|null;
 memory_id:string|null;
 parent_memory_ids:string[];
 decision:AdoptionAction|null;
 reason:string|null;
}
export interface AdoptionStats {
 adopted:number;
 updated:number;
 merged:number;
 pending:number;
 skipped_duplicate:number;
 skipped_deleted:number;
 skipped_noop:number;
 failed:number;
 results:AdoptionResult[];
 usages:ModelUsage[];
}
export interface MemoryAdoptionOptions {
 ownerId:string;
 transaction:Transaction;
 embed:EmbedTexts;
 adjudication?:AdjudicationRuntime|null;
}
export class MemoryAdoptionError extends Error {
 readonly code:string;
 readonly retryable:boolean;
 partial:AdoptionStats|null;
 constructor(code:string,retryable=false,cause?:unknown){super(code,{cause});this.code=code;this.retryable=retryable;this.partial=null;this.name='MemoryAdoptionError';}
}

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const categories=new Set(['common_fact','preference','taboo','recent_state','relationship_note']);
const subjects=new Set(['self','contact','shared']);
const actions=new Set<AdoptionAction>(['add','update','noop','keep','merge']);
const relations=new Set<EvolutionKind>(['supplement','state_change','error_correction','historical_supplement','unresolved_conflict','independent']);
const same=(a:unknown,b:unknown)=>canonicalJSON(a)===canonicalJSON(b);
const normalize=(text:string)=>text.replace(/\s+/gu,'').toLowerCase();
const json=(value:unknown)=>value==null?null:JSON.stringify(value);
const fail=(code:string,retryable=false,cause?:unknown):never=>{throw new MemoryAdoptionError(code,retryable,cause);};
const id=(value:unknown):string=>typeof value==='string'&&uuid.test(value)?value.toLowerCase():fail('adoption_contract_invalid');
const ids=(value:unknown,limit=60):string[]=>{
 if(!Array.isArray(value)||value.length>limit||value.some(item=>typeof item!=='string'||!uuid.test(item)))fail('adoption_contract_invalid');
 const result=(value as string[]).map(item=>item.toLowerCase());if(new Set(result).size!==result.length)fail('adoption_contract_invalid');return result;
};

interface SourceDetails {complete:boolean;receipt:string|null;messages:{message_id:string;text:string;occurred_at:string|null}[]}
interface Snapshot {
 contactPool:MemoryRow[];
 ownerPool:MemoryRow[];
 deleted:Set<string>;
 sources:Map<string,SourceDetails>;
 claims:Map<string,string[]>;
}
interface VerifiedDecision {decision:AdjudicationDecision;verification:RelationVerification|null;merge:MergeVerification|null;forcedPending:string|null}
interface CommitOutcome {result:AdoptionResult}
interface Shortcut {kind:'deleted'|'duplicate';memory:SimilarMemory|null}

function positiveRevision(value:unknown):number{
 if(!Number.isSafeInteger(value)||Number(value)<1)fail('adoption_contract_invalid');
 return Number(value);
}
function candidateId(scope:AdoptionScope,fact:AdoptionFact):string{
 const hex=createHash('sha256').update(canonicalJSON({scope,
  text:fact.text,category:fact.category,subject:fact.subject,topic:fact.topic,
  source_message_ids:[...fact.source_message_ids].sort(),valid_at:fact.valid_at,invalid_at:fact.invalid_at,
  event:fact.event,conditions:fact.conditions,event_fingerprint:fact.event?canonicalJSON(fact.event):null,
  conditions_fingerprint:fact.conditions?canonicalJSON(fact.conditions):null,
  dependency:fact.source_dependency_mode,requires_all_sources:fact.requires_all_sources,
  dimension_evidence:fact.dimension_evidence})).digest('hex').slice(0,32);
 const chars=[...hex];chars[12]='5';chars[16]=((parseInt(chars[16]!,16)&3)|8).toString(16);
 const raw=chars.join('');
 return `${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`;
}
function validateFact(value:AdoptionFact):AdoptionFact{
 if(!value||typeof value!=='object'||typeof value.text!=='string'||!value.text.trim()||[...value.text].length>4096)fail('adoption_contract_invalid');
 if(!categories.has(value.category)||!subjects.has(value.subject)||typeof value.topic!=='string'||!value.topic.trim())fail('adoption_contract_invalid');
 const sourceIds=ids(value.source_message_ids);
 if(!sourceIds.length||!value.dimension_evidence||![1,2,3,4].includes(Number((value.dimension_evidence as MemoryRow).version)))fail('adoption_source_unverified');
 if(!Number.isFinite(value.confidence)||value.confidence<0||value.confidence>1||!Array.isArray(value.risk_flags)
  ||value.risk_flags.some(flag=>typeof flag!=='string')||!Array.isArray(value.alternatives)
  ||value.alternatives.some(item=>typeof item!=='string')||typeof value.interpretation_reason!=='string')fail('adoption_contract_invalid');
 if(!['any','all'].includes(value.source_dependency_mode))fail('adoption_contract_invalid');
 if(value.source_dependency_mode==='all'&&!value.requires_all_sources)fail('adoption_contract_invalid');
 if(value.conditions!==null&&value.conditions!==undefined&&(value.conditions.version!==1||value.conditions.items.some(item=>!item.source_supported)))fail('adoption_conditions_unverified');
 if(value.event&&(!value.event.stage_verified||!value.event.occurrence_verified&&value.event.stage!=='cancelled'))fail('adoption_event_unverified');
 return {...value,source_message_ids:sourceIds,event:value.event??null,conditions:value.conditions??null};
}

async function sourceDetails(client:pg.Client,scope:AdoptionScope,sourceIds:readonly string[]):Promise<SourceDetails>{
 const wanted=ids(sourceIds);
 const messages=(await client.query(`SELECT m.id,m.text_content,m.media_placeholder,
  CASE WHEN m.occurred_at IS NULL THEN NULL ELSE to_char(m.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS') ||
   CASE WHEN extract(microseconds FROM m.occurred_at)::bigint % 1000000=0 THEN '' ELSE to_char(m.occurred_at AT TIME ZONE 'UTC','.US') END || '+00:00' END AS occurred_at
  FROM public.message m WHERE m.owner_id=$1 AND m.contact_id=$2 AND m.id=ANY($3::uuid[])
  AND EXISTS(SELECT 1 FROM public.message_source_ref ref WHERE ref.owner_id=m.owner_id AND ref.contact_id=m.contact_id
   AND ref.message_id=m.id AND ${activeRef}) ORDER BY m.id`,[scope.owner_id,scope.contact_id,wanted])).rows;
 const represented=new Set<string>();
 const rows=messages.map(row=>{
  represented.add(row.id);
  return {message_id:row.id as string,text:(row.text_content||row.media_placeholder||'') as string,occurred_at:row.occurred_at as string|null};
 });
 // 非消息来源只作生命周期依赖，不复制来源正文；只有全部ID当前有效才形成可发布回执。
 const available=(await client.query(`SELECT id FROM public.source_document WHERE owner_id=$1 AND contact_id=$2 AND status='active' AND id=ANY($3::uuid[])
  UNION SELECT id FROM public.local_wechat_observation WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[])`,[scope.owner_id,scope.contact_id,wanted])).rows;
 for(const row of available)represented.add(row.id);
 if(represented.size!==wanted.length||rows.some(row=>!row.text.trim()))return {complete:false,receipt:null,messages:rows};
 const evidence=await captureSnapshot(client,scope.owner_id,wanted,wanted,scope.contact_id);
 return {complete:true,receipt:digest(evidence),messages:rows};
}
async function sourceSetReceipt(client:pg.Client,scope:AdoptionScope,sourceIds:readonly string[]):Promise<string|null>{
 const wanted=ids(sourceIds,1000),rows=[];
 for(const source of wanted){
  const detail=await sourceDetails(client,scope,[source]);
  if(!detail.complete||!detail.receipt)return null;
  rows.push([source,detail.receipt]);
 }
 return digest(rows.sort());
}
function factEvidenceRow(scope:AdoptionScope,fact:AdoptionFact):MemoryRow{
 return {owner_id:scope.owner_id,contact_id:scope.contact_id,text_content:fact.text,category:fact.category,topic:fact.topic,subject:fact.subject,
  source_ids:fact.source_message_ids,valid_at:fact.valid_at,invalid_at:fact.invalid_at,confidence:fact.confidence,risk_flags:fact.risk_flags,
  alternatives:fact.alternatives,interpretation_reason:fact.interpretation_reason,event:fact.event,conditions:fact.conditions,
  source_dependency_mode:fact.source_dependency_mode,requires_all_sources:fact.requires_all_sources,dimension_evidence:fact.dimension_evidence};
}
async function factSourcesCurrent(client:pg.Client,scope:AdoptionScope,fact:AdoptionFact):Promise<SourceDetails>{
 const detail=await sourceDetails(client,scope,fact.source_message_ids);
 if(!detail.complete||!await dimensionSourcesCurrent(client,factEvidenceRow(scope,fact)))fail('adoption_source_changed',true);
 return detail;
}
async function deletedTexts(client:pg.Client,scope:AdoptionScope):Promise<string[]>{
 return (await client.query(`SELECT text_content FROM public.confirmed_memory WHERE owner_id=$1 AND contact_id=$2 AND status='deleted'
  UNION SELECT m.text_content FROM public.owner_memory m LEFT JOIN public.memory_candidate c
   ON c.id=m.source_candidate_id AND c.owner_id=m.owner_id
  WHERE m.owner_id=$1 AND m.status='deleted' AND (m.source_candidate_id IS NULL OR c.contact_id=$2)`,[scope.owner_id,scope.contact_id]))
  .rows.map(row=>row.text_content);
}
async function deletedTextCurrent(client:pg.Client,scope:AdoptionScope,text:string):Promise<boolean>{
 const rows=await deletedTexts(client,scope);
 return rows.some(value=>normalize(value)===normalize(text));
}
async function currentShortlistedRows(client:pg.Client,scope:AdoptionScope,item:AdjudicationItem,idsValue:readonly string[]):Promise<MemoryRow[]>{
 const targetIds=ids(idsValue,8);
 const owner=item.candidate.subject==='self';
 const rows=owner
  ?(await client.query('SELECT to_jsonb(m) AS value FROM public.owner_memory m WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND status=\'active\' FOR UPDATE',
    [scope.owner_id,targetIds])).rows.map(row=>row.value)
  :(await client.query(`SELECT to_jsonb(m) AS value FROM public.confirmed_memory m
    WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[]) AND status='active' FOR UPDATE`,
    [scope.owner_id,scope.contact_id,targetIds])).rows.map(row=>row.value);
 if(rows.length!==targetIds.length)fail('adoption_source_changed',true);
 for(const parent of rows){
  const shortlist=item.similar.find(memory=>memory.memory_id===parent.id);
  if(!shortlist)fail('adoption_source_changed',true);
  if(parent.revision!==shortlist!.revision)fail('adoption_source_changed',true);
  if(shortlist!.source_receipt!==null
   &&await sourceSetReceipt(client,scope,shortlist!.source_message_ids)!==shortlist!.source_receipt)fail('adoption_source_changed',true);
 }
 return rows;
}

async function readPool(client:pg.Client,scope:AdoptionScope,subject:'contact'|'owner'):Promise<MemoryRow[]>{
 const rows=subject==='contact'
  ?(await client.query(`SELECT to_jsonb(m) AS value FROM public.confirmed_memory m WHERE m.owner_id=$1 AND m.contact_id=$2
    AND m.status='active' AND (m.valid_at IS NULL OR m.valid_at<=now()) AND (m.invalid_at IS NULL OR now()<m.invalid_at)
    ORDER BY m.created_at,m.id LIMIT 1000`,[scope.owner_id,scope.contact_id])).rows.map(row=>row.value)
  :(await client.query(`SELECT to_jsonb(m) AS value FROM public.owner_memory m LEFT JOIN public.memory_candidate c
    ON c.id=m.source_candidate_id AND c.owner_id=m.owner_id WHERE m.owner_id=$1
    AND m.status='active' AND (m.valid_at IS NULL OR m.valid_at<=now()) AND (m.invalid_at IS NULL OR now()<m.invalid_at)
    AND (m.source_candidate_id IS NULL OR c.contact_id=$2) ORDER BY m.created_at,m.id LIMIT 1000`,[scope.owner_id,scope.contact_id])).rows.map(row=>row.value);
 return rows;
}
async function snapshot(client:pg.Client,scope:AdoptionScope):Promise<Snapshot>{
 const contactPool=await readPool(client,scope,'contact'),ownerPool=await readPool(client,scope,'owner');
 const deleted=await deletedTexts(client,scope);
 const sources=new Map<string,SourceDetails>(),claims=new Map<string,string[]>();
 for(const [arena,pool] of [['contact',contactPool],['owner',ownerPool]] as const){
  for(const memory of pool){
   let claim=ids(memory.source_ids,1000);
   if(memory.source_candidate_id){
    const candidate=(await client.query('SELECT source_ids,text_content,category,topic FROM public.memory_candidate WHERE owner_id=$1 AND id=$2',[scope.owner_id,memory.source_candidate_id])).rows[0];
    if(candidate&&candidate.text_content===memory.text_content&&candidate.category===memory.category&&candidate.topic===memory.topic
     &&candidate.source_ids.every((source:string)=>memory.source_ids.includes(source)))claim=candidate.source_ids;
   }
   claims.set(`${arena}:${memory.id}`,claim);
   for(const source of claim)if(!sources.has(source))sources.set(source,await sourceDetails(client,scope,[source]));
  }
 }
 return {contactPool,ownerPool,deleted:new Set(deleted.map(text=>normalize(text))),sources,claims};
}
function poolKey(memory:MemoryRow):string {return `${memory.contact_id?'contact':'owner'}:${memory.id}`;}
function poolItem(memory:MemoryRow,snapshotValue:Snapshot):SimilarMemory{
 const claimSourceIds=snapshotValue.claims.get(poolKey(memory))??ids(memory.source_ids,1000);
 const dependency=memory.source_dependency_mode;
 if(dependency!=='any'&&dependency!=='all')fail('adoption_contract_invalid');
 const rows=claimSourceIds.flatMap(source=>snapshotValue.sources.get(source)?.messages??[]);
 const complete=claimSourceIds.every(source=>snapshotValue.sources.get(source)?.complete);
 const receipt=digest(claimSourceIds.map(source=>[source,snapshotValue.sources.get(source)?.receipt]).sort());
 const times=rows.map(row=>row.occurred_at).filter((value):value is string=>value!==null).sort((a,b)=>Date.parse(a)-Date.parse(b));
 return {memory_id:memory.id,revision:positiveRevision(memory.revision),text:memory.text_content,category:memory.category,topic:memory.topic,
  subject:['self','contact','shared'].includes(memory.subject)?memory.subject:memory.contact_id?'contact':'self',
  adoption_method:memory.adoption_method,source_message_ids:claimSourceIds,source_texts:rows,
  statement_time:times.at(-1)??null,valid_at:memory.valid_at??null,invalid_at:memory.invalid_at??null,event:memory.event??null,
  conditions:memory.conditions??null,source_receipt:complete?receipt:null,source_dependency_mode:dependency,
  requires_all_sources:Boolean(memory.requires_all_sources)};
}
function sameMemoryClaim(fact:AdoptionFact,memory:MemoryRow,sourceIds:readonly string[],sourceReceipt:string|null):boolean{
 return sourceReceipt!==null&&normalize(memory.text_content)===normalize(fact.text)&&memory.category===fact.category&&memory.topic===fact.topic
  &&same(memory.event,fact.event)&&same(memory.conditions,fact.conditions)&&memory.valid_at===fact.valid_at&&memory.invalid_at===fact.invalid_at
  &&same([...sourceIds].sort(),[...fact.source_message_ids].sort())&&memory.source_dependency_mode===fact.source_dependency_mode
  &&Boolean(memory.requires_all_sources)===fact.requires_all_sources;
}
function exactDuplicate(fact:AdoptionFact,similar:readonly SimilarMemory[]):SimilarMemory|undefined{
 return similar.find(memory=>memory.source_receipt!==null&&normalize(memory.text)===normalize(fact.text)&&memory.category===fact.category&&memory.topic===fact.topic
  &&memory.source_dependency_mode===fact.source_dependency_mode&&memory.requires_all_sources===fact.requires_all_sources
  &&same(memory.event,fact.event)&&same(memory.conditions,fact.conditions)&&memory.valid_at===fact.valid_at&&memory.invalid_at===fact.invalid_at
  &&same([...memory.source_message_ids].sort(),[...fact.source_message_ids].sort()));
}
function pendingIdentity(row:MemoryRow,fact:AdoptionFact):boolean{
 return row.owner_id&&row.contact_id&&row.status==='pending'&&row.text_content===fact.text&&row.category===fact.category
  &&row.topic===fact.topic&&row.subject===fact.subject&&same([...row.source_ids].sort(),[...fact.source_message_ids].sort())
  &&same(row.event,fact.event)&&same(row.conditions,fact.conditions)&&row.valid_at===fact.valid_at&&row.invalid_at===fact.invalid_at
  &&Number(row.confidence)===fact.confidence&&same(row.risk_flags??[],fact.risk_flags)&&same(row.alternatives??[],fact.alternatives)
  &&(row.interpretation_reason??'')===fact.interpretation_reason&&same(row.dimension_evidence,fact.dimension_evidence)
  &&row.source_dependency_mode===fact.source_dependency_mode&&Boolean(row.requires_all_sources)===fact.requires_all_sources;
}
function validEvidence(decision:AdjudicationDecision,item:AdjudicationItem,verification:RelationVerification|undefined):void{
 if(!actions.has(decision.action)||decision.candidate_index!==item.candidate_index)fail('adjudication_invalid');
 const available=new Set(item.similar.map(memory=>memory.memory_id));
 const relationIds=decision.relation?.related_memory_ids??[];
 if(relationIds.some(target=>!available.has(target))||new Set(relationIds).size!==relationIds.length)fail('adjudication_invalid');
 if(decision.relation&&!relations.has(decision.relation.kind))fail('adjudication_invalid');
 if(decision.action==='update'){
  if(!decision.replaced_memory_id||!available.has(decision.replaced_memory_id)||decision.merged_memory_ids?.length||decision.merged_text!=null)fail('adjudication_invalid');
  const replaced=decision.replaced_memory_id!;
  const relation=decision.relation!;
  if(!relation)fail('adjudication_invalid');
  if(!relation.related_memory_ids.includes(replaced))fail('adjudication_invalid');
 }
 if(decision.action==='merge'){
  const targets=decision.merged_memory_ids??[];
  if(targets.length<2||targets.length>8||new Set(targets).size!==targets.length||targets.some(target=>!available.has(target))
   ||!decision.merged_text?.trim()||[...decision.merged_text].length>4096||decision.replaced_memory_id)fail('adjudication_invalid');
  if(!decision.relation||decision.relation.related_memory_ids.length!==targets.length||targets.some(target=>!decision.relation!.related_memory_ids.includes(target)))fail('adjudication_invalid');
 } else if(decision.action!=='update'&&(decision.merged_memory_ids?.length||decision.merged_text!=null||decision.replaced_memory_id))fail('adjudication_invalid');
 if(decision.action==='noop'&&(!decision.duplicate_memory_id||!available.has(decision.duplicate_memory_id)))fail('adjudication_invalid');
 if(decision.action!=='noop'&&decision.duplicate_memory_id)fail('adjudication_invalid');
 if(decision.relation){
  if(!relationIds.length||!decision.relation.explanation.trim()||[...decision.relation.explanation].length>1000)fail('adjudication_invalid');
  if(!verification)fail('adjudication_relation_unsupported');
  const checked:RelationVerification=verification!;
  if(checked.candidate_index!==item.candidate_index
   ||checked.claim_changed!==decision.relation.claim_changed||checked.condition_changed!==decision.relation.condition_changed
   ||checked.source_receipt!==item.relation_source_receipt||!checked.evidence.length)fail('adjudication_relation_unsupported');
  const texts=new Map<string,string>();
  for(const source of item.similar)for(const row of source.source_texts)texts.set(row.message_id,row.text);
  for(const row of item.candidate_source_texts)texts.set(row.message_id,row.text);
  for(const evidence of checked.evidence)if(!texts.has(evidence.message_id)||!texts.get(evidence.message_id)!.includes(evidence.quote))fail('adjudication_relation_unsupported');
  const cited=new Set(checked.evidence.map(row=>row.message_id));
  if(!item.candidate.source_message_ids.some(source=>cited.has(source)))fail('adjudication_relation_unsupported');
  for(const relatedId of relationIds){
   const parent=item.similar.find(memory=>memory.memory_id===relatedId);
   const available=parent?.source_message_ids.filter(source=>texts.has(source))??[];
   if(available.length&&!available.some(source=>cited.has(source)))fail('adjudication_relation_unsupported');
  }
 }
}
function canReplace(item:AdjudicationItem,parent:SimilarMemory):string|null{
 if(parent.adoption_method==='manual')return 'manual_parent_protected';
 if(!parent.source_receipt)return 'parent_source_unavailable';
 const statement=Date.parse(item.candidate.timing.source_ended_at??item.candidate.timing.source_started_at??'');
 const previous=Date.parse(parent.statement_time??'');
 if(Number.isFinite(statement)&&Number.isFinite(previous)&&statement<previous)return 'newer_parent_cannot_be_replaced_by_earlier_source';
 return null;
}
function mergeSources(item:AdjudicationItem,decision:AdjudicationDecision):string[]{
 const targets=new Set(decision.merged_memory_ids??[]);
 return [...new Set([...item.candidate.source_message_ids,...item.similar.filter(memory=>targets.has(memory.memory_id)).flatMap(memory=>memory.source_message_ids)])];
}
function mergeEvidenceValid(item:AdjudicationItem,merge:MergeVerification):boolean{
 const texts=new Map<string,string>();
 for(const memory of item.similar)for(const row of memory.source_texts)texts.set(row.message_id,row.text);
 for(const row of item.candidate_source_texts)texts.set(row.message_id,row.text);
 if(merge.evidence.some(row=>!texts.has(row.message_id)||!texts.get(row.message_id)!.includes(row.quote)))return false;
 const cited=new Set(merge.evidence.map(row=>row.message_id));
 return merge.source_message_ids.every(source=>cited.has(source));
}
async function validateEvolutionProof(client:pg.Client,owner:string,contact:string,candidate:MemoryRow,evolution:MemoryRow):Promise<void>{
 const proof=evolution.proof;
 if(!proof?.sources||proof.scope?.owner_id!==owner||proof.scope?.contact_id!==contact)fail('adoption_contract_invalid');
 const version=candidate.source_dependency_mode==='all'?4:1;
 if(proof.candidate_sha256!==candidateDigest(candidate,version))fail('adoption_source_changed',true);
 await validateFrozen(client,owner,proof.sources);
 const scopes=Object.values(proof.sources.message_scopes??{});
 if(!scopes.length||new Set(scopes).size!==1||scopes[0]!==contact)fail('adoption_source_changed',true);
 const related=new Set(evolution.related_versions.map((row:MemoryRow)=>row.memory_id));
 for(const parent of proof.parents??[]){
  if(!related.has(parent.memory_id))continue;
  const table=parent.subject==='self'?'owner_memory':'confirmed_memory';
  const row=(await client.query(`SELECT to_jsonb(m) AS value FROM public.${table} m WHERE owner_id=$1 AND id=$2 FOR SHARE`,[owner,parent.memory_id])).rows[0]?.value;
  if(!row||row.status!=='active'||row.revision!==parent.revision
   ||(table==='confirmed_memory'&&row.contact_id!==contact)
   ||overviewRecordDigest(row,normalizeEvolution(row.evolution),parent.revision,parent.invalid_at)!==parent.record_sha256)fail('adoption_source_changed',true);
 }
}

export class MemoryAdoption {
 private readonly ownerId:string;
 private readonly transaction:Transaction;
 private readonly embed:EmbedTexts;
 private readonly adjudication:AdjudicationRuntime|null;
 constructor(options:MemoryAdoptionOptions){
  if(!uuid.test(options.ownerId))throw new MemoryAdoptionError('adoption_scope_invalid');
  this.ownerId=options.ownerId.toLowerCase();this.transaction=options.transaction;this.embed=options.embed;
  this.adjudication=options.adjudication??null;
 }
 async adoptBatch(input:AdoptionBatchInput):Promise<AdoptionStats>{
  input.signal.throwIfAborted();
  if(!uuid.test(input.contact_id)||!Array.isArray(input.facts)||input.facts.length>100)fail('adoption_request_invalid');
  if(input.trace_id!=null&&!uuid.test(input.trace_id))fail('adoption_request_invalid');
  if(input.batch_key!=null&&(typeof input.batch_key!=='string'||!input.batch_key||input.batch_key.length>256))fail('adoption_request_invalid');
  const scope={owner_id:this.ownerId,contact_id:input.contact_id.toLowerCase()};
  const facts=input.facts.map(entry=>{
   if(entry.candidate_trace_id!=null&&!uuid.test(entry.candidate_trace_id))fail('adoption_request_invalid');
   return {fact:validateFact(entry.fact),candidate_trace_id:entry.candidate_trace_id??null};
  });
  const current=await this.transaction(client=>snapshot(client,scope));
  const stats:AdoptionStats={adopted:0,updated:0,merged:0,pending:0,skipped_duplicate:0,skipped_deleted:0,skipped_noop:0,failed:0,results:[],usages:[]};
  const work:number[]=[],items:AdjudicationItem[]=[],shortcuts=new Map<number,Shortcut>();
  for(const [index,entry] of facts.entries()){
   const fact=entry.fact;
   if(current.deleted.has(normalize(fact.text))){
    shortcuts.set(index,{kind:'deleted',memory:null});continue;
   }
   const subject=fact.subject==='self'?'owner':'contact';
   const rawPool=subject==='owner'?current.ownerPool:current.contactPool;
   const pool=rawPool.map(memory=>poolItem(memory,current));
   const duplicate=exactDuplicate(fact,pool);
   if(duplicate){
    shortcuts.set(index,{kind:'duplicate',memory:duplicate});continue;
   }
   const direct=await this.transaction(client=>factSourcesCurrent(client,scope,fact));
   work.push(index);items.push({candidate_index:index,candidate:fact,candidate_source_receipt:direct.receipt??'',
    candidate_source_texts:direct.messages,relation_source_receipt:'',similar:pool});
  }
  // 同一固定本机模型按联系人/本人池分别计算；不提供词法或云端降级。
  for(const subject of ['contact','owner'] as const){
   const group=items.filter(item=>(item.candidate.subject==='self')===(subject==='owner')&&item.similar.length);
   if(!group.length)continue;
   const poolRaw=subject==='owner'?current.ownerPool:current.contactPool;
   const pool=poolRaw.map(memory=>poolItem(memory,current));
   let recalled:SimilarMemory[][];
   try{recalled=await hybridCandidates(group.map(item=>item.candidate.text),pool,this.embed,5);}
   catch(error){fail('embedding_unavailable',true,error);}
   for(const [offset,item] of group.entries())item.similar=[...(recalled![offset]??[])];
  }
  const modelled=items.filter(item=>item.similar.length);
  if(modelled.length&&!this.adjudication)fail('adjudication_unavailable',true);
  let decisions=new Map<number,AdjudicationDecision>();
  const decisionRows=modelled.length?await this.adjudication!.adjudicate(modelled,input.signal):[];
  if(decisionRows.length!==modelled.length)fail('adjudication_invalid',true);
  for(const row of decisionRows)decisions.set(row.candidate_index,row);
  for(const item of items)if(!item.similar.length)decisions.set(item.candidate_index,{candidate_index:item.candidate_index,action:'add',relation:null});
  for(const item of modelled)item.relation_source_receipt=digest([item.candidate_source_receipt,...item.similar.map(memory=>memory.source_receipt)]);
  let relationRows:readonly RelationVerification[]=[];
  const related=modelled.filter(item=>decisions.get(item.candidate_index)?.relation);
  if(related.length){
   if(!this.adjudication)fail('adjudication_unavailable',true);
   relationRows=await this.adjudication!.verifyRelations(related,related.map(item=>decisions.get(item.candidate_index)!),input.signal);
   if(relationRows.length!==related.length)fail('adjudication_relation_unsupported',true);
  }
  const consumers=new Map<string,number[]>();
  for(const item of modelled){
   const decision=decisions.get(item.candidate_index)!;
   if(!['update','merge'].includes(decision.action))continue;
   for(const target of new Set([...(decision.merged_memory_ids??[]),...(decision.replaced_memory_id?[decision.replaced_memory_id]:[])]))
    consumers.set(target,[...(consumers.get(target)??[]),item.candidate_index]);
  }
  const conflicted=new Set([...consumers.values()].filter(indexes=>indexes.length>1).flat());
  const verified=new Map<number,VerifiedDecision>();
  for(const item of items){
   const decision=decisions.get(item.candidate_index)!;
   const relation=relationRows.find(row=>row.candidate_index===item.candidate_index);
   validEvidence(decision,item,relation);
   let merge:MergeVerification|null=null;
   if(decision.action==='merge'){
    const sourceIds=mergeSources(item,decision);
    const receipt=(await this.transaction(client=>sourceDetails(client,scope,sourceIds))).receipt??'';
    merge=await this.adjudication!.verifyMerge(item,decision,sourceIds,receipt,input.signal);
    if(!merge.supported)fail('merge_verification_failed:unsupported');
    if(merge.candidate_index!==item.candidate_index)fail('merge_verification_failed:index');
    if(merge.text!==decision.merged_text)fail('merge_verification_failed:text');
    if(!same([...merge.source_message_ids].sort(),[...sourceIds].sort()))fail('merge_verification_failed:sources');
    if(merge.source_receipt!==receipt)fail('merge_verification_failed:receipt');
    if(!mergeEvidenceValid(item,merge))fail('merge_verification_failed:evidence');
   }
   verified.set(item.candidate_index,{decision,verification:relation??null,merge,forcedPending:conflicted.has(item.candidate_index)?'parent_already_consumed':null});
  }
  // 先写新增/并存，再写会支出旧父版本的更新与合并，保证同批内部冲突可见。
  const priority=(index:number)=>shortcuts.has(index)?0:['update','merge'].includes(verified.get(index)!.decision.action)?2:1;
  const ordered=facts.map((_,index)=>index).sort((a,b)=>priority(a)-priority(b)||a-b);
  for(const index of ordered){
   input.signal.throwIfAborted();
   try{
    const shortcut=shortcuts.get(index),item=items.find(value=>value.candidate_index===index)??null;
    const committed=shortcut
     ?await this.transaction(client=>this.commitShortcut(client,scope,index,facts[index]!,shortcut,input))
     :await this.transaction(client=>this.commit(client,scope,index,facts[index]!,verified.get(index)!,current,item!,input));
    const result=committed.result;stats.results.push(result);
    if(result.disposition==='adopted')stats.adopted++;
    else if(result.disposition==='updated')stats.updated++;
    else if(result.disposition==='merged')stats.merged++;
    else if(result.disposition==='pending')stats.pending++;
    else if(result.disposition==='skipped_noop')stats.skipped_noop++;
    else if(result.disposition==='skipped_duplicate')stats.skipped_duplicate++;
    else if(result.disposition==='skipped_deleted')stats.skipped_deleted++;
    else stats.failed++;
    if(!shortcut){
     const verifiedDecision=verified.get(index)!;
     const usages=[verifiedDecision.decision.usage,verifiedDecision.verification?.usage,verifiedDecision.merge?.usage].filter((value):value is ModelUsage=>Boolean(value));
     stats.usages.push(...usages);
    }
   }catch(error){
    const failure=error instanceof MemoryAdoptionError?error:new MemoryAdoptionError('adoption_commit_failed',true,error);
    stats.results.sort((a,b)=>a.candidate_index-b.candidate_index);
    failure.partial=stats;
    throw failure;
   }
  }
  stats.results.sort((a,b)=>a.candidate_index-b.candidate_index);
  return stats;
 }

 private async lock(client:pg.Client,scope:AdoptionScope):Promise<void>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${scope.owner_id}:${scope.contact_id}`]);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${scope.owner_id}`]);
 }
 private async commitShortcut(client:pg.Client,scope:AdoptionScope,index:number,entry:AdoptionFactInput,shortcut:Shortcut,
  input:AdoptionBatchInput):Promise<CommitOutcome>{
  await this.lock(client,scope);
  const fact=entry.fact;
  await factSourcesCurrent(client,scope,fact);
  if(shortcut.kind==='deleted'){
   if(!await deletedTextCurrent(client,scope,fact.text))fail('adoption_source_changed',true);
   return this.commitTrace(client,scope,input,index,{candidate_index:index,disposition:'skipped_deleted',candidate_id:null,memory_id:null,
    parent_memory_ids:[],decision:null,reason:'deleted_fingerprint'},[]);
  }
  const expected=shortcut.memory;
  if(!expected||expected.source_receipt===null)fail('adoption_source_changed',true);
  const item:AdjudicationItem={candidate_index:index,candidate:fact,candidate_source_receipt:'',candidate_source_texts:[],
   relation_source_receipt:'',similar:[expected!]};
  const parent=(await currentShortlistedRows(client,scope,item,[expected!.memory_id]))[0];
  const receipt=await sourceSetReceipt(client,scope,expected!.source_message_ids);
  if(!parent)fail('adoption_source_changed',true);
  if(!sameMemoryClaim(fact,parent!,expected!.source_message_ids,receipt))fail('adoption_source_changed',true);
  return this.commitTrace(client,scope,input,index,{candidate_index:index,disposition:'skipped_duplicate',candidate_id:null,
   memory_id:parent.id,parent_memory_ids:[parent.id],decision:'noop',reason:'same_claim_and_source_set'},[]);
 }
 private async commit(client:pg.Client,scope:AdoptionScope,index:number,entry:AdoptionFactInput,verified:VerifiedDecision,
  snapshotValue:Snapshot,item:AdjudicationItem,input:AdoptionBatchInput):Promise<CommitOutcome>{
  await this.lock(client,scope);
  const fact=entry.fact,decision=verified.decision;
  const currentSources=await factSourcesCurrent(client,scope,fact);
  if(item.candidate_source_receipt&&currentSources.receipt!==item.candidate_source_receipt)fail('adoption_source_changed',true);
  if(await deletedTextCurrent(client,scope,fact.text))
   return this.commitTrace(client,scope,input,index,{candidate_index:index,disposition:'skipped_deleted',candidate_id:null,memory_id:null,
    parent_memory_ids:[],decision:null,reason:'deleted_fingerprint'},[]);
  if(verified.forcedPending)return this.commitPending(client,scope,input,index,entry,verified.forcedPending,decision,verified.verification);
  if(decision.relation&&(!verified.verification?.supported||decision.relation.kind==='unresolved_conflict'))
   return this.commitPending(client,scope,input,index,entry,
    decision.relation.kind==='unresolved_conflict'?'timeline:unresolved_conflict':'timeline:relation_unknown',decision,verified.verification);
  if(decision.action==='noop'){
   const duplicate=decision.duplicate_memory_id;
   const expected=item.similar.find(memory=>memory.memory_id===duplicate);
   if(expected?.source_receipt){
    const parent=(await currentShortlistedRows(client,scope,item,[expected.memory_id]))[0];
    const receipt=await sourceSetReceipt(client,scope,expected.source_message_ids);
    if(parent&&sameMemoryClaim(fact,parent,expected.source_message_ids,receipt))
     return this.commitTrace(client,scope,input,index,{candidate_index:index,disposition:'skipped_noop',candidate_id:null,memory_id:parent.id,parent_memory_ids:[parent.id],decision:'noop',reason:null},[]);
   }
   return this.commitPending(client,scope,input,index,entry,'timeline:relation_unknown',decision,null);
  }
  if(decision.action==='add'||decision.action==='keep'){
   if(item.similar.length&&!decision.relation)return this.commitPending(client,scope,input,index,entry,'timeline:relation_unknown',decision,null);
   if(verified.verification&&(decision.relation?.kind!=='independent'||decision.relation.claim_changed||decision.relation.condition_changed))return this.commitPending(client,scope,input,index,entry,
    decision.relation?.kind==='unresolved_conflict'?'timeline:unresolved_conflict':'timeline:relation_unknown',decision,verified.verification);
   const relatedIds=decision.relation?.related_memory_ids??[];
   const related=relatedIds.length?await currentShortlistedRows(client,scope,item,relatedIds):[];
   return this.commitMemory(client,scope,input,index,entry,verified,related,fact.source_dependency_mode,item);
  }
  if(decision.action==='update'){
   if(!decision.relation||!['state_change','error_correction'].includes(decision.relation.kind)||!decision.relation.claim_changed)
    return this.commitPending(client,scope,input,index,entry,'timeline:relation_unknown',decision,verified.verification);
   const parentId=id(decision.replaced_memory_id);
   const parent=(await currentShortlistedRows(client,scope,item,[parentId]))[0];
   if(parent.adoption_method!=='auto')return this.commitPending(client,scope,input,index,entry,'manual_parent_protected',decision,verified.verification);
   if(item.similar.find(memory=>memory.memory_id===parentId)?.source_receipt===null)fail('adoption_source_changed',true);
   const similar=poolItem(parent??{},snapshotValue);
   if((fact.subject==='self')!==(!parent.contact_id))fail('adoption_scope_invalid');
   const blocked=canReplace({candidate_index:index,candidate:fact,candidate_source_receipt:'',candidate_source_texts:item.candidate_source_texts,
    relation_source_receipt:'',similar:[similar]},similar);
   if(blocked)return this.commitPending(client,scope,input,index,entry,blocked,decision,verified.verification);
   if(fact.source_message_ids.every(source=>parent.source_ids.includes(source)))return this.commitPending(client,scope,input,index,entry,'automatic_update_requires_new_evidence',decision,verified.verification);
   if((await client.query(`SELECT 1 FROM public.confirmed_memory WHERE owner_id=$1 AND contact_id=$2 AND supersedes_memory_id=$3 AND status='active'
    UNION ALL SELECT 1 FROM public.owner_memory WHERE owner_id=$1 AND supersedes_memory_id=$3 AND status='active' LIMIT 1`,[scope.owner_id,scope.contact_id,parentId])).rowCount)
    return this.commitPending(client,scope,input,index,entry,'parent_already_consumed',decision,verified.verification);
   return this.commitMemory(client,scope,input,index,entry,verified,[parent],parent.source_dependency_mode==='all'||fact.source_dependency_mode==='all'?'all':fact.source_dependency_mode,item);
  }
  if(!verified.merge)fail('merge_verification_failed');
  const merge:MergeVerification=verified.merge!;
  if(!decision.relation||decision.relation.kind!=='supplement'||decision.relation.claim_changed||decision.relation.condition_changed)
   return this.commitPending(client,scope,input,index,entry,'timeline:relation_unknown',decision,verified.verification);
  const sourceIds=[...merge.source_message_ids];
  const receipt=(await sourceDetails(client,scope,sourceIds)).receipt;
  if(!merge.supported||!receipt||merge.source_receipt!==receipt)fail('adoption_source_changed',true);
  const targetIds=(decision.merged_memory_ids??[]).map(id);
  const parents=await currentShortlistedRows(client,scope,item,targetIds);
  if(parents.length!==targetIds.length||parents.some(parent=>parent.adoption_method!=='auto'))return this.commitPending(client,scope,input,index,entry,'manual_parent_protected',decision,verified.verification);
  if(targetIds.some(target=>item.similar.find(memory=>memory.memory_id===target)?.source_receipt===null))fail('adoption_source_changed',true);
  if(fact.event!==null||fact.conditions!==null||parents.some(parent=>parent.event!=null||parent.conditions!=null
   ||parent.valid_at!==fact.valid_at||parent.invalid_at!==fact.invalid_at))
   return this.commitPending(client,scope,input,index,entry,'timeline:merge_incompatible',decision,verified.verification);
  const merged={...fact,text:merge.text,source_message_ids:sourceIds,source_dependency_mode:'all' as const,requires_all_sources:true,dimension_evidence:null};
  return this.commitMemory(client,scope,input,index,{...entry,fact:merged},verified,parents,'all',{...item,candidate:merged});
 }
 private async commitPending(client:pg.Client,scope:AdoptionScope,input:AdoptionBatchInput,index:number,entry:AdoptionFactInput,reason:string,
  decision:AdjudicationDecision,verification:RelationVerification|null):Promise<CommitOutcome>{
  const existing=await this.ensureCandidate(client,scope,entry,reason);
  const usages=[decision.usage,verification?.usage].filter((usage):usage is ModelUsage=>Boolean(usage));
  if(existing.status==='invalidated'||existing.status==='rejected'){
   return this.commitTrace(client,scope,input,index,{candidate_index:index,disposition:'failed',candidate_id:existing.id,memory_id:null,parent_memory_ids:[],decision:decision.action,reason:existing.failure_reason??reason},usages);
  }
  return this.commitTrace(client,scope,input,index,{candidate_index:index,disposition:'pending',candidate_id:existing.id,memory_id:null,
   parent_memory_ids:decision.relation?.related_memory_ids??[],decision:decision.action,reason},usages);
 }
 private async ensureCandidate(client:pg.Client,scope:AdoptionScope,entry:AdoptionFactInput,failureReason:string|null=null):Promise<MemoryRow>{
  const fact=entry.fact,stableId=candidateId(scope,fact);
  const samePending=(await client.query("SELECT to_jsonb(c) AS value FROM public.memory_candidate c WHERE owner_id=$1 AND contact_id=$2 AND status='pending' FOR UPDATE",[scope.owner_id,scope.contact_id]))
   .rows.map(row=>row.value).find(row=>pendingIdentity(row,fact));
  if(samePending){
   if(failureReason&&!samePending.failure_reason){
    await client.query("UPDATE public.memory_candidate SET failure_reason=$4,updated_at=now() WHERE owner_id=$1 AND contact_id=$2 AND id=$3 AND status='pending' AND failure_reason IS NULL",
     [scope.owner_id,scope.contact_id,samePending.id,failureReason]);
    samePending.failure_reason=failureReason;
   }
   return samePending;
  }
  const existing=(await client.query('SELECT to_jsonb(c) AS value FROM public.memory_candidate c WHERE owner_id=$1 AND contact_id=$2 AND id=$3 FOR UPDATE',[scope.owner_id,scope.contact_id,stableId])).rows[0]?.value;
  if(existing)return existing;
  await ensureMemorySources(client,scope.owner_id,scope.contact_id,{source_ids:fact.source_message_ids,source_dependency_mode:fact.source_dependency_mode});
  const evidence=await captureSnapshot(client,scope.owner_id,fact.source_message_ids,fact.source_message_ids,scope.contact_id);
  const row=(await client.query(`INSERT INTO public.memory_candidate
   (id,owner_id,contact_id,text_content,category,topic,subject,source_ids,status,valid_at,invalid_at,confidence,risk_flags,
    alternatives,interpretation_reason,failure_reason,correction_evidence,dimension_evidence,event,conditions,source_dependency_mode,requires_all_sources)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
   ON CONFLICT(id) DO NOTHING RETURNING to_jsonb(memory_candidate) AS value`,
  [stableId,scope.owner_id,scope.contact_id,fact.text,fact.category,fact.topic,fact.subject,fact.source_message_ids,fact.valid_at,fact.invalid_at,
   fact.confidence,fact.risk_flags,fact.alternatives,fact.interpretation_reason,failureReason,json(evidence),json(fact.dimension_evidence),
   json(fact.event),json(fact.conditions),fact.source_dependency_mode,fact.requires_all_sources])).rows[0]?.value;
  return row??(await client.query('SELECT to_jsonb(c) AS value FROM public.memory_candidate c WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[scope.owner_id,scope.contact_id,stableId])).rows[0].value;
 }
 private async commitMemory(client:pg.Client,scope:AdoptionScope,input:AdoptionBatchInput,index:number,entry:AdoptionFactInput,
  verified:VerifiedDecision,parents:MemoryRow[],dependency:'any'|'all',item:AdjudicationItem):Promise<CommitOutcome>{
  const fact=entry.fact,decision=verified.decision;
  const initialSources=await sourceDetails(client,scope,fact.source_message_ids);
  if(!initialSources.complete)fail('adoption_source_changed',true);
  const candidate=await this.ensureCandidate(client,scope,entry,null);
  if(candidate.status==='confirmed'){
   const table=fact.subject==='self'?'owner_memory':'confirmed_memory';
   const existing=(await client.query(`SELECT to_jsonb(m) AS value FROM public.${table} m WHERE owner_id=$1 ${fact.subject==='self'?'':'AND contact_id=$2'} AND source_candidate_id=$${fact.subject==='self'?2:3} AND status='active'`,
    fact.subject==='self'?[scope.owner_id,candidate.id]:[scope.owner_id,scope.contact_id,candidate.id])).rows[0]?.value;
   if(!existing)fail('adoption_source_changed',true);
   const usages=[decision.usage,verified.verification?.usage,verified.merge?.usage].filter((usage):usage is ModelUsage=>Boolean(usage));
   return this.commitTrace(client,scope,input,index,{candidate_index:index,disposition:'skipped_duplicate',candidate_id:candidate.id,memory_id:existing.id,
    parent_memory_ids:decision.relation?.related_memory_ids??[],decision:decision.action,reason:'existing_adoption_receipt'},usages);
  }
  const protectedCandidate=await protectCandidate(client,candidate);
  if(protectedCandidate.reviews.length||protectedCandidate.row.failure_reason==='version:original_window_unknown'
   ||protectedCandidate.row.status!=='pending')return this.commitPending(client,scope,input,index,{...entry,fact:{...fact,dimension_evidence:candidate.dimension_evidence}},
    protectedCandidate.row.failure_reason??'correction_review_required',decision,verified.verification);
  if(decision.action==='merge'){
   const targetIds=new Set(parents.map(parent=>parent.id));
   if([...targetIds].some(target=>![...(decision.merged_memory_ids??[])].includes(target)))fail('adjudication_invalid');
  }else if(!await dimensionSourcesCurrent(client,candidate))fail('adoption_source_changed',true);
  const parentUpdates:MemoryRow[]=parents.map(parent=>({...parent,revision:positiveRevision(parent.revision)}));
  const relatedSourceIds=[...new Set<string>([...fact.source_message_ids,...parentUpdates.flatMap(parent=>parent.source_ids)])];
  const sourceIds=decision.action==='update'||decision.action==='merge'?relatedSourceIds:[...fact.source_message_ids];
  const all=decision.action==='merge'||dependency==='all';
  const consumesParents=decision.action==='update'||decision.action==='merge';
  await ensureMemorySources(client,scope.owner_id,scope.contact_id,{...candidate,source_ids:sourceIds,source_dependency_mode:all?'all':'any'});
  const contactParents=parentUpdates.filter(parent=>parent.contact_id),ownerParents=parentUpdates.filter(parent=>!parent.contact_id);
  const latestContact=contactParents.length?(await client.query(`SELECT to_jsonb(m) AS value FROM public.confirmed_memory m WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[])
   AND status='active' FOR UPDATE`,[scope.owner_id,scope.contact_id,contactParents.map(parent=>parent.id)])).rows.map(row=>row.value):[];
  const latestOwner=ownerParents.length?(await client.query(`SELECT to_jsonb(m) AS value FROM public.owner_memory m WHERE owner_id=$1 AND id=ANY($2::uuid[])
   AND status='active' FOR UPDATE`,[scope.owner_id,ownerParents.map(parent=>parent.id)])).rows.map(row=>row.value):[];
  const latestMap=new Map([...latestContact,...latestOwner].map(row=>[row.id,row]));
  if(latestMap.size!==parentUpdates.length)fail('adoption_source_changed',true);
  for(const parent of parentUpdates)if(!latestMap.has(parent.id)||latestMap.get(parent.id)!.revision!==parent.revision)fail('adoption_source_changed',true);
  const memoryId=randomUUID();
  let evolution:MemoryRow|null=null;
  if(decision.relation){
   const related:MemoryRow[]=decision.relation.related_memory_ids.map(relatedId=>parentUpdates.find(parent=>parent.id===relatedId)??{
    id:relatedId,revision:Math.max(1,...parentUpdates.map(parent=>parent.revision))} as MemoryRow);
   const messageIds=[...new Set<string>(relatedSourceIds)];
   const proofSourceIds=[...new Set<string>(relatedSourceIds)];
   const proofSources=await captureSnapshot(client,scope.owner_id,messageIds,proofSourceIds,scope.contact_id);
   evolution={version:1,kind:decision.relation.kind,explanation:decision.relation.explanation,
    related_versions:related.map(parent=>({memory_id:parent.id,revision:positiveRevision(parent.revision)})),
    evidence_message_ids:[...new Set(verified.verification?.evidence.map(item=>item.message_id)??[])],
    source_supported:Boolean(verified.verification?.supported),claim_changed:Boolean(verified.verification?.claim_changed),
    condition_changed:Boolean(verified.verification?.condition_changed),
    proof:{scope:{owner_id:scope.owner_id,contact_id:scope.contact_id},
     candidate_sha256:candidateDigest({...candidate,text_content:fact.text,source_ids:fact.source_message_ids,event:fact.event,conditions:fact.conditions,
      source_dependency_mode:fact.source_dependency_mode},decision.action==='merge'?4:1),
     sources:proofSources,parents:parentUpdates.map(parent=>({memory_id:parent.id,revision:parent.revision,subject:parent.contact_id?'contact':'self',
      claim_source_ids:parent.source_ids,invalid_at:parent.invalid_at??null,
      record_sha256:overviewRecordDigest(parent,normalizeEvolution(parent.evolution),parent.revision,parent.invalid_at)}))}};
  }
  const candidateRow={...candidate,text_content:fact.text,source_ids:fact.source_message_ids,event:fact.event,conditions:fact.conditions,evolution};
  if(evolution)await validateEvolutionProof(client,scope.owner_id,scope.contact_id,{...candidateRow,contact_id:scope.contact_id},evolution);
  let current={
   id:memoryId,owner_id:scope.owner_id,...(fact.subject==='self'?{}:{contact_id:scope.contact_id}),text_content:fact.text,category:fact.category,topic:fact.topic,
   source_ids:sourceIds,source_candidate_id:candidate.id,adoption_method:'auto',status:'active',valid_at:fact.valid_at,invalid_at:fact.invalid_at,
   confidence:fact.confidence,risk_flags:fact.risk_flags,revision:consumesParents&&parentUpdates.length?Math.max(...parentUpdates.map(parent=>parent.revision))+1:1,
   supersedes_memory_id:decision.action==='update'?id(decision.replaced_memory_id):null,
   merge_parent_ids:decision.action==='merge'?(decision.merged_memory_ids??[]).map(id):[],
   event:fact.event,conditions:fact.conditions,evolution,version_evidence:null,
   source_dependency_mode:all?'all':fact.source_dependency_mode,requires_all_sources:Boolean(all||fact.requires_all_sources),
  } as MemoryRow;
  if(decision.action==='update'){
   const previous=parentUpdates[0]!;
   current.version_evidence=await candidateVersionEvidence(client,previous,current);
  }
  const table=fact.subject==='self'?'owner_memory':'confirmed_memory';
  const columns=['id','owner_id',...(fact.subject==='self'?[]:['contact_id']),'text_content','category','topic','source_ids','source_candidate_id',
   'adoption_method','status','valid_at','invalid_at','confidence','risk_flags','revision','supersedes_memory_id','merge_parent_ids',
   'event','conditions','evolution','version_evidence','source_dependency_mode','requires_all_sources'];
  const jsonColumns=new Set(['event','conditions','evolution','version_evidence']);
  const values=columns.map(column=>jsonColumns.has(column)?json(current[column]):current[column]??null);
  const written=(await client.query(`INSERT INTO public.${table}(${columns.join(',')}) VALUES(${columns.map((_,offset)=>`$${offset+1}`).join(',')})
   RETURNING to_jsonb(${table}) AS value`,values)).rows[0].value as MemoryRow;
  if(consumesParents&&parentUpdates.length){
   const retirement=decision.relation?.kind==='error_correction'?'error_correction':'state_changed';
   const contactParentIds=contactParents.map(parent=>parent.id);
   const ownerParentIds=ownerParents.map(parent=>parent.id);
   if(contactParentIds.length){
    const changed=await client.query(`UPDATE public.confirmed_memory SET status='invalidated',revision=revision+1,retirement_reason=$3,retired_at=now(),updated_at=now()
     WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($4::uuid[]) AND status='active' AND adoption_method='auto'`,[scope.owner_id,scope.contact_id,retirement,contactParentIds]);
    if(changed.rowCount!==contactParentIds.length)fail('adoption_source_changed',true);
   }
   if(ownerParentIds.length){
    const changed=await client.query(`UPDATE public.owner_memory SET status='invalidated',revision=revision+1,retirement_reason=$2,retired_at=now(),updated_at=now()
     WHERE owner_id=$1 AND id=ANY($3::uuid[]) AND status='active' AND adoption_method='auto'`,[scope.owner_id,retirement,ownerParentIds]);
    if(changed.rowCount!==ownerParentIds.length)fail('adoption_source_changed',true);
   }
  }
  const marked=await client.query("UPDATE public.memory_candidate SET status='confirmed',updated_at=now() WHERE owner_id=$1 AND contact_id=$2 AND id=$3 AND status='pending'",[scope.owner_id,scope.contact_id,candidate.id]);
  if(marked.rowCount!==1)fail('adoption_source_changed',true);
  const finalSources=await sourceDetails(client,scope,fact.source_message_ids);
  if(!finalSources.complete||finalSources.receipt!==initialSources.receipt)fail('adoption_source_changed',true);
  await bumpMemoryRevision(client,scope.owner_id,scope.contact_id);
  await eraseLayeredReplies(client,scope.owner_id,scope.contact_id,[written.id,...sourceIds,...parentUpdates.map(parent=>parent.id)]);
  const disposition=decision.action==='update'?'updated':decision.action==='merge'?'merged':'adopted';
  const result={candidate_index:index,disposition,candidate_id:candidate.id,memory_id:written.id,parent_memory_ids:parentUpdates.map(parent=>parent.id),
   decision:decision.action,reason:null} as AdoptionResult;
  const usages=[decision.usage,verified.verification?.usage,verified.merge?.usage].filter((usage):usage is ModelUsage=>Boolean(usage));
  return this.commitTrace(client,scope,input,index,result,usages);
 }
 private async commitTrace(client:pg.Client,scope:AdoptionScope,input:AdoptionBatchInput,index:number,result:AdoptionResult,usages:ModelUsage[]):Promise<CommitOutcome>{
  if(input.trace_id){
   const trace=(await client.query('SELECT status,batch_key FROM public.memory_extraction_trace WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3 FOR UPDATE',
    [input.trace_id,scope.owner_id,scope.contact_id])).rows[0];
   if(!trace||trace.status!=='running'||input.batch_key!=null&&trace.batch_key!==input.batch_key)fail('adoption_trace_unavailable',true);
   await client.query(`INSERT INTO public.memory_extraction_trace_event(event_id,trace_id,owner_id,contact_id,position,stage,candidate_trace_id,payload)
    SELECT $1,$2,$3,$4,COALESCE(max(position),0)+1,'candidate_result',$5,$6::jsonb FROM public.memory_extraction_trace_event
    WHERE trace_id=$2`,[randomUUID(),input.trace_id,scope.owner_id,scope.contact_id,
    input.facts[index]?.candidate_trace_id??null,json({candidate_index:index,result,usages})]);
   if(result.candidate_id)await client.query(`INSERT INTO public.memory_extraction_trace_link(trace_id,owner_id,contact_id,candidate_trace_id,record_kind,record_id,commit_status)
    VALUES($1,$2,$3,$4,'candidate',$5,$6) ON CONFLICT(trace_id,record_kind,record_id) DO UPDATE SET commit_status=EXCLUDED.commit_status`,
   [input.trace_id,scope.owner_id,scope.contact_id,input.facts[index]?.candidate_trace_id??null,result.candidate_id,
    result.disposition==='adopted'||result.disposition==='updated'||result.disposition==='merged'?'committed':'planned']);
   if(result.memory_id)await client.query(`INSERT INTO public.memory_extraction_trace_link(trace_id,owner_id,contact_id,candidate_trace_id,record_kind,record_id,commit_status)
    VALUES($1,$2,$3,$4,$5,$6,'committed') ON CONFLICT(trace_id,record_kind,record_id) DO UPDATE SET commit_status='committed'`,
   [input.trace_id,scope.owner_id,scope.contact_id,input.facts[index]?.candidate_trace_id??null,
    result.candidate_id&&input.facts[index]!.fact.subject==='self'?'owner_memory':'contact_memory',result.memory_id]);
   const dependencyIds=new Set(input.facts[index]!.fact.source_message_ids);
   if(result.parent_memory_ids.length){
    const parents=(await client.query(`SELECT source_ids FROM public.confirmed_memory WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[])
     UNION ALL SELECT source_ids FROM public.owner_memory WHERE owner_id=$1 AND id=ANY($3::uuid[])`,[scope.owner_id,scope.contact_id,result.parent_memory_ids])).rows;
    for(const parent of parents)for(const source of parent.source_ids)dependencyIds.add(source);
   }
   for(const source of dependencyIds)await client.query(`INSERT INTO public.memory_extraction_trace_dependency(trace_id,owner_id,contact_id,source_id)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[input.trace_id,scope.owner_id,scope.contact_id,source]);
  }
  return {result};
 }
}
