import { canonicalJSON, type Evidence } from '../../evidence/canonical-json.ts';
import { length, representations, validateBody, type Message } from './bounded-body.ts';

/** 来源窗口已由调用者复核；这里继续按已存协议重解析全文与语义定位。 */
export async function reverifySemantic(candidate: Evidence, evidence: Evidence, current: Evidence[], texts: Record<string, string>, snapshots: Record<string, Evidence[]>): Promise<boolean> {
  if (!evidence.pragmatics || Object.keys(texts).sort().join(',') !== Object.keys(snapshots).sort().join(',')) return false;
  if (evidence.version !== 4) {
    const { reverifyLegacyBasis } = await import('./legacy-semantic.ts');
    return reverifyLegacyBasis(candidate, evidence, current, texts, snapshots);
  }
  const messages: Message[] = current.map(item => ({ ...item, message_id: item.message_id, text: texts[item.message_id], sender: item.sender, occurred_at: item.occurred_at, source_snapshots: snapshots[item.message_id] }));
  const targets = evidence.target_message_ids;
  if (!Array.isArray(targets) || !targets.length || messages.length > 4 || messages.some(item => length(item.text) > 4096) || length(candidate.text_content) > 4096) return false;
  if (!validateBody(messages, candidate, targets) || (evidence.media ?? []).some((item: Evidence) => !candidate.source_ids.includes(item.message_id))) return false;
  const basis = evidence.semantic_basis;
  if (basis === null) return true;
  if (!basis || basis.version !== 3) return false;
  const reps = representations(messages, candidate, targets);
  if (reps.length !== 1) return false;
  const rep = reps[0];
  if (candidate.subject !== rep.target.sender || rep.contexts.length > 4 || messages.some(item => item.message_type !== 'text' || item.text_representation !== 'text' || !item.source_state_sha256)) return false;
  const { boundedBasis } = await import('./bounded-graph.ts');
  const expected = boundedBasis(candidate, evidence, messages, rep);
  if (!expected || !Array.isArray(basis.capabilities) || new Set(basis.capabilities).size !== basis.capabilities.length
    || basis.capabilities.some((item: string) => !expected.capabilities.includes(item))) return false;
  expected.capabilities = basis.capabilities;
  if (canonicalJSON(expected) !== canonicalJSON(basis)) return false;
  // 旧reverify生成的提案必须继续落在同一实际主句和目标上。
  const start = rep.main[0].start, end = rep.main.at(-1)!.end;
  for (const atom of expected.atoms) {
    if (atom.source.message_id !== rep.target.message_id || atom.source.span.start < start || atom.source.span.end > end
      || atom.candidate.start < rep.quote_start || atom.candidate.end > rep.quote_end) return false;
  }
  for (const binding of expected.reference_bindings) {
    if (binding.mention.message_id !== rep.target.message_id || binding.mention.span.start < start || binding.mention.span.end > end) return false;
  }
  return true;
}
