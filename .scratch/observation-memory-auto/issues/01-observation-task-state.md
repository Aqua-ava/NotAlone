# 01 — 支持增量观察记忆任务的持久状态

Triage: ready-for-agent
State: resolved
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

## Comments

2026-10-09：按 implement → TDD → 双轴评审继续本票。基点 `11bd959` 已包含
`8184bf0` 合入的模型、045 迁移及初版仓储实现，票面尚未收尾。本轮在任务仓储、
TaskService、Worker 的既定公开接缝核验并补缺，不接入任务 02 的事件唤醒。
独立随机 `_test` 库应用现有 45 个迁移，初版模型与观察任务 7 项验证通过。
不使用业务库、真实微信、外部模型或桌面验收。

首轮补缺：TaskService.defer 对 observation 的配置错误原先不记录（公开状态返回
None，red），接通受绑定范围限制的排队原因后 green。相同 Worker 在下一轮能用
旧 claim 完成步骤（未抛租约错误，red），新增 046 领取代次后拒绝旧完成、失败和
续期；过期接管与正常心跳兼容。既有 045 不改写。

当前验证：观察任务及 Worker/留存 25 项通过；根目录执行 unit 950 项通过。
首次从 backend 目录执行 unit 因实验模块的仓库根导入路径缺失报错，改用根目录
约定入口后通过，未修改无关实验模块。真实提取接线用例首次使用非法 `hobby` 主题
导致候选被拒绝，修正合成模型的受控主题后通过；这不是生产代码红绿证据。
来源删除后候选清除，重复排队沿用水位且不重新发送已删除消息给合成模型。
领取代次只是无正文元数据；没有变更采纳门或增量观察自动触发方式。等待双轴评审及
相关迁移、导入、删除、HTTP 回归后收尾。

## Answer

2026-10-09：任务 01 完成。初版 `8184bf0` 加本轮 `1b390b4` 提供联系人级唯一
observation 任务、终态重排、运行中新批次合并、提取／索引／验证、失败恢复和非正文
状态查询。本轮补齐配置不可用原因，并通过独立领取代次拒绝跨轮次或过期接管的旧结果。
观察任务没有历史文件外键；import/delete 原来源约束保持。调用创建／重排接缝的前提
仍是可靠观察已经提交，批次事件筛选与自动唤醒由任务 02 实现，本票没有自动调度。

验收覆盖：并发创建复用任务，运行中不重置有效租约；成功步骤在失败恢复时保留；
解绑后拒绝创建、领取、恢复、完成和续期；跨 owner/contact 不能查询或恢复；联系人
删除后旧任务不可恢复。真实观察存储和生产提取执行器使用合成模型完成候选与水位；
来源删除清除失去来源的候选，后续执行不能再次读取已删除消息。联系人任务不依附于
单份来源，因此来源删除不删除整位联系人的任务身份，仍可处理其他有效消息。

### 已运行验证

均先执行 `conda activate NotAlone`，设置 `NOTALONE_DISABLE_DOTENV=1`；数据库验证
显式指向本轮随机 `_test` 库，HTTP 与迁移测试按自身夹具另建随机库。

- 根目录：`python -m unittest discover -s backend/tests/unit -t backend`：950 项通过。
- backend：`python -m unittest discover -s tests/integration/tasks -t . -v`：25 项通过。
- backend：`python -m unittest tests.integration.persistence.test_database_migrations tests.integration.persistence.test_database_adoption tests.integration.persistence.test_observation_store tests.integration.persistence.test_observation_reply_deletion tests.integration.server.test_failed_task_recovery tests.integration.server.test_import_task_api tests.integration.server.test_import_auto_flow tests.integration.server.test_core_business_flow -v`：104 项中首次 103 项通过、1 项 `adoption_writers_present` 错误；该错误发生于旧库接管测试的连接保护，不是断言失败。
- 对上述失败单项 `tests.integration.persistence.test_database_adoption.DatabaseAdoptionTest.test_interrupted_036_rolls_back_and_resumes_from_audited_035` 原样重跑：1 项通过；保留首次失败记录，不宣称首轮全绿，也不据此声称偶发连接问题已修复。
- backend：`python -m mypy src/notalone/tasks/models.py src/notalone/persistence/background_tasks.py --follow-imports=silent`：2 个生产文件通过；`git diff --check` 通过。
- 新库 001–046 安装与重复执行、旧库审计后续迁移均有测试；045 及以前迁移内容不变。精确随机库 `notalone_observation01_92625d361e4a47dd84ceb28042d5b047_test` 删除前 owner 残留 0，删除后 catalog 核对不存在。

### 评审、数据影响及剩余工作

按 code-review 技能独立执行 Standards／Spec：确认问题均为 0。开始基点是
`11bd959`；期间其他会话提交 `a635823`、`ddfb6cb` 两笔草图更新，已明确排除在本票
成果之外；本票 `1b390b4` 只包含自己的 9 个文件，集成分支沿用当前
`codex/prototype-conversation-paths`，没有推送或创建远端分支。

只新增领取代次等无正文元数据，不改变采纳门、联系人授权或读取范围；未迁移业务库、
读取真实聊天、调用外部模型、启动微信或桌面 App。046 使用前须按数据库说明停旧
Worker 并受控升级。任务 02 的观察提交后自动唤醒仍未实现，真实渠道集成未验收。
