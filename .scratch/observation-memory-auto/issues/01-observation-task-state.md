# 01 — 支持增量观察记忆任务的持久状态

**State:** ready
**Blocked by:** none

## What to build

扩展后台任务的持久模型、值对象和 Worker 领取/完成边界，使 observation 任务可以按联系人复用既有提取、索引和核验步骤，并保持历史导入与删除任务兼容。

## Acceptance

- `background_task` 支持 observation 类型和不绑定历史来源文件的联系人级任务；既有 import/delete 外键、状态和删除语义保持有效。
- 观察任务按 owner/contact 唯一，终态在新观察触发时可安全重排，运行中不重置租约或重复领取。
- Worker 可领取 observation 任务，复用现有 extraction/index/verify runner；任务仍使用联系人有效消息与水位。
- 未确认绑定、来源删除、联系人删除和失效租约不会让 observation 任务复活。
- 任务查询和恢复入口返回非正文状态；既有导入任务回归不受影响。

## Verification

先写失败测试，再跑观察任务模型、仓储、Worker 和既有导入/删除相关测试；使用随机 `_test` 数据库、合成联系人与 scripted fake model。
