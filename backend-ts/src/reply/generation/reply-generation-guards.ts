import {createReplyAssistantGuards} from './reply-assistant-factory.ts';
/** 每轮生成的同事务守卫组装；历史重放不重新选择当前资料或偏好。 */
import type pg from 'pg';
import {isDeepStrictEqual} from 'node:util';
import {normalizeReplyInput,replyUuid,type ReplyRequestInput} from './reply-contract.ts';
import {requireReplyScope,type VerifiedReplyScope} from './reply-scope.ts';
import {ReplyStoreError,type ReplyStoreGuards,type ReplyStoreInput,type ReplyStoreRequest,type ReplyStoreContext} from './reply-store.ts';
import {type AuthenticatedContinuation,type ReplyAssistantContext} from './reply-assistant-guards.ts';
import {PostgresReplyDiscussionContext,type ReplyDiscussionContext} from '../discussion/reply-discussion-context.ts';
import {PostgresReplyContext,type BuiltReplyContext,type ReplyContextOptions} from '../context/reply-context.ts';
import {requireCurrentReplyMemory} from '../context/reply-context-guards.ts';
import * as sources from './reply-source-guards.ts';
import {evidenceSources} from './reply-assistant-erasure.ts';
import {captureReplyPreferences,requireCapturedReplyPreferences,type PreferenceSnapshot} from '../../preferences/preference-service.ts';
import type {PostgresSkillPort,SkillUse} from '../../skills/skill-port.ts';
import type {createReplySkillGuards} from './reply-skill-guards.ts';
import {selectedSkillFailureEntry,type SelectedSkillFailure} from './reply-skill-runtime.ts';
import {parseJson} from '../../host/host-json.ts';
type Row=Record<string,any>;
export interface LegacyEmptyPreferenceSnapshot {readonly revision:null;readonly preferences:[]}
export type ReplyPreferenceSnapshot=PreferenceSnapshot|LegacyEmptyPreferenceSnapshot;
const decodedLegacyPreferences=new WeakSet<object>();
/** 仅供严格v2/r15 codec完整解码成功后的内部恢复接缝；不接收公开请求。 */
export function restoreLegacyEmptyPreferences():LegacyEmptyPreferenceSnapshot {const value:LegacyEmptyPreferenceSnapshot={revision:null,preferences:[]};Object.freeze(value.preferences);Object.freeze(value);decodedLegacyPreferences.add(value);return value;}
export function isLegacyEmptyPreferences(value:ReplyPreferenceSnapshot):value is LegacyEmptyPreferenceSnapshot {return value.revision===null&&value.preferences.length===0&&decodedLegacyPreferences.has(value);}
export interface PreparedGenerationState {
 context:BuiltReplyContext;discussion:ReplyDiscussionContext|null;preferences:ReplyPreferenceSnapshot;
 skillRevision:string;contextOptions?:ReplyContextOptions;
}
export interface ReplyGenerationGuardOptions {
 scope:VerifiedReplyScope;input:ReplyRequestInput;authenticatedContinuation?:AuthenticatedContinuation;
 skillPort:Pick<PostgresSkillPort,'validateUseInTransaction'|'validateInTransaction'>;
 savedSkill:ReturnType<typeof createReplySkillGuards>;
 selectedSkillFailure?:()=>SelectedSkillFailure|null;
 /** suggestion入口必须提供实际探索回执复验，普通入口不需要。 */
 validateExploredContext?:(client:pg.Client,context:BuiltReplyContext)=>Promise<void>;
}
const invalid=():never=>{throw new ReplyStoreError('reply_context_invalidated');};
const unavailable=():never=>{throw new ReplyStoreError('reply_guards_unavailable');};
const unique=(ids:Iterable<string>)=>[...new Set(ids)].sort();
const equal=isDeepStrictEqual;
function preferenceReceipts(p:ReplyPreferenceSnapshot):Row[]{return p.preferences.map(v=>({preference_id:v.preference_id,text:v.text,revision:v.revision,scope:{contact_id:v.scope.contact_id,reply_mode:v.scope.reply_mode}}));}
function navigation(context:BuiltReplyContext):string[]{return unique([...(context.navigation_dependency_ids??[]),...context.evidence.flatMap(e=>e.navigation?.dependency_ids??[]),...[context.layered_context,context.owner_layered_context].flatMap(m=>m?[...m.snapshot.dependency_ids,...m.snapshot.scenarios.map(s=>s.version_id),...m.snapshot.profile_version_id?[m.snapshot.profile_version_id]:[]]:[])]);}
export const replyGenerationNavigationDependencies=navigation;
function normalizedReceipts(value:unknown,contact:string):Row[]{
 if(!Array.isArray(value)||value.length>5)invalid();let count=0;const ids=new Set();
 return (value as Row[]).map(v=>{if(!v||Object.keys(v).sort().join(',')!=='preference_id,revision,scope,text'||typeof v.text!=='string'||!v.text.trim()||[...v.text].length>512||!v.scope||Object.keys(v.scope).sort().join(',')!=='contact_id,reply_mode'||![null,contact].includes(v.scope.contact_id)||![null,'reply_to_message','rewrite_draft','initiate_conversation'].includes(v.scope.reply_mode))invalid();
   const id=replyUuid(v.preference_id);if(ids.has(id))invalid();ids.add(id);count+=[...v.text].length;if(count>1536)invalid();
   if(!['number','bigint'].includes(typeof v.revision)||typeof v.revision==='number'&&!Number.isSafeInteger(v.revision)||BigInt(v.revision)<1n)invalid();return {...v,revision:BigInt(v.revision)};
 }).sort((a:Row,b:Row)=>a.preference_id.localeCompare(b.preference_id));
}
export function createReplyGenerationGuards(options:ReplyGenerationGuardOptions){
 if(typeof options.skillPort?.validateUseInTransaction!=='function'||typeof options.savedSkill?.requireSavedSkillPolicy!=='function'||typeof options.savedSkill?.savedSkillPolicyChange!=='function')unavailable();
 const scope=structuredClone(options.scope),input=structuredClone(options.input),auth=options.authenticatedContinuation?structuredClone(options.authenticatedContinuation):undefined;
 let prepared:PreparedGenerationState|undefined;
 const matches=(r:ReplyStoreInput)=>{if(r.owner_id!==scope.owner_id||r.contact_id!==scope.contact_id||r.conversation_binding_id!==scope.conversation_binding_id||r.idempotency_key!==input.idempotency_key||r.continued_from_candidate_id!==input.continued_from_candidate_id||r.normalized_input!==normalizeReplyInput(input))invalid();};
 const {assistant,ports}=createReplyAssistantGuards(options.savedSkill,async(client,s)=>{
  if(s.owner_id!==scope.owner_id||s.contact_id!==scope.contact_id)invalid();await requireReplyScope(client,scope,input);return scope.conversation_binding_id;
 });
 const discussion=new PostgresReplyDiscussionContext({guards:assistant,ports});
 const assistantContext=(context:ReplyStoreContext):ReplyAssistantContext=>({...context,continuation_basis:prepared!.context.continuation_basis,assistant_discussion_snapshot:prepared!.discussion?.snapshot??null});
 async function validate(client:pg.Client,request:ReplyStoreRequest,context:ReplyStoreContext):Promise<PreparedGenerationState>{
   if(!prepared)unavailable();matches(request);const state=prepared!,built=state.context;if(state.preferences.revision===null&&!isLegacyEmptyPreferences(state.preferences))invalid();
   if(isLegacyEmptyPreferences(state.preferences)){
     const legacy=(await client.query('SELECT expression_preference_revision FROM reply_request WHERE id=$1 AND owner_id=$2 AND contact_id=$3',[request.request_id,scope.owner_id,scope.contact_id])).rows[0];
     if(!legacy||legacy.expression_preference_revision!==null||(await client.query('SELECT 1 FROM reply_expression_preference_use WHERE reply_request_id=$1',[request.request_id])).rowCount)invalid();
   }
   if(built.reply_request_id!==request.request_id||!equal(built.scope,{owner_id:scope.owner_id,contact_id:scope.contact_id})||built.conversation_binding_id!==scope.conversation_binding_id||!equal(built.command.content,input.content)||built.command.contact_id!==input.contact_id||built.command.continued_from_candidate_id!==input.continued_from_candidate_id||!equal(context.evidence,built.evidence)||String(context.skill_library_revision)!==state.skillRevision)invalid();
   await requireReplyScope(client,scope,input);
   await new PostgresReplyContext(client,{...state.contextOptions,readContinuationBasis:(c,s,b,id)=>assistant.readContinuationBasis(c,s,b,id)}).validateCurrent(built);
   await requireCurrentReplyMemory(client,built.scope,built.evidence);
   await discussion.validateCurrent(client,request,state.discussion);
   if(input.suggestion){if(!options.validateExploredContext)unavailable();await options.validateExploredContext!(client,built);}
   if(!equal(context.snapshot.scope,built.scope)||!equal(context.snapshot.evidence,built.evidence)||!equal(normalizedReceipts(context.snapshot.expression_preferences,scope.contact_id),normalizedReceipts(preferenceReceipts(state.preferences),scope.contact_id)))invalid();
   if(!equal(context.snapshot.assistant_discussion_snapshot??null,state.discussion?.snapshot??null))invalid();
   const nav=navigation(built);if(!equal(unique(context.snapshot.navigation_dependency_ids as string[]??[]),nav))invalid();
   if(state.discussion===null&&context.snapshot.assistant_discussion_snapshot!=null)invalid();
   const expected=built.continuation_basis?{candidate_id:built.continuation_basis.candidate_id,basis_revision_sha256:built.continuation_basis.basis_revision_sha256,basis_changes:built.continuation_basis.basis_changes}:null;
   if(!equal(context.snapshot.continuation_basis??null,expected))invalid();
   return state;
 }
 async function captureSources(client:pg.Client,request:ReplyStoreRequest,state:PreparedGenerationState,initial:boolean):Promise<void>{
   const declared=new Set<string>();
   for(const e of state.context.evidence){
     if(initial){for(const id of await evidenceSources(client,scope.owner_id,e,false,{historical:!!e.navigation&&e.timing.current_status==='historical',text:e.text}))declared.add(id);for(const id of e.evolution?.evidence_message_ids??[])declared.add(id);if(e.kind==='message')declared.add(e.evidence_id);}
     else for(const id of e.source_ids)declared.add(id);
   }
   if(initial)for(const p of state.preferences.preferences)for(const id of p.source_ids)declared.add(id);
   const raw=(await client.query(`SELECT id FROM source_document WHERE owner_id=$1 AND id=ANY($2::uuid[]) ${initial?"AND status='active'":''} UNION SELECT id FROM local_wechat_observation WHERE owner_id=$1 AND id=ANY($2::uuid[])`,[scope.owner_id,unique(declared)])).rows.map(r=>r.id);
   if(initial){
     const refs=(await client.query(`SELECT ref.message_id,coalesce(ref.source_document_id,ref.observation_id) AS id FROM message_source_ref ref LEFT JOIN source_document s ON s.id=ref.source_document_id LEFT JOIN local_wechat_observation o ON o.id=ref.observation_id WHERE ref.owner_id=$1 AND ref.message_id=ANY($2::uuid[]) AND(s.status='active' OR o.id IS NOT NULL)`,[scope.owner_id,unique(declared)])).rows;
     const found=new Set([...raw,...refs.map(r=>r.message_id)]);if([...declared].some(id=>!found.has(id)))invalid();for(const r of refs)raw.push(r.id);
     const nav=(await client.query("SELECT id FROM source_document WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND status='active' UNION SELECT id FROM local_wechat_observation WHERE owner_id=$1 AND id=ANY($2::uuid[])",[scope.owner_id,navigation(state.context)])).rows;for(const r of nav)raw.push(r.id);
     if(request.continued_from_candidate_id){const parent=(await client.query('SELECT reply_request_id FROM reply_candidate WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[scope.owner_id,scope.contact_id,request.continued_from_candidate_id])).rows[0];if(!parent)invalid();raw.push(...await ports.requireReplySourcesCurrent(client,scope,parent.reply_request_id,true));}
   }
   for(const id of unique(raw))await client.query('INSERT INTO reply_original_source_use(reply_request_id,source_id,owner_id,contact_id)VALUES($1,$2,$3,$4)ON CONFLICT DO NOTHING',[request.request_id,id,scope.owner_id,scope.contact_id]);
 }
 const guards:ReplyStoreGuards={
   async start(client,request){matches(request);await requireReplyScope(client,scope,input);if(input.suggestion&&!options.validateExploredContext)unavailable();await assistant.prepareAssistantReplyStart(client,request,auth);},
   async started(client,request){matches(request);await assistant.captureContinuationBasis(client,request);},
   async prepare(client,request,context){const state=await validate(client,request,context);await assistant.requireContinuationBasis(client,request,assistantContext(context));if(!isLegacyEmptyPreferences(state.preferences))await captureReplyPreferences(client,scope.owner_id,scope.contact_id,request.request_id,input.content.type,state.preferences);await captureSources(client,request,state,true);
     // 新TS准备无需写旧A序列化副本；在C原快照登记已真实复验的导航身份。
     await client.query("UPDATE reply_request SET context_snapshot=jsonb_set(coalesce(context_snapshot,'{}'::jsonb),'{navigation_dependency_ids}',$2::jsonb) WHERE id=$1",[request.request_id,JSON.stringify(navigation(state.context))]);
     await assistant.captureReplyDiscussion(client,request,state.discussion?.snapshot??null);await ports.requireReplySourcesCurrent(client,scope,request.request_id,false);},
   async commit(client,request,context,use){const state=await validate(client,request,context);if(input.skill_disabled&&use!==null)invalid();if(input.skill_version_id!==null&&use?.version_id!==input.skill_version_id){const failure=use===null?options.selectedSkillFailure?.()??null:null;const entry=selectedSkillFailureEntry(failure,options.skillPort,{ownerId:scope.owner_id,contactId:scope.contact_id},state.skillRevision);if(!failure||failure.version_id!==input.skill_version_id||!entry||typeof options.skillPort.validateInTransaction!=='function')invalid();await options.skillPort.validateInTransaction(client,{ownerId:scope.owner_id,contactId:scope.contact_id,scene:input.scene??''},state.skillRevision,entry);}if(!isLegacyEmptyPreferences(state.preferences))await requireCapturedReplyPreferences(client,scope.owner_id,scope.contact_id,request.request_id,input.content.type,state.preferences);await assistant.requireReplyDiscussion(client,request,state.discussion?.snapshot??null,true);await captureSources(client,request,state,false);await ports.requireReplySourcesCurrent(client,scope,request.request_id,false);await assistant.prepareAssistantReplyCommit(client,request,assistantContext(context),auth);await assistant.requireContinuationBasis(client,request,assistantContext(context));await options.skillPort.validateUseInTransaction(client,{ownerId:scope.owner_id,contactId:scope.contact_id,scene:input.scene??''},state.skillRevision,use as SkillUse|null);},
   async replay(client,request){matches(request);await ports.requireReplySourcesCurrent(client,scope,request.request_id,true);await options.savedSkill.requireSavedSkillPolicy(client,scope,request.request_id);
     const row=(await client.query('SELECT context_snapshot::text AS snapshot FROM reply_request WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[scope.owner_id,scope.contact_id,request.request_id])).rows[0];if(!row?.snapshot)invalid();const snap=parseJson(row.snapshot) as Row;
     const receipts=normalizedReceipts(snap.expression_preferences??[],scope.contact_id),captured=(await client.query('SELECT preference_id,preference_revision FROM reply_expression_preference_use WHERE owner_id=$1 AND contact_id=$2 AND reply_request_id=$3',[scope.owner_id,scope.contact_id,request.request_id])).rows;
     if(captured.length!==receipts.length||captured.some(r=>!receipts.some(p=>p.preference_id===r.preference_id&&p.revision===BigInt(r.preference_revision))))invalid();
   },
 };
 return {guards,assistant,discussion,bindPrepared(state:PreparedGenerationState):void{if(!state?.context||!state.preferences||typeof state.skillRevision!=='string'||!/^(0|[1-9][0-9]*)$/.test(state.skillRevision)||!Object.hasOwn(state,'discussion'))unavailable();if(state.preferences.revision===null&&!isLegacyEmptyPreferences(state.preferences))invalid();if(prepared&&prepared.context.reply_request_id!==state.context.reply_request_id)invalid();prepared=state;}};
}
