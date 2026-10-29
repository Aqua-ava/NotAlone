import type {StorageMigration} from '../../storage/sqlite/contracts.ts';
/** 独立后续迁移，保留首份共享DDL检查点。 */
export const memoryExecutionMigration=(version:number):StorageMigration=>({version,sql:`
CREATE TABLE operation_scope (
 owner_id TEXT NOT NULL,operation_id TEXT NOT NULL,source_contact_id TEXT NOT NULL,effect_kind TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('reserved','sent','unknown','released')),
 PRIMARY KEY(owner_id,operation_id,source_contact_id,effect_kind),
 FOREIGN KEY(owner_id,operation_id) REFERENCES model_operation(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,source_contact_id) REFERENCES contact(owner_id,id)
) STRICT;
ALTER TABLE model_call ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE model_call ADD COLUMN configuration_id TEXT NOT NULL DEFAULT '';
ALTER TABLE model_call ADD COLUMN input_cap INTEGER NOT NULL DEFAULT 0 CHECK(input_cap>=0);
ALTER TABLE model_call ADD COLUMN output_cap INTEGER NOT NULL DEFAULT 0 CHECK(output_cap>=0);
`});
