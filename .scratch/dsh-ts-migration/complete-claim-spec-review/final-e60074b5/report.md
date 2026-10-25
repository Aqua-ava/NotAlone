# 最终小增量 Spec 审查

结论：**approve**。最终源码候选 `e60074b5946b8d1c990fcb75ba13bd58f789b2fb` 在本次 Spec 范围内可接受，未发现阻塞缺陷。原核心审查仍绑定 `bcc6701ce67249d18b51625c07f4cad4e401ad04`，本报告只追加 `bcc6701 → e60074b5`，不改写原核心阶段身份。

## 依据与范围

最新授权依据为 `.scratch/dsh-ts-migration/acceptance-scope-update.md:40–49`。固定输出 4096、输出容量预算、费用比 1.10 和费用预算不再用于本轮否决；usage、费用、失败、unknown、质量、来源、授权、取消和完整分母要求继续有效。没有以旧费用门槛否决，也没有将豁免写成测量达标。

补审四个提交：`ac427b00`、`9b20e99c`、`b448474a`、`e60074b5`。完整 delta 为 116 个路径，其中既有共享实现改动 9 个文件；其余为新增测试、工程接缝和证据。未读取 Standards 报告或私有真实预审材料。

## 源码判断

- `host-reply-config.ts:45–50,82–120`：缺省输出与 provider/model/request 统一使用 393216，显式配置严格校验，未把上下文容量当输出上限。独立查询的[官方模型目录](https://api-docs.deepseek.com/api/list-models/)明确区分 `context_window=1048576` 与 `max_output_tokens=393216`；这只是能力约定，不是本审查的真实供应商调用证据。
- `extraction-flow.ts:147–174`：prepare 回到既有错误处理区；协议准备失败归一为 invalid_output，保留结构拒绝计数，取消优先；来源或追踪错误仍传播。`extraction-batch-service.ts:27–36,99–107,257–259` 与 `host-reply.ts:77–79,292–297` 只增内部可选重试策略；正式评测可显式 0/0，产品省略时沿用 Flow 原默认 5 次／30000 ms，没有新增产品 API 或未知回执重放路径。
- `execution-snapshot.mjs:13–85`：显式策略绑定原 primary 摘要和本轮范围；输出之外的 controls 不变，旧默认仍 4096。派生执行副本保留适配前后 SHA，原 primary、冻结材料和既有真实测量报告未改写。
- `runner.mjs:112–183,281–289`、`run-full.mjs:13–48` 与 `normalize.mjs:110–135,235–295`：两臂控制绑定实际 wire、模型和输出参数；失败及零调用仍保留，正式入口维持 96 条及每臂 48 的分母，没有自动重试。collector 仍以明确源码 pin 建立执行快照。
- `reply-comparison.ts:203–225,327–363`：费用豁免只从资格合取中移除 cost，原费用测量、旧阈值结果、null 和 unknown 均保留；未豁免项仍阻塞。工程 FormalExecutor 必须由根显式注入端口和正式资格，工程证据不升级为质量通过。

## 独立验证

只在仓库外 0700 的固定 SHA archive 执行；raw 日志始终在仓库外 0700/0600，仓库只有脱敏公开副本。

| 验证 | 结果 |
| --- | --- |
| 本轮 scope/primary 真实摘要，旧默认及派生副本；修改 temperature/retry/非法输出反例 | 通过 |
| 改一臂输出、丢失请求哈希、伪造零调用的三个实际 wire 反例 | 全部拒绝 |
| 费用极高或未知仍如实保留；新增严重假事、usage unknown、少一条记录 | 费用豁免有效，其余反例均不能通过；96/48/48 保持 |
| 无根端口调用正式工程执行器 | 拒绝 |
| 实际 strict 发送入口配置及预约摘要（fetch 全程合成拦截） | 通过 |
| 61 条准备错误在默认/NULL/v1/v2 的旧错误合同，以及取消优先级 | 通过，E1/V0 |
| 真实随机合成库的内部 retry0 与省略策略 | 通过；前者不重试，后者保留原重试资格 |

独立探针 4/4、定向用例 5/5，命令与退出码见 `verification.json`／`log-binding.json`。未重跑原核心全套、原 98 项或完整 backend。两个自有合成库普通 DROP 后精确查验不存在；固定 archive 前后 116 个路径 SHA 一致，结束后删除 archive，保留外部私有 raw 原件。见 `cleanup.json`。

最终 source stamp 为 `f22df426d48d701ef520cdbd6a1262497545b830cbec1dff9b3be4ee92ea5f50`，与旧核心的 `2e36ada0…` 分别记录，未混用旧证据身份。没有修改生产代码、共享 index、真实资料、App/微信、真实模型、push 或 PR。

本报告只批准上述最终源码的 Spec 差异；**真实质量、完整功能/性能、实际 App/微信及 Ticket 25/26 均未由本审查批准**。
