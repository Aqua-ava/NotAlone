import { isAiServiceBaseUrl, isDeepSeekConfiguration, type DeepSeekConfiguration } from '../../shared/ai-service-configuration';
import { DEFAULT_MODEL_PARAMETERS, equalModelParameters, isModelParameters, modelParametersFromApi, modelParametersToApi, type ModelParameters } from '../../shared/model-parameters';
import { BackendRequestFailure } from '../backend/json-client';
import type { SetupState } from '../../shared/setup-bridge';
import type { BackendHost } from '../backend/host';

type Operation = { generation: number; epoch: number };

export class SetupController {
  private state: SetupState = { phase: 'offline', credentialsConfigured: false, revision: 0 };
  private generation: number | undefined;
  private epoch = 0;
  private busy = false;
  private savedConfigPending = false;
  private savedExpectation: 'credentials' | 'parameters' = 'credentials';
  private savedModelParameters: ModelParameters | undefined;
  private readonly listeners = new Set<(state: SetupState) => void>();

  constructor(private readonly backend: BackendHost) {
    backend.onStateChanged(() => {
      const generation = backend.getConnectionGeneration();
      if (generation === this.generation) return;
      this.generation = generation;
      ++this.epoch;
      // 主动重启期间保留进度；普通保存遇到失联时仍立即失效旧界面。
      if (this.busy && this.state.phase === 'restarting') return;
      if (generation === undefined) this.publish({ phase: 'offline', credentialsConfigured: false, baseUrl: undefined });
      else void this.refresh();
    });
  }
  getState(): SetupState { return structuredClone(this.state); }
  onStateChanged(listener: (state: SetupState) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  async refresh(): Promise<void> {
    const operation = this.beginOperation();
    if (operation) await this.readStatus(operation);
  }
  private async readStatus(operation: Operation): Promise<void> {
    this.publish({ phase: 'loading', credentialsConfigured: false, errorCode: undefined });
    try {
      const { data } = await this.backend.requestJson({ method: 'GET', path: '/api/setup/status', maxResponseBytes: 4096 });
      const status = data as { credentials_configured?: unknown; runtime_owner_configured?: unknown; deepseek_base_url?: unknown; model_parameters?: unknown; runtime_configuration_pending?: unknown; semantic_model_ready?: unknown; runtime_configuration_environment_override?: unknown };
      if (!status || typeof status.credentials_configured !== 'boolean' || typeof status.runtime_owner_configured !== 'boolean'
        || status.runtime_configuration_pending !== undefined && typeof status.runtime_configuration_pending !== 'boolean'
        || status.semantic_model_ready !== undefined && typeof status.semantic_model_ready !== 'boolean'
        || status.runtime_configuration_environment_override !== undefined && typeof status.runtime_configuration_environment_override !== 'boolean') throw new Error();
      const modelParametersInvalid = status.model_parameters === null;
      const modelParameters = status.model_parameters === undefined ? structuredClone(DEFAULT_MODEL_PARAMETERS) : modelParametersFromApi(status.model_parameters);
      if (!modelParameters && !modelParametersInvalid) throw new Error();
      if (!this.isCurrent(operation)) return;
      const pending = status.runtime_configuration_pending === true;
      if (pending) {
        if (!this.savedConfigPending) this.savedExpectation = 'credentials';
        this.savedConfigPending = true;
      }
      this.publish({ phase: pending ? 'restart-failed' : status.runtime_owner_configured ? 'ready' : 'failed',
        configurationPending: pending, errorCode: pending ? status.runtime_configuration_environment_override === true ? 'configuration-environment-override' : 'reload-failed' : undefined,
        credentialsConfigured: status.credentials_configured,
        semanticModelReady: typeof status.semantic_model_ready === 'boolean' ? status.semantic_model_ready : undefined,
        modelParameters,
        modelParametersInvalid,
        baseUrl: isAiServiceBaseUrl(status.deepseek_base_url) ? status.deepseek_base_url : undefined });
    } catch { if (this.isCurrent(operation)) this.publish({ phase: 'failed', credentialsConfigured: false }); }
  }
  async saveDeepSeekConfiguration(configuration: DeepSeekConfiguration): Promise<void> {
    if (!isDeepSeekConfiguration(configuration)) throw new Error('AI 服务配置无效');
    if (this.state.phase !== 'ready') return;
    await this.writeConfiguration('credentials', async () => {
      const result = await this.backend.requestJson({ method: 'POST', path: '/api/setup/deepseek-configuration',
        body: { base_url: configuration.baseUrl, api_key: configuration.apiKey }, maxResponseBytes: 4096 });
      const value = result.data as { provider?: unknown; configured?: unknown };
      if (value?.provider !== 'deepseek' || value.configured !== true) throw new Error();
    });
  }
  async saveModelParameters(parameters: ModelParameters): Promise<void> {
    if (!isModelParameters(parameters)) throw new Error('模型参数无效');
    if (this.state.phase !== 'ready') throw new Error('模型设置暂不可用');
    const submitted = structuredClone(parameters);
    let written = false;
    await this.writeConfiguration('parameters', async () => {
      const { data } = await this.backend.requestJson({ method: 'POST', path: '/api/setup/model-parameters',
        body: modelParametersToApi(submitted), maxResponseBytes: 4096 });
      const value = data as { configured?: unknown; restart_required?: unknown };
      if (value?.configured !== true || value.restart_required !== true) throw new Error();
      this.savedModelParameters = submitted;
      written = true;
    });
    if (!written) throw new Error('模型参数未能保存，请重试。');
  }
  private async writeConfiguration(kind: 'credentials' | 'parameters', write: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    const operation = this.beginOperation();
    if (!operation) return;
    this.busy = true;
    this.publish({ phase: 'saving', errorCode: undefined });
    try {
      await write();
      if (!this.isCurrent(operation)) return;
      this.savedConfigPending = true;
      this.savedExpectation = kind;
      this.publish({ configurationPending: true });
      await this.reloadConfiguration();
    } catch (error) {
      if (!this.isCurrent(operation)) return;
      const environmentOverride = error instanceof BackendRequestFailure && error.code === 'configuration_environment_override';
      const recovery = this.beginOperation();
      if (!recovery || recovery.generation !== operation.generation) return;
      await this.readStatus(recovery);
      // 自己的恢复查询返回也需复核；断线或较新查询不能被旧保存错误覆盖。
      if (this.isCurrent(recovery)) this.publish({ errorCode: environmentOverride ? 'configuration-environment-override' : kind === 'parameters' ? 'parameters-failed' : 'credentials-failed' });
    } finally { this.busy = false; }
  }
  async retryRestart(): Promise<void> {
    if (this.busy || !this.savedConfigPending) return;
    this.busy = true;
    try { await this.reloadConfiguration(); }
    finally { this.busy = false; }
  }
  private async reloadConfiguration(): Promise<void> {
    this.publish({ phase: 'restarting', credentialsConfigured: false, errorCode: undefined });
    // 保存已经成功；重启异常只能报告待加载，不能回退成保存失败。
    const restarted = await this.backend.restart().catch(() => false);
    if (!restarted) {
      this.publish({ phase: 'restart-failed', errorCode: 'reload-failed' }); return;
    }
    const operation = this.beginOperation();
    if (!operation) { this.publish({ phase: 'restart-failed', errorCode: 'reload-failed' }); return; }
    await this.readStatus(operation);
    if (!this.isCurrent(operation)) return;
    const parametersConfirmed = this.savedExpectation !== 'parameters' || equalModelParameters(this.state.modelParameters, this.savedModelParameters);
    if (this.state.phase === 'ready' && parametersConfirmed && (this.savedExpectation === 'parameters' || this.state.credentialsConfigured)) {
      this.savedConfigPending = false;
      this.savedModelParameters = undefined;
    }
    else this.publish({ phase: 'restart-failed', configurationPending: true, errorCode: this.state.errorCode === 'configuration-environment-override' ? 'configuration-environment-override' : 'reload-failed' });
  }
  private beginOperation(): Operation | undefined {
    const generation = this.backend.getConnectionGeneration();
    return generation === undefined ? undefined : { generation, epoch: ++this.epoch };
  }
  private isCurrent(operation: Operation): boolean {
    return operation.generation === this.backend.getConnectionGeneration() && operation.epoch === this.epoch;
  }
  private publish(update: Partial<SetupState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}
