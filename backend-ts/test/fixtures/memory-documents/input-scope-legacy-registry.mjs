import {registry as current} from '../../../src/storage/sqlite/registry.ts';
// 固定旧版结构，验证已存在的52版资料按正式入口升级。
export const registry={...current,migrations:current.migrations.filter(migration=>migration.version<=52)};
