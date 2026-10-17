import type { BackendHost } from '../backend/host';
import type { SavedAssistantTurn } from '../../shared/assistant-session';
import { readAssistantGenerationReceipt } from './assistant-generation-jobs';
import { isRecord } from './result-read';

// 明确重新准备前只核对原无正文身份，不提交旧正文或创建第二次生成。
export async function checkPreparationFormat(backend: BackendHost, contactId: string, sessionId: string,
  turn: SavedAssistantTurn, signal: AbortSignal) {
  const generation = backend.getConnectionGeneration();
  const response = await backend.requestJson({ method: 'POST',
    path: `/api/contacts/${contactId}/assistant-sessions/${sessionId}/preparation-format`,
    body: { request_key: turn.requestKey, input_version_id: turn.inputVersionId }, signal });
  const value = response.data;
  if (response.generation !== generation || backend.getConnectionGeneration() !== generation
    || !isRecord(value) || Object.keys(value).length !== 6
    || !['compatible', 'reprepare_required', 'generation_running', 'generation_unconfirmed'].includes(value.format_status as string)) {
    throw new Error('原准备归属尚未确认，请重新读取讨论。');
  }
  const { format_status: formatStatus, ...identity } = value;
  const receipt = readAssistantGenerationReceipt(identity, sessionId, turn.requestKey);
  if (receipt.turnId !== turn.turnId || receipt.inputVersionId !== turn.inputVersionId
    || formatStatus === 'reprepare_required' && receipt.state !== 'failed') {
    throw new Error('原准备归属尚未确认，请重新读取讨论。');
  }
  return { receipt, formatStatus, generation };
}
