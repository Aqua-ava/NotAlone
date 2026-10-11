// continue澄清的有限传输契约；不依赖主进程客户端或持久状态。

export const ASSISTANT_CONTINUATION_RESPONSE_LIMIT = 1_048_576;

export type RequirementChange =
  | { action: 'keep' | 'remove'; previous: string }
  | { action: 'replace'; previous: string; replacement: string }
  | { action: 'add'; replacement: string };
export type RequirementClarificationOption =
  | Readonly<{ requirement: string; origin: 'existing'; actions: readonly ['keep', 'replace', 'remove'] }>
  | Readonly<{ requirement: string; origin: 'new'; actions: readonly ['add'] }>;
const clarificationReasons = [
  'candidate_session_mismatch', 'candidate_group_missing', 'candidate_frame_ambiguous',
  'candidate_group_unavailable', 'candidate_version_unavailable', 'completed_generation_required',
  'candidate_number_missing', 'candidate_number_unclear', 'candidate_reference_ambiguous',
  'requirements_need_confirmation', 'requirements_conflict', 'requirement_change_stale',
  'intention_conflict',
] as const;
export interface AssistantContinuationClarification {
  readonly reason: typeof clarificationReasons[number];
  readonly requirements: readonly string[];
  readonly requirement_options: readonly RequirementClarificationOption[];
  readonly requirement_actions: readonly RequirementChange['action'][];
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function withinResponseLimit(value: unknown): boolean {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= ASSISTANT_CONTINUATION_RESPONSE_LIMIT; }
  catch { return false; }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

// 只解析当前已授权continue的有限澄清；拒绝附带正文、未知字段及不适用于该要求的动作。
export function readAssistantContinuationClarification(value: unknown): AssistantContinuationClarification | undefined {
  if (!isRecord(value) || !withinResponseLimit(value) || !exactKeys(value, ['error', 'clarification'])
    || value.error !== 'assistant_continuation_clarification_required' || !isRecord(value.clarification)) return undefined;
  const clarification = value.clarification;
  if (!exactKeys(clarification, ['reason', 'requirements', 'requirement_options', 'requirement_actions'])
    || typeof clarification.reason !== 'string' || !clarificationReasons.some((reason) => reason === clarification.reason)
    || !Array.isArray(clarification.requirements)
    || !clarification.requirements.every((item) => typeof item === 'string' && item.trim() === item && Boolean(item))
    || new Set(clarification.requirements).size !== clarification.requirements.length
    || !Array.isArray(clarification.requirement_options)
    || clarification.requirement_options.length !== clarification.requirements.length) return undefined;
  const options: RequirementClarificationOption[] = [];
  for (const [index, item] of clarification.requirement_options.entries()) {
    if (!isRecord(item) || !exactKeys(item, ['requirement', 'origin', 'actions'])
      || item.requirement !== clarification.requirements[index]) return undefined;
    if (item.origin === 'existing' && sameStrings(item.actions, ['keep', 'replace', 'remove'])) {
      options.push(Object.freeze({ requirement: item.requirement as string, origin: 'existing',
        actions: Object.freeze(['keep', 'replace', 'remove'] as const) }));
    } else if (item.origin === 'new' && sameStrings(item.actions, ['add'])) {
      options.push(Object.freeze({ requirement: item.requirement as string, origin: 'new', actions: Object.freeze(['add'] as const) }));
    } else return undefined;
  }
  const actions = [...new Set(options.flatMap((option) => [...option.actions]))];
  if (!sameStrings(clarification.requirement_actions, actions)) return undefined;
  return Object.freeze({ reason: clarification.reason as AssistantContinuationClarification['reason'],
    requirements: Object.freeze([...clarification.requirements] as string[]),
    requirement_options: Object.freeze(options), requirement_actions: Object.freeze(actions) });
}
