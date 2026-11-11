import type { StorageTransaction } from '../contracts.ts';

export type DeletionScope =
  | { kind: 'source'; contactId: string; sourceId: string }
  | { kind: 'contact' | 'contact_history'; contactId: string }
  | { kind: 'account' }
  | { kind: 'discussion'; contactId: string; discussionId: string }
  | { kind: 'media_result_clear' | 'media_result_replace'; contactId: string; messageId: string };
export type DeletionState = 'fenced' | 'cleaning' | 'verifying' | 'blocked' | 'completed';
export interface DeletionOperation {
  operationId: string; ownerId: string; scope: DeletionScope; acceptedGeneration: bigint;
  planRevision: bigint; state: DeletionState;
  createdAt: string; completedAt: string | null;
  // completed 操作的操作级摘要：按 `domain:row_kind`（文件目标记为 `domain:file`）汇总条数的 JSON 文本，不含任何行键；未完成操作为 null。
  targetSummary: string | null;
}
export const checkKinds = ['write_fence', 'database_rows', 'derived_eligibility', 'trace_payloads',
  'request_replay', 'runtime_files', 'runtime_live_refs', 'sqlite_pages_wal', 'scope_suppression', 'final_recheck'] as const;
export type CheckKind = typeof checkKinds[number];
export interface CheckResult { result: 'passed' | 'blocked' | 'not_applicable'; proof: string }
export type DomainChecks = Record<'database_rows' | 'derived_eligibility' | 'trace_payloads' | 'request_replay' | 'scope_suppression', CheckResult>;
export interface InvalidatedRequest { namespace: string; key: string }
// 身份不含系统设备号：设备号会随重启或重新挂载变化。dev 仅可能出现在旧记录中，比较与校验一律忽略。
export interface FileIdentity { dev?: string; ino: string; birthtimeNs: string; uid: string }
export type ManagedArea = 'runtime' | 'media' | 'cache';
export interface ManagedAddress {
  area: ManagedArea; locator: string; identity: FileIdentity;
  // 从受管区根到父目录的已核验身份；文件删除不能越过被换身份的父目录。
  ancestors: FileIdentity[]; kind: 'file' | 'directory';
}
export interface RowDeletionTarget {
  kind: 'row'; domain: string; rowKind: string; key: Record<string, string>; identity: string;
  holderKeys: string[];
}
export interface FileDeletionTarget {
  kind: 'file'; domain: string; ownerId: string; fileId: string; generation: string; address: ManagedAddress;
  holderKeys: string[];
}
export type DeletionTarget = RowDeletionTarget | FileDeletionTarget;
export interface PlannedTarget { targetNo: bigint; target: DeletionTarget | null; state: 'pending' | 'cleared' | 'failed'; attempts: bigint }
export interface DeletionSnapshot extends DeletionOperation {
  targets: PlannedTarget[]; checks: { kind: CheckKind; domain: string; result: CheckResult }[];
}

// 由02/16提供真实范围代次。fence必须在当前短事务撤销旧writer，不能只返回计数。
export interface DeletionAuthority {
  fence(tx: StorageTransaction, ownerId: string, scope: DeletionScope): bigint;
  verify(tx: StorageTransaction, operation: DeletionOperation): CheckResult;
}
// 仅受版本管理的宿主注册；不能由HTTP/Tool传SQL、回调或模块路径。
export interface DeletionDomain {
  id: string;
  // 每种rowKind的真实复合主键列。地址只能选此白名单，删除逻辑仍归所属领域。
  rowKinds: Record<string, { keys: readonly string[]; ownerKey: string }>;
  fence(tx: StorageTransaction, operation: DeletionOperation): InvalidatedRequest[];
  // 必须反查实际参与窗口及跨联系人贡献，不能只沿展示citation。
  collect(tx: StorageTransaction, operation: DeletionOperation): DeletionTarget[];
  clearRow(tx: StorageTransaction, operation: DeletionOperation, target: RowDeletionTarget): void;
  // 文件I/O前复验归属、代次、cleanup_pending及仍必需的父件；计划文件不得再发布为current。
  authorizeFile(tx: StorageTransaction, operation: DeletionOperation, target: FileDeletionTarget): void;
  fileCleared(tx: StorageTransaction, operation: DeletionOperation, target: FileDeletionTarget): void;
  verify(tx: StorageTransaction, operation: DeletionOperation): DomainChecks;
}
export interface DeletionRegistration {
  authority: DeletionAuthority;
  domains: DeletionDomain[];
  // 显式清单阻止漏装领域时把空闭包判完成；集成负责人按实际写者维护。
  requiredDomains: readonly string[];
}
