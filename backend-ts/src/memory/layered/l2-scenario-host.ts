/** 独立宿主接线候选：只装配 L2 业务、DSH LLM 与既有 ModelHost，不修改共享主宿主。 */
import type {Context} from '@deepseek-ai/cordis';
import type {Client} from 'pg';
import type {installModelProvider} from '../../platform/models/model-provider.ts';
import type {ExtractionPermitEndpoint} from '../extraction/extraction-model.ts';
import type {MessagesBudgetProfile} from '../../platform/models/model-input-budget.ts';
import {
  createL2ScenarioModel,
  createL2ScenarioCallPort,
} from './l2-scenario-model.ts';
import {
  L2ScenarioService,
  type L2ScenarioClaim,
  type L2ScenarioPreparedWork,
  type L2ScenarioQualityReader,
  type L2ScenarioServiceOptions,
} from './l2-scenario-service.ts';
import type {L2ScenarioBudget, L2ScenarioScope} from './l2-scenario-workspace.ts';

export interface L2ScenarioHostOptions {
  ctx: Context;
  transaction: L2ScenarioServiceOptions['transaction'];
  provider: ReturnType<typeof installModelProvider>;
  permit: ExtractionPermitEndpoint;
  binding: L2ScenarioServiceOptions['binding'];
  profile: MessagesBudgetProfile;
  budget?: L2ScenarioBudget;
  validateSources?: L2ScenarioServiceOptions['validateSources'];
  quality?: L2ScenarioQualityReader;
  costForUsage?: Parameters<typeof createL2ScenarioModel>[0]['costForUsage'];
  now?: () => Date;
}

export interface L2ScenarioHostCandidate {
  service: L2ScenarioService;
  prepare(scope: L2ScenarioScope, claim: L2ScenarioClaim): Promise<L2ScenarioPreparedWork|null>;
  run(scope: L2ScenarioScope, claim: L2ScenarioClaim, signal: AbortSignal): Promise<{
    state: Record<string, any>;
    status: 'completed'|'idle';
    processed_count: number;
  }>;
  read(scope: L2ScenarioScope, mappingCursor?: string|null): Promise<Record<string, any>>;
}

/**
 * 固定唯一物理调用桥：每次 DSH `prepareCall` 前领取后台 permit，
 * `beforeDispatch` 内通过现有 accounting 做 reservation。
 */
export function createL2ScenarioHost(options: L2ScenarioHostOptions): L2ScenarioHostCandidate {
  const physical = createL2ScenarioModel({
    ctx: options.ctx,
    provider: options.provider,
    permit: options.permit,
    ...(options.costForUsage ? {costForUsage: options.costForUsage} : {}),
  });
  const service = new L2ScenarioService({
    transaction: options.transaction,
    model: createL2ScenarioCallPort(physical),
    binding: options.binding,
    profile: options.profile,
    ...(options.budget ? {budget: options.budget} : {}),
    ...(options.now ? {now: options.now} : {}),
    ...(options.validateSources ? {validateSources: options.validateSources} : {}),
    ...(options.quality ? {quality: options.quality} : {}),
  });
  return {
    service,
    prepare: (scope, claim) => service.prepare(scope, claim),
    run: (scope, claim, signal) => service.run(scope, claim, signal),
    read: (scope, cursor = null) => service.read(scope, cursor),
  };
}

export type L2ScenarioTransaction = <T>(work: (client: Client) => Promise<T>) => Promise<T>;
