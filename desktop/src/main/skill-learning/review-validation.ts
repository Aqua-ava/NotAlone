import type { SkillComparison, SkillComparisonInput, SkillPublication, SkillPublicationScope, SkillReviewForm, SkillStrategyEdit } from '../../shared/skill-learning-bridge';
import { isUuid } from '../uuid';
import { readSkillExecutionView } from '../skill-execution-view';

export function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

function text(value: unknown, limit: number, complete: boolean): value is string {
  return typeof value === 'string' && value.length <= limit && (!complete || value.trim().length > 0);
}

export function readReviewInput(value: unknown, complete = true): SkillComparisonInput {
  if (!exactObject(value, ['incoming_text', 'intent', 'scene']) || !text(value.incoming_text, 8192, complete)
    || !text(value.intent, 4096, complete) || !text(value.scene, 256, complete)) throw new Error('请填写来话、当前意图和精确场景。');
  return { incoming_text: complete ? value.incoming_text.trim() : value.incoming_text,
    intent: complete ? value.intent.trim() : value.intent, scene: complete ? value.scene.trim() : value.scene };
}

export function readPublicationScope(value: unknown, contactId: string, scene?: string, complete = true): SkillPublicationScope {
  if (!exactObject(value, ['kind', 'contact_id', 'scene'])
    || !(value.kind === 'contact' && value.contact_id === contactId && value.scene === null
      || value.kind === 'owner' && value.contact_id === null && value.scene === null
      || value.kind === 'scene' && value.contact_id === null && text(value.scene, 256, complete)
        && (scene === undefined || (complete ? value.scene.trim() : value.scene) === scene))) throw new Error('请确认当前联系人、精确场景或本人通用范围。');
  return { kind: value.kind as SkillPublicationScope['kind'], contact_id: value.contact_id as string | null,
    scene: typeof value.scene === 'string' && complete ? value.scene.trim() : value.scene as string | null };
}

export function readStrategyEdit(value: unknown, complete = true): SkillStrategyEdit {
  if (!exactObject(value, ['name', 'description', 'scene', 'methods'])
    || !text(value.name, 64, complete) || complete && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.name)
    || !text(value.description, 1024, complete) || !text(value.scene, 256, complete)
    || !Array.isArray(value.methods) || value.methods.length < 1 || value.methods.length > 6
    || !value.methods.every(method => exactObject(method, ['key', 'title', 'instruction', 'replaces_method_ids'])
      && text(method.key, 64, complete) && (!complete || /^[a-z][a-z0-9-]{0,63}$/.test(method.key))
      && text(method.title, 256, complete) && text(method.instruction, 2048, complete)
      && Array.isArray(method.replaces_method_ids) && method.replaces_method_ids.length <= 48
      && method.replaces_method_ids.every(isUuid) && new Set(method.replaces_method_ids).size === method.replaces_method_ids.length)
    || complete && new Set(value.methods.map(method => method.key)).size !== value.methods.length) throw new Error('请填写有效且不重复的方法标识、名称和策略正文。');
  return structuredClone(value) as unknown as SkillStrategyEdit;
}

export function readReviewForm(value: unknown, contactId: string, complete = false): SkillReviewForm {
  if (!exactObject(value, ['strategy', 'input', 'scope'])) throw new Error('审核表单无效。');
  const input = readReviewInput(value.input, complete);
  return { strategy: readStrategyEdit(value.strategy, complete), input,
    scope: readPublicationScope(value.scope, contactId, input.scene, complete) };
}

export function sameInput(left: SkillComparisonInput, right: SkillComparisonInput) {
  return left.incoming_text === right.incoming_text && left.intent === right.intent && left.scene === right.scene;
}
export function sameScope(left: SkillPublicationScope, right: SkillPublicationScope) {
  return left.kind === right.kind && left.contact_id === right.contact_id && left.scene === right.scene;
}
export function sameStrategy(left: SkillStrategyEdit, right: SkillStrategyEdit) {
  return left.name === right.name && left.description === right.description && left.scene === right.scene
    && left.methods.length === right.methods.length && left.methods.every((method, index) => {
      const other = right.methods[index];
      return method.key === other.key && method.title === other.title && method.instruction === other.instruction
        && method.replaces_method_ids.length === other.replaces_method_ids.length
        && method.replaces_method_ids.every((id, position) => id === other.replaces_method_ids[position]);
    });
}

export function readComparison(value: unknown, contactId: string, revision: number): SkillComparison {
  if (!exactObject(value, ['comparison_id', 'draft_revision', 'input_version', 'input', 'scope', 'before', 'after', 'valid'])
    || !isUuid(value.comparison_id) || value.draft_revision !== revision || !isUuid(value.input_version)
    || typeof value.valid !== 'boolean') throw new Error('对照已变化，请重新生成。');
  const input = readReviewInput(value.input);
  const scope = readPublicationScope(value.scope, contactId, input.scene);
  for (const side of [value.before, value.after]) {
    const hasView = !!side && typeof side === 'object' && Object.hasOwn(side, 'execution_view');
    if (!exactObject(side, ['name', 'version_id', 'load_state', 'candidates', ...(hasView ? ['execution_view'] : [])])
      || !(side.name === null || text(side.name, 64, true)) || !(side.version_id === null || isUuid(side.version_id))
      || !['loaded', 'resource_failed', 'not_used'].includes(side.load_state as string)
      || (side.load_state === 'not_used' ? side.name !== null || side.version_id !== null : side.name === null || side.version_id === null)
      || !Array.isArray(side.candidates) || side.candidates.length < 1 || side.candidates.length > 3
      || !side.candidates.every(candidate => exactObject(candidate, ['text', 'basis', 'risk_notes'])
        && text(candidate.text, 24000, true) && text(candidate.basis, 4096, false)
        && Array.isArray(candidate.risk_notes) && candidate.risk_notes.length <= 20
        && candidate.risk_notes.every(note => text(note, 2048, true)))) throw new Error('对照结果无效，请重试。');
    if (hasView) {
      readSkillExecutionView(side.execution_view);
      if (side.load_state !== 'loaded') throw new Error('未加载的策略不能带执行凭证。');
    }
  }
  if ((value.after as Record<string, unknown>).version_id !== value.comparison_id) throw new Error('新侧策略不属于本次对照。');
  return { ...structuredClone(value), input, scope } as unknown as SkillComparison;
}

export function readPublication(value: unknown, contactId: string, scope: SkillPublicationScope): SkillPublication {
  if (!exactObject(value, ['skill_id', 'version_id', 'version_number', 'name', 'scope', 'revision'])
    || !isUuid(value.skill_id) || !isUuid(value.version_id) || !Number.isSafeInteger(value.version_number)
    || (value.version_number as number) < 1 || !text(value.name, 64, true)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || !sameScope(readPublicationScope(value.scope, contactId), scope)) throw new Error('发布回执无效，请刷新核验。');
  return structuredClone(value) as unknown as SkillPublication;
}
