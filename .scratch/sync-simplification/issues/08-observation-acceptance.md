# 观察期验收：正常使用下不再出现围栏

Triage: wontfix
State: resolved
Type: task
Blocked by: 03

新读取器（原生守卫登记修复）与诊断日志已在应用中启用。需要用户正常使用若干天后核对。

## 要做

- 正常使用（含多次退出再进入）3 到 7 天后，读取 `logs/history-continuity.jsonl` 与库内围栏数，汇总新增围栏的入口、分支编号和联系人编号。
- 无新增 → 记录结案；有新增 → 按日志归因，并作为新任务单（含入口与条件）追加。

## 验收

- 汇总报告写入 `docs/verification/`：观察时长、重启次数、围栏新增数、各入口计数。

## 约束

- 真实库 `~/Library/Application Support/NotAloneDesktop/managed/sqlite/notalone.sqlite` 只读；演练用副本；动真实库前先备份。
- 在独立工作树改代码（dev 应用热更新会因主工作区源码变化重启）。不点任何“修复同步”。
- 报告和提交不含联系人姓名与聊天内容，联系人用编号或 `contact_id` 前 8 位。
- 本地提交（Conventional Commits，中文，无署名行），不 push。验证记录写入 `docs/verification/`，现行规格与 ADR 同步。

## Comments

## Answer

2026-11-07：用户决定自行做观察，本任务关闭，不由 Agent 执行。观察所需的诊断日志（`logs/history-continuity.jsonl`）和围栏计数已就绪；发现新围栏时按日志的入口与分支编号另立任务单（已有首条：见 09）。
