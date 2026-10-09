# 01 — 支持增量观察记忆任务的持久状态

Triage: ready-for-agent
State: claimed
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
