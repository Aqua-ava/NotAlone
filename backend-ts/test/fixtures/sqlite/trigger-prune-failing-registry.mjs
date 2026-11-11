import {registry as base} from './trigger-prune-registry.mjs';
export const registry={...base,migrations:[...base.migrations,{version:base.migrations.at(-1).version+1,sql:'INSERT INTO intentionally_missing_table VALUES(1);'}]};
