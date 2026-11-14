import type { DeepSeekConfiguration } from './ai-service-configuration';
import type { ModelParameters } from './model-parameters';
export type SetupPhase = 'offline' | 'loading' | 'needs-owner' | 'identity-unbound' | 'ready' | 'failed' | 'saving' | 'restarting' | 'restart-failed';
export interface SetupState {
  phase: SetupPhase;
  ownerReady: boolean;
  credentialsConfigured: boolean;
  /** 本机语义模型是否已准备；旧后台不返回时为 undefined。未准备时记忆检索退回字面匹配。 */
  semanticModelReady?: boolean;
  /** 配置已保存，但当前宿主尚未确认采用新启动快照。 */
  configurationPending?: boolean;
  officialDefaults?: boolean;
  baseUrl?: string;
  modelParameters?: ModelParameters;
  modelParametersInvalid?: boolean;
  recoverableOwner?: boolean;
  revision: number;
  errorCode?: 'initialize-failed' | 'credentials-failed' | 'parameters-failed' | 'reload-failed' | 'configuration-environment-override';
}
export interface SetupBridge {
  getState(): Promise<SetupState>;
  refresh(): Promise<void>;
  initializeOwner(displayName: string): Promise<void>;
  recoverExistingOwner(): Promise<void>;
  saveDeepSeekKey(apiKey: string): Promise<void>;
  saveDeepSeekConfiguration(configuration: DeepSeekConfiguration): Promise<void>;
  saveModelParameters(parameters: ModelParameters): Promise<void>;
  saveOfficialDeepSeekKey(apiKey: string, confirmed: true): Promise<void>;
  retryRestart(): Promise<void>;
  reloadControlledConfiguration(): Promise<void>;
  onStateChanged(listener: (state: SetupState) => void): () => void;
}
