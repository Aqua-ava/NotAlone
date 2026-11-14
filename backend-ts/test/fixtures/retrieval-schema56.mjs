import {registry as current} from '../../src/storage/sqlite/registry.ts';
import {registry as beforeIndex} from './retrieval-schema55.mjs';
// 已应用的最初56没有向量游标与manifest补迁移；保留真实旧删除装配供恢复验收。
export const registry={...beforeIndex,migrations:current.migrations.filter(m=>m.version<=56)};
