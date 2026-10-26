import { createHash } from 'node:crypto';
import type { Client } from 'pg';

class StoredNumber {
  readonly literal: string;
  constructor(literal: string) { this.literal = literal; }
}
/** 保留 JSONB 中的大整数及 1.0 类型，避免 Node 数字解析改变既有来源指纹。 */
export function parseStoredJSON(text: string): Evidence {
  return JSON.parse(text, (_key: string, value: unknown, ...context: any[]) =>
    typeof value === 'number' ? new StoredNumber(context[0].source) : value);
}
function storedNumberJSON(literal: string): string {
  if (!/[.eE]/.test(literal)) return literal;
  const value = Number(literal), absolute = Math.abs(value);
  if (!Number.isFinite(value)) throw new UnavailableEvidence();
  if (Object.is(value,-0)) return '-0.0';
  if (absolute && (absolute < 1e-4 || absolute >= 1e16)) {
    return value.toExponential().replace(/e([+-])(\d+)$/, (_: string, sign: string, exponent: string) => `e${sign}${exponent.padStart(2,'0')}`);
  }
  return Number.isInteger(value) ? `${value}.0` : String(value);
}
function codepointOrder(left: string, right: string): number {
  const a = [...left], b = [...right];
  for (let index = 0; index < Math.min(a.length,b.length); index++) {
    const difference = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
    if (difference) return difference;
  }
  return a.length - b.length;
}
// Python 既有冻结窗口使用排序 JSON；引用摘要另使用默认的逗号／冒号空格。
export function canonicalJSON(value: unknown, spaced = false, ascii = false): string {
  const separator = spaced ? ', ' : ',';
  const colon = spaced ? ': ' : ':';
  let result: string;
  if (value instanceof StoredNumber) return storedNumberJSON(value.literal);
  if (Array.isArray(value)) result = `[${value.map(item => canonicalJSON(item, spaced, ascii)).join(separator)}]`;
  else if (value !== null && typeof value === 'object') result = `{${Object.keys(value).sort(codepointOrder).map(key => `${canonicalJSON(key, spaced, ascii)}${colon}${canonicalJSON((value as Record<string, unknown>)[key], spaced, ascii)}`).join(separator)}}`;
  else result = JSON.stringify(value);
  return ascii ? result.replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`) : result;
}
export function digest(value: unknown): string { return sha(canonicalJSON(value)); }
export function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export const activeRef = `(EXISTS (SELECT 1 FROM public.local_wechat_observation o WHERE o.id=ref.observation_id AND o.owner_id=ref.owner_id AND o.contact_id=ref.contact_id) OR EXISTS (SELECT 1 FROM public.source_document s WHERE s.id=ref.source_document_id AND s.owner_id=ref.owner_id AND s.contact_id=ref.contact_id AND s.status='active'))`;
export class UnavailableEvidence extends Error {}
export type Evidence = Record<string, any>;

export async function documentsAvailable(client: Client, owner: string, ids: string[]): Promise<boolean> {
  return !(await client.query("SELECT 1 FROM public.source_document WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND status<>'active' LIMIT 1", [owner, ids])).rowCount;
}
export async function decisionAvailable(client: Client, owner: string, evidence: Evidence): Promise<boolean> {
  if (evidence.kind === 'generation_unknown') return false;
  if (!(await documentsAvailable(client, owner, evidence.source_ids))) return false;
  const ids = [...new Set(evidence.source_refs.map((ref: Evidence) => ref.ref_id))];
  const rows = (await client.query(`SELECT ref.id FROM public.message_source_ref ref WHERE ref.owner_id=$1 AND ref.id=ANY($2::uuid[]) AND ${activeRef}`, [owner, ids])).rows;
  return rows.length === ids.length;
}
function sourceState(rows: Evidence[]): string | null {
  if (!rows.length || rows.some(row => !row.source_locator?.trim() || !row.raw_payload || typeof row.raw_payload !== 'object' || Array.isArray(row.raw_payload) || !['source_document', 'local_wechat_observation'].includes(row.source_kind) || (row.source_kind === 'source_document' && !/^[a-f0-9]{64}$/.test(row.source_digest ?? '')))) return null;
  return digest(rows.map(row => ({source_ref_id: row.ref_id, source_id: row.source_id, source_kind: row.source_kind, locator: row.source_locator, raw_payload: row.raw_payload, source_content_sha256: row.source_digest})).sort((a,b) => a.source_ref_id.localeCompare(b.source_ref_id)));
}
export async function captureSnapshot(client: Client, owner: string, messageIds: string[], sourceIds: string[] = [], contact: string | null = null, refIds: string[] | null = null): Promise<Evidence> {
  const rows = (await client.query(`SELECT message.id,message.contact_id,message.text_content,message.media_placeholder,message.speaker,message.message_type,
    CASE WHEN message.occurred_at IS NULL THEN NULL ELSE to_char(message.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS') || CASE WHEN extract(microseconds FROM message.occurred_at)::bigint % 1000000 = 0 THEN '' ELSE to_char(message.occurred_at AT TIME ZONE 'UTC','.US') END || '+00:00' END AS occurred_at,
    ref.id AS ref_id,COALESCE(ref.source_document_id,ref.observation_id) AS source_id,ref.source_kind,ref.source_locator,ref.raw_payload::text AS raw_payload_text,
    (SELECT s.content_sha256 FROM public.source_document s WHERE s.id=ref.source_document_id AND s.owner_id=ref.owner_id AND s.contact_id=ref.contact_id AND s.status='active') AS source_digest
    FROM public.message message JOIN public.message_source_ref ref ON ref.message_id=message.id AND ref.owner_id=message.owner_id AND ref.contact_id=message.contact_id
    WHERE message.owner_id=$1 AND ($2::uuid IS NULL OR message.contact_id=$2) AND (message.id=ANY($3::uuid[]) OR ref.source_document_id=ANY($4::uuid[]) OR ref.observation_id=ANY($4::uuid[])) AND ${activeRef} AND ($5::uuid[] IS NULL OR ref.id=ANY($5::uuid[])) ORDER BY message.id,ref.id`, [owner, contact, messageIds, sourceIds, refIds])).rows;
  for (const row of rows) row.raw_payload = parseStoredJSON(row.raw_payload_text);
  const grouped = new Map<string, Evidence[]>(), sources = new Set(sourceIds), refs: Evidence[] = [];
  for (const row of rows) {
    grouped.set(row.id, [...(grouped.get(row.id) ?? []), row]);
    sources.add(row.id); sources.add(row.source_id);
    refs.push({message_id: row.id, ref_id: row.ref_id, source_id: row.source_id, digest: sha(canonicalJSON([row.source_kind,row.source_locator,row.raw_payload,row.source_digest], true))});
  }
  const snapshots: Evidence = {}, scopes: Evidence = {}, digests: Evidence = {};
  for (const [id, group] of grouped) {
    const row = group[0], text = row.text_content || row.media_placeholder || '';
    snapshots[id] = {message_id: id,text_sha256: sha(text),text_length: [...text].length,sender: row.speaker === 'user' ? 'self' : row.speaker,message_type: row.message_type,occurred_at: row.occurred_at,text_representation: !row.text_content ? 'placeholder' : row.message_type === 'text' ? 'text' : 'unknown',source_refs: group.map(item => ({ref_id:item.ref_id,source_id:item.source_id})),source_state_sha256: sourceState(group)};
    scopes[id] = row.contact_id; digests[id] = sha(text);
  }
  return {version: 1,message_ids: [...grouped.keys()].sort(),source_ids: [...sources].sort(),source_refs: refs,message_digests: digests,message_snapshots: snapshots,message_scopes: scopes};
}
export async function validateFrozen(client: Client, owner: string, evidence: Evidence): Promise<void> {
  if (evidence.kind === 'generation_unknown' || canonicalJSON(Object.keys(evidence.message_snapshots ?? {}).sort()) !== canonicalJSON([...evidence.message_ids].sort()) || canonicalJSON(Object.keys(evidence.message_scopes ?? {}).sort()) !== canonicalJSON([...evidence.message_ids].sort())) throw new UnavailableEvidence();
  const current = await captureSnapshot(client, owner, evidence.message_ids, [], null, evidence.source_refs.map((ref: Evidence) => ref.ref_id));
  const sortedRefs = (refs: Evidence[]) => [...refs].sort((a,b) => `${a.message_id}/${a.ref_id}/${a.source_id}`.localeCompare(`${b.message_id}/${b.ref_id}/${b.source_id}`));
  for (const field of ['message_digests','message_scopes','message_snapshots']) if (canonicalJSON(current[field]) !== canonicalJSON(evidence[field])) throw new UnavailableEvidence();
  if (canonicalJSON(sortedRefs(current.source_refs)) !== canonicalJSON(sortedRefs(evidence.source_refs))) throw new UnavailableEvidence();
}

/** 只沿当前资料登记的身份复验，不把旧窗口用新引用补证。 */
export async function readLineage(client: Client, owner: string, contact: string, memory: Evidence): Promise<Evidence> {
  const identifiers: string[] = memory.source_ids;
  const available = (await client.query(`SELECT id FROM public.source_document WHERE owner_id=$1 AND contact_id=$2 AND status='active' AND id=ANY($3::uuid[])
    UNION SELECT id FROM public.local_wechat_observation WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[])
    UNION SELECT message.id FROM public.message message WHERE message.owner_id=$1 AND message.contact_id=$2 AND message.id=ANY($3::uuid[]) AND EXISTS (SELECT 1 FROM public.message_source_ref ref WHERE ref.owner_id=message.owner_id AND ref.contact_id=message.contact_id AND ref.message_id=message.id AND ${activeRef})`, [owner, contact, identifiers])).rows;
  if (available.length !== new Set(identifiers).size) throw new UnavailableEvidence();
  const candidate = memory.source_candidate_id ? (await client.query('SELECT correction_evidence,dimension_evidence::text AS dimension_evidence_text FROM public.memory_candidate WHERE owner_id=$1 AND contact_id=$2 AND id=$3', [owner,contact,memory.source_candidate_id])).rows[0] : null;
  if (candidate?.correction_evidence && (candidate.correction_evidence.decision_ids?.length || candidate.correction_evidence.has_memory_context) && !(await decisionAvailable(client,owner,candidate.correction_evidence))) throw new UnavailableEvidence();
  const original: Evidence[] = [], windows: Evidence[] = [], sources = new Set<string>(identifiers);
  if (candidate?.correction_evidence && candidate.correction_evidence.kind !== 'generation_unknown') { original.push(candidate.correction_evidence); windows.push(candidate.correction_evidence); }
  const decisions = (await client.query("SELECT * FROM public.memory_correction_decision WHERE owner_id=$1 AND contact_id=$2 AND record_kind='contact_memory' AND (record_id=$3 OR replacement_memory_id=$3)", [owner,contact,memory.id])).rows;
  for (const decision of decisions) {
    const evidence = decision.evidence;
    if (evidence.kind === 'erased_guard') {
      if (decision.decision !== 'rejected' || decision.rejected_text !== null || decision.corrected_text !== null || !Array.isArray(evidence.canonical_ids) || !evidence.canonical_ids.length || Object.keys(evidence).sort().join(',') !== 'canonical_ids,kind,version' || evidence.version !== 1 || new Set(evidence.canonical_ids).size !== evidence.canonical_ids.length) throw new UnavailableEvidence();
      const valid = await client.query(`SELECT 1 FROM public.message message JOIN public.message_source_ref ref ON ref.owner_id=message.owner_id AND ref.contact_id=message.contact_id AND ref.message_id=message.id WHERE message.owner_id=$1 AND message.contact_id=$2 AND message.id=ANY($3::uuid[]) AND ${activeRef} LIMIT 1`, [owner,contact,evidence.canonical_ids]);
      if (!valid.rowCount) throw new UnavailableEvidence();
    } else if (!(await decisionAvailable(client, owner, evidence))) throw new UnavailableEvidence();
    sources.add(decision.id);
    if (!['generation_unknown','erased_guard'].includes(evidence.kind)) {
      windows.push(evidence);
      if (decision.decision === 'corrected' && decision.replacement_memory_id === memory.id) original.push(evidence);
    }
  }
  if (memory.version_evidence) for (const window of [memory.version_evidence.previous_window,memory.version_evidence.current_window]) if (window) windows.push(window);
  const refs = new Map<string, Evidence>();
  for (const window of windows) {
    await validateFrozen(client, owner, window);
    if (!(await decisionAvailable(client,owner,window))) throw new UnavailableEvidence();
    for (const id of [...window.source_ids,...window.message_ids]) sources.add(id);
    for (const ref of window.source_refs) { for (const id of [ref.source_id,ref.message_id,ref.ref_id]) sources.add(id); refs.set(`${ref.message_id}/${ref.ref_id}/${ref.source_id}`,ref); }
  }
  const traces = (await client.query(`SELECT DISTINCT dependency.source_id FROM public.memory_extraction_trace_dependency dependency JOIN public.memory_extraction_trace_link link ON link.owner_id=dependency.owner_id AND link.trace_id=dependency.trace_id WHERE link.owner_id=$1 AND ((link.record_kind='contact_memory' AND link.record_id=$2) OR (link.record_kind='candidate' AND link.record_id=$3))`,[owner,memory.id,memory.source_candidate_id])).rows;
  for (const trace of traces) sources.add(trace.source_id);
  if (memory.source_candidate_id) sources.add(memory.source_candidate_id);
  if (!(await documentsAvailable(client,owner,[...sources]))) throw new UnavailableEvidence();
  const originalRefs = original.length ? [...new Set<string>(original.flatMap(window => window.source_refs.map((ref: Evidence) => ref.ref_id)))] : null;
  const direct = await captureSnapshot(client,owner,identifiers,identifiers,contact,originalRefs);
  for (const id of direct.source_ids) sources.add(id);
  const sourceRows = (await client.query('SELECT id,status,source_type,content_sha256 FROM public.source_document WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[owner,[...sources]])).rows;
  const context: Evidence[] = [];
  for (const [kind, table] of [['contact_memory','confirmed_memory'],['owner_memory','owner_memory']]) {
    const rows = (await client.query(`SELECT id,revision,status,text_content,category,topic,source_ids,source_candidate_id,adoption_method,valid_at::text,invalid_at::text,supersedes_memory_id,event,version_evidence FROM public.${table} WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND id<>$3 ORDER BY id`,[owner,[...sources],memory.id])).rows;
    for (const row of rows) {
      for (const key of ['valid_at','invalid_at']) if (row[key]) {
        row[key] = row[key].replace(/([+-]\d{2})$/, '$1:00').replace(/\.(\d+)(?=[+-])/, (_: string, fraction: string) => `.${fraction.padEnd(6,'0')}`);
      }
      context.push({record_kind:kind,memory_id:row.id,revision:row.revision,status:row.status,record_sha256:digest(row)});
    }
  }
  return {source_ids:[...sources].sort(),source_refs:[...refs.values()].sort((a,b) => a.ref_id.localeCompare(b.ref_id)),context_records:context,original_known:!!original.length,original_ref_ids:originalRefs,
    generation_sha256:digest({frozen_windows:windows,direct,dimension_evidence:candidate?.dimension_evidence_text ? parseStoredJSON(candidate.dimension_evidence_text) : null,sources:sourceRows,context_records:context,trace_dependency_ids:traces.map(row => row.source_id).sort()})};
}
export async function overviewReferences(client: Client, owner: string, contact: string, ids: string[], refIds: string[] | null): Promise<Evidence[]> {
  const refs = (await client.query(`SELECT ref.id,ref.message_id,ref.source_kind,ref.source_locator,COALESCE(ref.source_document_id,ref.observation_id) AS source_id FROM public.message_source_ref ref WHERE ref.owner_id=$1 AND ref.contact_id=$2 AND (ref.message_id=ANY($3::uuid[]) OR ref.source_document_id=ANY($3::uuid[]) OR ref.observation_id=ANY($3::uuid[])) AND ${activeRef} AND ($4::uuid[] IS NULL OR ref.id=ANY($4::uuid[])) ORDER BY ref.message_id,ref.id`,[owner,contact,ids,refIds])).rows;
  const result = refs.map(row => ({source_id:row.source_id,source_kind:row.source_kind === 'local_wechat_observation' ? row.source_kind : 'source_document',message_id:row.message_id,source_ref_id:row.id,locator:row.source_locator}));
  const represented = new Set(result.map(row => row.source_id));
  const documents = (await client.query("SELECT id,source_type FROM public.source_document WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[]) AND status='active' ORDER BY id",[owner,contact,ids])).rows;
  for (const row of documents) if (!represented.has(row.id)) result.push({source_id:row.id,source_kind:row.source_type === 'manual' ? 'manual' : 'source_document',message_id:null,source_ref_id:null,locator:null});
  return result;
}
