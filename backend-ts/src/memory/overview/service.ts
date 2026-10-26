import { digest, readLineage, overviewReferences, UnavailableEvidence } from './evidence/sources.ts';
import type { Evidence } from './evidence/sources.ts';
import { projectOverviewMemory } from './projection/memory.ts';
import type { Client } from 'pg';

export class OverviewError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}

export interface OverviewDTO {
  version: 1;
  scope_kind: 'contact';
  contact_id: string;
  projection_revision: string;
  memory_revision: number;
  built_at: string;
  entries: Evidence[];
}

/** 调用方持 contact→owner 锁并在提交前复验范围；这里不提交事务。 */
export async function readContactOverview(client: Client, ownerId: string, contactId: string, includeDependencies = false): Promise<OverviewDTO> {
  const scope = [ownerId, contactId];
  if (!(await client.query('SELECT 1 FROM public.contact WHERE owner_id=$1 AND id=$2', scope)).rowCount) {
    throw new OverviewError('overview_not_found', 404);
  }
  const memoryRevision = Number((await client.query(
    'SELECT memory_revision FROM public.contact_memory_state WHERE owner_id=$1 AND contact_id=$2', scope,
  )).rows[0]?.memory_revision ?? 0);
  const memories = (await client.query(
    "SELECT to_jsonb(memory) AS value FROM public.confirmed_memory memory WHERE owner_id=$1 AND contact_id=$2 AND status IN ('active','invalidated') ORDER BY created_at,id", scope,
  )).rows;
  const entries: Evidence[] = [], dependencies: Evidence[] = [];
  for (const { value: row } of memories) {
    try {
      const lineage = await readLineage(client, ownerId, contactId, row);
      const projected = await projectOverviewMemory(client, row);
      const references = await overviewReferences(client, ownerId, contactId, row.source_ids, lineage.original_ref_ids);
      const kind = references.length && references.every(ref => ref.source_kind === 'manual') ? 'manual_entry'
        : references.length && lineage.original_known ? 'source_supported' : 'unknown';
      entries.push({ memory: projected.payload, is_latest: false, current_leaf: null, provenance: { kind, references }, ...(includeDependencies ? {dependency_ids:lineage.source_ids} : {}) });
      dependencies.push({ memory_id: row.id, revision: row.revision, status: row.status,
        record_sha256: projected.recordDigest, timing_sha256: digest(projected.timing),
        version_evidence_sha256: digest(projected.versionEvidence), current_event_sha256: digest(projected.eventCurrent),
        version_evidence_source_current: !!projected.payload.version_evidence_source_current,
        source_generation_sha256: lineage.generation_sha256, original_known: lineage.original_known,
        context_records: lineage.context_records, source_ids: lineage.source_ids, source_refs: lineage.source_refs });
    } catch (error) { if (!(error instanceof UnavailableEvidence)) throw error; }
  }
  const children = new Map<string, Evidence>();
  for (const entry of entries) if (entry.memory.supersedes_memory_id) {
    if (children.has(entry.memory.supersedes_memory_id)) throw new OverviewError('overview_unavailable',503);
    children.set(entry.memory.supersedes_memory_id, entry);
  }
  for (const entry of entries) {
    let current = entry;
    const visited = new Set<string>();
    while (children.has(current.memory.memory_id)) {
      if (visited.has(current.memory.memory_id) || visited.size >= 100) throw new OverviewError('overview_unavailable',503);
      visited.add(current.memory.memory_id); current = children.get(current.memory.memory_id)!;
    }
    entry.current_leaf = current.memory.status === 'active' ? { memory_id: current.memory.memory_id, revision: current.memory.revision } : null;
    entry.is_latest = entry.current_leaf?.memory_id === entry.memory.memory_id;
  }
  const manifest = { version: 1, memory_revision: memoryRevision, memories: dependencies };
  const revision = digest(manifest);
  const saved = (await client.query(
    "SELECT projection_revision,to_char(built_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US') || '+00:00' AS built_at FROM public.relationship_overview_projection WHERE owner_id=$1 AND contact_id=$2 AND scope_kind='contact'", scope,
  )).rows[0];
  let builtAt: string;
  if (saved?.projection_revision === revision) builtAt = saved.built_at;
  else {
    const result = await client.query(
      `INSERT INTO public.relationship_overview_projection
       (owner_id,scope_kind,contact_id,projection_revision,memory_ids,source_ids,manifest,built_at)
       VALUES ($1,'contact',$2,$3,$5::uuid[],$6::uuid[],$4,clock_timestamp())
       ON CONFLICT (owner_id,contact_id) WHERE scope_kind='contact' DO UPDATE SET
       projection_revision=EXCLUDED.projection_revision,memory_ids=EXCLUDED.memory_ids,
       source_ids=EXCLUDED.source_ids,manifest=EXCLUDED.manifest,built_at=EXCLUDED.built_at
       RETURNING to_char(built_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00' AS built_at`,
      [...scope, revision, manifest, entries.map(entry => entry.memory.memory_id), [...new Set([...dependencies.flatMap(item => item.source_ids), ...entries.flatMap(entry => entry.provenance.references.map((ref: Evidence) => ref.source_id))])].sort()],
    );
    builtAt = result.rows[0].built_at;
  }
  return { version: 1, scope_kind: 'contact', contact_id: contactId, projection_revision: revision,
    memory_revision: memoryRevision, built_at: builtAt.replace(/\.000000(?=[+-])/,''), entries };
}
