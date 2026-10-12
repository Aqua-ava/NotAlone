// 仅传递后端同一预算守卫的纯元数据；桌面不估算或重新计量模型输入。
export interface AssistantInputBudget {
  state: 'ready' | 'warning' | 'exceeded' | 'unavailable';
  allowed: boolean;
  modelId: string;
  contextWindowTokens: number | null;
  inputTokens: number | null;
  outputReserveTokens: number | null;
  safetyMarginTokens: number;
  totalTokens: number | null;
  measurementKind: 'exact' | 'verified_upper_bound' | 'approximate' | null;
  measurementId: string | null;
  reason: string | null;
}

export interface AssistantInputBudgetNotice {
  contactId: string;
  scopeRevision: number;
  sessionId: string;
  requestKey: string;
  inputVersionId: string;
  connectionGeneration: number;
  operation: number;
  decision: AssistantInputBudget;
}
