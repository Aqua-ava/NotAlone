import {registry as current} from '../../../src/storage/sqlite/registry.ts';
import {loadPreSourceProofRegistry} from '../sqlite/pre-source-proof-registry.mjs';

// 38→39是单项历史升级；current始终走现行完整迁移，不把modern动作装到旧DDL。
const mode=new URL(import.meta.url).searchParams.get('mode')??'current';
const historical=['legacy','index39'].includes(mode),base=historical?await loadPreSourceProofRegistry():current;
export const registry={...base,migrations:historical?base.migrations.filter(migration=>migration.version<=(mode==='legacy'?38:39)):base.migrations};
