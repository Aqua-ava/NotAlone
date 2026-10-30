import { registry as base } from '../../../src/storage/sqlite/registry.ts';
// 只安装迁移 1..12 的旧结构库；用于验证升级到当前 13/14/15。
export const registry = { migrations: base.migrations.slice(0, 12), actions: base.actions };
