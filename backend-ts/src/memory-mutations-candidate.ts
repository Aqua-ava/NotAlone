import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { MemoryMutationError, ensureMemorySources, protectCandidate, recordMemoryDecision, type MemoryRow } from './memory-mutations-protection.ts';
import { eraseLayeredReplies, eraseRecordTraces } from './memory-mutations-erasure.ts';
import { candidateVersionEvidence, validateCandidateEvolution } from './memory-mutations-candidate-versions.ts';
import type { ErasurePorts } from './preference-erasure.ts';

type CandidateDependencies = {beforeErase?: () => Promise<void>; erasurePorts?: Partial<ErasurePorts>};

const conflict = (): never => { throw new MemoryMutationError(409,'候选、来源或资料版本已变化，请刷新后核对。'); };
const versionConflict = (): never => { throw new MemoryMutationError(409,'所选旧版已变化，请刷新后核对。','memory_version_changed'); };
const invalid = (): never => { throw new MemoryMutationError(400,'记忆操作参数无效。'); };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);

export function candidateActionBody(action: string, body: unknown): MemoryRow {
  // 原 discard 不读取正文，confirm 仅解析纠错决定；apply-update 才限制精确字段。
  if (action === 'discard') return {};
  if (body == null) body = {};
  if (typeof body !== 'object' || Array.isArray(body)) invalid();
  const value = body as MemoryRow;
  const fields = action === 'apply-update' ? ['previous_memory_id','expected_revision','correction_decision_ids']
    : action === 'confirm' ? ['correction_decision_ids'] : [];
  if (!['confirm','apply-update'].includes(action)
    || (action === 'apply-update' && Object.keys(value).some(key => !fields.includes(key)))) invalid();
  if (action === 'apply-update' && (!uuid(value.previous_memory_id) || !Number.isSafeInteger(value.expected_revision) || value.expected_revision < 1)) invalid();
  if (value.correction_decision_ids != null && (!Array.isArray(value.correction_decision_ids)
    || value.correction_decision_ids.some((id: unknown) => !uuid(id))
    || new Set(value.correction_decision_ids.map((id: string) => id.toLowerCase())).size !== value.correction_decision_ids.length)) invalid();
  return {...value, ...(value.previous_memory_id ? {previous_memory_id:value.previous_memory_id.toLowerCase()} : {}),
    ...(value.correction_decision_ids ? {correction_decision_ids:value.correction_decision_ids.map((id: string) => id.toLowerCase())} : {})};
}

