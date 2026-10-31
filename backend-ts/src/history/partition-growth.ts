import type { HistorySupportReport, HistoryTarget } from './sqlite/contracts.ts';

export interface WechatGrowthTable {
  target: string; partition: string; role: string;
  columns: readonly unknown[]; indexes: readonly unknown[]; declaredPrimaryKey: readonly string[];
  autoIncrement: boolean; sqlFingerprint: string; triggerFingerprints: readonly string[];
  schemaVersion: string; rootPage: string;
}
export interface WechatGrowthSchema {
  schemaFingerprint: string; checkedPartitions: readonly string[]; tables: readonly WechatGrowthTable[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function uniqueStrings(values: readonly string[],maximum=128): boolean {
  return values.length <= maximum && values.every(value=>typeof value==='string'&&value.length>0&&value.length<=512)
    &&new Set(values).size===values.length;
}
function sameSet(a: readonly string[],b: readonly string[]): boolean {
  return a.length===b.length&&[...a].sort().every((value,index)=>value===[...b].sort()[index]);
}
function tableKey(table: Pick<WechatGrowthTable,'partition'|'target'>): string {
  return JSON.stringify([table.partition,table.target]);
}
function sameSchemaExceptVersion(previous: WechatGrowthTable,current: WechatGrowthTable): boolean {
  const {schemaVersion: _previousVersion,...oldShape}=previous;
  const {schemaVersion: _currentVersion,...newShape}=current;
  return canonical(oldShape)===canonical(newShape);
}

/**
 * 仅接受同一批已检查文件中新增联系人表：全部旧表身份与结构保持不变，
 * schemaVersion 单独变化不阻断；缩表、替换、结构变化或文件集合变化均拒绝。
 */
export function isSafeWechatSchemaGrowth(previous: WechatGrowthSchema,current: WechatGrowthSchema): boolean {
  if (!previous||!current||!uniqueStrings(previous.checkedPartitions)||!uniqueStrings(current.checkedPartitions)
    ||!sameSet(previous.checkedPartitions,current.checkedPartitions)||!Array.isArray(previous.tables)||!Array.isArray(current.tables)
    ||previous.tables.length>128||current.tables.length>128||previous.tables.length>=current.tables.length) return false;
  if (previous.tables.some(table=>!table||typeof table.target!=='string'||!table.target||typeof table.partition!=='string'||!table.partition)
    ||current.tables.some(table=>!table||typeof table.target!=='string'||!table.target||typeof table.partition!=='string'||!table.partition
      ||!current.checkedPartitions.includes(table.partition))) return false;
  const currentByKey=new Map(current.tables.map(table=>[tableKey(table),table]));
  if (currentByKey.size!==current.tables.length||new Set(previous.tables.map(table=>tableKey(table))).size!==previous.tables.length) return false;
  for (const oldTable of previous.tables) {
    const nextTable=currentByKey.get(tableKey(oldTable));
    if (!nextTable||!sameSchemaExceptVersion(oldTable,nextTable)) return false;
  }
  return current.tables.some(table=>!previous.tables.some(old=>tableKey(old)===tableKey(table)));
}

/** NativeClient 共用的schema增长边界名称。 */
export const isSafePartitionGrowth = isSafeWechatSchemaGrowth;

/** 当前支持档除 schema fingerprint 外完全相同，且双方都明确认证安全分片增长。 */
export function isPartitionGrowthReportChange(previous: HistorySupportReport,current: HistorySupportReport): boolean {
  if (!previous||!current||previous.schemaFingerprint===current.schemaFingerprint
    ||previous.capabilities?.partitionGrowth!=='supported'||current.capabilities?.partitionGrowth!=='supported') return false;
  const {schemaFingerprint: _oldFingerprint,...oldReport}=previous;
  const {schemaFingerprint: _newFingerprint,...newReport}=current;
  return canonical(oldReport)===canonical(newReport);
}

/** 空目标首次出现消息表时重新建立目标，不能把不同读取规则的旧检查点当作可恢复证据。 */
export function isPartitionGrowthTargetChange(previous: HistorySupportReport,current: HistorySupportReport): boolean {
  if(isPartitionGrowthReportChange(previous,current))return true;
  if(previous.profileId!=='wechat-4.0.6-29387-absent-private-target-v1'
    ||current.profileId!=='wechat-4.0.6-29387-observed-states-v1'
    ||previous.status!=='supported'||current.status!=='supported'||previous.schemaFingerprint===current.schemaFingerprint
    ||previous.capabilities?.partitionGrowth!=='supported'||current.capabilities?.partitionGrowth!=='supported'
    ||previous.declaredPrimaryKey.length!==0||JSON.stringify(current.declaredPrimaryKey)!=='["local_id"]'
    ||previous.continuity!=='same-source-instances-normal-use-v1'||current.continuity!==previous.continuity)return false;
  return ['protocol','adapterVersion','accountKey','conversationKey','sourceGeneration','programVersion','build','artifactSha256','identity','serverAliasSemantics']
    .every(key=>previous[key as keyof HistorySupportReport]===current[key as keyof HistorySupportReport]);
}

export type HistoryTargetTransition = 'same'|'legacy-exact-upgrade'|'growth'|null;
function validTarget(target: HistoryTarget): boolean {
  return Boolean(target&&target.protocol==='private-history-v1'&&typeof target.sourceGeneration==='string'&&target.sourceGeneration
    &&Array.isArray(target.partitions)&&uniqueStrings(target.partitions,10_000)&&Array.isArray(target.tables)&&target.tables.length<=10_000
    &&target.tables.every(table=>table&&typeof table.partition==='string'&&table.partition.length>0&&typeof table.instance==='string'
      &&table.instance.length>0&&target.partitions.includes(table.partition))
    &&new Set(target.tables.map(table=>tableKey({partition:table.partition,target:table.instance}))).size===target.tables.length
    &&(target.checkedPartitions===undefined||target.checkedPartitions.length>0&&uniqueStrings(target.checkedPartitions))
    &&(target.checkedPartitions===undefined||target.tables.every(table=>target.checkedPartitions!.includes(table.partition))));
}
function sameTargetParts(a:HistoryTarget,b:HistoryTarget):boolean {
  return sameSet(a.partitions,b.partitions)
    &&sameSet(a.tables.map(table=>tableKey({partition:table.partition,target:table.instance})),b.tables.map(table=>tableKey({partition:table.partition,target:table.instance})));
}

/**
 * 存储层的目标转移证明。具体 root/SQL/index/column 完整复核由原生 checkpoint 完成；
 * TS 再要求已检查文件完全相同、旧表实例全部保留，不能借此恢复未知旧scope。
 */
export function historyTargetTransition(previous:HistoryTarget,current:HistoryTarget,allowGrowth:boolean):HistoryTargetTransition {
  if(!validTarget(previous)||!validTarget(current)||previous.sourceGeneration!==current.sourceGeneration) return null;
  if(previous.checkedPartitions===undefined){
    if(!sameTargetParts(previous,current))return null;
    return current.checkedPartitions===undefined?'same':'legacy-exact-upgrade';
  }
  if(current.checkedPartitions===undefined||!sameSet(previous.checkedPartitions,current.checkedPartitions))return null;
  if(sameTargetParts(previous,current))return 'same';
  const currentTables=new Set(current.tables.map(table=>tableKey({partition:table.partition,target:table.instance})));
  const oldTables=previous.tables.map(table=>tableKey({partition:table.partition,target:table.instance}));
  if(!allowGrowth||oldTables.some(table=>!currentTables.has(table))||previous.tables.length>0&&previous.partitions.some(partition=>!current.partitions.includes(partition))
    ||current.tables.length<=previous.tables.length)return null;
  return 'growth';
}
