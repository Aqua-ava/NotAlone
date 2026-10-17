import { randomUUID } from 'node:crypto';
import type { ContactSelection } from '../../shared/contact-session-bridge';
import type { SkillHistoryState, SkillVersionHistory } from '../../shared/skill-learning-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import { isUuid } from '../uuid';
import { exactObject, readPublicationScope } from './review-validation';

type Scope = ContactSelection & { generation: number };
export class SkillHistorySession {
  private state: SkillHistoryState | null = null;
  private pending: AbortController | undefined;
  private operation = 0;
  private retry: { scope: Scope; skillId: string; body: Record<string, unknown> } | undefined;
  constructor(private readonly backend: BackendHost, private readonly scope: () => Scope | undefined,
    private readonly changed: (state: SkillHistoryState | null) => void) {}
  clear() {
    ++this.operation; this.pending?.abort(); this.pending = undefined; this.retry = undefined;
    this.state = null; this.changed(null);
  }
  async open(scope: Scope) {
    if (this.state?.phase === 'writing' || this.retry) return;
    await this.perform(scope);
  }
  async rollback(scope: Scope, skillId: string, versionId: string) {
    if (this.state?.phase !== 'ready' || this.retry) throw new Error('请先刷新版本历史。');
    const skill = this.state.skills.find(item => item.skill_id === skillId);
    if (!skill || !skill.versions.some(item => item.version_id === versionId && !item.is_current && item.enabled)) throw new Error('该版本当前不可回滚。');
    await this.perform(scope, skillId, { version_id: versionId, expected_revision: skill.revision,
      expected_current_version_id: skill.current_version_id, operation_key: randomUUID() });
  }
  async retryOriginal(scope: Scope) {
    if (!this.retry || this.retry.scope !== scope) throw new Error('没有可重试的原回滚动作。');
    await this.perform(scope, this.retry.skillId, this.retry.body);
  }
  private async perform(scope: Scope, skillId?: string, body?: Record<string, unknown>) {
    const operation = ++this.operation; this.pending?.abort(); const pending = this.pending = new AbortController();
    const current = () => this.scope() === scope && operation === this.operation && scope.generation === this.backend.getConnectionGeneration();
    this.publish({ phase: body ? 'writing' : 'loading', skills: this.state?.skills ?? [], error: null, retry: false });
    if (body) this.retry = { scope, skillId: skillId!, body };
    try {
      const result = await this.backend.requestJson({ method: body ? 'POST' : 'GET',
        path: `/api/contacts/${scope.contactId}/skill-learning/skills${body ? `/${skillId}/rollback` : ''}`,
        body, signal: pending.signal });
      if (!current() || result.generation !== scope.generation) return;
      let skills = body ? [readHistory(result.data, scope.contactId)] : readHistories(result.data, scope.contactId);
      if (body && (skills[0].skill_id !== skillId || skills[0].current_version_id !== body.version_id)) throw new Error('回滚回执与原动作不符。');
      if (body) {
        const currentList = await this.backend.requestJson({ method: 'GET',
          path: `/api/contacts/${scope.contactId}/skill-learning/skills`, signal: pending.signal });
        if (!current() || currentList.generation !== scope.generation) return;
        skills = readHistories(currentList.data, scope.contactId);
      }
      this.retry = undefined;
      this.publish({ phase: 'ready', skills, error: null, retry: false });
    } catch (error) {
      if (!current()) return;
      const unknown = !!body && !(error instanceof BackendRequestFailure && error.kind === 'response' && !!error.status && error.status < 500);
      if (!unknown) this.retry = undefined;
      this.publish({ phase: 'failed', skills: [], retry: unknown,
        error: unknown ? '回滚结果尚未确认，请重试原操作。' : '版本、范围或来源已变化，请重新打开历史核验。' });
    } finally { if (this.pending === pending) this.pending = undefined; }
  }
  private publish(state: SkillHistoryState) { this.state = state; this.changed(structuredClone(state)); }
}

function readHistories(value: unknown, contactId: string) {
  if (!exactObject(value, ['skills']) || !Array.isArray(value.skills)) throw new Error('版本目录无效。');
  const skills = value.skills.map(item => readHistory(item, contactId));
  if (new Set(skills.map(item => item.skill_id)).size !== skills.length) throw new Error('版本目录重复。');
  return skills;
}
function readHistory(value: unknown, contactId: string): SkillVersionHistory {
  if (!exactObject(value, ['skill_id', 'name', 'status', 'revision', 'current_version_id', 'versions'])
    || !isUuid(value.skill_id) || typeof value.name !== 'string' || !['active', 'disabled'].includes(value.status as string)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || !(value.current_version_id === null || isUuid(value.current_version_id)) || !Array.isArray(value.versions)) throw new Error('版本历史无效。');
  const versions = value.versions.map(item => {
    if (!exactObject(item, ['version_id', 'version_number', 'document', 'is_current', 'enabled', 'scope', 'methods', 'source_dependency_count'])
      || !isUuid(item.version_id) || !Number.isSafeInteger(item.version_number) || (item.version_number as number) < 1
      || typeof item.document !== 'string' || !item.document.trim() || typeof item.is_current !== 'boolean'
      || typeof item.enabled !== 'boolean' || !Number.isSafeInteger(item.source_dependency_count) || (item.source_dependency_count as number) < 0
      || !Array.isArray(item.methods) || !item.methods.every(method => exactObject(method, ['method_id', 'title', 'instruction', 'replaces_method_ids', 'mapping_state'])
        && isUuid(method.method_id) && typeof method.title === 'string' && typeof method.instruction === 'string'
        && ['new', 'confirmed'].includes(method.mapping_state as string) && Array.isArray(method.replaces_method_ids) && method.replaces_method_ids.every(isUuid))) throw new Error('版本内容无效。');
    readPublicationScope(item.scope, contactId);
    return structuredClone(item);
  });
  if (new Set(versions.map(item => item.version_id)).size !== versions.length
    || versions.filter(item => item.is_current).length !== (value.current_version_id ? 1 : 0)
    || value.current_version_id && !versions.some(item => item.is_current && item.version_id === value.current_version_id)) throw new Error('当前版本身份无效。');
  return { ...structuredClone(value), versions } as unknown as SkillVersionHistory;
}
