import { registry as base } from '../../../src/storage/sqlite/registry.ts';
/** 仅用于验证既有 v12 数据库升级；迁移只提供到 12，动作保持当前合同。 */
export const registry = { migrations: base.migrations.filter(migration => migration.version <= 12), actions: base.actions };
