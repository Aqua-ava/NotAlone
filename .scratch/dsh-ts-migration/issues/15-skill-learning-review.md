# 15：学习、审核和发布 Skill 草稿

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 06, 10, 13, 14
Spec: ../spec.md

## 交付行为

合格素材形成提案，用户审核后发布／撤回，版本谱系、预算、反馈及素材删除保持。

规格：[精简 DSH 与 TS 后端迁移](../spec.md)。前置任务：[06](../issues/06-reply-skill-library.md)、[10](../issues/10-memory-extraction-verification.md)、[13](../issues/13-l2-scenario-organization.md)、[14](../issues/14-l3-profile-overview.md)。

## 验收条件

- [x] 完成本票下方 DSH 查证要求，记录版本、官方文档／源码／示例依据与适配理由；无直接接口时记录边界核对结论，未查证不得宣称完成。
- [x] 限定授权素材和目标 Skill，单次有界模型提案可返回不变、复用、新建／更新／合并草稿；不能直接发布。
- [x] 用户查看草稿、对照预览、审核、发布／撤回及反馈操作保持，范围建议未经审核不能扩大为全局策略。
- [x] 审核预览复用生产回复上下文，正确读取合格 L2 场景目录和 L3 画像并复验来源／失效；此依赖不意味着学习主动触发整理。
- [x] 素材、目标版本和批准状态变化时拒绝旧预览发布，保留版本谱系、受控文件写入和来源删除清理。
- [x] 学习任务、预算、实际调用台账、停止与恢复和晚结果规则保持；策略正文不夹带私人事实或原话。

依赖补齐依据：发布前核对确认审核预览复用生产回复上下文，会读取当前 L2 目录与 L3 画像。按已批准拆分中的条件增加13／14；这不是要求学习主动运行整理任务。

## 验证

通过授权学习、任务、草稿审核与发布入口验证完整链；对照预览必须覆盖L2/L3输入资格和失效。 优先经已确认的 HTTP／事件业务入口和桌面控制器检查持久状态及用户可见结果，必要时补充模型／任务接口与宿主生命周期检查，不依赖框架私有内部结构。

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

票内 TS 业务纵切、草稿审核、原子发布和共享宿主接线已完成。实际 App／微信与最终切换验收仍由根线程在集成环境完成，本票不把合成宿主证据冒充渠道验收。

### DSH 依据

