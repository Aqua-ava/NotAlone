import path from 'node:path';

/** 默认实例沿用本机隔离仓；独立资料目录的隔离仓由本次实例选择。 */
export function resolveQuarantineRoot(appData: string, userData: string, selectedDataPath: string): string {
  return selectedDataPath && path.isAbsolute(selectedDataPath)
    ? path.join(userData, 'quarantine') : path.join(appData, 'NotAlone-Quarantine');
}
