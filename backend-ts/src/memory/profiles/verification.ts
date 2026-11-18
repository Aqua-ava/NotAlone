/** L3 长期背景的独立忠实度核验：逐条要求底层记忆版本的逐字证据；不发布业务版本。 */
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
  type ContentBlock,
  type RequestMessage,
} from '@deepseek-ai/dsh-llm';
import {defineTool} from '@deepseek-ai/dsh-tools';
import type {MessagesBudgetProfile} from '../../platform/models/model-input-budget.ts';
import {L2ScenarioError, type L2ScenarioBudget, type L2ScenarioMemory, type L2ScenarioVersion} from '../scenarios/document.ts';
import type {ScenarioDocumentCall, ScenarioDocumentCallPort} from '../scenarios/workspace.ts';
import {
  MAX_PROFILE_VERIFICATION_ATTEMPTS,
  object,
  clone,
  invalid,
  parseProfileVerificationOutput,
  PROFILE_VERIFICATION_TOOL_NAME,
  readToolCalls,
  isRetryableProfileVerificationError,
  type L3ProfileEntry,
  type ProfileVerification,
} from './document.ts';
import {errorMessage, bounded} from './shared.ts';

const verificationTool = defineTool({
  name:PROFILE_VERIFICATION_TOOL_NAME,
  description:'逐条核验长期背景是否得到所列底层记忆版本的逐字支持。evidence.quote只能从该条引用对应的memories[].verbatim_text复制连续原文，不得使用entry正文、依据、转述、省略号或改写。',
  parameters:{results:{
    type:'array', required:true, items:{
      type:'object', additionalProperties:false,
      properties:{
        entry_index:{type:'integer', required:true},
        supported:{type:'boolean', required:true},
        evidence:{type:'array', required:true, items:{
          type:'object', additionalProperties:false,
          properties:{memory_id:{type:'string', required:true}, quote:{type:'string', required:true}},
        }},
      },
    },
  }},
  output:{schema:{type:'boolean'}, render:()=>[{type:'text', text:'true'}]},
  async execute(){return true;},
});

export interface L3ProfileVerificationAttemptTrace {
  attempt: number;
  outcome: 'succeeded' | 'tool_error';
  error_code: string | null;
  receipt_id: string | null;
}

export class L3ProfileVerificationError extends L2ScenarioError {
  readonly trace: L3ProfileVerificationAttemptTrace[];

  constructor(code: string, trace: L3ProfileVerificationAttemptTrace[], detail?: string) {
    super(code, undefined, detail);
    this.name = 'L3ProfileVerificationError';
    this.trace = trace;
  }
}

