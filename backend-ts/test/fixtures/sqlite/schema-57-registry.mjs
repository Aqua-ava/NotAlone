import {registry as current} from '../../../src/storage/sqlite/registry.ts';

// 固定第 57 版结构：后续迁移不能替换第 57 版到新版的原地升级覆盖。
export const registry={...current,migrations:current.migrations.slice(0,57)};
