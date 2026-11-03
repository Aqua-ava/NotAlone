import {registry as base} from '../../../src/storage/sqlite/registry.ts';

// 只截取已发布迁移；候选、版本与升级执行沿正式动作。
const legacy=new URL(import.meta.url).searchParams.get('mode')==='legacy';
export const registry={...base,migrations:legacy?base.migrations.filter(migration=>migration.version<=38):base.migrations};
