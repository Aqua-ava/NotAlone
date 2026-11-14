import {registry as current} from '../../../src/storage/sqlite/registry.ts';

// 固定旧结构，后续迁移不能替换第 53 版到新版的原地升级覆盖。
export const registry={...current,migrations:current.migrations.slice(0,53)};
