export interface WechatFile { path: string; bytes: number; mode: number; sha256: string }
export interface WechatManifest {
  formatVersion: 1; runtimeKind: 'notalone-wechat'; architecture: 'arm64'; minimumMacOS: string;
  paths: { cli: string; wcdb: string; lldb: string; debugserver: string; python: string };
  capabilities: { readOnlyCli: true; privilegedPreparation: false };
  acceptance: { realWechat: false; cleanMachine: false; systemAuthorization: false };
  provenance: { sourceLockSha256: string; signing: 'ad-hoc-development'; developerId: false; notarized: false; licenseCoverage: string; nativeFilesAudited: number; syntheticPython: boolean };
  components: Array<{ name: string; version: string; source: string; commit?: string; sha256?: string; role: 'runtime' | 'source-evidence' }>;
  files: WechatFile[];
}
export const wechatDirectoryName: 'notalone-wechat';
export const wechatLockedComponents: Readonly<WechatManifest['components']>;
export const wechatPaths: WechatManifest['paths'];
export const wechatCapabilities: WechatManifest['capabilities'];
export const wechatAcceptance: WechatManifest['acceptance'];
export function hashWechatFile(file: string): Promise<string>;
export function wechatInventory(directory: string): Promise<WechatFile[]>;
export function inspectWechatComponents(directory: string): Promise<WechatManifest>;
