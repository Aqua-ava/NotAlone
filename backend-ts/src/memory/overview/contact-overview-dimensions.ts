import type { Client } from 'pg';
import { activeRef, canonicalJSON, digest, sha, parseStoredJSON, type Evidence } from './contact-overview-evidence.ts';
import { normalizeEvent, normalizeConditions } from './contact-overview-metadata.ts';
import { pythonISO } from './contact-overview-time.ts';

function utcISO(value: string | null | undefined): string | null {
  if (value == null) return null;
  const iso = pythonISO(value)!;
  const fraction = iso.match(/\.(\d+)(?=[+-]\d\d:\d\d$)/u)?.[1];
  return new Date(iso).toISOString().slice(0, 19) + (fraction && Number(fraction) ? '.' + fraction : '') + '+00:00';
}

/** 只重核已存候选，不生成新的维度证明或长期资料。 */
export function candidateDigest(candidate: Evidence, version = 1): string {
  if (version === 4 && candidate.source_dependency_mode !== 'all') throw new TypeError('版本四需要ALL资料');
  const event = normalizeEvent(candidate.event), conditions = normalizeConditions(candidate.conditions);
  const value = {
    ...(version === 4 ? { source_dependency_mode: 'all' } : {}),
    text: candidate.text_content, category: candidate.category, topic: candidate.topic, subject: candidate.subject,
    source_ids: [...candidate.source_ids].sort(), valid_at: utcISO(candidate.valid_at), invalid_at: utcISO(candidate.invalid_at),
    confidence: candidate.confidence, risk_flags: candidate.risk_flags ?? [], alternatives: candidate.alternatives ?? [],
    interpretation_reason: candidate.interpretation_reason || '',
    ...(event === null ? {} : { event }), ...(conditions === null ? {} : { conditions }),
  };
  // PostgreSQL confidence 读取为 Python float；整数值也保留 .0 的原摘要合同。
  const confidence = Number(candidate.confidence);
  const floatText = Number.isInteger(confidence) ? confidence.toFixed(1)
    : confidence !== 0 && Math.abs(confidence) < 0.0001 ? confidence.toExponential().replace(/e([+-])(\d+)$/u, (_all, sign: string, exponent: string) => 'e' + sign + exponent.padStart(2, '0'))
    : String(confidence);
  const serialized = canonicalJSON(value).replace(/"confidence":[^,}]+/u, '"confidence":' + floatText);
  return sha(serialized);
}

const same = (left: unknown, right: unknown): boolean => canonicalJSON(left) === canonicalJSON(right);
const spanValid = (span: Evidence, text: string): boolean => span && Number.isInteger(span.start) && Number.isInteger(span.end)
  && span.start >= 0 && span.start < span.end && span.end <= [...text].length
  && sha([...text].slice(span.start, span.end).join('')) === span.sha256;

function messageSpans(evidence: Evidence): Evidence[] {
  const spans = [
    ...(evidence.paraphrase ?? []).map((item: Evidence) => item.source),
    ...(evidence.reference ?? []).flatMap((item: Evidence) => [item.mention, item.target]),
    ...(evidence.reported ?? []).flatMap((item: Evidence) => [item.speaker, item.reported_subject]),
  ];
  // 语义依据的所有消息定位与候选定位另由完整规则核验。
  return spans;
}

