import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {createDeletionActions} from '../../../src/storage/sqlite/deletion/actions.ts';

// 明确省略生产领域注册，验证缺少闭包时拒绝；不依赖当前安装哪些业务域。
export const registry = {migrations: base.migrations, actions: createDeletionActions()};
