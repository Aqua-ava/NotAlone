import { createHash } from 'node:crypto';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import type { HistorySupportReport, HistoryTarget } from './contracts.ts';

/** 增量续读游标的合同版本；渠道游标保持不透明，作用域与顺序由本证据固定。 */
export const historyCursorScheme = 'opaque-scope-bound-tail-v1';
const maxCursorLength = 65_536;
const controlCharacters = /[\u0000-\u001f\u007f]/;

/** 只接受不透明、有界、无控制字符的游标；未知形状直接拒绝，不做补造。 */
export function assertHistoryCursor(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxCursorLength || controlCharacters.test(value)) throw new StorageFailure(code);
  return value;
}

function sortedCapabilities(report: HistorySupportReport): [string, string][] {
  const capabilities = report.capabilities ?? {};
  return Object.keys(capabilities).sort().map(key => [key, String(capabilities[key])]);
}

/**
 * 游标完整作用域证据摘要：账号实例、稳定会话、来源代次、固定目标（描述/分片/表实例）、
 * 支持档制品与结构、声明主键、状态/连续性语义、声明能力及游标合同。
 * 不含 read_epoch/grant/selection_generation 等“当前许可”字段，使关闭再开启或重选在同一渠道
 * 范围内可以续读，但账号/版本/分片/目标/语义任一变化都会失配并显式停止。
 */
export function historyCursorScopeDigest(token: ReadEligibility, report: HistorySupportReport, target: HistoryTarget): string {
  const scope = {
    protocol: 'private-history-v1', identity: report.identity,
    accountKey: report.accountKey, conversationKey: report.conversationKey,
    sourceGeneration: report.sourceGeneration, tokenSourceGeneration: token.source_generation,
    targetProtocol: target.protocol, targetDescriptor: target.descriptor,
    partitions: [...target.partitions].sort(),
    tables: target.tables.map(table => `${table.partition}\u0000${table.instance}`).sort(),
    ...(target.checkedPartitions===undefined?{}:{checkedPartitions:[...target.checkedPartitions].sort()}),
    adapterVersion: report.adapterVersion, programVersion: report.programVersion, build: report.build,
    artifactSha256: report.artifactSha256, schemaFingerprint: report.schemaFingerprint,
    declaredPrimaryKey: [...report.declaredPrimaryKey],
    statusSemantics: report.statusSemantics, continuity: report.continuity,
    serverAliasSemantics: report.serverAliasSemantics ?? null,
    capabilities: sortedCapabilities(report),
    cursorScheme: historyCursorScheme,
  };
  return createHash('sha256').update(JSON.stringify(scope)).digest('hex');
}
