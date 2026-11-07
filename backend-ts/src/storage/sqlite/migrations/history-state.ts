import type { StorageMigration } from '../contracts.ts';

/** 消息资格暂时失效，不等同于删除，且不自动恢复旧派生资料。 */
export const historyStateMigration = (version: number): StorageMigration => ({ version, sql: `
CREATE TABLE history_message_quarantine (
 owner_id TEXT NOT NULL, contact_id TEXT NOT NULL, message_id TEXT NOT NULL, reason TEXT NOT NULL,
 PRIMARY KEY(owner_id,contact_id,message_id),
 FOREIGN KEY(owner_id,contact_id,message_id) REFERENCES message(owner_id,contact_id,id) ON DELETE CASCADE
) STRICT;
` });