function fields(value: unknown, names: string[]): value is Evidence {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...names].sort().join(',');
}
function ordinaryShape(evidence: Evidence): boolean {
  const names = ['version','scope','candidate_sha256','window_sha256','messages','pragmatics','paraphrase','reference','media','reported'];
  if (evidence.version >= 2) names.push('semantic_basis');
  if (evidence.version === 4) names.push('target_message_ids');
  if (!fields(evidence, names) || !fields(evidence.scope, ['owner_id','contact_id'])) return false;
  const pragmatics = evidence.pragmatics;
  if (pragmatics !== null && (!fields(pragmatics, ['speech_act','assertion_status','figurative_type'])
    || !['assertion','plan','question','request','report','correction','unknown'].includes(pragmatics.speech_act)
    || !['asserted','hypothetical','conditional','reported','unknown'].includes(pragmatics.assertion_status)
    || !['literal','joke','sarcasm','hyperbole','unknown'].includes(pragmatics.figurative_type))) return false;
  const span = (item: unknown): boolean => fields(item, ['start','end','sha256']) && Number.isInteger(item.start)
    && Number.isInteger(item.end) && item.start >= 0 && item.start < item.end && /^[a-f0-9]{64}$/u.test(item.sha256);
  const anchor = (item: unknown): boolean => fields(item, ['message_id','span']) && typeof item.message_id === 'string' && span(item.span);
  for (const name of ['paraphrase','reference','media','reported']) if (evidence[name] !== null && !Array.isArray(evidence[name])) return false;
  if ((evidence.paraphrase ?? []).some((item: Evidence) => !fields(item,['candidate','source']) || !span(item.candidate) || !anchor(item.source))) return false;
  if ((evidence.reference ?? []).some((item: Evidence) => !fields(item,['mention','target','subject']) || !anchor(item.mention) || !anchor(item.target)
    || !['self','contact','shared','unknown'].includes(item.subject))) return false;
  if ((evidence.reported ?? []).some((item: Evidence) => !fields(item,['speaker','reported_subject','relationship']) || !anchor(item.speaker) || !anchor(item.reported_subject)
    || !['direct','reported','unknown'].includes(item.relationship))) return false;
  return !(evidence.media ?? []).some((item: Evidence) => !fields(item,['message_id','message_type','representation']) || typeof item.message_id !== 'string'
    || typeof item.message_type !== 'string' || !item.message_type.trim() || !['text','processed_text','placeholder','unknown'].includes(item.representation));
}