- 锁定 `@deepseek-ai/dsh* 0.2.1-rc.2`，tag `dsh-v0.2.1-rc.2`，commit `687f282e8625c6b8d11ff58211a90524be2e4317`。核对官方 [Tool 教程](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/user/develop/basic/tool.zh.md#L13)、[执行流水线](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/tool-execution-pipeline.zh.md#L8)、`packages/core/tools/src/index.ts#L1071`／`#L1105`／`#L1144`、`packages/llm/llm/README.md#L34`／`#L63`／`#L93`、`packages/llm/llm/src/index.ts#L945`、`packages/skill/skill/src/index.ts#L380` 和 `packages/core/scope/src/index.ts#L137`。
- 核对锁定安装哈希：`dsh/package.json` `bea4288a…68dd`、`dsh-skill/package.json` `a59e0d4e…1b2d`、`dsh-skill/lib/index.js` `4b88621b…a791`、`dsh-llm/lib/index.js` `d18d8ae4…1155`。
- 学习模型调用使用官方 `prepareCall`／单次 stream，经现有受控 provider、ModelPermit、预算和 PostgreSQL 台账；模型只可返回一个结构化 `SkillLearningProposal`，没有发布、文件、SQL 或发送 Tool。审核与发布由普通 TS 业务模块和 PostgreSQL 事务负责，未改 DSH 核心。

### 实现与数据边界

- 新增 [学习合同](../../../backend-ts/src/skill-learning-contract.ts)、[材料选择](../../../backend-ts/src/skill-learning-materials.ts)、[权威存储](../../../backend-ts/src/skill-learning-store.ts)、[模型运行时](../../../backend-ts/src/skill-learning-runtime.ts)和[唯一 Worker](../../../backend-ts/src/skill-learning-worker.ts)。材料每批最多 8 份、24,000 个 Unicode 码点，纠正优先；提案支持 `no_change/reuse/create/update/merge`，目标、方法替换和范围必须经过结构校验与用户审核。
- [审核服务](../../../backend-ts/src/skill-review-service.ts)复用生产 `PostgresReplyContext` 读取当前 L2／L3，[审核存储](../../../backend-ts/src/skill-review-store.ts)在单事务内复核绑定、来源、分层快照、记忆／偏好／库修订和目标版本后写入不可变版本、方法清单、来源证明及发布范围。v4 证明失败关闭空分层材料，旧预览在任一依赖变化后不能批准。
- [历史与范围政策](../../../backend-ts/src/skill-history-policy-store.ts)支持版本查看、回滚、方法／范围停用和撤销；同版本回滚保持幂等，仅在真正切换版本时更新当前版本、工作副本和库修订。删除继续复用既有 Skill 清理路径，来源删除会清空草稿私人依据、审核输入和结果，并使已发布版本不可读及清理文件。
- 学习任务沿用原全局 Worker 锁、联系人任务租约、心跳、取消、显式恢复和晚结果栅栏。任务结束后继续处理后续合格材料；停止或关闭时排空在途任务，旧租约和取消后的结果不能保存。
- 仅使用随机 `_test` PostgreSQL、合成联系人和合成模型响应；未读写正式聊天、关系资料、微信或凭据，未发送外部消息，未执行打包、push、远端分支或 PR。

### 验证

- `tsc --noEmit`：0 错误。
- 最终代码串行全量分两段：`485/485` 与 `737/737`，合计 `1222/1222`，零失败、零取消、零跳过；两段分别耗时约 399 秒和 431 秒。
- 修复 Spec 审查三项问题后的最终聚焦回归：`37/37`。覆盖错误码 409 语义、同版本回滚不递增修订、空 L2／L3 冻结材料拒绝、来源／目标／修订失效、预算与取消、晚结果、HTTP 错误映射和真实合成 DSH 宿主。
- `git diff --check`：通过。公开历史扫描：`issues 0`。
- Spec 审查发现的三项阻断已修复：授权失效返回既有 409 语义；同版本回滚不递增库修订且不更新时间；v4 分层证明即使材料选择为空也执行来源快照复验。修复后的聚焦回归如上通过。

### 根集成只读验收

- 使用 `npm run dev` 复用实际开发 App，显式开启五个迁移 TS runtime 开关；`/api/runtime/status` 返回 `ownership.skillLearning=typescript`、`ownership.skills=typescript`，task worker 为 running。
- 选择验收联系人 `ran` 并点击“Skill”，实际 App 正确显示“已有 Skill”／“待审核”两个页签；已有页显示当前没有有效发布版本，待审核页显示 0 项且没有建议。
- 本次 App 验收仅只读：没有开启经验整理，没有学习／模型调用，没有批准、发布、回滚或停用，没有外部消息或真实资料写入。发布写入、L2／L3 审核与失效链仍由上方的 1222/1222 及 37/37 合成 HTTP／PG／控制器证据覆盖，不冒充 `ran` 的真实写入。

### 清理与未覆盖

- 清理 85 个 `notalone_ts_host_*_test` 与 15 个 `notalone_b15_*_test` 合成 PostgreSQL 残留库，均确认无连接且名称符合固定测试前缀；未触碰正式库或非测试库。
- 自动化验证覆盖合成 HTTP、事件、任务租约、共享官方 DSH profile 与持久状态；实际 App 已完成上述只读入口验收。真实微信写入操作、真实资料写入／删除路径和共享宿主最终切换验收仍未执行；不得据此宣称真实渠道写入集成已验收。
- `SourceVerificationOutput` 的 DeepSeek strict 适配属于提取模型传输，不在本票 Skill 学习／审核／发布范围内，已转交独立用户可见会话；本票未扩改该适配器或相应测试。
