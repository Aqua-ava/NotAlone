export interface Scope { owner_id: string; contact_id: string }
export interface Candidate { text: string; evidence: string }

/** 合成范围验证夹具，不连接真实业务存储。 */
const sources = new Map([
  ['owner-a/contact-1', 'source-a1'], ['owner-a/contact-2', 'source-a2'],
  ['owner-b/contact-1', 'source-b1'], ['owner-b/contact-2', 'source-b2'],
]);
export function verifyScope(input: Scope): string {
  const source = sources.get(`${input.owner_id}/${input.contact_id}`);
  if (!source) throw new Error('SCOPE_DENIED');
  return source;
}
export function validateCandidate(raw: string, source: string): Candidate {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('INVALID_OUTPUT'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'evidence,text'
    || !('text' in value) || !('evidence' in value) || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 1000 || value.evidence !== source) {
    throw new Error('INVALID_OUTPUT');
  }
  return { text: value.text, evidence: source };
}

export function revokeScope(scope: Scope) {
  return sources.delete(`${scope.owner_id}/${scope.contact_id}`);
}