export async function dimensionSourcesCurrent(client: Client, candidate: Evidence): Promise<boolean> {
  const evidence = candidate.dimension_evidence;
  if (!evidence || ![1, 2, 3, 4].includes(evidence.version) || !Array.isArray(evidence.messages) || !evidence.messages.length) return false;
  if (!ordinaryShape(evidence)) return false;
  if ((evidence.version === 4) !== (candidate.source_dependency_mode === 'all')) return false;
  if (!same(evidence.scope, { owner_id: candidate.owner_id, contact_id: candidate.contact_id })) return false;
  try { if (candidateDigest(candidate, evidence.version) !== evidence.candidate_sha256) return false; }
  catch { return false; }
  if (evidence.version >= 2) {
    const shape = (await client.query(`SELECT public.notalone_dimension_evidence_v${evidence.version}_shape($1::jsonb,$2::integer) AS valid`, [evidence, [...candidate.text_content].length])).rows[0];
    if (!shape?.valid) return false;
  }
  const ids = evidence.messages.map((item: Evidence) => item.message_id);
  if (new Set(ids).size !== ids.length) return false;
  const rows = (await client.query(`SELECT message.id,message.text_content,message.media_placeholder,message.speaker,message.message_type,
    to_jsonb(message)->>'occurred_at' AS occurred_at,
    ref.id AS ref_id,COALESCE(ref.source_document_id,ref.observation_id) AS source_id,ref.source_kind,ref.source_locator,ref.raw_payload::text AS raw_payload_text,
    (SELECT s.content_sha256 FROM public.source_document s WHERE s.id=ref.source_document_id AND s.owner_id=ref.owner_id AND s.contact_id=ref.contact_id AND s.status='active') AS source_digest
    FROM public.message message JOIN public.message_source_ref ref ON ref.message_id=message.id AND ref.owner_id=message.owner_id AND ref.contact_id=message.contact_id
    WHERE message.owner_id=$1 AND message.contact_id=$2 AND message.id=ANY($3::uuid[]) AND ${activeRef}
    ORDER BY message.id,ref.id`, [candidate.owner_id, candidate.contact_id, ids])).rows;
  const groups = new Map<string, Evidence[]>();
  for (const row of rows) groups.set(row.id, [...(groups.get(row.id) ?? []), row]);
  const texts: Record<string, string> = {}, snapshots: Record<string, Evidence[]> = {}, current: Evidence[] = [];
  for (const id of ids) {
    const group = groups.get(id);
    if (!group?.length) return false;
    const row = group[0], text = row.text_content || row.media_placeholder || '';
    const refs = group.map(item => ({ source_ref_id: item.ref_id, source_id: item.source_id, source_kind: item.source_kind,
      locator: item.source_locator, raw_payload: parseStoredJSON(item.raw_payload_text), source_content_sha256: item.source_digest }));
    if (!text || refs.some(ref => !ref.locator?.trim() || !ref.raw_payload || typeof ref.raw_payload !== 'object' || Array.isArray(ref.raw_payload)
      || !['source_document', 'local_wechat_observation'].includes(ref.source_kind)
      || ref.source_kind === 'source_document' && !/^[a-f0-9]{64}$/u.test(ref.source_content_sha256 ?? ''))) return false;
    let occurred = utcISO(row.occurred_at);
    if (evidence.version === 4 && occurred !== null) {
      const rawTimes = refs.map(ref => ref.raw_payload.time_iso);
      if (rawTimes.every(time => typeof time === 'string' && /(?:Z|[+-]\d\d:\d\d)$/u.test(time) && utcISO(time) === occurred)
        && new Set(rawTimes.map(time => time.match(/(?:Z|[+-]\d\d:\d\d)$/u)?.[0].replace('Z', '+00:00'))).size === 1) {
        const raw = rawTimes[0];
        const match = raw.match(/^(.*?)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/u);
        if (match) occurred = match[1] + (match[2] && Number(match[2]) !== 0 ? '.' + match[2].padEnd(6, '0').slice(0, 6) : '') + match[3].replace('Z', '+00:00');
      }
    }
    texts[id] = text; snapshots[id] = refs;
    current.push({ message_id: id, text_sha256: sha(text), text_length: [...text].length, sender: row.speaker === 'user' ? 'self' : row.speaker,
      message_type: row.message_type, occurred_at: occurred, source_refs: refs.map(ref => ({ ref_id: ref.source_ref_id, source_id: ref.source_id })),
      text_representation: !row.text_content ? 'placeholder' : row.message_type === 'text' ? 'text' : 'unknown', source_state_sha256: digest(refs) });
  }
  const original = evidence.messages.map((item: Evidence) => ({ ...item, occurred_at: evidence.version === 4 ? item.occurred_at : utcISO(item.occurred_at) }));
  if (!same(original, current)) return false;
  const window = evidence.version === 4
    ? { version: 4, scope: evidence.scope, messages: current, target_message_ids: evidence.target_message_ids }
    : { ...evidence.scope, messages: current };
  if (digest(window) !== evidence.window_sha256) return false;
  for (const anchor of messageSpans(evidence)) if (!(anchor?.message_id in texts) || !spanValid(anchor.span, texts[anchor.message_id])) return false;
  for (const alignment of evidence.paraphrase ?? []) if (!spanValid(alignment.candidate, candidate.text_content)) return false;
  for (const origin of evidence.media ?? []) if (!ids.includes(origin.message_id) || origin.message_type !== current.find(item => item.message_id === origin.message_id)?.message_type) return false;
  if (evidence.semantic_basis !== undefined && evidence.semantic_basis !== null || evidence.version === 4) {
    // 语义重验证模块仍使用已存版本及当前全文，不以摘要相等替代规则重放。
    const { reverifySemantic } = await import('./contact-overview-semantic.ts');
    return reverifySemantic(candidate, evidence, current, texts, snapshots);
  }
  return true;
}
