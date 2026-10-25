# 完整命题核验：Standards 核心审查

- 结论：`request_changes`，1 项 P2；仅评价本次固定源码差异。
- 基点：`d4e7690bd9f57a2fae66b04d348219476c0cb497`。
- 核心候选：`bcc6701ce67249d18b51625c07f4cad4e401ad04`。
- manifest：`.scratch/tencent-source-reuse/quality-followup/complete-claim/manifest.json`，SHA256 `88b7c4844d766f1ded51fd877ec1dab6e6d374d6983212558a9bac9e2281990f`。
- 34 路径及逐文件 SHA 见 `review-scope.json`；31 payload 哈希全部匹配。本报告不绑定工作树输出配置或尚未收到的最终 pin。

## [P2] 保留旧任务遇到非法候选数量时的失败合同

位置：`backend-ts/src/extraction-flow.ts:149-150`；抛错点：`backend-ts/src/complete-claim-verification.ts:115`。

`prepareSourceVerification()` 在核验的 try/catch 之外执行。默认 legacy 输入返回 61 条结构合法候选时，原有数量校验现在抛出 `ExtractionProtocolError('complete_claim_policy_invalid')`。基点对完全相同输入返回 `failure_kind=invalid_output`、`extraction_completed=true`、空 accepted。

这会改变旧 NULL/v1 的任务失败和恢复路径：原返回值经 `extraction-task-runner.ts:144-150` 处理，最终在 `:179` 包为可重试任务错误；新异常经 `:133-140` 的 `trace_failed` 原样传播，没有 `retryable=true`，而 `extraction-worker.ts:45-46` 仅认该字段。原模型非法输出因此成为不可自动重试的任务失败。违反既有错误语义与可见恢复约束（`architecture/current/core-flows.md:50-51`、`architecture/current/domain-data.md:107-110`，以及本轮明确保留旧 NULL/v1 合同的要求）。

最小复现见 `overflow-probe.mjs`／`overflow-probe.json`：基点及候选分别从固定 Git archive 导入；E 各调用 1 次合成端口，V 均为 0。建议让准备阶段的此类协议错误继续归一成原 `invalid_output` 结果，保留来源、取消等独立故障的传播。该结论评价错误处理，不恢复已豁免的输出或费用验收门槛。

## 其余核验与证据边界

三个独立探针组通过（`standards-probes.mjs`／`standards-probes.log`）：乱序多候选和组合 Unicode 码点、请求/返回隔离、失效后重复解码、并发换响应拒绝、JSON receipt 伪造与原始大整数/1.0 摘要；实际生产依赖闭包的 9 个文件扰动、文件缺失及计算式动态导入均失败关闭；SQL116 与 TS 的 25 项配置边界一致，旧 NULL/v1 行不变，B 策略读取拒绝错范围、旧 A 版本、任务降级及换 stamp。

Interface 评审沿用 `code-review` 与 `codebase-design`：请求、指纹、幂等解码和准入集中；未见需要额外报告的设计性阻塞。静态追踪确认旧 event/conditions 检查仍合取，新 facet 失败不进入 B；来源 receipt 不把可序列化模型字段作为能力凭证。结构准入不证明一般自然语言含义，真实语义质量仍未实测。

本轮仅操作合成文本、独占随机 `_test` 库和仓库外 0700 快照；SQL 探针只建最小合成表并应用116，未执行全库迁移或完整 B 写入验收。原 96/98 RED、修复日志及根 7/7/TSC 保留原证据身份，本审查没有重跑或冒认。

`source-verification.json` 记录690个归档文件前后相同；原/公开日志 SHA 见 `log-binding.json`，原件0600。自有库已普通 DROP 且无残留连接；快照及进程收尾见 `cleanup.json`。真实模型、真实资料、原账本、App/微信、打包、共享 index、提交、push、PR 均未操作。

本报告不批准整体质量、实际 App 或 Ticket25/26；输出增量与上述修复须收到固定 pin 后另审小 delta，不能把本报告冒充最终候选通过。
