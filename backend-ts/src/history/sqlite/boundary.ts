import { createHash } from 'node:crypto';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import type { HistoryRecord, HistoryScope, HistorySupportReport, HistoryTarget } from './contracts.ts';

/** 由已认证只读适配器提供的固定源快照边界；真实制品未认证时不得实现。 */
export const boundaryProtocol = 'private-history-boundary-v1' as const;
/** 最大成员数：完整身份集合必须逐条持久化，不按最大号/时间/摘要替代。 */
export const maxBoundaryMembers = 100_000;
const maxIdentifier = 512;
const maxProofText = 64_000;

export interface BoundaryMemberIdentity { partition: string; table: string; localId: string }
/** 每分片独立 observer/reader 的短获取窗口证据；pre/post 必须同一窗口相等。 */
export interface BoundaryPartitionEvidence {
  partition: string; instance: string; preSample: string; postSample: string;
  readerCompleted: boolean; memberCount: number;
}
export interface HistoryBoundaryCandidate {
  protocol: typeof boundaryProtocol;
  target: HistoryTarget; support: HistorySupportReport;
  accountKey: string; conversationKey: string; sourceGeneration: string;
  /** 协议证明与续读位置；不能替代精确成员。 */
  boundaryToken: string; manifestSha256: string;
  members: readonly BoundaryMemberIdentity[];
  partitions: readonly BoundaryPartitionEvidence[];
  namespaceContinuity: boolean; instanceContinuity: boolean;
  observedAt: string;
}
/** 可选能力：只有认证过边界协议的适配器才实现；正式微信适配器未认证时保持缺席。 */
export interface HistoryBoundaryCapability {
  /** 与 04 的 HistoryChannel 可选能力同名；只有认证过边界协议的适配器实现。 */
  boundarySnapshot(scope: HistoryScope, signal?: AbortSignal): Promise<HistoryBoundaryCandidate>;
}
export interface PreparedBoundaryMember { memberNo: number; partition: string; tableInstance: string; localKey: string }
export interface PreparedBoundary {
  boundaryToken: string; manifestSha256: string; members: PreparedBoundaryMember[];
  proof: { partitions: BoundaryPartitionEvidence[]; namespaceContinuity: true; instanceContinuity: true; observedAt: string };
  target: HistoryTarget; support: HistorySupportReport;
}
export class HistoryBoundaryInvalid extends Error {
  readonly reason: string;
  /** 只有获取窗口变化允许在接受前有界重试；实例替换或连续性无法证明直接失效。 */
  readonly retryable: boolean;
  constructor(reason: string, retryable = false) { super(reason); this.name = 'HistoryBoundaryInvalid'; this.reason = reason; this.retryable = retryable; }
}
const fail = (reason: string, retryable = false): never => { throw new HistoryBoundaryInvalid(reason, retryable); };
const text = (value: unknown, max = maxIdentifier): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const exactInteger = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]])) : item);
}
/** 与 normalize.ts 的来源出现键保持一致；成员/排除都只存该不透明身份。 */
export const sourceLocalKey = (sourceGeneration: string, partition: string, table: string, localId: string): string =>
  JSON.stringify([sourceGeneration, partition, table, localId]);
/** manifest 摘要绑定目标描述与完整成员集合；不能只摘要数量、最大号或时间。 */
export function membersManifestSha256(descriptor: string, members: readonly { partition: string; tableInstance: string; localKey: string }[]): string {
  return sha256(canonicalJson({ descriptor, members: members.map(member => ({ partition: member.partition, tableInstance: member.tableInstance, localKey: member.localKey })) }));
}
function target(value: unknown, sourceGeneration: string): HistoryTarget {
  const item = value as HistoryTarget | undefined;
  if (!item || item.protocol !== 'private-history-v1' || item.sourceGeneration !== sourceGeneration
    || !text(item.descriptor, maxProofText) || !Array.isArray(item.partitions) || !item.partitions.length || item.partitions.length > 10_000
    || item.partitions.some(partition => !text(partition)) || new Set(item.partitions).size !== item.partitions.length
    || !Array.isArray(item.tables) || item.tables.length > 10_000
    || item.partitions.some(partition => !item.tables.some(table => table.partition === partition))
    || item.tables.some(table => !item.partitions.includes(table.partition) || !text(table.instance))
    || new Set(item.tables.map(table => JSON.stringify([table.partition, table.instance]))).size !== item.tables.length) fail('history_boundary_target_changed');
  return item as HistoryTarget;
}
function support(value: unknown): HistorySupportReport {
  const report = value as HistorySupportReport | undefined;
  // 只做结构门槛；完整支持档语义仍由调用方 assertSupport 校验。
  if (!report || report.protocol !== 'private-history-v1' || report.identity !== 'source-table-local-v1'
    || report.status !== 'supported' || !text(report.profileId) || !text(report.adapterVersion)
    || !Array.isArray(report.declaredPrimaryKey) || !report.declaredPrimaryKey.length
    || report.capabilities?.[boundaryProtocol] !== 'supported') fail('history_boundary_support_unverified');
  return report as HistorySupportReport;
}
/**
 * 校验并规范化适配器返回的 S(B) 候选。
 * 拒绝：目标/支撑档不符、分片覆盖不全、pre/post 窗口不一致、实例或命名空间不连续、
 * 成员越界/重复/夹带正文、manifest 摘要不符。候选此时尚未生效。
 */
