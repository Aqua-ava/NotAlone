/** 审计目录生成器：把设计工件的 77 表/778 字段/215 FK 与 115 旧名称转成可公开提交的 disposition。
 *
 * 用法（backend-ts 目录）：
 *   node test/fixtures/cutover/build-audit-catalog.mjs \
 *     <consolidated-schema.json> <consolidated-legacy-check.json>
 * 原始工件留在 .scratch 设计目录，不复制任何用户数据、聊天正文或凭据；只保留表名、分组、字段/键计数与旧名称结论。
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFERRED = ['expression_preference', 'expression_preference_version', 'preference_source',
  'organization_feedback', 'feedback_input', 'quality_case', 'quality_case_input', 'quality_run', 'quality_attempt'];
const REPLACED = { read_exclusion: 'history_source_exclusion' };
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');

export function logicalCatalog(catalog) {
  const tables = catalog.tables.map(table => ({
    name: table.name,
    group: table.group,
    disposition: DEFERRED.includes(table.name) ? 'deferred_entry_closed' : REPLACED[table.name] ? 'replaced' : 'implemented',
    fieldCount: (table.field_contract ?? []).length,
    foreignKeyCount: (table.foreign_key_contracts ?? []).length,
  }));
  return {
    source: { artifact: 'consolidated-schema.json', sha256: '' },
    counts: { tables: tables.length, fields: tables.reduce((sum, table) => sum + table.fieldCount, 0), foreignKeys: tables.reduce((sum, table) => sum + table.foreignKeyCount, 0) },
    dispositionCounts: {
      implemented: tables.filter(table => table.disposition === 'implemented').length,
      deferredEntryClosed: tables.filter(table => table.disposition === 'deferred_entry_closed').length,
      replaced: tables.filter(table => table.disposition === 'replaced').length,
    },
    tables,
  };
}

export function legacyDisposition(legacy, implementedTables) {
  const names = new Set(implementedTables);
  const tables = legacy.tables.map(row => {
    const targets = row.targets ?? [];
    let disposition;
    if (row.status === '本次范围外') disposition = 'out_of_scope_entry_closed';
    else if (row.status === '旧入口待接线核对') disposition = 'retired_manual_import';
    else if (row.status === '不复刻旧流程' || row.status === '不建候选') disposition = 'retired';
    else if (row.status === '查询派生') disposition = 'derived_no_table';
    else if (targets.length === 0) disposition = 'retired';
    else if (targets.every(target => Object.hasOwn(REPLACED, target))) disposition = 'replaced_entry_closed';
    else if (targets.some(target => DEFERRED.includes(target))) disposition = 'deferred_entry_closed';
    else if (targets.every(target => names.has(target) || Object.hasOwn(REPLACED, target))) disposition = 'implemented';
    else disposition = 'retired';
    return { oldTable: row.old_table, disposition, targets };
  });
  return {
    source: { artifact: 'consolidated-legacy-check.json', sha256: '' },
    count: tables.length,
    dispositionCounts: {
      implemented: tables.filter(table => table.disposition === 'implemented').length,
      replacedEntryClosed: tables.filter(table => table.disposition === 'replaced_entry_closed').length,
      deferredEntryClosed: tables.filter(table => table.disposition === 'deferred_entry_closed').length,
      retiredManualImport: tables.filter(table => table.disposition === 'retired_manual_import').length,
      outOfScopeEntryClosed: tables.filter(table => table.disposition === 'out_of_scope_entry_closed').length,
      derivedNoTable: tables.filter(table => table.disposition === 'derived_no_table').length,
      retired: tables.filter(table => table.disposition === 'retired').length,
    },
    tables,
  };
}

async function main() {
  const [catalogPath, legacyPath] = process.argv.slice(2);
  if (!catalogPath || !legacyPath) throw new Error('usage: build-audit-catalog.mjs <consolidated-schema.json> <consolidated-legacy-check.json>');
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const catalogBuffer = await readFile(path.resolve(catalogPath));
  const legacyBuffer = await readFile(path.resolve(legacyPath));
  const catalog = JSON.parse(catalogBuffer.toString('utf8'));
  const legacy = JSON.parse(legacyBuffer.toString('utf8'));
  const directoryOutput = logicalCatalog(catalog);
  directoryOutput.source.sha256 = digest(catalogBuffer);
  const implemented = directoryOutput.tables.filter(table => table.disposition === 'implemented').map(table => table.name);
  const legacyOutput = legacyDisposition(legacy, implemented);
  legacyOutput.source.sha256 = digest(legacyBuffer);
  await writeFile(path.join(directory, 'logical-catalog.json'), `${JSON.stringify(directoryOutput, null, 1)}\n`);
  await writeFile(path.join(directory, 'legacy-disposition.json'), `${JSON.stringify(legacyOutput, null, 1)}\n`);
  console.log(JSON.stringify({ catalog: directoryOutput.counts, catalogDisposition: directoryOutput.dispositionCounts, legacy: legacyOutput.count, legacyDisposition: legacyOutput.dispositionCounts }));
}
if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) await main();
