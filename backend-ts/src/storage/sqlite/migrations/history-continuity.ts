import type { StorageMigration } from '../contracts.ts';

export const historyContinuityMigration = (version: number): StorageMigration => ({ version, sql: `
CREATE TABLE history_continuity_fence (
 owner_id TEXT NOT NULL, contact_id TEXT NOT NULL, reason TEXT NOT NULL,
 PRIMARY KEY(owner_id,contact_id), FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id)
) STRICT;
CREATE TABLE history_continuity_scope (
 owner_id TEXT NOT NULL, contact_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 source_generation TEXT NOT NULL, tables_json TEXT NOT NULL,
 PRIMARY KEY(owner_id,contact_id), FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id),
 FOREIGN KEY(owner_id,conversation_id) REFERENCES channel_conversation(owner_id,id)
) STRICT;
` });
