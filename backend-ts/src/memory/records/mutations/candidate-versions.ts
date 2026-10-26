import type { Client } from 'pg';
import { canonicalJSON, validateFrozen } from '../../overview/evidence/sources.ts';
import { candidateDigest } from '../../overview/evidence/dimensions.ts';
import { normalizeEvolution } from '../../overview/projection/metadata.ts';
import { overviewRecordDigest, pythonISO } from '../../overview/projection/memory.ts';
import { MemoryMutationError, type MemoryRow } from './protection.ts';

// 只能组合原候选已保存的窗口；不捕获当前来源补造旧版本证明。
async function originalWindow(client: Client, owner: string, id: string | null): Promise<MemoryRow | null> {
  if (!id) return null;
  const row = (await client.query('SELECT dimension_evidence,correction_evidence FROM public.memory_candidate WHERE owner_id=$1 AND id=$2', [owner,id])).rows[0];
  const dimension = row?.dimension_evidence, frozen = row?.correction_evidence;
  if (!dimension?.messages || !frozen?.message_ids || frozen.kind === 'generation_unknown') return null;
  const ordered = dimension.messages.map((item: MemoryRow) => item.message_id);
  if (!ordered.length || ordered.some((id: string) => !frozen.message_ids.includes(id)
    || canonicalJSON(dimension.messages.find((item: MemoryRow) => item.message_id === id)) !== canonicalJSON(frozen.message_snapshots?.[id]))) return null;
  const refs = frozen.source_refs.filter((ref: MemoryRow) => ordered.includes(ref.message_id));
  const result: MemoryRow = {version:1, ordered_message_ids:ordered, message_ids:[...new Set(ordered)].sort(),
    source_ids:[...new Set([...ordered,...refs.map((ref: MemoryRow) => ref.source_id)])].sort(), source_refs:refs};
  for (const key of ['message_digests','message_snapshots','message_scopes']) {
    if (!frozen[key] || ordered.some((id: string) => frozen[key][id] === undefined)) return null;
    result[key] = Object.fromEntries(ordered.map((id: string) => [id,frozen[key][id]]));
  }
  return result;
}

export async function candidateVersionEvidence(client: Client, previous: MemoryRow, current: MemoryRow): Promise<MemoryRow> {
  return {version:1, previous:{memory_id:previous.id,revision:previous.revision,adoption_method:previous.adoption_method,
    valid_at:pythonISO(previous.valid_at),invalid_at:pythonISO(previous.invalid_at),record_sha256:overviewRecordDigest(previous)},
  current:{memory_id:current.id,revision:current.revision,record_sha256:overviewRecordDigest(current)},
  previous_window:await originalWindow(client,previous.owner_id,previous.source_candidate_id),
  current_window:await originalWindow(client,current.owner_id,current.source_candidate_id)};
}

export async function validateCandidateEvolution(client: Client, candidate: MemoryRow): Promise<void> {
  if (!candidate.evolution) return;
  const fail = (): never => { throw new MemoryMutationError(409,'变化依据已改变，请重新核对。'); };
  const evolution = normalizeEvolution(candidate.evolution), proof = evolution?.proof;
  if (!proof?.sources || proof.scope?.owner_id !== candidate.owner_id || proof.scope.contact_id !== candidate.contact_id
    || proof.candidate_sha256 !== candidateDigest(candidate)) fail();
  await validateFrozen(client,candidate.owner_id,proof.sources);
  if (new Set(Object.values(proof.sources.message_scopes)).size !== 1
    || Object.values(proof.sources.message_scopes)[0] !== candidate.contact_id) fail();
  const related = new Set(evolution!.related_versions.map((item: MemoryRow) => item.memory_id));
  for (const parent of proof.parents) {
    if (!related.has(parent.memory_id)) continue;
    const table = parent.subject === 'self' ? 'owner_memory' : 'confirmed_memory';
    const row = (await client.query(`SELECT to_jsonb(m) AS value FROM public.${table} m WHERE owner_id=$1 AND id=$2 FOR SHARE`, [candidate.owner_id,parent.memory_id])).rows[0]?.value;
    if (!row || row.status !== 'active' || row.revision !== parent.revision
      || (table === 'confirmed_memory' && row.contact_id !== candidate.contact_id)
      || overviewRecordDigest(row,normalizeEvolution(row.evolution),parent.revision,parent.invalid_at) !== parent.record_sha256) fail();
  }
}
