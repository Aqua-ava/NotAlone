# 10：从现有消息提取并核验候选

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 05, 09
Spec: ../spec.md

## 交付行为

后台领取、批次、来源核验、停止／恢复、前台优先及后台有界并发可用；不发布未通过结果。

规格：[精简 DSH 与 TS 后端迁移](../spec.md)。前置任务：[05](../issues/05-traceable-replies.md)、[09](../issues/09-memory-and-preferences.md)。

## 验收条件

- [x] 完成本票下方 DSH 查证要求，记录版本、官方文档／源码／示例依据与适配理由；无直接接口时记录边界核对结论，未查证不得宣称完成。
- [x] 现有规范化消息经任务入队、原子领取、批次提取与来源核验形成可追溯候选，保留现行生产路径及明确历史模式选择。
- [x] 模型单次调用、核验、预算、来源版本复验与失败分类保持，未通过的候选不发布为已采纳记忆。
- [x] 迁移业务任务租约、幂等、检查点及显式恢复；批次流水线允许有界并行，采纳／写入／水位仍按现行批序合同。
- [x] 复用05的优先级与调用仲裁，验证前台优先、后台并发、暂停、停止、晚结果和实际记账；旧新 Worker 不双领取。
- [x] 来源撤销或删除取消对应任务和提交资格，重启不复活资料；从进度和失败入口可核对真实处理量。

## 验证

合成消息经任务入口和生产处理链验证批次、租约、并发、核验、取消和恢复，按实际物理调用检查台账。 优先经已确认的 HTTP／事件业务入口和桌面控制器检查持久状态及用户可见结果，必要时补充模型／任务接口与宿主生命周期检查，不依赖框架私有内部结构。

## 执行前必须核对 DSH

- 先阅读本票涉及的**锁定版本** DSH 官方文档、相关源码和示例，核对现有 NotAlone 实现；不能凭印象猜 API、配置、依赖或生命周期。尚未锁定版本的01／02先记录候选版本并由02固化。
- 在本票记录版本／commit、具体来源链接或源码位置、核验结论及本次适配理由。官方说明只证明约定，仍需实际测试；不得用可变 master 文档冒充锁定版本证据。
- 优先官方插件、公开接口和已有机制；不胡乱重写框架能力、绕过官方 profile、臆造配置或擅改 DSH 核心。能力缺口须有最小复现或源码依据，影响已确认方案时先报告冲突，不自行换路线。
- 纯业务改动也先判断与 DSH 的交互和生命周期影响；确实无直接依赖时明确记录“不涉及直接接口”及依据，不为完成阅读要求无关重构。

## 工作边界

- 当前仅发布任务，尚未开始实现。执行前核对前置票的实际验收和现有代码，按已确认[规格](../spec.md)及[规划索引](../planning.md)推进，未通过前置不能开始依赖实现。
- 业务始终按 owner_id + contact_id 隔离，来源、权限、预算及删除随本票一起验证；确定性流程由业务代码控制，模型没有外部聊天发送能力。
- 新旧实现每项业务只有一个执行和写入责任方；回退先核验结构和在途任务，保留新增／编辑／删除决定，不恢复旧库或自动逐请求兜底。
- 日常开发先核验并复用 npm run dev 实例，不打包、不运行打包版；本票不授权发送外部消息或扩大真实资料范围。合成验证、真实模型及实际 App／微信证据分开记录。
- 先运行最小相关验证；仅提交本票变更的本地提交，不 push。若范围超过一上下文，先记录完整行为切片与依赖调整，不降低验收要求或任意扩大本票。

## Comments

2026-10-23：用户已认可任务拆分、依赖和验收入口并要求逐张发布；补充明确要求实施前必须看 DSH，不凭猜测乱改。任务保持 open。

## Answer

实现切片已由根验收，证据见[根验收](../root-next-10/root-acceptance.md)。主树接收
`d00a01a2`；extraction 52/52、tsc 0、公开扫描 0。当前 Python `TaskHost` 仍是唯一
生产领取者，TS Worker 未启用。B 段采纳/trace 留票 11/12，生产切换与排空留票 24，
实际 App/微信和真实模型质量留票 25；本票不把后续能力伪装为已验收。

## 2026-10-25 Comments：DeepSeek strict 生产接入

本轮只补票 10 的来源核验传输，不修改票 15。锁定依赖仍为 DSH `0.2.1-rc.2`、commit
`687f282e8625c6b8d11ff58211a90524be2e4317`。官方 [DeepSeek strict Mode（Beta）](https://api-docs.deepseek.com/guides/tool_calls#strict-mode-beta)
要求 `/beta/chat/completions`、function `strict:true`、唯一指定工具，并限制 `minLength`／
`maxLength`／`minItems`／`maxItems` 及 `oneOf`；锁定 [DSH README:83](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-deepseek/README.md#L83)
只走 `/anthropic` Messages，[:206](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-deepseek/README.md#L206)
明确不映射 `tool_choice`，[serialize.ts:160](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-deepseek/src/serialize.ts#L160)
也未写 `strict`。因此仅在业务代码为 `SourceVerificationOutput` 增加专用 Beta strict 传输，
不修改 DSH 核心，也不扩展到普通回复、提取、Skill 或其他供应商。

实现仍由 `createExtractionModelCaller` 唯一执行：先取得现有 ModelPermit，再测量最终 strict
请求正文、预约同一模型台账、发送、结算并复验来源。strict 仅匹配唯一
`SourceVerificationOutput`；混合工具、非 strict 回退和非预期 endpoint／响应均失败关闭。
nullable union 等价转为 `anyOf`，`oneOf` 仅在互斥规则分支转 `anyOf`，删除服务端不支持的
长度／数量约束但继续由现有 parser 严验；工具结果继续进入原 `readExtractionToolArguments`
与逐项来源、引文解析。trace 的 `model_request` 记录
`deepseek-strict-chat-completions-beta` 与转换后的 `wire_schema`，不新增正文持久化或外发能力。
strict 模块同时纳入 A 段 `ruleVersion`，避免复用旧规则产生的冻结执行。

验证只使用随机 `*_test` PostgreSQL、合成身份与本地回环 provider：strict wire／nullable-v3
解析 3/3；提取相关模块 27/27；E/V 模型、预算、取消、HTTP 503、验证拒绝及 ACK 恢复 2/2；
生产 A 入口 1/1；三类 B 唯一提交 1/1；实际 host-plugin 装配 1/1；本任务相关源码定向 strict
TypeScript 检查 exit 0。既有两轮合成真实 API 诊断仍只证明 deepseek-flash 的 strict 格式可行，
不代表质量或 `ran` 验收。本轮未调用真实模型、embedding、App、微信或外部消息，未处理 `ran`，
未 push、打包或创建 PR。生产切换及真实 `ran` 的 A/V、B、index、verify 闭环仍由票 24／25 把关。
