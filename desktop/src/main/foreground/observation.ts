import { isUuid } from '../uuid';

type Observation = {
  observationId: string;
  observedAt: string;
  phase: 'paused' | 'manual-required' | 'unavailable';
  reason: string;
  probeAvailable: boolean;
  wechatInFront: boolean;
};

// 首片尚不支持自动采纳；任何非空身份或未知阶段均失败关闭。
export function foregroundObservation(value: unknown): Observation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('前台观察不可用。');
  const result = value as Record<string, unknown>;
  const keys = ['observation_id', 'observed_at', 'phase', 'reason', 'probe_available', 'wechat_in_front', 'binding_id', 'contact_id'];
  if (Object.keys(result).length !== keys.length || !Object.keys(result).every((key) => keys.includes(key))
    || !isUuid(result.observation_id) || typeof result.observed_at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(result.observed_at)
    || !Number.isFinite(Date.parse(result.observed_at))
    || !['paused', 'manual-required', 'unavailable'].includes(result.phase as string)
    || typeof result.reason !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(result.reason)
    || typeof result.probe_available !== 'boolean' || typeof result.wechat_in_front !== 'boolean'
    || result.binding_id !== null || result.contact_id !== null
    || (result.phase === 'manual-required' && (!result.probe_available || !result.wechat_in_front))
    || (result.phase === 'unavailable' && result.probe_available)) throw new Error('前台观察不可用。');
  return { observationId: (result.observation_id as string).toLowerCase(), observedAt: result.observed_at,
    phase: result.phase as Observation['phase'], reason: result.reason,
    probeAvailable: result.probe_available, wechatInFront: result.wechat_in_front };
}
