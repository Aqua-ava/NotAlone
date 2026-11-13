# 查明“修复后又被围栏”：2026-11-07 16:45 的 L01 事件

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: none

新装的诊断日志抓到第一条真实围栏：`~/Library/Application Support/NotAloneDesktop/logs/history-continuity.jsonl`，时间 2026-11-07T08:45:47Z（本地 16:45），入口 `history.markContinuityLost`，分支 `L01`，错误码 `history_source_unverified`，联系人 `27ab43c0`（中午 12:17 手动修复成功过的那位）。发生在原生守卫登记修复的读取器启用（约 14:30）之后，说明除已修的原生误判外还有别的触发路径。04 之后该入口已改为写 `source_proof`，库里该联系人现为 `needs_confirmation`。

## 要做

1. 取证（只读）：以该时间点前后 5 分钟为窗口，查该联系人 `read_goal`、`sync_capture`、`source_proof`/历史记录、`database_instance.epoch`，对照 dev 应用当时的启动与读取器状态；用 `L01` 反查代码里这条分支的条件（`backend-ts/src/history/sqlite/` 中 `markContinuityLost` 调用处）和错误码的来源（原生读取器何时返回 `history_source_unverified`）。
2. 判断它是真实来源变化，还是误判：对照当时的账号、会话、来源代次、分片与文件身份。
3. 能复现则用合成/副本写先红后绿的用例并修复；不能复现则如实写“未复现”，并把已确认的事实、入口和条件写清楚。
4. 若发现 `markContinuityLost` 对瞬时/可恢复错误过于激进，改为“降级为需确认但可原地恢复”或重试，不得放宽真实来源变化的拦截。

## 验收

- 报告写入 `docs/verification/`：事发窗口的事实、`L01` 分支条件、触发原因（已证实/未证实分开写）。
- 如有修复：失败用例先红后绿，反例仍被拒绝，全量对照基线无新增失败。

## 约束

- 真实库只读，演练用副本；不要重启或切换真实读取器；不点“修复同步”类按钮（03 才允许操作 App）。
- 在独立工作树里改代码；报告和提交不含联系人姓名与聊天内容；本地提交，不 push。

## Comments

## Answer

已完成只读取证。16:45 原生细分触发原因**未复现**；旧版将 history_source_unverified 当成来源变化已复现（旧64376743d同一服务用例1/1失败，当前16/16通过），既有02已修正，无需新增产品代码。

报告：docs/verification/sync-simplification-09-l01-20261107.md；提交41d21fc4f。命令：node --test --test-name-pattern='来源暂不可核验时五次重启' test/sync-09-source-replay.test.mjs（旧隔离工作树）；node --test backend-ts/test/sqlite-history-in-place-recovery.test.mjs（当前）。真实库/备份仅只读，无消息正文或模型出站，无读取器切换、打包、微信发送或push。代码未变，复用04同源全量对照的新增失败0；原生历史细分条件缺失仍为风险，03逐步恢复核验。
