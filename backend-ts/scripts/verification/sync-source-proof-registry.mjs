import {registry as current} from '../../src/storage/sqlite/registry.ts';

// 固定45→46的验证上限；仅重放迁移并核对授权，不进入当前版本运行流程。
export const registry={migrations:current.migrations.filter(migration=>migration.version<=46),actions:current.actions.filter(action=>action.name==='identity.eligibility')};
