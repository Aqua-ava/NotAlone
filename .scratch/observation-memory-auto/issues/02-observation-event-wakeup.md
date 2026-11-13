# 02 — 观察提交后自动唤醒记忆任务

Triage: ready-for-agent
State: resolved
**Blocked by:** 01 — observation 任务的持久状态和 Worker 领取能力

## What to build

在本地微信 CLI 观察批次可靠提交并发布消息事件后，创建或重排 observation 任务并调用现有 `TaskHost.wake`。调度失败不能回滚已提交的消息、来源或游标；同一联系人事件应合并，跨联系人和 owner 必须隔离。

## Acceptance

- 新建消息观察批次在事务提交后自动排队并完成记忆处理，公开状态可查询。
- 同批次重放、并发事件、运行中新增批次和锁忙均不丢唤醒或重复执行。
- 绑定撤销、来源删除、后端关闭和旧事件晚到时不创建或复活任务。
- 任务缺少模型配置时保持 queued 并记录稳定原因；修复配置后可显式或新观察继续。
- 仅处理已确认联系人的观察消息，不触发其他联系人或旧导入任务。

## Verification

在真实观察存储、真实 PostgreSQL、真实 Worker 与 scripted fake model 上先红后绿；覆盖任务状态、消息水位、来源引用、候选/记忆结果和隔离，不读取真实微信或业务库。

## Comments

2026-10-09：从 `b4d9bb5` 继续 implement → TDD → 双轴评审；任务 01 已完成。
沿用消息提交后的公开发布端口、TaskHost、真实观察存储和 HTTP 任务状态接缝。
事件只作通知，数据库复验消息的观察来源与绑定后按观察批次去重调度；全局锁忙由
既有 TaskHost 保留唤醒。验证仅用新建随机 `_test` 库及合成模型，不运行桌面或微信。

## Answer

2026-10-09：任务 02 完成。实现提交 `24084fe`，后续评审修复随本记录提交。
本地后端将已提交观察消息通知交给 TaskHost；数据库按 owner/contact、原绑定和消息来源
复验，再将观察排队凭证与联系人任务重排原子提交。重复批次不重开终态，锁忙保留唤醒，
运行中新批次保留下一轮，配置缺失留在 queued，后续新观察或显式执行可继续。
失败轮次只有仍有效的新批次能重开预算；解绑、来源删除和关闭拒绝旧通知。
调度失败不会回滚观察消息、来源和游标，日志只记录稳定无正文分类。

TDD 证据：同秒消息按 UUID 排序漏提、解绑后的锁忙等待、失败轮次丢失新批次及关闭
信号窗口均先复现后修正。评审新增多轮用例复现已删除新来源导致第 5 次模型调用
（预期 4 次），清除自动重排后的父任务开始时间后通过。真实 PostgreSQL 锁等待用例
复现事务开始时间早于拿锁时刻，回执与父任务领取时间统一改用持锁后的实际时刻后通过。
测试开发中的缺失 shutdown 回调、错误来源列名、遗漏 lease_duration 和等待时限
均属合成夹具修正，不计作产品缺陷。

实际验证（均先激活 Conda `NotAlone`，设置 `NOTALONE_DISABLE_DOTENV=1`）：

- 根目录 `python -m unittest discover -s backend/tests/unit -t backend`：950 项通过。
- backend 目录 `python -m unittest`，模块为
  `tests.integration.tasks.{test_worker,test_task_retention,test_observation_task}`、
  `tests.integration.server.{test_observation_auto_flow,test_import_auto_flow,test_core_business_flow,test_failed_task_recovery,test_import_task_api}`、
  `tests.integration.persistence.{test_observation_store,test_observation_reply_deletion,test_database_migrations,test_database_adoption}`、
  `tests.integration.memory_extraction.test_extraction_trace`：展开模块名运行，166 项通过。
- 评审修正后的最终命令：`python -m unittest tests.unit.application.test_import_service tests.integration.server.test_observation_auto_flow tests.integration.tasks.test_observation_task tests.integration.tasks.test_worker -v`：50 项通过，含 18 项观察自动流程测试。
- `python -m mypy --follow-imports=silent` 检查 background_tasks、import_service、event_publisher、cli_support 四个修改模块：通过。加上 server/command.py 有 4 处既有 name-defined；固定基线相同位置原有 5 处，本次 TaskHost 导入消除其中 1 处，其余不在任务内。
- `git diff --check`：通过。测试使用本任务新建随机 `_test` 库或夹具自建库，正式迁移安装、重复执行及采用旧库流程均仅在隔离库验证，测试库已清理。

## Standards

初审 0 项硬规范问题、1 项非阻断性命名建议：布尔判断名称隐藏状态修改。
已将 `_can_execute` 更名为 `_prepare_for_execution`，补充可消费新批次重排的说明；复审无遗留问题。

## Spec

初审 1 项 P2：成功进入下一轮未清父任务 started_at，使已删除的新批次可能错误重开预算。
已修正并追加多轮与锁等待回归；复审无遗留问题。最终 Standards 0 项、Spec 0 项。

数据与剩余边界：只新增观察上的无正文排队时间戳，随来源删除；任务元数据仍按
owner/contact 隔离。ADR-041 明确修订 ADR-034/038 的有限范围。独立同步 CLI 不自动
提取，重启不扫描旧队列，内存通知丢失可由后续新观察或显式执行继续。只修复同秒
入库顺序，更早时间戳的历史回补仍沿用原联系人水位规则。既有业务库需受控升级至
迁移 047；未读取真实微信、未启动桌面、未调用外部模型、未迁移业务库、未 push。
