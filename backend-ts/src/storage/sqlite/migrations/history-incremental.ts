import type { StorageMigration } from '../contracts.ts';

/**
 * 迁移 14：增量交接与检查点（只 ALTER，不重建既有 CHECK）。
 * - read_goal 增加终页续读游标、游标作用域证据与检查点进度；
 * - message 增加发送状态观察列；语义解释仍依赖支持档，代码不把状态值推断为完成。
 */
export const historyIncrementalMigration = (version: number): StorageMigration => ({
  version,
  sql: `
ALTER TABLE read_goal ADD COLUMN resume_cursor TEXT;
ALTER TABLE read_goal ADD COLUMN cursor_scope_digest TEXT;
ALTER TABLE read_goal ADD COLUMN cursor_scheme TEXT;
ALTER TABLE read_goal ADD COLUMN handoff_from_goal_id TEXT;
ALTER TABLE read_goal ADD COLUMN pages_accepted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE read_goal ADD COLUMN last_accepted_at INTEGER;
ALTER TABLE message ADD COLUMN status_code TEXT;
ALTER TABLE message ADD COLUMN status_observed_at INTEGER;
`,
});
