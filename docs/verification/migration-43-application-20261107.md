# 迁移 43 应用真实库记录（2026-11-07，用户批准）

任务：`.scratch/runtime-waste-cleanup-20261106/issues/02-deletion-lookup-indexes.md`（实现与副本实测见该任务 `## Answer`，提交 `995e4b3a7`）。本记录登记快照与真实库应用结果（R5）。

## 改前快照

- 路径：`backups/sqlite/before-migration-43-20261107.sqlite`
- 生成方式：**APFS 克隆（`cp -c`）**，不是 `sqlite3 .backup`——`sqlite3 -readonly` 直开真实库在本机持续返回 `unable to open database file (14)`（`file:` immutable 读正常，判为本地安全机制对该受保护路径的加锁限制），改为"无进程占用窗口内 ＋ APFS 逐字节克隆"达成同一单文件快照目标，并以下列核对兜底：
  - `shasum` 逐字节一致：`501f564f07ed7e63…`（3,199,328,256 字节）；
  - `immutable` 只读核对：`schema_migration` 42 行、`max(version)=42`、`user_version=42`、`journal_mode=delete`；
  - 前后两次 `lsof` 均无真实库占用；快照后真实库 shasum 未变。
- 用途：迁移 43（`message_alias_message(owner_id,message_id)` 索引）应用真实库前的唯一回滚点。版本升至 43 后旧代码会报 `schema_too_new`，回滚只能还原本快照。
- 可删除条件：迁移 43 在真实库应用成功、后续一轮开发（含联系人删除路径实际使用）确认无问题、且按`.scratch/runtime-waste-cleanup-20261106/issues/03-backup-retention.md` 保留策略"保留最近 2 份改动前快照"排序时被更晚快照覆盖后，可由用户批准处置。删除后保留当前应用程序库即可。

## 应用条件（用户批准的顺序）

1. 完整退出 App 与开发后台，`lsof` 确认无真实库占用。✓（2026-11-07 00:24 核对：stopped、无占用、epoch 1215、journal delete）
2. 建快照并核对（见上）。
3. `pnpm run dev` 打开 App，迁移自动执行。
4. 60 秒打开预算超时会自动回滚（库保持 42 版、无半迁移状态）；重试一次；再失败停下报告，不改预算、不手改库。
5. 成功后核对 schema=43、quick_check／foreign_key_check 通过、`message_alias_message` 索引存在，耗时与结果回填本记录与任务 02 的 Answer。

## 结果

2026-11-07 00:27–00:36 执行（用户已批准）：

- 开发实例启动后，因同一会话并行的另一重构任务（04）正在修改共享源码，开发监督器连续串行重启后台多次；存储第一次成功打开在重启循环结束后完成。**`database_instance.epoch` 从 1215 推进到 1219（四次成功打开）**，无失败积压。
- **`schema_migration` 43 行、`max(version)=43`、`user_version=43`、`message_alias_message` 索引存在**；随后重开仍稳定为 43。
- `PRAGMA quick_check` 通过（暖缓存 1 秒）；`PRAGMA foreign_key_check` 0 行违反；`journal_mode=delete`、无 `-wal`/`-shm` 残留。
- 主数据库文件大小不变：3,199,328,256 字节——建索引完全复用库内既有空闲页（与 3 GB 副本实测一致的形态）；索引 `dbstat` 体积在副本实测为 35,725,312 字节。
- 未触发 60 秒打开预算超时重试路径（前两次打开未在成功窗口内完成提交，均安全回滚有据；成功路径在页面缓存多次预热后完成）。
- 后续验证：在库中直接 `EXPLAIN QUERY PLAN` 确认删除路径三处反查（真实库数据行数见任务 02 Answer）由 owner 前缀扫描变为按 `(owner_id=? AND message_id=?)` 索引精确定位。

**剩余风险（记录在案）**：
1. 60 秒打开预算下的冷缓存首开仍可能出现"超时→安全回滚→热后再试"的现象（本次即发生），不影响一致性；若想根除需改打开预算或打开后延迟整检的内容，属产品行为决策，未做。
2. 本机 `sqlite3 -readonly` 直开真实库持续返回 `unable to open database file (14)`（`immutable` 只读正常），影响以 CLI 工具直接校验；产品内打开不受影响（本次迁移即通过产品路径完成）。
3. 沙箱限制：在 Agent 沙箱会话内启动的 App 继承沙箱文件锁限制——后续验收涉及真实库打开时，应由用户正常 shell 启动，或按需免沙箱启动本会话命令。

**租约侧重申**：开发实例已按用户流程完成应用并核对；当前 App 已退出（用户离开时也保持停止），真实库无占用。
