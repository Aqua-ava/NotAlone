import type { ReplyCandidate, ReplyUsedSkill } from '../../shared/reply-bridge';
import { isUuid } from '../uuid';
import { readInputBudget } from './input-budget-read';
import { readReplyBasisChanges } from './basis-changes-read';
import { readExpressionPreferenceReceipt } from '../expression-preferences/client';
import type { SkillPublicationScope } from '../../shared/skill-learning-bridge';
import { readSkillExecutionView } from '../skill-execution-view';

export const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 65_536 && Boolean(value.trim());
function identifiers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 512 || !value.every(isUuid)) throw new Error('候选结果格式无效。');
  return value.map((item: string) => item.toLowerCase());
}

function readUsedSkill(value: unknown): ReplyUsedSkill | null {
  if (value === null) return null;
  if (!isRecord(value) || !isUuid(value.skill_id) || !isUuid(value.version_id) || !text(value.name)
    || (value.load_state !== 'loaded' && value.load_state !== 'resource_failed')
    || value.version_number !== undefined && value.version_number !== null
      && (!Number.isSafeInteger(value.version_number) || (value.version_number as number) < 1)) throw new Error('候选实际策略格式无效。');
  let scope: SkillPublicationScope | undefined;
  let executionView: ReplyUsedSkill['executionView'];
  if (value.execution_view !== undefined) {
    const view = readSkillExecutionView(value.execution_view);
    executionView = { policyRevision: view.policy_revision, methodIds: view.method_ids, sha256: view.sha256 };
  }
  if (value.scope !== undefined) {
    const row = value.scope;
    if (!isRecord(row) || Object.keys(row).length !== 3 || !['kind', 'contact_id', 'scene'].every(key => Object.hasOwn(row, key))
      || !(row.kind === 'owner' && row.contact_id === null && row.scene === null
        || row.kind === 'contact' && isUuid(row.contact_id) && row.scene === null
        || row.kind === 'scene' && row.contact_id === null && typeof row.scene === 'string'
          && row.scene.trim().length > 0 && row.scene.length <= 256 && row.scene === row.scene.trim())) throw new Error('候选实际策略范围无效。');
    scope = row as unknown as SkillPublicationScope;
  }
  return { name: value.name, versionId: value.version_id.toLowerCase(), loadState: value.load_state,
    ...(value.version_number === undefined ? {} : { versionNumber: value.version_number as number | null }),
    ...(scope ? { scope } : {}), ...(executionView ? { executionView } : {}) };
}

export function readReplyResult(value: unknown) {
  if (!isRecord(value) || !isUuid(value.reply_request_id) || !Array.isArray(value.candidates)
    || value.candidates.length < 1 || value.candidates.length > 3 || !isRecord(value.context_receipt)) throw new Error('候选结果格式无效。');
  const known = new Set<string>();
  const candidates: ReplyCandidate[] = value.candidates.map((item: unknown) => {
    if (!isRecord(item) || !isUuid(item.candidate_id) || !text(item.text) || !text(item.basis)
      || !Array.isArray(item.risk_notes) || item.risk_notes.length > 32
      || !item.risk_notes.every((note) => typeof note === 'string' && note.length <= 4096)) throw new Error('候选结果格式无效。');
    const candidateId = item.candidate_id.toLowerCase();
    if (known.has(candidateId)) throw new Error('候选结果格式无效。');
    known.add(candidateId);
    return { candidateId, text: item.text, basis: item.basis, citationIds: identifiers(item.citation_ids), riskNotes: [...item.risk_notes] };
  });
  const contextEvidenceIds = identifiers(value.context_receipt.evidence_ids);
  const expressionPreferenceIds = identifiers(value.context_receipt.expression_preference_ids ?? []);
  if (expressionPreferenceIds.length > 5 || new Set(expressionPreferenceIds).size !== expressionPreferenceIds.length
    || expressionPreferenceIds.some((id) => contextEvidenceIds.includes(id))) throw new Error('长期偏好回执格式无效。');
  const snapshots = value.context_receipt.expression_preferences ?? [];
  if (!Array.isArray(snapshots) || snapshots.length > 5) throw new Error('长期偏好回执格式无效。');
  const expressionPreferences = snapshots.map(readExpressionPreferenceReceipt);
  if (expressionPreferences.length !== expressionPreferenceIds.length
    || new Set(expressionPreferences.map((item) => item.preferenceId)).size !== expressionPreferences.length
    || expressionPreferences.some((item) => !expressionPreferenceIds.includes(item.preferenceId))
    || expressionPreferences.reduce((size, item) => size + item.text.length, 0) > 1536) throw new Error('长期偏好回执格式无效。');
  return { replyRequestId: value.reply_request_id.toLowerCase(), candidates, contextEvidenceIds, expressionPreferenceIds, expressionPreferences,
    ...(value.basis_changes === undefined ? {} : { basisChanges: readReplyBasisChanges(value.basis_changes) }),
    ...(value.input_budget === undefined ? {} : { inputBudget: readInputBudget(value.input_budget, true) }),
    ...(value.used_skill === undefined ? {} : { usedSkill: readUsedSkill(value.used_skill) }) };
}
