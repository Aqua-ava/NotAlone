import {loadPreSourceProofRegistry} from '../sqlite/pre-source-proof-registry.mjs';
import {registry as current} from '../../../src/storage/sqlite/registry.ts';

// 只截取已发布迁移；42 为记忆自动处理总开关，43 为 message_alias 反查索引，44 为 execution_input 外键子列索引，legacy 截到 41，升级执行沿正式迁移。
const legacy=new URL(import.meta.url).searchParams.get('mode')==='legacy';
const base=legacy?await loadPreSourceProofRegistry():current;
export const registry={...base,migrations:legacy?base.migrations.filter(migration=>migration.version<=41):base.migrations};