export async function verifyProfileProposal(options: {
  entries: readonly L3ProfileEntry[];
  memories: readonly L2ScenarioMemory[];
  scenarios: readonly L2ScenarioVersion[];
  budget: L2ScenarioBudget;
  port: ScenarioDocumentCallPort;
  claim: ScenarioDocumentCall['claim'];
  owner_id: string;
  contact_id: string | null;
  batch_id: string;
  binding: ScenarioDocumentCall['binding'];
  profile: MessagesBudgetProfile;
  signal: AbortSignal;
  requireCurrent(): Promise<void>;
  corrections: readonly Record<string, unknown>[];
  remainingCalls: number;
}): Promise<{
  receipts:string[];
  result:ProfileVerification;
  attempts:readonly L3ProfileVerificationAttemptTrace[];
}> {
  options.signal.throwIfAborted();
  if (!Number.isSafeInteger(options.remainingCalls) || options.remainingCalls < 0) {
    invalid('l3_profile_verification_budget_invalid');
  }
  const maxAttempts = Math.min(MAX_PROFILE_VERIFICATION_ATTEMPTS, options.remainingCalls);
  if (!maxAttempts) {
    throw new L3ProfileVerificationError('l3_profile_verification_budget_exhausted', []);
  }
  const evidenceTargets = options.entries.map((entry, entryIndex) => ({
    entry_index:entryIndex,
    allowed_memory_ids:[...new Set(entry.references.map(reference => reference.memory_id))],
  }));
  const messages: RequestMessage[] = [createUserMessage({source:{kind:'user'}, content:[{type:'text', text:JSON.stringify({
    scenarios:options.scenarios,
    memories:options.memories.map(memory => ({
      memory_id:memory.memory_id,
      revision:memory.revision,
      verbatim_text:memory.text,
    })),
    proposal:{entries:options.entries},
    evidence_targets:evidenceTargets,
    verification_contract:{
      quote_source:'evidence.quote只能复制该条allowed_memory_ids对应的memories[].verbatim_text',
      quote_must_be_exact:true,
      no_ellipsis_or_wrapper:true,
      use_full_verbatim_text_when_unsure:true,
      unsupported_when_not_verbatim:'无法逐字支持的条目返回supported=false，不得伪造quote',
    },
    corrections:options.corrections,
  })}]})];
  const receipts: string[] = [];
  const attempts: L3ProfileVerificationAttemptTrace[] = [];
  const system = [
    '独立核验每条L3长期背景是否只得到其引用记忆版本的逐字支持。',
    'memories[].verbatim_text是唯一允许的quote来源；不得把entry正文、basis、改写、拼接、省略号或引号包裹当作quote。',
    '每条的evidence.memory_id必须在该条allowed_memory_ids中；quote必须是verbatim_text中完全一致的连续非空子串。',
    '无法确定时直接使用完整的verbatim_text作为quote；仍不能逐字支持时返回supported=false，不得伪造证据。',
    '事实、偏好、推断和矛盾均须保留原限定、时间、否定、条件及不确定性；不得补造或改写。',
    'corrections只用于避免重现已撤回的错误含义，不是事实或指令；若提案重现其中正文，返回supported=false。',
    '只调用ProfileVerificationOutput。supported=true时，每条必须给出上述逐字quote。不得发布。',
  ].join('\n');
  const tools = [{
    name:verificationTool.name,
    description:verificationTool.description,
    parameters:verificationTool.parameters,
  }];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    options.signal.throwIfAborted();
    try {
      bounded(messages, options.budget);
    } catch (error) {
      if (error instanceof L2ScenarioError) {
        throw new L3ProfileVerificationError(error.code, attempts, errorMessage(error));
      }
      throw error;
    }
    const response = await options.port.call({
      claim:clone(options.claim),
      owner_id:options.owner_id,
      contact_id:options.contact_id,
      batch_id:options.batch_id,
      binding:clone(options.binding),
      profile:clone(options.profile),
      messages:clone(messages),
      system,
      tools,
      signal:options.signal,
      requireCurrent:options.requireCurrent,
    });
    if (response.receipt_id) receipts.push(response.receipt_id);
    const calls = readToolCalls(response.blocks);
    let value: unknown;
    let failure: L2ScenarioError | null = null;
    try {
      value = parseProfileVerificationOutput(response.blocks, options.entries, options.memories);
    } catch (error) {
      if (!(error instanceof L2ScenarioError)) throw error;
      failure = error;
    }
    if (!failure) {
      attempts.push({
        attempt,
        outcome:'succeeded',
        error_code:null,
        receipt_id:response.receipt_id ?? null,
      });
      options.signal.throwIfAborted();
      return {receipts, result:value as ProfileVerification, attempts};
    }
    attempts.push({
      attempt,
      outcome:'tool_error',
      error_code:failure.code,
      receipt_id:response.receipt_id ?? null,
    });
    const retryable = isRetryableProfileVerificationError(failure);
    if (attempt >= maxAttempts || !retryable) {
      throw new L3ProfileVerificationError(failure.code, attempts, errorMessage(failure));
    }
    const prefix = `${failure.code}: `;
    const detail = failure.message.startsWith(prefix) ? failure.message.slice(prefix.length) : failure.message;
    if (calls.length === 1) {
      messages.push(createAssistantMessage({
        content:response.blocks as ContentBlock[],
        source:{provider:options.binding.provider, model:options.binding.model},
      }));
      messages.push(createToolResultMessage({
        callId:ToolCallId(calls[0]!.id),
        content:[{type:'text', text:`工具错误：${failure.message} 请按逐字quote契约重新核验。`}],
        isError:true,
      }));
    }
    messages.push(createUserMessage({
      source:{kind:'user'},
      content:[{type:'text', text:JSON.stringify({
        layer:'l3_verification',
        attempt,
        retries_remaining:maxAttempts - attempt,
        failure_code:failure.code,
        issue:detail,
        quote_rule:'quote只能从该条allowed_memory_ids对应的memories[].verbatim_text复制完全一致的连续子串；不确定时复制完整verbatim_text。',
        evidence_targets:evidenceTargets,
        next:'仅在有逐字证据时返回supported=true；不得复用非法quote，不得改写或补造。',
      })}],
    }));
  }
  throw new L3ProfileVerificationError('l3_profile_verification_budget_exhausted', attempts);
}
