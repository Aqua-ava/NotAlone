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
  enabledOrigin: 'user_action' | 'default' | null;
  verificationState: SkillVerificationState;
  verificationReason: string | null;
  currentRevisionNo: bigint | null;
  headRevision: bigint;
  revisions: SkillRevision[];
}
export interface SkillRunScope { ownerId: string; contactId: string; callId: string }
/** 仅表示本轮已返回的策略及清单，不授予物理文件访问权限。 */
export interface LoadedSkill {
  anchor: SkillAnchor;
  name: string;
  resources: {relativePath: string; mediaType: string; bytes: number; payloadDigest: string}[];
}
/** 显式兼容入口与自动预加载集合分开记录来源，不把自动集合冒称为用户选择。 */
export type SkillPreloadOrigin = 'explicit' | 'auto_preload';
/** 本轮冻结的预加载选择：来源、目录快照及每个 anchor 的包身份与修订。 */
export interface SkillPreloadSelection {
  origin: SkillPreloadOrigin;
  catalogRevision: string;
  anchors: SkillAnchor[];
}
/** 已在打开运行前读取并写入实际输入事件的本轮 Skill 正文。 */
export interface PreloadedSkill extends LoadedSkill { content: string }
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
