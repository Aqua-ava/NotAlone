import {registry as base} from './trigger-prune-registry.mjs';
export const registry={...base,migrations:base.migrations.filter(migration=>migration.version<=48)};
