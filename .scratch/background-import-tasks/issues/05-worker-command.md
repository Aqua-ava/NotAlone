# 05 — Worker 启动命令

**Triage:** ready-for-agent  
**State:** resolved

**What to build:** 提供 `notalone-task-worker` 命令，复用已有模型提取和 `BackgroundTaskWorker`，让用户可以指定一个联系人并串行执行该联系人最早的一个导入后台任务。

**Blocked by:** 02 — Worker 记忆提取；03 — 联系人记忆目录

- [x] 启动前校验数据库、owner、联系人和模型配置。
- [x] PostgreSQL 全局会话锁保证当前 v1 只有一个命令 Worker。
- [x] 一个命令连续执行 `parse -> normalize -> extract_memory -> index -> verify`。
- [x] 暂时失败自动退避重试，永久失败返回非零退出码。
- [x] 长提取步骤通过租约心跳续期，成功步骤不重复执行。
- [x] 输出只包含状态、步骤数量和错误分类。

## Answer

已完成：新增 `notalone-task-worker` 命令，启动前校验数据库、owner、联系人和模型配置；使用
PostgreSQL 会话级全局锁保证 v1 当前只有一个命令 Worker；一次只处理指定联系人最早的一个任务，
连续执行五个固定步骤，暂时失败按 1/2/4 秒退避并复用已有最多三次重试语义。新增步骤租约续期，
模型提取超过默认租约时仍可安全完成；命令输出不含聊天正文、联系人标识或模型完整输入输出。

验证：Worker 锁、租约续期和长提取保活测试通过；命令单元测试通过；全套 `275` 个 unittest
通过，`2` 个真实凭据测试按环境跳过；编译、`git diff --check` 和入口 `--help` 通过。

真实本地任务验证：当前 207 条来源任务由命令推进到 `succeeded`，五个步骤均完成，目录为
`active`。联系人提取水位在本次 Worker 启动前已经指向这 207 条消息的末尾，因此本次
`extract_memory` 按幂等规则处理 0 条；已有候选和已确认记忆仍各有来源引用，未重复生成。
