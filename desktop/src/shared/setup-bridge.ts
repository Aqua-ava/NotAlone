import type { DeepSeekConfiguration } from './ai-service-configuration';
import type { ModelParameters } from './model-parameters';
export type SetupPhase = 'offline' | 'loading' | 'ready' | 'failed' | 'saving' | 'restarting' | 'restart-failed';
export interface SetupState {
  phase: SetupPhase;
  credentialsConfigured: boolean;
  /** 本机语义模型是否已准备；旧后台不返回时为 undefined。未准备时记忆检索退回字面匹配。 */
  semanticModelReady?: boolean;
  /** 配置已保存，但当前宿主尚未确认采用新启动快照。 */
  configurationPending?: boolean;
  baseUrl?: string;
  modelParameters?: ModelParameters;
  modelParametersInvalid?: boolean;
  revision: number;
  errorCode?: 'credentials-failed' | 'parameters-failed' | 'reload-failed' | 'configuration-environment-override';
}
export interface SetupBridge {
  getState(): Promise<SetupState>;
  refresh(): Promise<void>;
  saveDeepSeekConfiguration(configuration: DeepSeekConfiguration): Promise<void>;
  saveModelParameters(parameters: ModelParameters): Promise<void>;
  retryRestart(): Promise<void>;
  onStateChanged(listener: (state: SetupState) => void): () => void;
}
