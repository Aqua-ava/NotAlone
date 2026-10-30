/** 14 的最小业务合同；身份、调用追踪及受管副本由 02/05/11/12 接入。 */
export type SkillEnabledState = 'enabled' | 'disabled' | 'unknown';
export type SkillVerificationState = 'verified' | 'pending' | 'missing' | 'conflict' | 'invalid';
export interface SkillAnchor {
  packageId: string;
  revisionNo: bigint;
  headRevision: bigint;
  directoryIdentity: string;
  manifestDigest: string;
  contentDigest: string;
}
export interface SkillRevision {
  revisionNo: bigint;
  manifestDigest: string;
  contentDigest: string;
  sourceKind: 'user_directory';
  verificationState: 'verified' | 'pending';
  verifiedAt: bigint;
  availability: 'current' | 'unavailable';
}
export interface SkillPackageState {
  id: string;
  directoryName: string;
  directoryIdentity: string;
  displayName: string;
  description: string;
  enabledState: SkillEnabledState;
  enabledOrigin: 'user_action' | null;
  verificationState: SkillVerificationState;
  verificationReason: string | null;
  currentRevisionNo: bigint | null;
  headRevision: bigint;
  revisions: SkillRevision[];
}
export interface SkillRunScope { ownerId: string; contactId: string; callId: string }
export interface SkillRunRevision {
  packages: {id: string; headRevision: bigint}[];
  eligible: SkillAnchor[];
}
export interface SkillInput {
  scope: SkillRunScope;
  runRevision: SkillRunRevision;
  selected: SkillAnchor | null;
  loaded: SkillAnchor;
  relativePath: string;
  text: string;
  payloadDigest: string;
}
/**
 * 必须由受信任宿主提供，缺失时禁止运行；不能以 Skill 内容产生授权。
 * recordInput 须在实际追踪写事务内复验调用/联系人/来源/删除代次，并调用
 * requireSkillRun(tx, scope.ownerId, input.runRevision)及requireSkillRevision。
 * assertCurrent也必须在同一短事务核验scope与非null的冻结runRevision，不能只验其中一面。
 * 保存真实正文及来源删除关系；
 * 失败或迟到返回须拒绝，不能保留独立于来源的“新来源”。
 * assertCurrent 同时负责已授权模型资料出站；加载本身不发送模型请求。
 */
export interface SkillRunProtection {
  assertCurrent(scope: SkillRunScope, runRevision: SkillRunRevision | null, signal?: AbortSignal): Promise<void>;
  recordSelection(scope: SkillRunScope, selected: SkillAnchor | null, signal?: AbortSignal): Promise<void>;
  recordInput(input: SkillInput, signal?: AbortSignal): Promise<void>;
}
