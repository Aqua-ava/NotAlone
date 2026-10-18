import { loadBackendConfiguration } from '../backend/config';
import { inspectScreenPermission } from './native';

export async function inspectConfiguredScreenPermission(userData: string, resourcesDirectory: string | undefined,
  request: boolean, signal: AbortSignal): Promise<boolean | undefined> {
  if (signal.aborted) return;
  // 与后台定位共用可信配置解析；复查和主动授权均使用当前保存的探针。
  const config = await loadBackendConfiguration(userData, resourcesDirectory);
  return inspectScreenPermission(config.syncProbePath, request, signal);
}
