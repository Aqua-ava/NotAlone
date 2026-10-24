/** 原 PostgreSQL 回复表适配器；不调用 DSH、Python 或模型。所有资格检查在同一 owner 锁事务内执行。 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {parseJson,stringifyJson} from './host-json.ts';

export class ReplyStoreError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = 'ReplyStoreError'; }
}
export interface ReplyStoreInput {
  owner_id: string; contact_id: string; conversation_binding_id: string;
  idempotency_key: string; normalized_input: string; continued_from_candidate_id: string | null;
}
export interface ReplyStoreRequest extends ReplyStoreInput {
  request_id: string; attempt: number; lease_expires_at: Date;
}
export interface ReplyStoreEvidence {
  evidence_id: string; kind: string; text: string; source_ids: string[]; selection_reason: string;
  status: string; valid_at?: string | null; invalid_at?: string | null; revision?: number | null;
}
export interface ReplyStoreContext {
  evidence: ReplyStoreEvidence[]; snapshot: Record<string, unknown>; skill_library_revision: number;
}
export interface ReplyStoreCandidate {
  candidate_id: string; text: string; basis: string; citation_ids: string[]; risk_notes: string[];
  messages: {message_id: string; text: string}[];
}
export interface ReplyStoreResult {
  reply_request_id: string; candidates: ReplyStoreCandidate[]; context_snapshot: Record<string, unknown>;
  skill_library_revision: number; used_skill: Record<string, unknown> | null;
}
/** 实现端口必须复验来源、讨论、续写、记忆、偏好和 Skill 的版本；禁止缺省成功。 */
export interface ReplyStoreGuards {
  start(client: pg.Client, input: ReplyStoreInput): Promise<void>;
  started(client: pg.Client, request: ReplyStoreRequest): Promise<void>;
  prepare(client: pg.Client, request: ReplyStoreRequest, context: ReplyStoreContext): Promise<void>;
  commit(client: pg.Client, request: ReplyStoreRequest, context: ReplyStoreContext, used_skill: Record<string, unknown> | null): Promise<void>;
  replay(client: pg.Client, request: ReplyStoreRequest): Promise<void>;
}
export interface ReplyStoreOptions {
  transaction<T>(fn: (client: pg.Client) => Promise<T>): Promise<T>;
  guards: ReplyStoreGuards; clock?: () => Date; leaseMs?: number;
}
type Row = Record<string, any>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new ReplyStoreError('reply_input_invalid');
}
function requestOf(row: Row): ReplyStoreRequest {
  return {request_id: row.id, owner_id: row.owner_id, contact_id: row.contact_id,
    conversation_binding_id: row.conversation_binding_id, idempotency_key: row.idempotency_key,
    normalized_input: row.normalized_input, continued_from_candidate_id: row.continued_from_candidate_id,
    attempt: row.attempt, lease_expires_at: new Date(row.lease_expires_at)};
}
function matches(row: Row, request: ReplyStoreRequest): boolean {
  const stored = requestOf(row);
  return Object.keys(stored).every(key => key === 'lease_expires_at'
    ? stored.lease_expires_at.getTime() === request.lease_expires_at.getTime()
    : stored[key as keyof ReplyStoreRequest] === request[key as keyof ReplyStoreRequest]);
}
export class PostgresReplyStore {
  private readonly options: ReplyStoreOptions;
  private readonly clock: () => Date;
  private readonly leaseMs: number;
  constructor(options: ReplyStoreOptions) {
    if (!options.guards || ['start','started','prepare','commit','replay'].some(k=> typeof options.guards[k as keyof ReplyStoreGuards] !== 'function')) throw new ReplyStoreError('reply_guards_unavailable');
    this.options=options; this.clock=options.clock ?? (()=>new Date()); this.leaseMs=options.leaseMs ?? 30000;
    if (!Number.isFinite(this.leaseMs) || this.leaseMs<=0) throw new ReplyStoreError('reply_input_invalid');
  }
  private async transaction<T>(owner: string, fn: (client: pg.Client)=>Promise<T>): Promise<T> {
    requireUuid(owner);
    return this.options.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
      return fn(client);
    });
  }

  private async invalidated(client: pg.Client, input: ReplyStoreInput): Promise<void> {
    if ((await client.query('SELECT 1 FROM reply_invalidated_key WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3',[input.owner_id,input.contact_id,input.idempotency_key])).rowCount) throw new ReplyStoreError('reply_input_invalidated');
  }
  async start(input: ReplyStoreInput): Promise<{state:'started'|'in_progress'|'replayed';request:ReplyStoreRequest;result?:ReplyStoreResult}> {
    for(const value of [input.owner_id,input.contact_id,input.conversation_binding_id,input.idempotency_key]) requireUuid(value);
    if(input.continued_from_candidate_id!==null) requireUuid(input.continued_from_candidate_id);
    if(typeof input.normalized_input!=='string'||!input.normalized_input.trim()) throw new ReplyStoreError('reply_input_invalid');
    return this.transaction(input.owner_id,async client=>{
      await this.options.guards.start(client,input); await this.invalidated(client,input);
      let row=(await client.query('SELECT * FROM reply_request WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3 FOR UPDATE',[input.owner_id,input.contact_id,input.idempotency_key])).rows[0];
      const now=this.clock(), lease=new Date(now.getTime()+this.leaseMs);
      if(row) {
        if(row.normalized_input!==input.normalized_input || row.continued_from_candidate_id!==input.continued_from_candidate_id) throw new ReplyStoreError('reply_input_conflict');
        const request=requestOf(row);
        if(row.state==='completed') {await this.options.guards.replay(client,request);return {state:'replayed',request,result:await this.readResult(client,row)};}
        if(row.state==='running' && now<request.lease_expires_at) return {state:'in_progress',request};
        if(row.state==='running') await client.query("UPDATE reply_attempt SET state='expired',failure_reason='lease_expired' WHERE reply_request_id=$1 AND number=$2 AND state='running'",[row.id,row.attempt]);
        await client.query('DELETE FROM reply_candidate WHERE reply_request_id=$1',[row.id]);
        await client.query('DELETE FROM reply_context_evidence WHERE reply_request_id=$1',[row.id]);
        row=(await client.query("UPDATE reply_request SET state='running',attempt=attempt+1,lease_expires_at=$2,context_snapshot=NULL,skill_library_revision=NULL,skill_id=NULL,skill_version_id=NULL,skill_name=NULL,skill_selection_method=NULL,skill_selection_reason=NULL,skill_load_state=NULL,skill_loaded_resources=NULL,updated_at=now() WHERE id=$1 RETURNING *",[row.id,lease])).rows[0];
      } else {
        row=(await client.query("INSERT INTO reply_request(id,owner_id,contact_id,conversation_binding_id,idempotency_key,normalized_input,state,attempt,lease_expires_at,continued_from_candidate_id) VALUES($1,$2,$3,$4,$5,$6,'running',1,$7,$8) RETURNING *",[randomUUID(),input.owner_id,input.contact_id,input.conversation_binding_id,input.idempotency_key,input.normalized_input,lease,input.continued_from_candidate_id])).rows[0];
      }
      await client.query("INSERT INTO reply_attempt(reply_request_id,number,state,started_at,lease_expires_at) VALUES($1,$2,'running',$3,$4)",[row.id,row.attempt,now,lease]);
      const request=requestOf(row);
      await this.options.guards.started(client,request);
      return {state:'started',request};
    });
  }
  private async current(client: pg.Client, request: ReplyStoreRequest, completed=false): Promise<Row> {
    await this.invalidated(client,request);
    const row=(await client.query('SELECT r.*,a.state AS attempt_state,a.lease_expires_at AS attempt_lease FROM reply_request r JOIN reply_attempt a ON a.reply_request_id=r.id AND a.number=r.attempt WHERE r.id=$1 AND r.owner_id=$2 AND r.contact_id=$3 FOR UPDATE OF r,a',[request.request_id,request.owner_id,request.contact_id])).rows[0];
    if(!row || !matches(row,request)) throw new ReplyStoreError('reply_request_expired');
    if(completed && row.state==='completed' && row.attempt_state==='completed') return row;
    if(row.state!=='running'||row.attempt_state!=='running'||new Date(row.attempt_lease).getTime()!==request.lease_expires_at.getTime()||this.clock()>=request.lease_expires_at) throw new ReplyStoreError('reply_request_expired');
    return row;
  }
  async requireCurrent(request: ReplyStoreRequest): Promise<void> {
    await this.transaction(request.owner_id,async client=>{await this.current(client,request);});
  }
  /** prepare/Tool复验复用调用方事务；不开始/提交事务，也不借另一连接读租约。 */
  async requireCurrentInTransaction(client:pg.Client,request:ReplyStoreRequest):Promise<void>{
    requireUuid(request.owner_id);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${request.owner_id}`]);
    await this.current(client,request);
  }
  async prepareContext(request: ReplyStoreRequest, context: ReplyStoreContext): Promise<void> {
    await this.transaction(request.owner_id,async client=>{
      await this.current(client,request);
      await this.options.guards.prepare(client,request,context);
    });
  }
  async save(request: ReplyStoreRequest, context: ReplyStoreContext, candidates: ReplyStoreCandidate[], used_skill: Record<string, unknown> | null = null, signal?:AbortSignal): Promise<ReplyStoreResult> {
    return this.transaction(request.owner_id,async client=>{
      signal?.throwIfAborted();
      const row=await this.current(client,request,true);
      if(row.state==='completed') { await this.options.guards.replay(client,request); return this.readResult(client,row); }
      this.validateCandidates(context,candidates);
      this.validateSkill(used_skill);
      await this.options.guards.commit(client,request,context,used_skill);
      signal?.throwIfAborted();
      const completedSnapshot={...context.snapshot,...used_skill?{
        skill_version_number:used_skill.version_number??null,
        skill_runtime_scope:{kind:used_skill.scope_kind??'owner',contact_id:used_skill.scope_contact_id??null,scene:used_skill.scope_scene??null},
        ...used_skill.execution_view?{skill_execution_view:used_skill.execution_view}:{},
      }:{}};
      await this.current(client,request);
      for(const [ordinal,e] of context.evidence.entries()) {
        await client.query(`INSERT INTO reply_context_evidence(reply_request_id,evidence_id,owner_id,contact_id,conversation_binding_id,ordinal,kind,evidence_text,source_ids,selection_reason,evidence_status,evidence_valid_at,evidence_invalid_at,evidence_revision)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[request.request_id,e.evidence_id,request.owner_id,request.contact_id,request.conversation_binding_id,ordinal,e.kind,e.text,JSON.stringify(e.source_ids),e.selection_reason,e.status,e.valid_at??null,e.invalid_at??null,e.revision??null]);
      }
      for(const [ordinal,c] of candidates.entries()) {
        await client.query(`INSERT INTO reply_candidate(id,reply_request_id,owner_id,contact_id,conversation_binding_id,ordinal,candidate_text,basis,risk_notes,message_group)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[c.candidate_id,request.request_id,request.owner_id,request.contact_id,request.conversation_binding_id,ordinal,c.text,c.basis,JSON.stringify(c.risk_notes),JSON.stringify(c.messages)]);
        for(const [position,id] of c.citation_ids.entries()) await client.query('INSERT INTO reply_candidate_citation(reply_request_id,candidate_id,evidence_id,ordinal) VALUES($1,$2,$3,$4)',[request.request_id,c.candidate_id,id,position]);
      }
      const s=used_skill;
      signal?.throwIfAborted();
      const completed=(await client.query(`UPDATE reply_request SET state='completed',context_snapshot=$2,skill_library_revision=$3,
        skill_id=$4,skill_version_id=$5,skill_name=$6,skill_selection_method=$7,skill_selection_reason=$8,skill_load_state=$9,skill_loaded_resources=$10,updated_at=now() WHERE id=$1 RETURNING *`,
        [request.request_id,stringifyJson(completedSnapshot),context.skill_library_revision,s?.skill_id??null,s?.version_id??null,s?.name??null,s?.selection_method??null,s?.selection_reason??null,s?.load_state??null,s?JSON.stringify(s.resource_paths??[]):null])).rows[0];
      await client.query("UPDATE reply_attempt SET state='completed',failure_reason=NULL WHERE reply_request_id=$1 AND number=$2",[request.request_id,request.attempt]);
      const result=await this.readResult(client,completed);
      signal?.throwIfAborted();
      return result;
    });
  }
  private validateSkill(skill: Record<string, unknown> | null): void {
    if (skill === null) return;
    if (typeof skill !== 'object' || !uuid.test(String(skill.skill_id)) || !uuid.test(String(skill.version_id))
      || typeof skill.name !== 'string' || !skill.name.trim()
      || !['auto','user'].includes(String(skill.selection_method))
      || typeof skill.selection_reason !== 'string' || !skill.selection_reason.trim()
      || !['loaded','resource_failed'].includes(String(skill.load_state))
      || !Array.isArray(skill.resource_paths) || skill.resource_paths.some(x=>typeof x!=='string'||!x.trim())) {
      throw new ReplyStoreError('reply_candidates_rejected');
    }
    if(skill.execution_view!==undefined&&skill.execution_view!==null){
      const view=skill.execution_view as Record<string,unknown>;
      if(typeof view!=='object'||Array.isArray(view)||Object.keys(view).sort().join(',')!=='method_ids,policy_revision,sha256'
        ||!Number.isSafeInteger(view.policy_revision)||Number(view.policy_revision)<0||typeof view.sha256!=='string'||!/^[a-f0-9]{64}$/.test(view.sha256)
        ||!Array.isArray(view.method_ids)||new Set(view.method_ids).size!==view.method_ids.length||view.method_ids.some(id=>typeof id!=='string'||!uuid.test(id)))throw new ReplyStoreError('reply_candidates_rejected');
    }
  }
  private validateCandidates(context: ReplyStoreContext, candidates: ReplyStoreCandidate[]): void {
    const reject=()=>{throw new ReplyStoreError('reply_candidates_rejected');};
    if(!Array.isArray(context.evidence)||!Number.isInteger(context.skill_library_revision)||context.skill_library_revision<0||!context.snapshot||typeof context.snapshot!=='object'||Array.isArray(context.snapshot)) reject();
    const evidence=new Set<string>();
    for(const e of context.evidence) {requireUuid(e.evidence_id);if(evidence.has(e.evidence_id)||!e.text?.trim()) reject();evidence.add(e.evidence_id);for(const id of e.source_ids) requireUuid(id);}
    if(!Array.isArray(candidates)||candidates.length<1||candidates.length>3) reject();
    const ids=new Set<string>();
    for(const c of candidates) {
      requireUuid(c.candidate_id);
      if(ids.has(c.candidate_id)||!c.text?.trim()||!c.basis?.trim()||!Array.isArray(c.citation_ids)||c.citation_ids.length===0||c.citation_ids.some(id=>!evidence.has(id))||!Array.isArray(c.risk_notes)||c.risk_notes.some(x=>typeof x!=='string'||!x.trim())) reject();
      ids.add(c.candidate_id);
      if(!Array.isArray(c.messages)||c.messages.length<1||c.messages.length>8||c.messages.map(m=>m.text).join('\n\n')!==c.text||new Set(c.messages.map(m=>m.message_id)).size!==c.messages.length) reject();
      for(const m of c.messages) {requireUuid(m.message_id);if(typeof m.text!=='string'||!m.text.trim()) reject();}
    }
  }
  async fail(request: ReplyStoreRequest, reason: string): Promise<void> {
    const safe=/^[a-z][a-z0-9_]{0,63}$/.test(reason)?reason:'reply_failed';
    await this.transaction(request.owner_id,async client=>{
      const row=(await client.query('SELECT * FROM reply_request WHERE id=$1 AND owner_id=$2 AND contact_id=$3 FOR UPDATE',[request.request_id,request.owner_id,request.contact_id])).rows[0];
      if(!row||!matches(row,request)||row.state!=='running') return;
      await client.query("UPDATE reply_request SET state='failed',updated_at=now() WHERE id=$1",[request.request_id]);
      await client.query("UPDATE reply_attempt SET state='failed',failure_reason=$3 WHERE reply_request_id=$1 AND number=$2 AND state='running'",[request.request_id,request.attempt,safe]);
    });
  }
  async read(request_id: string, scope: {owner_id:string;contact_id:string}): Promise<{state:string;request:ReplyStoreRequest;result?:ReplyStoreResult;attempts:Row[]}> {
    requireUuid(request_id);requireUuid(scope.contact_id);
    return this.transaction(scope.owner_id,async client=>{
      const row=(await client.query('SELECT * FROM reply_request WHERE id=$1 AND owner_id=$2 AND contact_id=$3',[request_id,scope.owner_id,scope.contact_id])).rows[0];
      if(!row) throw new ReplyStoreError('reply_not_found');
      const request=requestOf(row);await this.invalidated(client,request);
      const attempts=(await client.query('SELECT number,state,started_at,lease_expires_at,failure_reason FROM reply_attempt WHERE reply_request_id=$1 ORDER BY number',[request_id])).rows;
      if(row.state==='completed') {await this.options.guards.replay(client,request);return {state:row.state,request,attempts,result:await this.readResult(client,row)};}
      return {state:row.state,request,attempts};
    });
  }
  private async readResult(client: pg.Client, row: Row): Promise<ReplyStoreResult> {
    // pg默认JSON解码会截断旧Python bigint；范围锁内重读原文保留偏好等修订号。
    const snapshot=(await client.query('SELECT context_snapshot::text AS text FROM reply_request WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[row.owner_id,row.contact_id,row.id])).rows[0]?.text;
    if(typeof snapshot!=='string')throw new ReplyStoreError('reply_candidates_rejected');
    row={...row,context_snapshot:parseJson(snapshot)};
    const candidates: ReplyStoreCandidate[]=[];
    const rows=(await client.query('SELECT * FROM reply_candidate WHERE reply_request_id=$1 ORDER BY ordinal',[row.id])).rows;
    for(const c of rows) {
      const refs=(await client.query('SELECT evidence_id FROM reply_candidate_citation WHERE reply_request_id=$1 AND candidate_id=$2 ORDER BY ordinal',[row.id,c.id])).rows;
      candidates.push({candidate_id:c.id,text:c.candidate_text,basis:c.basis,risk_notes:c.risk_notes,messages:c.message_group,citation_ids:refs.map(r=>r.evidence_id)});
    }
    const evidence=(await client.query('SELECT evidence_id,kind,evidence_text AS text,source_ids,selection_reason,evidence_status AS status FROM reply_context_evidence WHERE reply_request_id=$1 ORDER BY ordinal',[row.id])).rows as ReplyStoreEvidence[];
    this.validateCandidates({evidence,snapshot:row.context_snapshot,skill_library_revision:row.skill_library_revision},candidates);
    const used_skill=row.skill_id?{skill_id:row.skill_id,version_id:row.skill_version_id,name:row.skill_name,selection_method:row.skill_selection_method,selection_reason:row.skill_selection_reason,load_state:row.skill_load_state,resource_paths:row.skill_loaded_resources??[],
        version_number:row.context_snapshot?.skill_version_number??null,scope_kind:row.context_snapshot?.skill_runtime_scope?.kind??'owner',scope_contact_id:row.context_snapshot?.skill_runtime_scope?.contact_id??null,scope_scene:row.context_snapshot?.skill_runtime_scope?.scene??null,
        execution_view:row.context_snapshot?.skill_execution_view??null}:null;
    this.validateSkill(used_skill);
    return {reply_request_id:row.id,candidates,context_snapshot:row.context_snapshot,skill_library_revision:row.skill_library_revision,used_skill};
  }
}