export function prepareBoundaryCandidate(scope: HistoryScope, candidate: HistoryBoundaryCandidate): PreparedBoundary {
  if (!scope?.token || !text(scope.accountKey) || !text(scope.conversationKey)) fail('history_boundary_scope_invalid');
  if (!candidate || candidate.protocol !== boundaryProtocol) fail('history_boundary_unsupported');
  const fixed = target(candidate.target, scope.token.source_generation);
  const report = support(candidate.support);
  if (candidate.accountKey !== scope.accountKey || candidate.conversationKey !== scope.conversationKey
    || candidate.sourceGeneration !== scope.token.source_generation) fail('history_boundary_external_scope_changed');
  if (candidate.instanceContinuity !== true) fail('history_boundary_instance_changed');
  if (candidate.namespaceContinuity !== true) fail('history_boundary_namespace_changed');
  if (!text(candidate.boundaryToken, maxProofText) || !/^[a-f0-9]{64}$/.test(candidate.manifestSha256)) fail('history_boundary_proof_invalid');
  if (!text(candidate.observedAt, 64) || !Number.isFinite(Date.parse(candidate.observedAt))) fail('history_boundary_proof_invalid');
  if (!Array.isArray(candidate.partitions) || !Array.isArray(candidate.members)) fail('history_boundary_candidate_incomplete');
  if (candidate.members.length > maxBoundaryMembers) fail('history_boundary_candidate_too_large');
  if (candidate.partitions.length !== fixed.partitions.length) fail('history_boundary_candidate_incomplete');
  const observed = new Map<string, BoundaryPartitionEvidence>();
  for (const evidence of candidate.partitions) {
    if (!evidence || !text(evidence.partition) || !text(evidence.instance) || !fixed.partitions.includes(evidence.partition)
      || !text(evidence.preSample, maxProofText) || !text(evidence.postSample, maxProofText)
      || !Number.isSafeInteger(evidence.memberCount) || evidence.memberCount < 0
      || !fixed.tables.some(table => table.partition === evidence.partition && table.instance === evidence.instance)
      || observed.has(evidence.partition)) fail('history_boundary_candidate_incomplete');
    if (evidence.preSample !== evidence.postSample) fail('history_boundary_window_changed', true);
    if (evidence.readerCompleted !== true) fail('history_boundary_reader_incomplete', true);
    observed.set(evidence.partition, evidence);
  }
  if (fixed.partitions.some(partition => !observed.has(partition))) fail('history_boundary_candidate_incomplete');
  const seen = new Set<string>();
  let total = 0;
  for (const evidence of observed.values()) total += evidence.memberCount;
  if (total !== candidate.members.length) fail('history_boundary_candidate_incomplete');
  const members: PreparedBoundaryMember[] = candidate.members.map((member, memberNo) => {
    if (!member || !text(member.partition) || !text(member.table) || !exactInteger(member.localId)) fail('history_boundary_member_invalid');
    const evidence = observed.get(member.partition);
    if (!evidence || evidence.instance !== member.table) fail('history_boundary_member_invalid');
    const localKey = sourceLocalKey(scope.token.source_generation, member.partition, member.table, member.localId);
    if (seen.has(localKey)) fail('history_boundary_member_duplicate');
    seen.add(localKey);
    return { memberNo, partition: member.partition, tableInstance: member.table, localKey };
  });
  members.sort((left, right) => left.localKey.localeCompare(right.localKey)).forEach((member, memberNo) => { member.memberNo = memberNo; });
  const manifestSha256 = membersManifestSha256(fixed.descriptor, members);
  if (manifestSha256 !== candidate.manifestSha256) fail('history_boundary_manifest_mismatch');
  return { boundaryToken: candidate.boundaryToken, manifestSha256, members, target: fixed, support: report,
    proof: { partitions: fixed.partitions.map(partition => ({ ...observed.get(partition)! })), namespaceContinuity: true, instanceContinuity: true, observedAt: candidate.observedAt } };
}
/** 来源记录是否属于边界成员；供接受页和诊断复用。 */
export function boundaryMemberFor(record: HistoryRecord, sourceGeneration: string): string {
  return sourceLocalKey(sourceGeneration, record.partition, record.table, record.localId!);
}
export function boundaryStorageFailure(error: unknown, fallback: string): StorageFailure {
  return error instanceof StorageFailure ? error : new StorageFailure(error instanceof HistoryBoundaryInvalid ? error.reason : fallback);
}
