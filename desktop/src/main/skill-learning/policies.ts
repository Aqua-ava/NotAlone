import { randomUUID } from 'node:crypto';
import type { ContactSelection } from '../../shared/contact-session-bridge';
import type { SkillPolicy, SkillPolicyState, SkillPublicationScope } from '../../shared/skill-learning-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import { isUuid } from '../uuid';
import { exactObject, sameScope } from './review-validation';

type Scope = ContactSelection & { generation: number };
export function readPolicyScope(value: unknown, contactId: string): SkillPublicationScope {
  if (!exactObject(value, ['kind', 'contact_id', 'scene'])
    || !(value.contact_id === null || value.contact_id === contactId)
    || !(value.kind === 'owner' && value.contact_id === null && value.scene === null
      || value.kind === 'contact' && value.contact_id === contactId && value.scene === null
      || value.kind === 'scene' && typeof value.scene === 'string' && value.scene.trim() === value.scene
        && value.scene.length > 0 && value.scene.length <= 256)) throw new Error('请明确反馈的联系人和场景范围。');
  return structuredClone(value) as unknown as SkillPublicationScope;
}
function readPolicies(value: unknown, contactId: string): Pick<SkillPolicyState, 'revision' | 'policies'> {
  if (!exactObject(value, ['revision', 'policies']) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || !Array.isArray(value.policies)) throw new Error('停用范围状态无效。');
  const policies = value.policies.map(item => {
    if (!exactObject(item, ['policy_id', 'skill_id', 'name', 'method_id', 'scope', 'revision'])
      || !isUuid(item.policy_id) || !isUuid(item.skill_id) || !(item.method_id === null || isUuid(item.method_id))
      || typeof item.name !== 'string' || !item.name.trim() || !Number.isSafeInteger(item.revision)
      || (item.revision as number) < 1 || (item.revision as number) > (value.revision as number)) throw new Error('停用目标状态无效。');
    return { ...structuredClone(item), scope: readPolicyScope(item.scope, contactId) } as unknown as SkillPolicy;
  });
  if (new Set(policies.map(item => item.policy_id)).size !== policies.length) throw new Error('停用目标重复。');
  return { revision: value.revision as number, policies } as Pick<SkillPolicyState, 'revision' | 'policies'>;
}
export class SkillPolicySession {
  private state: SkillPolicyState | null = null;
  private pending: AbortController | undefined;
  private operation = 0;
  private retry: { scope: Scope; body: Record<string, unknown>; suffix: string } | undefined;
  constructor(private readonly backend: BackendHost, private readonly scope: () => Scope | undefined,
    private readonly changed: (state: SkillPolicyState | null) => void) {}
  clear() { ++this.operation; this.pending?.abort(); this.pending = undefined; this.retry = undefined; this.state = null; this.changed(null); }
  async open(scope: Scope, background = false) {
    if (this.state?.phase === 'writing' || this.retry || background && this.pending) return;
    await this.perform(scope, undefined, '', background);
  }
  async change(scope: Scope, command: Record<string, unknown>) {
    if (this.state?.phase !== 'ready' || this.retry) throw new Error('请先核验当前停用范围。');
    await this.perform(scope, { ...command, expected_revision: this.state.revision, operation_key: randomUUID() });
  }
  async retryOriginal(scope: Scope) {
    if (!this.retry || this.retry.scope !== scope) throw new Error('没有待重试的原反馈动作。');
    await this.perform(scope, this.retry.body, this.retry.suffix);
  }
  async undo(scope: Scope, policyId: string) {
    if (this.state?.phase !== 'ready' || this.retry || !this.state.policies.some(item => item.policy_id === policyId)) throw new Error('请先核验要撤销的明确停用。');
    await this.perform(scope, { expected_revision: this.state.revision, operation_key: randomUUID() }, `/${policyId}/undo`);
  }
  private async perform(scope: Scope, body?: Record<string, unknown>, suffix = '', background = false) {
    const operation = ++this.operation; this.pending?.abort(); const pending = this.pending = new AbortController();
    const current = () => this.scope() === scope && operation === this.operation && scope.generation === this.backend.getConnectionGeneration();
    if (!(background && this.state?.phase === 'ready')) {
      this.publish({ phase: body ? 'writing' : 'loading', revision: this.state?.revision ?? 0, policies: [], error: null, retry: false });
    }
    if (body) this.retry = { scope, body, suffix };
    try {
      const result = await this.backend.requestJson({ method: body ? 'POST' : 'GET',
        path: `/api/contacts/${scope.contactId}/skill-learning/policies${suffix}`, body, signal: pending.signal });
      if (!current() || result.generation !== scope.generation) return;
      const policies = readPolicies(result.data, scope.contactId);
      if (body?.disabled === true && !policies.policies.some(item => item.skill_id === body.skill_id
        && item.method_id === body.method_id && sameScope(item.scope, body.scope as SkillPublicationScope))
        || suffix && policies.policies.some(item => suffix === `/${item.policy_id}/undo`)) throw new Error('反馈回执与原动作不符。');
      this.retry = undefined;
      this.publish({ phase: 'ready', ...policies, error: null, retry: false });
    } catch (error) {
      if (!current()) return;
      const unknown = !!body && !(error instanceof BackendRequestFailure && error.kind === 'response' && !!error.status && error.status < 500);
      if (!unknown) this.retry = undefined;
      this.publish({ phase: 'failed', revision: 0, policies: [], retry: unknown,
        error: unknown ? '反馈结果尚未确认，请重试原动作。' : '目标或范围已经变化，请重新核验。' });
    } finally { if (this.pending === pending) this.pending = undefined; }
  }
  private publish(state: SkillPolicyState) { this.state = state; this.changed(structuredClone(state)); }
}
