import { isUuid } from '../uuid';

type Observation = {
  observationId: string;
  observedAt: string;
  recognizedName: string | null;
  recognitionConfidence: number | null;
  phase: 'confirmed' | 'paused' | 'manual-required' | 'unavailable';
  reason: string;
  probeAvailable: boolean;
  wechatInFront: boolean;
  contactId: string | null;
};

// 只有confirmed允许身份，且必须同时包含稳定绑定及联系人。
export function foregroundObservation(value: unknown): Observation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('前台观察不可用。');
  const result = value as Record<string, unknown>;
  const keys = ['observation_id', 'observed_at', 'phase', 'reason', 'probe_available', 'wechat_in_front', 'binding_id', 'contact_id'];
  const hasName = Object.hasOwn(result, 'recognized_name');
  if (hasName) keys.push('recognized_name', 'recognition_confidence');
  if (Object.keys(result).length !== keys.length || !Object.keys(result).every((key) => keys.includes(key))
    || !isUuid(result.observation_id) || typeof result.observed_at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(result.observed_at)
    || !Number.isFinite(Date.parse(result.observed_at))
    || !['confirmed', 'paused', 'manual-required', 'unavailable'].includes(result.phase as string)
    || typeof result.reason !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(result.reason)
    || typeof result.probe_available !== 'boolean' || typeof result.wechat_in_front !== 'boolean'
    || (result.phase === 'confirmed'
      ? (!isUuid(result.binding_id) || !isUuid(result.contact_id) || !result.probe_available
        || !result.wechat_in_front || !['confirmed_active_binding', 'confirmed_active_binding_emoji_fallback'].includes(result.reason as string))
      : (result.binding_id !== null || result.contact_id !== null))
    || (result.phase === 'manual-required' && (!result.probe_available || !result.wechat_in_front))
    || (result.phase === 'unavailable' && result.probe_available)
    || (hasName && (typeof result.recognized_name !== 'string' || !result.recognized_name.trim()
      || result.recognized_name.length > 256 || /[\r\n]/.test(result.recognized_name)
      || typeof result.recognition_confidence !== 'number' || !Number.isFinite(result.recognition_confidence)
      || result.recognition_confidence < 0 || result.recognition_confidence > 1
      || !result.wechat_in_front || !result.probe_available
      || !['confirmed', 'manual-required'].includes(result.phase as string)))) throw new Error('前台观察不可用。');
  return { observationId: (result.observation_id as string).toLowerCase(), observedAt: result.observed_at,
    recognizedName: hasName ? result.recognized_name as string : null,
    recognitionConfidence: hasName ? result.recognition_confidence as number : null,
    phase: result.phase as Observation['phase'], reason: result.reason,
    probeAvailable: result.probe_available, wechatInFront: result.wechat_in_front,
    contactId: result.phase === 'confirmed' ? (result.contact_id as string).toLowerCase() : null };
}
