import type { AssistantNoGenerationProof } from '../../shared/assistant-no-generation';
import type { AssistantGenerationIdentity, AssistantGenerationOwner, AssistantGenerationReceipt,
  AssistantGenerationStopping, AssistantPreparationCommandIdentity, OwnedAssistantGeneration, PendingAssistantGenerationReceipt } from './assistant-generation-jobs';

// 协议适配器提交已经核验的证据；传输结束本身不是终态。
export type GenerationEvidence = { kind: 'completed' | 'invalidated' }
  | { kind: 'receipt'; receipt: AssistantGenerationReceipt }
  | { kind: 'failed'; canRetry: boolean; generationActive: boolean | undefined };
export interface GenerationProtocol {
  readonly signal: AbortSignal;
  readonly job: OwnedAssistantGeneration | undefined;
  readonly receipt: AssistantGenerationReceipt | undefined;
  readonly active: boolean;
  prepared(receipt: AssistantGenerationReceipt): Promise<void>;
  preparing(): void;
  requested(): void;
  notReserved(proof: AssistantNoGenerationProof, generation: number | undefined): void;
  observe(evidence: GenerationEvidence): void;
}
export interface GenerationAdapter<Result, Failure = undefined> {
  run(protocol: GenerationProtocol): Promise<{ value: Result; outcome: 'completed' | 'no_generation' | 'unknown' }>;
  verifyFailure?(error: unknown, protocol: GenerationProtocol): Promise<Failure | undefined>;
}
export interface GenerationExecution<Result, Failure> {
  identity: AssistantGenerationIdentity | AssistantGenerationOwner;
  controller?: AbortController;
  stopping?: AssistantGenerationStopping;
  preparationCommand?: AssistantPreparationCommandIdentity;
  adapter: GenerationAdapter<Result, Failure>;
  registered?(job: OwnedAssistantGeneration): void;
  prepared?(job: OwnedAssistantGeneration, receipt: AssistantGenerationReceipt): void;
  replacement?: PendingAssistantGenerationReceipt;
  consume(value: Result): void | Promise<void>;
  beforeFailure?(): void;
  failed?(error: unknown, observation: Failure | undefined): void | Promise<void>;
  finished?(job: OwnedAssistantGeneration, settled: boolean, couldPublish: boolean): void | Promise<void>;
}
