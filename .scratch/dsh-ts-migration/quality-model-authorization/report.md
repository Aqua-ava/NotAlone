# 质量 case 模型授权工程交付

日期：2026-10-25。工程切片已完成，交统一集成与独立复审。精确源码／测试文件及 SHA-256 见 [files.json](files.json)；本切片未暂存或提交，未操作真实资料、App、微信或外部模型。

## 接口与授权

- `quality-model-caller.ts:53`：`createQualityModelCaller({ctx,provider,permit})` 返回 `call(OrganizationQualityModelInput)` 与只读 `diagnosticProblemBudgetBound`。复用已安装的官方 provider、原 Unix 许可、PG ledger 和诊断问题总账；没有新增供应商、SDK 重试或生产任务。
- `quality-model-authorization.ts:9`：独立 `ModelQualityClaim` 为 `kind:'quality_case'`、run/case/token/phase。原 `ModelTaskClaim` 的五个必填字段和严格检查保持。
- `quality-model-authorization.ts:20`：`qualityModelRequestId(runId,caseId,phase)` 为稳定 UUIDv5；物理 attempt 单独随机生成。
- `model-permit-server.ts:65` 的 `reserve_quality` 核对当前 permit 与 acquire 时的 attempt；`host-model-accounting.ts:145` 同事务核实际 case/run/token、owner/contact（含 NULL）、来源快照、世代、冻结 source_ref、attempt、预算及 lease，再持久预约回执。
- 质量 Store 的 `onDispatch` 在真实 provider 的发送前回调中持久原 attempt 和累计数。宿主不再扣 run；按原 case 的 `max_model_calls` 与 run 的 `max_http_attempts` 核验，失败、取消、unknown 与预约后拒绝不退款。
- source_ref 只采用 Store 单一 helper 的 `organization-quality-input-v1:<case_uuid>:<input_sha256>`；宿主从 PG 实际 case 配对，不能通过客户端字符串替换 case 或摘要。SDK runtime 的 guardBound/sourceRef 门禁由质量模块装配，额度与截止仍在原发送边界核对。

## 原保护与新增 metadata

`model-provider.ts:19` 只新增可选最终 HTTP 实体 Unicode 字符数。普通／strict 都按最终序列化 JSON 计算，语义 GenerateOptions 与 wire 摘要分开保存。诊断预留、`before_dispatch_started`、PG 回调及发送前复验的顺序未改变；`diagnostic-problem-budget.ts` 零改动。

provider 的只读 `diagnosticProblemBudgetBound` 来自安装时成功绑定的 guard 闭包；caller 捕获同一状态。它不暴露路径／问题身份，不创建或重置账本，不能用后来修改的 env 伪造绑定，也不表示仍有额度。

`quality-model-caller.ts:90` 在真正开始 Unix PG 预约前记录本地阶段。只有明确尚未开始预约或宿主明确拒绝时可安全释放许可；已经开始 exchange 后的 ACK 丢失保留原 pending 和未知许可。原 observation 标记不被改写。完成时先保存原 PG 回执、再保存有严格 Store guard 的质量证据，最后 settle。撤销后的正文晚写被拒绝，实际消费元数据保留。

## 验证

冻结相关组 **25/25**，原普通／strict 诊断与 ACK 保护最小回归 **4/4**；TSC、精确范围 `git diff --check` 通过。只跑本切片及相关模块，没有全后端或桌面全量。完整命令及私有日志摘要见 [validation.json](validation.json)、[private-log-index.json](private-log-index.json)。

实际 seam 是锁定官方 DSH profile、原 provider、Unix 许可、合成 PG 和本机 HTTP。未通过手工插入成功回执构造证据。覆盖：

- 联系人及本人 NULL scope 实际 HTTP、稳定 request/attempt/source_ref 与持久报告。
- 错 owner/contact/token、过期、世代与来源撤销零发送或拒绝质量晚写；实际消费记录不重建正文。
- 六 phase 共享 case/run 计数、case 超额零出站、同一合成八次总账第九次零出站。
- HTTP 503、transport unknown、预约后取消均不退款；旧 unknown 更换 phase 后不重放。
- 有效 PG 预约 ACK 被 Unix 代理破坏：HTTP 0、settled 0、原 pending 与未知许可保留；独立许可宿主 PID 实际退出并重启后，换 phase 仍无 HTTP。
- 普通请求的中文、emoji、转义实体为实际 HTTP **189** 个 Unicode 字符；等号发送、超一字符零 HTTP／无新 PG unknown／无孤儿。strict 另在 provider 公共边界独立比对实际 HTTP 实体；该补充用例不冒充质量 case 执行。
- 安装后注入／移除 env 不伪造或解除 bound 状态；原提取五字段 claim、学习、L2/L3 共账及原 ACK 反例保持通过。

RED 证据包括原缺 caller、最终实体字符数缺失、bound 状态缺失、错 case source_ref 原可发送；均在私有日志保留。夹具早期重复 state／PG 用户环境问题、同活 PID 无法伪装许可宿主重启，已修夹具且保留原生产保护。

## 数据、清理与限制

没有新表、结构迁移或真实资料配置。正文仍仅在原质量输入／attempt／证据的既有范围保存并沿用来源删除路径；新增 provider metadata 只有计数与布尔值。自有随机 `_test` PG、假 HTTP、DSH／许可子进程与临时 SQLite 由测试 teardown 清理；无打包或构建产物。原始日志留仓库外 0700 目录、0600 文件，公开只留文件名、摘要与哈希。

锁定 [DSH 官方 LLM 接口](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/index.ts)与 [DeepSeek adapter 类型](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-deepseek/src/types.ts)没有公开 raw response callback；extension 的 accept 不接收 Response，normalized stream 只保留 blocks／usage／finish。原始 response model／system_fingerprint 保持 unavailable／unknown，未把请求 binding 冒充返回身份。

工程通过不代表真实质量、正式 120 资格、本次 1152 协议、实际 App、Ticket 25／26 或独立复审通过。费用仍是用户暂豁免，未登记为达标。统一集成、独立复审、实际模型和桌面验证由后续验收完成。
