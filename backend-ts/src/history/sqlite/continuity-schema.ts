import type { StorageMigration } from '../../storage/sqlite/contracts.ts';

export const historyContinuityMigration = (version: number): StorageMigration => ({ version, sql: `
CREATE TABLE history_continuity_fence (
 owner_id TEXT NOT NULL, contact_id TEXT NOT NULL, reason TEXT NOT NULL,
 PRIMARY KEY(owner_id,contact_id), FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id)
) STRICT;
` });
