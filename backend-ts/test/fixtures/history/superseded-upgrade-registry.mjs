import {registry as base} from '../../../src/storage/sqlite/registry.ts';

// legacy 只截取到 44（新增 superseded_history 范围之前）；升级执行沿正式迁移 45。
// 截断后的动作表仍含 45 才有的动作，旧库不会调用它们。
const legacy=new URL(import.meta.url).searchParams.get('mode')==='legacy';
export const registry={...base,migrations:legacy?base.migrations.filter(migration=>migration.version<=44):base.migrations};
