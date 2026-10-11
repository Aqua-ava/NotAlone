// 同事务未领取证明只包含范围与请求身份，不传错误原文或正文。
export interface AssistantNoGenerationProof {
  readonly contactId: string;
  readonly sessionId: string;
  readonly requestKey: string;
  readonly state: 'not_reserved';
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

export function readAssistantNoGenerationProof(value: unknown, status: number,
  expected: { contactId: string; sessionId: string; requestKey: unknown }): AssistantNoGenerationProof | undefined {
  if (!record(value) || !uuid(expected.requestKey)
    || !(status === 404 && value.error === 'not_found' && exact(value, ['error', 'no_generation'])
      || status === 409 && value.error === 'assistant_session_input_conflict' && exact(value, ['error', 'no_generation'])
      || status === 409 && value.error === 'assistant_session_rejected' && exact(value, ['error', 'reason', 'no_generation'])
        && typeof value.reason === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value.reason))
    || !record(value.no_generation)) return undefined;
  const proof = value.no_generation;
  if (!exact(proof, ['contact_id', 'session_id', 'request_key', 'state']) || proof.state !== 'not_reserved'
    || proof.contact_id !== expected.contactId || proof.session_id !== expected.sessionId
    || proof.request_key !== expected.requestKey || !uuid(proof.contact_id) || !uuid(proof.session_id)) return undefined;
  return Object.freeze({ contactId: proof.contact_id, sessionId: proof.session_id,
    requestKey: expected.requestKey, state: 'not_reserved' });
}
