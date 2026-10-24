/** 只解析宿主注入的模型环境；认证、提供者生命周期和业务许可仍由宿主装配。 */
import {normalizeApiKey} from '@deepseek-ai/dsh-llm';
import {PUBLIC_BASE_URL, resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import type {DeepSeekAdapterOptions, DeepSeekConnectionOptions} from '@deepseek-ai/dsh-llm-deepseek';

export type HostReplyEnvironment = Readonly<Record<string, string | undefined>>;
export type HostReplyThinkingEffort = 'low' | 'high' | 'max';
export interface HostReplyConfigOptions {
  replyThinkingEffort?: HostReplyThinkingEffort | null;
}
export interface HostMessagesProviderConfiguration {
  provider: string;
  connection: DeepSeekConnectionOptions;
  resolveAuth: DeepSeekAdapterOptions['resolveAuth'];
}
export interface HostReplyModelConfiguration {
  provider: string;
  model: string;
  maxTokens: number;
  temperature: number;
  reasoningEffort: 'off' | HostReplyThinkingEffort;
  physical_limit: number;
  deadline_ms: number;
  warning_ratio: number;
  budgetProfile: {context_window_tokens: number; safety_margin_tokens: number};
}
export type HostReplyUnavailableCode =
  | 'reply_model_unconfigured'
  | 'reply_model_configuration_invalid'
  | 'reply_thinking_configuration_invalid'
  | 'input_budget_unavailable'
  | 'ecnu_provider_retired';
export type HostReplyConfiguration = {
  status: 'configured';
  provider: HostMessagesProviderConfiguration;
  model: HostReplyModelConfiguration;
} | {
  status: 'unavailable';
  code: HostReplyUnavailableCode;
};

const DEFAULT_MODEL = 'deepseek-flash';
const LEGACY_OFFICIAL_ROOT = 'https://api.deepseek.com';
const ECNU_BASE_URL = 'https://chat.ecnu.edu.cn/open/api/v1';
const OUTPUT_RESERVE_TOKENS = 4096;
const CONTEXT_WINDOW_TOKENS = 1048576;
const SAFETY_MARGIN_TOKENS = 65536;
const PROVIDER = 'notalone-deepseek';

/** 配置成功只表示可装配；实际发送仍须经过05的最终载荷计量、额度和来源守卫。 */
export function resolveHostReplyConfiguration(
  environment: HostReplyEnvironment,
  options: HostReplyConfigOptions = {},
): HostReplyConfiguration {
  // Python的空模型环境值回到默认；空白模型及显式空URL仍拒绝。
  const model = environment.NOTALONE_DEEPSEEK_MODEL || DEFAULT_MODEL;
  const rawBaseURL = environment.NOTALONE_DEEPSEEK_BASE_URL ?? LEGACY_OFFICIAL_ROOT;
  if (typeof model !== 'string' || !model.trim()
    || typeof rawBaseURL !== 'string' || !rawBaseURL.trim()) {
    return unavailable('reply_model_configuration_invalid');
  }
  const baseURL = rawBaseURL.replace(/\/+$/, '');
  // 用户已废除ECNU；旧模型或已知旧入口都要求显式改配置，不自动换供应商。
  if (model === 'ecnu-max' || baseURL === ECNU_BASE_URL) return unavailable('ecnu_provider_retired');

  const rawKey = environment.NOTALONE_DEEPSEEK_API_KEY;
  if (typeof rawKey !== 'string') return unavailable('reply_model_unconfigured');
  const key = normalizeApiKey(rawKey);
  if (!key.ok) return unavailable(key.reason === 'empty'
    ? 'reply_model_unconfigured' : 'reply_model_configuration_invalid');
  const effort = options.replyThinkingEffort;
  if (effort != null && effort !== 'low' && effort !== 'high' && effort !== 'max') {
    return unavailable('reply_thinking_configuration_invalid');
  }
  if (model !== DEFAULT_MODEL
    || (baseURL !== LEGACY_OFFICIAL_ROOT && baseURL !== `${LEGACY_OFFICIAL_ROOT}/v1`)) {
    return unavailable('input_budget_unavailable');
  }

  const reasoningEffort = effort ?? 'off';
  const connection = resolveAdapterOptions({
    // root/v1是旧Chat Completions入口；原生DSH接收官方Messages入口，不能直接拼旧URL。
    baseURL: PUBLIC_BASE_URL,
    thinking: reasoningEffort === 'off' ? 'disabled' : 'enabled',
    reasoningEffort,
    maxTokens: OUTPUT_RESERVE_TOKENS,
    defaultContextWindow: CONTEXT_WINDOW_TOKENS,
    models: [{id: DEFAULT_MODEL, contextWindow: CONTEXT_WINDOW_TOKENS,
      maxTokens: OUTPUT_RESERVE_TOKENS, inputModalities: ['text']}],
    // 旧SDK单次超时为60秒；回复服务的20秒总截止必须另外传入每次调用的signal。
    streamIdleTimeoutMs: 60000,
    retryPolicy: {mode: 'normal', maxRetries: 0},
  });
  return {
    status: 'configured',
    provider: {
      provider: PROVIDER,
      connection,
      resolveAuth: async requestConnection => {
        if (requestConnection.baseURL !== PUBLIC_BASE_URL) throw new Error('reply_auth_route_mismatch');
        return {headers: {'x-api-key': key.value}};
      },
    },
    model: {
      provider: PROVIDER, model: DEFAULT_MODEL, maxTokens: OUTPUT_RESERVE_TOKENS,
      temperature: 0, reasoningEffort,
      // 两层场景预算各至多8；业务层仍须按请求执行min(24, 8 + 实际call_limit)。
      physical_limit: 24, deadline_ms: 20000, warning_ratio: 0.8,
      budgetProfile: {context_window_tokens: CONTEXT_WINDOW_TOKENS,
        safety_margin_tokens: SAFETY_MARGIN_TOKENS},
    },
  };
}

function unavailable(code: HostReplyUnavailableCode): HostReplyConfiguration {
  return {status: 'unavailable', code};
}
