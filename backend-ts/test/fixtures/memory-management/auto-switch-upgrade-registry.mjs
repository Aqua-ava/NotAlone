import {registry as base} from '../../../src/storage/sqlite/registry.ts';

// 只截取已发布迁移；42 为记忆自动处理总开关，升级执行沿正式迁移。
const legacy=new URL(import.meta.url).searchParams.get('mode')==='legacy';
export const registry={...base,migrations:legacy?base.migrations.filter(migration=>migration.version<=41):base.migrations};
