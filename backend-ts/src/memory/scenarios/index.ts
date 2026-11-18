/**
 * memory/scenarios 的唯一对外入口：L2 场景文档的合同与校验、内存工作区、模型提案循环与独立核验。
 * 目录外（含 profiles、sqlite/documents）一律从这里导入；document.ts / workspace.ts 可随时重排。
 * UUID、canonicalScenarioJSON、clone、count、exactKeys、object、readToolCalls、scenarioDigest
 * 是 L3 profiles 共用的确定性小工具，暂随入口提供，后续可迁出时只需改此处。
 */
export {
  DEFAULT_L2_SCENARIO_BUDGET,
  L2ScenarioError,
  L2ScenarioVerificationError,
  UUID,
  canonicalScenarioJSON,
  clone,
  count,
  exactKeys,
  object,
  parseScenarioVerification,
  readToolCalls,
  scenarioDigest,
  scenarioVerificationFeedback,
  validateScenarioDocument,
} from './document.ts';
export type {L2ScenarioBudget, L2ScenarioMemory, L2ScenarioReference, L2ScenarioVersion} from './document.ts';
export {L2ScenarioDocumentWorkspace, runScenarioDocumentAgent, verifyScenarioProposal} from './workspace.ts';
export type {ScenarioDocumentCall, ScenarioDocumentCallPort} from './workspace.ts';
