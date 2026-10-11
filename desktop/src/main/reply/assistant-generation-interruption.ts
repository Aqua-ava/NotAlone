import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import { readAssistantGenerationReceipt, type AssistantGenerationOwner, type AssistantGenerationStopping, type AssistantGenerationIdentity, type AssistantGenerationReceipt, type PendingAssistantGenerationReceipt } from './assistant-generation-jobs';
import { readAssistantSession } from './assistant-sessions';
import { isRecord } from './result-read';

// 只使用已认证连接与实际回执；退出不提交输入正文，也不创建新请求。
export async function interruptAssistantGeneration(backend: Pick<BackendHost, 'getConnectionGeneration' | 'requestJson'>, receipt: PendingAssistantGenerationReceipt): Promise<void> {
  if (backend.getConnectionGeneration() !== receipt.connectionGeneration) throw new Error('退出生成归属尚未确认。');
  const path = `/api/contacts/${receipt.contactId}/assistant-sessions/${receipt.sessionId}`;
  try {
    const response = await backend.requestJson({ method: 'POST', path: `${path}/interrupt`,
      body: { request_key: receipt.requestKey, input_version_id: receipt.inputVersionId }, maxResponseBytes: 4096 });
    const value = response.data;
    if (response.generation !== receipt.connectionGeneration || !isRecord(value)
      || Object.keys(value).length !== 6 || !Object.hasOwn(value, 'interruption_reason')) throw new Error('退出生成未获确认。');
    const { interruption_reason: reason, ...identity } = value;
    const stopped = readAssistantGenerationReceipt(identity, receipt.sessionId, receipt.requestKey);
    if (stopped.turnId !== receipt.turnId || stopped.inputVersionId !== receipt.inputVersionId
      || !(stopped.state === 'completed' && reason === null || stopped.state === 'failed' && (reason === 'app_quit' || reason === null))) {
      throw new Error('退出生成未获确认。');
    }
  } catch (error) {
    if (!(error instanceof BackendRequestFailure && error.kind === 'response'
      && (error.status === 404 && error.code === 'not_found'
        || error.status === 409 && error.code === 'assistant_session_rejected'))
      || backend.getConnectionGeneration() !== receipt.connectionGeneration) throw error;
    // 删除先赢时只接受权威无正文占位或会话不存在；其他拒绝不能伪装成成功中断。
    try {
      const saved = await readAssistantSession(backend, receipt.contactId, receipt.sessionId, new AbortController().signal);
      const turn = saved.turns.find((item) => item.turnId === receipt.turnId && item.requestKey === receipt.requestKey
        && item.inputVersionId === receipt.inputVersionId);
      if (saved.generation === receipt.connectionGeneration && turn && ['redacted', 'unavailable'].includes(turn.state)
        && turn.input === null && turn.reply === null) return;
    } catch (readError) {
      if (readError instanceof BackendRequestFailure && readError.status === 404 && readError.code === 'not_found'
        && backend.getConnectionGeneration() === receipt.connectionGeneration) return;
      throw readError;
    }
    throw error;
  }
}

// 回执丢失后只在明确退出重试读取原会话；实际请求键唯一匹配，不能猜 turn/input 或创建新输入。
export async function recoverAssistantGenerationReceipt(backend: Pick<BackendHost, 'getConnectionGeneration' | 'requestJson'>,
  identity: AssistantGenerationIdentity): Promise<AssistantGenerationReceipt | null> {
  if (backend.getConnectionGeneration() !== identity.connectionGeneration) throw new Error('退出生成归属尚未确认。');
  try {
    const saved = await readAssistantSession(backend, identity.contactId, identity.sessionId, new AbortController().signal);
    const turns = saved.turns.filter((item) => item.requestKey === identity.requestKey);
    if (saved.generation !== identity.connectionGeneration || turns.length !== 1) throw new Error('退出生成身份尚未读到。');
    const turn = turns[0]!;
    if (['redacted', 'unavailable'].includes(turn.state) && turn.input === null && turn.reply === null) return null;
    return readAssistantGenerationReceipt({ session_id: identity.sessionId, turn_id: turn.turnId,
      input_version_id: turn.inputVersionId, request_key: identity.requestKey, state: turn.state }, identity.sessionId, identity.requestKey);
  } catch (error) {
    if (error instanceof BackendRequestFailure && error.kind === 'response' && error.status === 404 && error.code === 'not_found'
      && backend.getConnectionGeneration() === identity.connectionGeneration) return null;
    throw error;
  }
}

// 同一 registry 只保存此无正文停止句柄；凭据留在原 Host 的认证客户端内。
export function captureAssistantGenerationStopping(backend: BackendHost, owner: AssistantGenerationOwner):
  AssistantGenerationStopping | undefined {
  const original = backend.captureAssistantStoppingConnection?.(owner);
  return original && { interrupt: (receipt) => interruptAssistantGeneration(original, receipt),
    recover: (identity) => recoverAssistantGenerationReceipt(original, identity) };
}