// 调用方持有真实 PG 写事务；范围锁与旧 Python 使用同名键和同一顺序。
export async function mutateMemoryCandidate(client: Client, owner: string, contactId: string,
  action: string, id: string, input: unknown, dependencies: CandidateDependencies = {}): Promise<MemoryRow> {
  const body = candidateActionBody(action,input);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${owner}:${contactId}`]);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
  const candidate = (await client.query('SELECT to_jsonb(c) AS value FROM public.memory_candidate c WHERE owner_id=$1 AND contact_id=$2 AND id=$3 FOR UPDATE',[owner,contactId,id])).rows[0]?.value;
  if (!candidate) throw new MemoryMutationError(404,'记忆候选不存在。');
  if (action === 'discard') return discard(client,candidate,dependencies);
  const protectedCandidate = await protectCandidate(client,candidate);
  const decisions = protectedCandidate.decisionIds;
  if (protectedCandidate.row.failure_reason === 'correction:old_evidence'
    || (decisions.length && body.correction_decision_ids == null)
    || (body.correction_decision_ids != null && [...body.correction_decision_ids].sort().join('|') !== [...decisions].sort().join('|'))) conflict();
  const ownerLevel = candidate.subject === 'self';
  const table = ownerLevel ? 'owner_memory' : 'confirmed_memory';
  const scope = ownerLevel ? [owner] : [owner,contactId];
  const scopeSQL = ownerLevel ? 'owner_id=$1' : 'owner_id=$1 AND contact_id=$2';
  let previous: MemoryRow | undefined;
  if (action === 'apply-update') {
    previous = (await client.query(`SELECT to_jsonb(m) AS value FROM public.${table} m WHERE ${scopeSQL} AND id=$${scope.length+1} FOR UPDATE`,[...scope,body.previous_memory_id])).rows[0]?.value;
    if (!previous) conflict();
    if (!(previous!.status === 'active' && previous!.revision === body.expected_revision)
      && !(previous!.status === 'invalidated' && previous!.revision === body.expected_revision + 1)) versionConflict();
    // owner 资料跨联系人保存；旧版仍须有合法来源，不能恢复已删来源。
    await ensureMemorySources(client,owner,ownerLevel ? null : contactId,previous!);
  }
  if (candidate.status === 'confirmed') {
    const actual = (await client.query(`SELECT to_jsonb(m) AS value FROM public.${table} m WHERE ${scopeSQL} AND source_candidate_id=$${scope.length+1}`,[...scope,id])).rows[0]?.value;
    if (!actual) throw new MemoryMutationError(503,'候选确认记录不完整。');
    if (previous && (actual.status !== 'active' || actual.adoption_method !== 'manual'
      || actual.supersedes_memory_id !== previous.id || actual.revision !== body.expected_revision+1
      || previous.status !== 'invalidated' || previous.revision !== body.expected_revision+1)) versionConflict();
    return actual;
  }
  if (candidate.status !== 'pending') conflict();
  if (previous && (previous.status !== 'active' || previous.revision !== body.expected_revision)) conflict();
  if (previous && (await client.query(`SELECT 1 FROM public.${table} WHERE ${scopeSQL} AND supersedes_memory_id=$${scope.length+1} AND status='active'`,[...scope,previous.id])).rowCount) versionConflict();
  const current: MemoryRow = {...candidate,id:randomUUID(),source_candidate_id:id,adoption_method:'manual',status:'active',
    revision:previous ? previous.revision+1 : 1,supersedes_memory_id:previous?.id ?? null,
    source_ids:[...new Set([...(previous?.source_ids ?? []),...candidate.source_ids])],
    source_dependency_mode:previous?.source_dependency_mode === 'all' ? 'all' : candidate.source_dependency_mode,
    requires_all_sources:Boolean(previous?.requires_all_sources || candidate.requires_all_sources)};
  if (ownerLevel) delete current.contact_id;
  await ensureMemorySources(client,owner,current.source_dependency_mode === 'all' ? contactId : ownerLevel ? null : contactId,current);
  await validateCandidateEvolution(client,candidate);
  if (protectedCandidate.evidence) await client.query(`UPDATE public.memory_candidate SET correction_evidence=$4,
    correction_decision_ids=$5,failure_reason=$6,updated_at=now() WHERE owner_id=$1 AND contact_id=$2 AND id=$3 AND status='pending'`,
  [owner,contactId,id,protectedCandidate.evidence,decisions,protectedCandidate.row.failure_reason ?? null]);
  current.version_evidence = previous ? await candidateVersionEvidence(client,previous,current) : null;
  const columns = ['id','owner_id',...(!ownerLevel ? ['contact_id'] : []),'text_content','category','topic','source_ids','source_candidate_id','adoption_method',
    'status','valid_at','invalid_at','confidence','risk_flags','revision','supersedes_memory_id','event','conditions','evolution','version_evidence','source_dependency_mode','requires_all_sources'];
  const jsonColumns = new Set(['event','conditions','evolution','version_evidence']);
  const values = columns.map(key => jsonColumns.has(key) && current[key] != null ? JSON.stringify(current[key]) : current[key] ?? null);
  const written = (await client.query(`INSERT INTO public.${table} (${columns.join(',')}) VALUES (${columns.map((_,index) => `$${index+1}`).join(',')}) RETURNING to_jsonb(${table}) AS value`,values)).rows[0]?.value;
  if (!ownerLevel) await eraseLayeredReplies(client,owner,contactId,[id,...current.source_ids],dependencies.erasurePorts);
  if (previous) {
    await eraseLayeredReplies(client,owner,ownerLevel ? null : contactId,ownerLevel ? [previous.id] : [previous.id,...previous.source_ids],dependencies.erasurePorts);
    const parameters = [...scope,previous.id,previous.revision,previous.adoption_method,current.evolution?.kind === 'error_correction' ? 'error_correction' : 'state_changed'];
    const start = scope.length;
    const result = await client.query(`UPDATE public.${table} SET status='invalidated',revision=revision+1,retirement_reason=$${start+4},retired_at=now(),updated_at=now()
      WHERE ${scopeSQL} AND id=$${start+1} AND revision=$${start+2} AND adoption_method=$${start+3} AND status='active'`,parameters);
    if (result.rowCount !== 1) conflict();
  }
  const updated = await client.query("UPDATE public.memory_candidate SET status='confirmed',updated_at=now() WHERE owner_id=$1 AND contact_id=$2 AND id=$3 AND status='pending'",[owner,contactId,id]);
  if (updated.rowCount !== 1) conflict();
  if (!ownerLevel) await client.query(`INSERT INTO public.contact_memory_state(owner_id,contact_id,memory_revision) VALUES($1,$2,1)
    ON CONFLICT(owner_id,contact_id) DO UPDATE SET memory_revision=contact_memory_state.memory_revision+1,updated_at=now()`,[owner,contactId]);
  return written;
}

async function discard(client: Client, candidate: MemoryRow, dependencies: CandidateDependencies): Promise<MemoryRow> {
  if (candidate.status === 'rejected') return candidate;
  if (candidate.status !== 'pending') conflict();
  if (!dependencies.beforeErase) throw new MemoryMutationError(503,'删除备份清理尚未装配。');
  await dependencies.beforeErase();
  await eraseLayeredReplies(client,candidate.owner_id,candidate.contact_id,[candidate.id,...candidate.source_ids],dependencies.erasurePorts);
  await recordMemoryDecision(client,{owner:candidate.owner_id,contactId:candidate.contact_id,recordKind:'candidate',record:candidate,rejectedText:candidate.text_content});
  if (candidate.source_dependency_mode === 'all') await ensureMemorySources(client,candidate.owner_id,candidate.contact_id,candidate);
  await eraseRecordTraces(client,candidate.owner_id,'candidate',candidate.id);
  const updated = (await client.query(`UPDATE public.memory_candidate SET status='rejected',dimension_evidence=NULL,updated_at=now()
    WHERE owner_id=$1 AND contact_id=$2 AND id=$3 RETURNING to_jsonb(memory_candidate) AS value`,[candidate.owner_id,candidate.contact_id,candidate.id])).rows[0].value;
  await client.query(`INSERT INTO public.confirmed_memory(owner_id,contact_id,text_content,category,topic,source_ids,source_candidate_id,adoption_method,status,revision,source_dependency_mode,requires_all_sources)
    VALUES($1,$2,$3,$4,$5,$6,$7,'auto','deleted',1,$8,$9)`,[candidate.owner_id,candidate.contact_id,candidate.text_content,candidate.category,candidate.topic,candidate.source_ids,candidate.id,candidate.source_dependency_mode,Boolean(candidate.requires_all_sources)]);
  return updated;
}
