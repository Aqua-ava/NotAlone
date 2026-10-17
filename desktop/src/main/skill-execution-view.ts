import { isUuid } from './uuid';

export function readSkillExecutionView(value: unknown): { policy_revision: number; method_ids: string[]; sha256: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('策略执行凭证无效。');
  const view = value as Record<string, unknown>;
  if (Object.keys(view).length !== 3 || !['policy_revision', 'method_ids', 'sha256'].every(key => Object.hasOwn(view, key))
    || !Number.isSafeInteger(view.policy_revision) || (view.policy_revision as number) < 0
    || !Array.isArray(view.method_ids) || view.method_ids.length < 1 || view.method_ids.length > 6 || !view.method_ids.every(isUuid)
    || new Set(view.method_ids.map(id => id.toLowerCase())).size !== view.method_ids.length
    || typeof view.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(view.sha256)) throw new Error('策略执行凭证无效。');
  return { policy_revision: view.policy_revision as number, method_ids: view.method_ids.map(id => id.toLowerCase()), sha256: view.sha256 };
}
