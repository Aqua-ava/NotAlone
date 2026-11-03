import {registry as base} from '../../../src/storage/sqlite/registry.ts';
/** 保留图文接入前的已发布结构，用真实重开验证文字引用升级。 */
export const registry={...base,migrations:base.migrations.filter(migration=>migration.version<=31)};
