# 受控旧库接管与本机升级

Type: task
State: claimed
Triage: ready-for-agent

## Problem Statement

用户已于 2026-10-01 明确同意上一任务的旧库升级方案，并要求由 Agent 连续完成普通验证。本机旧库没有迁移账本，结构接近 035，但来源类型仍是 025 前约束；标准迁移应继续拒绝未审计的旧库。

## Solution

提供只针对已审计 035 契约的显式接管入口。先核对受信任的 001–035 文件、完整目录及全部 owner 的来源/隔离契约；停止其他连接，在本机受限目录备份并恢复到专用副本核验。只允许补齐已知来源类型约束，与审计基线同事务提交。独立基线不表示历史 SQL 曾执行；后续受管迁移只记录实际执行的 036 及新版本。

## Implementation Decisions

- 单一入口 `audit_legacy_database` / `adopt_legacy_database` 封装目录比对、全范围校验及备份恢复，调用方不提供可伪造的“验证成功”布尔值或自由指定结构摘要。
- 035 文件清单与 SHA-256 固定在仓库 profile；参考结构由同一 PostgreSQL 16 上新建、仅含合成数据的随机 `_test` 库生成。接管只支持该完整结构或唯一已审计的 `source_document_source_type_check` 旧定义，额外对象与任何其他差异均拒绝。
- 接管与迁移共用会话 advisory lock；接管事务锁定所有业务表，拒绝其他目标库连接。备份恢复和内容摘要比对均在本机完成，不显示私人行。恢复副本不作行为测试，结束后只清理命令自己创建的副本，保留受限备份及安全验证凭证。
- 基线单独保存 prefix manifest、前后结构摘要、实际补齐 SQL 摘要、备份 SHA-256、恢复核验的内容摘要和时间；不伪造 001–035 成功账本。基线和补齐同事务，036 SQL 与实际迁移记录同事务。
- 保留总开关、原有 ID、全部资料及 65 个暂停绑定。只扩展结构能力，不删除真实来源，不调用模型、不发送微信、不访问远端。

## Testing Decisions

- 使用公开接管入口和 `migrate`，通过随机、Agent 自建 `_test` 库验证正常接管后只执行 036；真实 pg_dump/pg_restore 和安全目录权限构成备份接缝。
- 按 TDD 垂直切片补齐结构异常、全 owner 来源异常、规范消息来源合法、文件漂移、幂等、互斥、备份失败、补齐/基线事务回滚及 036 中断续跑用例。仅使用合成资料；失败输出不得带行内容或连接凭据。
- 实机升级前停止 App/后端/Worker 并核验目标库无其他连接；备份恢复比较完整表内容摘要。升级后先比较业务内容、结构与实际账本，再启动 App 核验原有 115 个绑定及 50 个覆盖无法确认/65 个暂停状态。
- 完成 Standards / Spec 两轴审查和适当的 Python 回归；测试不使用私人恢复副本。

## Out of Scope

其他历史基线、猜测历史迁移成功、有损回填、改变绑定或暂停、真实删除、私人资料模型外发、修复微信 CLI 缺失的本地消息表、远端连接与 Git push/PR。

## Comments

- 用户已明确批准 `.scratch/desktop-runtime-recovery/migration-plan.md` 的实现、受限本机备份、恢复验证和旧业务库升级。普通实现与测试不重复询问。
- 实现前 Git 基线：`88a38919bfec2d4d53e521bc1fe61b13c4a39aa9`；工作区干净。
- 实现验证：`python -m unittest tests.integration.persistence.test_database_adoption tests.integration.persistence.test_database_migrations -v`，23 项接管与 10 项原迁移用例全部通过。审查提出的系统函数遮蔽、所有权/额外对象遗漏、扩展成员函数与备份/验证文件期间并发目录变化均已有拒绝回归用例。
- 完整隔离回归：在短名称、Agent 自建合成 `_test` 库运行 `python -m unittest discover -s tests -v`，1021 项中 1018 项通过、3 项跳过；最后两项审查回归加入后，重新运行上述 33 项相关验证通过。未使用业务库或私人恢复库运行测试。
- 接管后业务接缝：合成库经公开 `adopt_legacy_database` 与 `migrate` 升级后，手动记忆录入/列表/删除、HTTP 来源删除幂等与范围隔离、清理提交后步骤凭证恢复 3 项用例全部通过。
- 两轴审查复核：Standards 轴剩余可操作问题 0；Spec 轴剩余可操作问题 0。两位审查 Agent 只读代码，未访问业务库或操作 UI。
- 本阶段仅完成实现及合成验证；真实备份、升级和 App 验收仍待下述运行阶段记录，任务保持 claimed。
