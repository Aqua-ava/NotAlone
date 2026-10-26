/** 助手输入/续写/讨论在原回复事务中的守卫；领域资格由同连接权威端口提供。 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { ReplyStoreInput, ReplyStoreRequest, ReplyStoreContext, ReplyStoreEvidence } from './reply-store.ts';
import { ReplyStoreError } from './reply-store.ts';
import { canonical, snapshot, capturedEdges, inputRows, generationDependencies, evidenceSources, carryEdges, activeMessage } from './reply-assistant-erasure.ts';
import { anchor as anchorSql } from './reply-assistant-erasure-sql.ts';
import { ensureReplyValidationScope } from './reply-source-guards.ts';
type Row=Record<string,any>;
export interface AssistantScope {owner_id:string;contact_id:string}
/** 只能由已认证内部08应用接缝提供，公开生成解析器必须拒绝这些字段。 */
export interface AuthenticatedContinuation {
  /** 仅受理事务确认分段后，由生命周期传递精确旧候选引用。 */
  rollover_reference?:boolean;
  continuation: Record<string,unknown>;
  continuation_reference: {candidate_id:string;version_id:string;messages:{message_id:string;text:string}[]} | null;
}
export interface ReplyContinuationBasis {
  candidate_id:string;scope:AssistantScope;conversation_binding_id:string;text:string;
  basis_revision_sha256:string;basis_changes:Record<string,unknown>[];
}
export interface ReplyAssistantContext extends ReplyStoreContext {
  continuation_basis?:ReplyContinuationBasis|null;
  assistant_discussion_snapshot?:Record<string,unknown>|null;
}
export interface ReplyAssistantPorts {
  requireReplySourcesCurrent(client:pg.Client,scope:AssistantScope,requestId:string,historical:boolean):Promise<string[]>;
  requireDependencies(client:pg.Client,scope:AssistantScope,ids:string[],historical:boolean):Promise<void>;
  registeredNavigationDependencies(client:pg.Client,scope:AssistantScope):Promise<string[]>;
  requireCurrentReplyMemory(client:pg.Client,scope:AssistantScope,evidence:ReplyStoreEvidence[]):Promise<void>;
  requireGenerationMemoryDependencies(client:pg.Client,scope:AssistantScope,ids:string[]):Promise<void>;
  historicalBasisRevision(client:pg.Client,scope:AssistantScope,ids:string[]):Promise<string>;
  readReplyBasisChanges(client:pg.Client,scope:AssistantScope,requestId:string):Promise<Record<string,unknown>[]>;
  requireSavedSkillPolicy(client:pg.Client,scope:AssistantScope,requestId:string):Promise<void>;
  requireActiveBinding(client:pg.Client,scope:AssistantScope):Promise<string>;
  navigationDependencyIds(context:ReplyAssistantContext):string[];
}
const reject=():never=>{throw new ReplyStoreError('reply_context_invalidated');};
const scopeOf=(r:AssistantScope):AssistantScope=>({owner_id:r.owner_id,contact_id:r.contact_id});
const unique=(values:Iterable<string>):string[]=>[...new Set(values)].sort();
const same=(a:unknown,b:unknown):boolean=>canonical(a)===canonical(b);
const digest=(binding:string,normalized:string)=>createHash('sha256').update(binding+':'+normalized).digest('hex');
function normalizedIdentity(input:ReplyStoreInput,payload:Row|null,auth?:AuthenticatedContinuation):string {
  const metadata=payload?.continuation??null;
  if(metadata===null&&!auth)return input.normalized_input;
  if(!auth||metadata===null||!same(metadata,auth.continuation))reject();
  const ref=auth!.continuation_reference;
  if(ref===null) {if(metadata.candidate_id!=null||metadata.version_id!=null)reject();}
  else if(ref.candidate_id!==metadata.candidate_id||ref.version_id!==metadata.version_id||ref.candidate_id!==input.continued_from_candidate_id)reject();
  return canonical({reply:input.normalized_input,continuation:auth!.continuation});
}
function basisPayload(b:ReplyContinuationBasis):Row {return {candidate_id:b.candidate_id,basis_revision_sha256:b.basis_revision_sha256,basis_changes:b.basis_changes};}
export class ReplyAssistantGuards {
  private readonly ports:ReplyAssistantPorts;
  constructor(ports:ReplyAssistantPorts) {
    for(const key of ['requireReplySourcesCurrent','requireDependencies','registeredNavigationDependencies','requireCurrentReplyMemory','requireGenerationMemoryDependencies','historicalBasisRevision','readReplyBasisChanges','requireSavedSkillPolicy','requireActiveBinding','navigationDependencyIds'] as const)if(typeof ports?.[key]!=='function')throw new ReplyStoreError('reply_guards_unavailable');
    this.ports=ports;
  }
  async prepareAssistantReplyStart(client:pg.Client,input:ReplyStoreInput,auth?:AuthenticatedContinuation):Promise<void> {
    const turn=(await client.query('SELECT conversation_binding_id,input_digest,input_payload,state FROM assistant_session_turn WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3 FOR SHARE',[input.owner_id,input.contact_id,input.idempotency_key])).rows[0];
    if(turn?.state==='redacted')reject();
    const normalized=normalizedIdentity(input,turn?.input_payload??null,auth);
    if(turn&&(turn.conversation_binding_id!==input.conversation_binding_id||turn.input_digest!==digest(input.conversation_binding_id,normalized)))throw new ReplyStoreError('reply_input_conflict');
  }
  private async replyDependencies(client:pg.Client,scope:AssistantScope,requestId:string):Promise<string[]> {
    return generationDependencies(client,scope.owner_id,scope.contact_id,{turn_dependencies:[],reply_request_id:requestId});
  }
  async readContinuationBasis(client:pg.Client,scope:AssistantScope,binding:string,candidateId:string):Promise<ReplyContinuationBasis> {
    const row=(await client.query('SELECT id,candidate_text,reply_request_id FROM reply_candidate WHERE id=$1 AND owner_id=$2 AND contact_id=$3 AND conversation_binding_id=$4',[candidateId,scope.owner_id,scope.contact_id,binding])).rows[0];
    if(!row)reject();
    await this.ports.requireReplySourcesCurrent(client,scope,row.reply_request_id,true);
    await this.ports.requireSavedSkillPolicy(client,scope,row.reply_request_id);
    const dependencies=await this.replyDependencies(client,scope,row.reply_request_id);
    await this.ports.requireGenerationMemoryDependencies(client,scope,dependencies);
    return {candidate_id:row.id,scope,conversation_binding_id:binding,text:row.candidate_text,basis_changes:await this.ports.readReplyBasisChanges(client,scope,row.reply_request_id),basis_revision_sha256:await this.ports.historicalBasisRevision(client,scope,dependencies)};
  }
  async captureContinuationBasis(client:pg.Client,request:ReplyStoreRequest):Promise<ReplyContinuationBasis|null> {
    if(request.continued_from_candidate_id===null)return null;
    const basis=await this.readContinuationBasis(client,scopeOf(request),request.conversation_binding_id,request.continued_from_candidate_id);
    await client.query('UPDATE reply_request SET context_snapshot=$4 WHERE id=$1 AND owner_id=$2 AND contact_id=$3',[request.request_id,request.owner_id,request.contact_id,JSON.stringify({continuation_basis:basisPayload(basis)})]);
    return basis;
  }
  async requireContinuationBasis(client:pg.Client,request:ReplyStoreRequest,context:ReplyAssistantContext):Promise<Record<string,unknown>> {
    const row=(await client.query('SELECT context_snapshot FROM reply_request WHERE id=$1 AND owner_id=$2 AND contact_id=$3',[request.request_id,request.owner_id,request.contact_id])).rows[0];
    if(!row)reject();const captured=row.context_snapshot?.continuation_basis??null;
    if(request.continued_from_candidate_id===null){if(captured!==null||context.continuation_basis!=null)reject();return {};}
    const current=await this.readContinuationBasis(client,scopeOf(request),request.conversation_binding_id,request.continued_from_candidate_id);
    if(!same(captured,basisPayload(current)))reject();
    const basis=context.continuation_basis;
    if(basis&&(!same(basis.scope,current.scope)||basis.conversation_binding_id!==current.conversation_binding_id||basis.text!==current.text||!same(basisPayload(basis),captured)))reject();
    await this.ports.requireCurrentReplyMemory(client,scopeOf(request),context.evidence);
    return {continuation_basis:captured};
  }
  private async currentInput(client:pg.Client,scope:AssistantScope,session:string,input:string):Promise<Row> {
    const row=(await client.query(`SELECT i.*,t.state AS turn_state,t.dependency_ids AS turn_dependencies,t.reply_request_id,t.idempotency_key FROM assistant_session s JOIN assistant_session_input i ON i.id=s.current_input_version_id AND i.owner_id=s.owner_id AND i.contact_id=s.contact_id AND i.session_id=s.id LEFT JOIN assistant_session_turn t ON t.id=i.turn_id AND t.input_version_id=i.id AND t.owner_id=i.owner_id AND t.contact_id=i.contact_id AND t.session_id=i.session_id WHERE s.id=$1 AND s.owner_id=$2 AND s.contact_id=$3 AND i.id=$4 FOR SHARE OF s,i`,[session,scope.owner_id,scope.contact_id,input])).rows[0];
    if(!row||row.state!=='active'||row.conversation_binding_id!==await this.ports.requireActiveBinding(client,scope))reject();
    if(row.input_type==='generation'&&!['running','failed','completed'].includes(row.turn_state))reject();
    const dependencies=new Set<string>(row.input_type==='generation'?row.turn_dependencies??[]:row.dependency_ids);
    await this.ports.requireDependencies(client,scope,unique(dependencies),row.input_type==='generation');
    if(row.input_type==='generation') {
      const actual=(await client.query('SELECT id,conversation_binding_id FROM reply_request WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3',[scope.owner_id,scope.contact_id,row.idempotency_key])).rows[0];
      if(!actual&&row.reply_request_id!==null||actual&&(actual.conversation_binding_id!==row.conversation_binding_id||row.reply_request_id!==null&&actual.id!==row.reply_request_id))reject();
      if(row.turn_state==='completed'&&!actual)reject();
      if(actual) {
        for(const d of await this.ports.requireReplySourcesCurrent(client,scope,actual.id,true))dependencies.add(d);
        for(const d of await this.replyDependencies(client,scope,actual.id))dependencies.add(d);
        for(const d of await this.requireReplyDiscussionById(client,scope,actual.id)??[])dependencies.add(d);
      }
    } else if(row.input_type==='candidate_carry')await this.requireCarry(client,scope,row);
    await this.ports.requireGenerationMemoryDependencies(client,scope,unique(dependencies));
    return row;
  }
  private async captureOriginalDependencies(client:pg.Client,scope:AssistantScope,refs:string[],contactScoped:boolean):Promise<string[]> {
    const expanded=new Set(refs);
    const raw=(await client.query(`SELECT coalesce(ref.source_document_id,ref.observation_id) AS id FROM message_source_ref ref WHERE ref.owner_id=$1 AND ref.message_id=ANY($2::uuid[]) AND (EXISTS(SELECT 1 FROM local_wechat_observation observation WHERE observation.id=ref.observation_id AND observation.owner_id=ref.owner_id AND observation.contact_id=ref.contact_id) OR EXISTS(SELECT 1 FROM source_document source WHERE source.id=ref.source_document_id AND source.owner_id=ref.owner_id AND source.contact_id=ref.contact_id AND source.status='active'))`,[scope.owner_id,refs])).rows;
    for(const row of raw)expanded.add(row.id);
    const sources=unique(expanded);
    const found=(await client.query(`SELECT id FROM source_document WHERE owner_id=$1 AND id=ANY($3::uuid[]) AND status='active' AND (NOT $4 OR contact_id=$2) UNION SELECT id FROM local_wechat_observation WHERE owner_id=$1 AND id=ANY($3::uuid[]) AND (NOT $4 OR contact_id=$2) UNION SELECT id FROM message WHERE owner_id=$1 AND id=ANY($3::uuid[]) AND (NOT $4 OR contact_id=$2) AND ${activeMessage}`,[scope.owner_id,scope.contact_id,sources,contactScoped])).rows.map(r=>r.id);
    if(!same(unique(found),sources))reject();return sources;
  }
  async verifiedDiscussionDependencies(client:pg.Client,scope:AssistantScope,dependencies:string[],historical:boolean):Promise<string[]> {
    const registered=new Set(await this.ports.registeredNavigationDependencies(client,scope));
    const navigation=dependencies.filter(id=>registered.has(id)),declared=unique(dependencies.filter(id=>!registered.has(id)));
    await this.ports.requireDependencies(client,scope,navigation,historical);
    if(declared.includes(scope.owner_id))reject();if(!declared.length)return navigation;
    const args=[scope.owner_id,scope.contact_id,declared,historical];
    const rows=(await client.query(`SELECT id,'original' AS kind FROM source_document WHERE owner_id=$1 AND contact_id=$2 AND status='active' AND id=ANY($3::uuid[])
      UNION SELECT id,'original' FROM local_wechat_observation WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[])
      UNION SELECT id,'original' FROM message WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[]) AND ${activeMessage}
      UNION SELECT id,'memory' FROM confirmed_memory WHERE owner_id=$1 AND contact_id=$2 AND(status='active' OR $4 AND status='invalidated') AND id=ANY($3::uuid[]) AND($4 OR(valid_at IS NULL OR valid_at<=now())AND(invalid_at IS NULL OR now()<invalid_at))
      UNION SELECT id,'memory' FROM memory_candidate WHERE owner_id=$1 AND contact_id=$2 AND(status IN('pending','confirmed') OR $4 AND status IN('rejected','invalidated')) AND id=ANY($3::uuid[]) AND($4 OR(valid_at IS NULL OR valid_at<=now())AND(invalid_at IS NULL OR now()<invalid_at))`,args)).rows;
    const allowed=new Set<string>(rows.map(r=>r.id)),ownerRefs=new Set<string>();
    const own=(await client.query("SELECT id,source_ids FROM owner_memory WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND(status='active' OR $3 AND status='invalidated') AND($3 OR(valid_at IS NULL OR valid_at<=now())AND(invalid_at IS NULL OR now()<invalid_at))",[scope.owner_id,declared,historical])).rows;
    for(const m of own){allowed.add(m.id);for(const source of await evidenceSources(client,scope.owner_id,{evidence_id:m.id,kind:'owner_memory',source_ids:m.source_ids},true))ownerRefs.add(source);}
    const ownerSources=await this.captureOriginalDependencies(client,scope,unique(ownerRefs),false);
    for(const source of ownerSources)allowed.add(source);if(declared.some(id=>!allowed.has(id)))reject();
    const memories=(await client.query(`SELECT source_ids,adoption_method FROM confirmed_memory WHERE owner_id=$1 AND contact_id=$2 AND(status='active' OR $4 AND status='invalidated') AND id=ANY($3::uuid[]) AND($4 OR(valid_at IS NULL OR valid_at<=now())AND(invalid_at IS NULL OR now()<invalid_at)) UNION ALL SELECT source_ids,'auto' FROM memory_candidate WHERE owner_id=$1 AND contact_id=$2 AND(status IN('pending','confirmed') OR $4 AND status IN('rejected','invalidated')) AND id=ANY($3::uuid[]) AND($4 OR(valid_at IS NULL OR valid_at<=now())AND(invalid_at IS NULL OR now()<invalid_at))`,args)).rows;
    const refs=new Set<string>(rows.filter(r=>r.kind==='original').map(r=>r.id));
    for(const memory of memories)for(const source of memory.source_ids)if(memory.adoption_method!=='manual'||source!==scope.contact_id)refs.add(source);
    const contactSources=await this.captureOriginalDependencies(client,scope,unique(refs),true);
    const captured=unique([...declared,...ownerSources,...contactSources,...navigation]);await this.ports.requireDependencies(client,scope,captured,historical);return captured;
  }
  private async requireCarry(client:pg.Client,scope:AssistantScope,row:Row):Promise<void> {
    const edge=(await carryEdges(client,scope.owner_id,row.id)).find(e=>e.child===row.id);if(!edge)reject();
    const p=row.content;
    const turn=(await client.query("SELECT conversation_binding_id,input_version_id,dependency_ids FROM assistant_session_turn WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND id=$4 AND reply_request_id=$5 AND state='completed'",[scope.owner_id,scope.contact_id,p.origin_session_id,p.origin_turn_id,p.origin_reply_request_id])).rows[0];
    if(!turn||turn.conversation_binding_id!==row.conversation_binding_id||turn.input_version_id!==p.origin_input_version_id)reject();
    await this.ports.requireSavedSkillPolicy(client,scope,p.origin_reply_request_id);
    const deps=unique([...turn.dependency_ids,...await this.ports.requireReplySourcesCurrent(client,scope,p.origin_reply_request_id,true),...await this.replyDependencies(client,scope,p.origin_reply_request_id)]);
    await this.ports.requireGenerationMemoryDependencies(client,scope,deps);
    const verified=await this.verifiedDiscussionDependencies(client,scope,deps,true);
    if(!same(unique(verified),unique(row.dependency_ids)))reject();
  }
  async requireReplyDiscussionById(client:pg.Client,scope:AssistantScope,requestId:string):Promise<string[]|null> {
    const row=(await client.query('SELECT * FROM reply_request WHERE id=$1 AND owner_id=$2 AND contact_id=$3',[requestId,scope.owner_id,scope.contact_id])).rows[0];if(!row)reject();
    return this.requireReplyDiscussion(client,{...row,request_id:row.id,lease_expires_at:new Date(row.lease_expires_at)},null,false);
  }
  private async discussion(client:pg.Client,request:ReplyStoreRequest,snap:Row,current:boolean):Promise<string[]> {
    return ensureReplyValidationScope(client,request,()=>this.discussionScoped(client,request,snap,current));
  }
  private async discussionScoped(client:pg.Client,request:ReplyStoreRequest,snap:Row,current:boolean):Promise<string[]> {
    const scope=scopeOf(request);snapshot(snap,scope.owner_id,scope.contact_id,request.idempotency_key);
    // 完整的已捕获身份复验和原指纹，不将存在性当来源资格。
    await capturedEdges(client,request.owner_id,request.request_id,snap);
    const anchor=(await client.query(anchorSql.replace('turn.input_payload,','turn.input_payload::text AS input_payload_text,'),[request.owner_id,request.contact_id,request.idempotency_key])).rows[0];
    if(!anchor||anchor.anchor_input_state!=='active'||!['running','failed','completed'].includes(anchor.state)||anchor.input_payload_text===null)reject();
    if(current)await this.currentInput(client,scope,snap.session_id,snap.current_input_version_id);
    else await this.ports.requireDependencies(client,scope,anchor.dependency_ids,true);
    const rows=new Map((await inputRows(client,request.owner_id,request.contact_id,snap.session_id)).map(r=>[r.id,r]));
    const dependencies=new Set<string>();
    for(const identity of snap.records) {
      const row=rows.get(identity.input_version_id);if(!row)reject();
      if(identity.kind==='discussion_input') {
        await this.verifiedDiscussionDependencies(client,scope,row!.dependency_ids,false);
        if(row!.input_type==='candidate_carry')await this.requireCarry(client,scope,row!);
        for(const dep of row!.dependency_ids)dependencies.add(dep);
      } else {
        await this.ports.requireDependencies(client,scope,row!.turn_dependencies??[],true);
        if(row!.reply_request_id){await this.ports.requireReplySourcesCurrent(client,scope,row!.reply_request_id,true);if(current)await this.ports.requireSavedSkillPolicy(client,scope,row!.reply_request_id);}
        for(const dep of await generationDependencies(client,request.owner_id,request.contact_id,row!))dependencies.add(dep);
        if(identity.kind==='candidate_version') {
          const invalid=(await client.query('SELECT 1 FROM reply_invalidated_key invalidated JOIN reply_request request ON request.owner_id=invalidated.owner_id AND request.contact_id=invalidated.contact_id AND request.idempotency_key=invalidated.idempotency_key WHERE request.id=$1 AND request.owner_id=$2 AND request.contact_id=$3',[row!.reply_request_id,scope.owner_id,scope.contact_id])).rowCount;
          if(invalid)reject();
          await this.ports.requireSavedSkillPolicy(client,scope,row!.reply_request_id);
        }
      }
    }
    const ids=unique(dependencies);
    if(current){await this.ports.requireGenerationMemoryDependencies(client,scope,ids);if(snap.basis_revision_sha256==null&&ids.length||snap.basis_revision_sha256!=null&&snap.basis_revision_sha256!==await this.ports.historicalBasisRevision(client,scope,ids))reject();}
    return ids;
  }
  private async rawSources(client:pg.Client,scope:AssistantScope,ids:string[]):Promise<string[]> {
    return (await client.query('SELECT id FROM source_document WHERE owner_id=$1 AND id=ANY($2::uuid[]) UNION SELECT id FROM local_wechat_observation WHERE owner_id=$1 AND id=ANY($2::uuid[])',[scope.owner_id,ids])).rows.map(r=>r.id);
  }
  async captureReplyDiscussion(client:pg.Client,request:ReplyStoreRequest,snap:Record<string,unknown>|null):Promise<string[]|null> {
    const row=(await client.query('SELECT context_snapshot FROM reply_request WHERE id=$1 AND owner_id=$2 AND contact_id=$3',[request.request_id,request.owner_id,request.contact_id])).rows[0];if(!row)reject();
    const existing=row.context_snapshot?.assistant_discussion_snapshot??null;
    if(snap===null){if(existing!==null)reject();return null;}
    if(existing!==null&&!same(existing,snap))reject();
    const deps=await this.discussion(client,request,snap,true);
    await client.query('UPDATE reply_request SET context_snapshot=$2 WHERE id=$1',[request.request_id,JSON.stringify({...row.context_snapshot,assistant_discussion_snapshot:snap})]);
    for(const source of await this.rawSources(client,scopeOf(request),deps))await client.query('INSERT INTO reply_original_source_use(reply_request_id,source_id,owner_id,contact_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[request.request_id,source,request.owner_id,request.contact_id]);
    return deps;
  }
  async requireReplyDiscussion(client:pg.Client,request:ReplyStoreRequest,snap:Record<string,unknown>|null,current:boolean):Promise<string[]|null> {
    const row=(await client.query('SELECT context_snapshot FROM reply_request WHERE id=$1 AND owner_id=$2 AND contact_id=$3',[request.request_id,request.owner_id,request.contact_id])).rows[0];if(!row)reject();
    const saved=row.context_snapshot?.assistant_discussion_snapshot??null;
    if(saved===null){if(snap!==null)reject();return null;}
    if((current||snap!==null)&&!same(saved,snap))reject();
    const deps=await this.discussion(client,request,saved,current);
    const used=new Set((await client.query('SELECT source_id FROM reply_original_source_use WHERE reply_request_id=$1 AND owner_id=$2 AND contact_id=$3',[request.request_id,request.owner_id,request.contact_id])).rows.map(r=>r.source_id));
    if((await this.rawSources(client,scopeOf(request),deps)).some(id=>!used.has(id)))reject();return deps;
  }
  async prepareAssistantReplyCommit(client:pg.Client,request:ReplyStoreRequest,context:ReplyAssistantContext,auth?:AuthenticatedContinuation):Promise<void> {
    const turn=(await client.query('SELECT * FROM assistant_session_turn WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3 FOR UPDATE',[request.owner_id,request.contact_id,request.idempotency_key])).rows[0];if(!turn)return;
    if(turn.state==='redacted')reject();const scope=scopeOf(request),binding=await this.ports.requireActiveBinding(client,scope);
    if(binding!==request.conversation_binding_id||turn.conversation_binding_id!==binding||turn.input_digest!==digest(binding,normalizedIdentity(request,turn.input_payload,auth)))reject();
    await this.currentInput(client,scope,turn.session_id,turn.input_version_id);
    const deps=new Set<string>([...turn.dependency_ids,...this.ports.navigationDependencyIds(context)]);
    for(const r of (await client.query('SELECT source_id FROM reply_original_source_use WHERE owner_id=$1 AND reply_request_id=$2',[request.owner_id,request.request_id])).rows)deps.add(r.source_id);
    await this.ports.requireCurrentReplyMemory(client,scope,context.evidence);
    const current=new Set<string>(),historical=new Set<string>();
    for(const evidence of context.evidence as Row[]) {
      const target=evidence.navigation&&evidence.timing?.current_status==='historical'?historical:current;
      for(const source of await evidenceSources(client,request.owner_id,evidence))target.add(source);
      if(!['user_draft','user_current_chat','user_purpose','continued_candidate'].includes(evidence.kind))target.add(evidence.evidence_id);
    }
    await this.ports.requireDependencies(client,scope,unique(current),false);await this.ports.requireDependencies(client,scope,unique(historical),true);
    for(const d of [...current,...historical])deps.add(d);
    if(request.continued_from_candidate_id){const previous=(await client.query('SELECT reply_request_id FROM reply_candidate WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[request.owner_id,request.contact_id,request.continued_from_candidate_id])).rows[0];if(!previous)reject();for(const d of await this.replyDependencies(client,scope,previous.reply_request_id))deps.add(d);}
    await this.ports.requireDependencies(client,scope,unique(deps),true);
    await client.query('UPDATE assistant_session_turn SET reply_request_id=$2,dependency_ids=$3,updated_at=now() WHERE id=$1',[turn.id,request.request_id,unique(deps)]);
  }
}
