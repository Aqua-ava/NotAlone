import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFERRED_DESIGN_TABLES, EXPECTED_TABLES, IMPLEMENTED_DESIGN_TABLES, LOGICAL_CATALOG_TABLES, REPLACED_DESIGN_TABLES } from '../src/platform/cutover/structure.ts';

const directory = new URL('./fixtures/cutover/', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('logical-catalog.json', directory), 'utf8'));
const legacy = JSON.parse(await readFile(new URL('legacy-disposition.json', directory), 'utf8'));
const structure = JSON.parse(await readFile(new URL('structure-baseline.json', directory), 'utf8'));

test('77 表／778 字段／215 FK 逻辑目录逐项 disposition 与实现集合闭合', () => {
  assert.equal(catalog.counts.tables, 77);
  assert.equal(catalog.counts.fields, 778);
  assert.equal(catalog.counts.foreignKeys, 215);
  assert.deepEqual(catalog.dispositionCounts, { implemented: 67, deferredEntryClosed: 9, replaced: 1 });
  assert.deepEqual(catalog.tables.map(table => table.name).sort(), LOGICAL_CATALOG_TABLES, '逻辑目录名称与代码分类必须一致');
  assert.deepEqual(LOGICAL_CATALOG_TABLES, [...IMPLEMENTED_DESIGN_TABLES, ...DEFERRED_DESIGN_TABLES, ...REPLACED_DESIGN_TABLES].sort());
  const deferred = catalog.tables.filter(table => table.disposition === 'deferred_entry_closed').map(table => table.name);
  assert.deepEqual([...deferred].sort(), [...DEFERRED_DESIGN_TABLES].sort());
  const replaced = catalog.tables.filter(table => table.disposition === 'replaced').map(table => table.name);
  assert.deepEqual(replaced, [...REPLACED_DESIGN_TABLES]);
  // 实际结构基线只含实现逻辑表与 25 张实现关联表，不建暂缓／替代表。
  assert.deepEqual(Object.keys(structure.tables), EXPECTED_TABLES);
  assert.equal(EXPECTED_TABLES.length, 92);
  assert.equal(IMPLEMENTED_DESIGN_TABLES.length + 25, EXPECTED_TABLES.length);
  assert.match(structure.metadata.sqliteVersion, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(structure.metadata, { schemaVersion: 28, migrationVersions: Array.from({ length: 28 }, (_, index) => index + 1), userVersion: 28,
    sqliteVersion: structure.metadata.sqliteVersion, tableCount: 92, fieldCount: 914, foreignKeyGroups: 192, triggerCount: 99, checkCount: 295, viewCount: 0 });
});

test('115 个迁移来源名称逐项 disposition 闭合且落点集合可核验', () => {
  assert.equal(legacy.count, 115);
  assert.deepEqual(legacy.dispositionCounts, { implemented: 80, replacedEntryClosed: 1, deferredEntryClosed: 8, retiredManualImport: 1,
    outOfScopeEntryClosed: 16, derivedNoTable: 2, retired: 7 });
  const logical = new Set([...LOGICAL_CATALOG_TABLES, 'history_source_exclusion']);
  for (const row of legacy.tables) {
    assert.ok(typeof row.oldTable === 'string' && row.oldTable.length > 0);
    assert.ok(['implemented', 'replaced_entry_closed', 'deferred_entry_closed', 'retired_manual_import', 'out_of_scope_entry_closed', 'derived_no_table', 'retired'].includes(row.disposition), row.oldTable);
    for (const target of row.targets) assert.ok(logical.has(target) || target === 'read_exclusion' || target === 'history_source_exclusion', `${row.oldTable} 目标 ${target} 不在逻辑目录`);
    if (row.disposition === 'implemented') assert.ok(row.targets.length > 0 && row.targets.every(target => logical.has(target) || target === 'read_exclusion'));
    if (row.disposition === 'deferred_entry_closed') assert.ok(row.targets.some(target => DEFERRED_DESIGN_TABLES.includes(target)));
  }
  assert.deepEqual(catalog.source.artifact, 'consolidated-schema.json');
  assert.match(catalog.source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(legacy.source.artifact, 'consolidated-legacy-check.json');
  assert.match(legacy.source.sha256, /^[a-f0-9]{64}$/);
});
