# 14：更新 L3 画像与关系概览

Triage: ready-for-agent
State: claimed
Type: task
Blocked by: 13
Spec: ../spec.md

## 交付行为

使用合格场景与记忆生成有据版本，保留本人／联系人隔离、手工修正、时效和删除。

规格：[精简 DSH 与 TS 后端迁移](../spec.md)。前置任务：[13](../issues/13-l2-scenario-organization.md)。

## 验收条件

- [ ] 完成本票下方 DSH 查证要求，记录版本、官方文档／源码／示例依据与适配理由；无直接接口时记录边界核对结论，未查证不得宣称完成。
- [ ] 从合格记忆与有变化场景增量更新 L3 画像及关系概览，无需更新时按原规则跳过。
- [ ] 本人和联系人范围隔离，保留来源、版本、不确定性、时间资格和合法推断，不把行为建议写成关系事实。
- [ ] 用户可查看、修正及删除；来源失效、人工修改或输入变化时，旧摘要、缓存及晚结果不能覆盖当前状态。
- [ ] 回复和 Skill 审核读取的 L2 目录／L3 条目与实际发布 generation 一致，预算、取消和任务恢复保持。

## 验证

从整理任务到画像／概览查询及回复读取验证增量更新、generation、范围和来源失效。 优先经已确认的 HTTP／事件业务入口和桌面控制器检查持久状态及用户可见结果，必要时补充模型／任务接口与宿主生命周期检查，不依赖框架私有内部结构。

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

2026-10-25：代码与合成验证完成，本地实现提交 `3e9ec5abe947599c06c02cc22447148583bfb950`；`State` 保持 `claimed`，等待根线程完成实际 App／微信及真实模型验收后再改为 `resolved`。

### DSH 查证

- 锁定版本：`@deepseek-ai/dsh@0.2.1-rc.2`，commit `687f282e8625c6b8d11ff58211a90524be2e4317`；核对的是该 commit 的官方源码树，不以可变 master 为依据。
- 官方依据：`docs/user/develop/basic/tool.zh.md:13`（`defineTool`）、`:36`（参数、执行与渲染契约）；`docs/tool-execution-pipeline.zh.md:8`（工具调用流水线）；`packages/core/tools/src/index.ts:1071`（工具注册）、`:1144`（执行守卫）；`packages/llm/llm/README.md:34`、`:63`、`:93`（单次 provider attempt、`prepareCall`、终止 chunk）；`apps/cli/src/profile-boot.ts:283`（官方 profile 启动与清理边界）。
- 核验结论与适配：L3 使用公开的 `defineTool` 定义只读场景、暂存 `profile.md` 与独立核验工具；文档执行、范围、轮次、预算、核验、发布、取消均由业务代码控制。模型只提交工具调用，不能直接写数据库、文件系统或发送消息。未发现需要修改 DSH 私有 API 或核心的缺口，因此未改动框架源码。

### 已实现

- 新增 L3 内存工作区、逐条结构／版本／时间／不确定性／行动建议校验、独立忠实度核验、增量保留、纠错正文隔离及短事务发布。
- L3 与 L2 在同一 Worker 租约内衔接：L2 发布后继续 L3；已有成功 L2 回执时只补 L3，不重新生成场景。无变化时复用同一画像版本，不调用模型。
- 画像版本、场景版本集合和 `organization_generation` 原子推进；generation 场景缺失、重复、跨范围、清单或底层 revision 变化时失败关闭，不投影部分目录。部分旧场景失效时不用覆盖失效集合的旧画像做增量基准，改从当前有效集合重建。
- 本人与联系人按 `owner_id + contact_id` 隔离；回复上下文及 Skill 审核导航复用同一冻结 generation、revision 和依赖摘要。画像可查看、总结纠错、撤回和删除，来源失效会物理清除 L3 批次并令旧快照失效。
- 用户纠错撤下当前画像并保护完整实际输入窗口；纠错正文只作为最小错误对照进入后续提案和核验，不能再由其他来源换入发布。
- 多轮文档调用改为每次只为后续核验保留一个额度；提案与核验输入都在物理调用前执行字符预算检查。L2／L3 共享累计 job 预算，取消与显式重试仍有界。

变更文件：

- 新增：`backend-ts/src/l3-profile-workspace.ts`、`backend-ts/src/l3-profile-service.ts`
- 接入：`backend-ts/src/l2-scenario-service.ts`、`backend-ts/src/l2-scenario-http.ts`、`backend-ts/src/l2-scenario-source-validation.ts`、`backend-ts/src/host-reply.ts`、`backend-ts/src/host-model-accounting.ts`
- 桌面：`desktop/src/renderer/LayeredMemorySections.tsx`
- 测试：`backend-ts/test/l3-profile-workspace.test.mjs`、`backend-ts/test/l3-profile-service.test.mjs`、`backend-ts/test/l2-scenario-http.test.mjs`、`backend-ts/test/l2-scenario-service.test.mjs`、`backend-ts/test/l2-scenario-shared-host.test.mjs`、`backend-ts/test/host-model-accounting.test.mjs`
- 桌面测试：`desktop/tests/layered-memory/react.test.mjs`、`desktop/tests/memory-ui-wiring.test.mjs`

### 验证结果

- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- L3 工作区、服务、公开 HTTP：`25/25` 通过，覆盖增量／无变化跳过、generation 精确闭合、部分旧场景失效后重建、亚毫秒时间资格、核验输入预算、多轮工具历史压缩、本人／联系人隔离、纠错、撤回、来源物理删除、晚结果、取消重试、仅剩两次额度及 HTTP 错误映射。
- L2 服务、Worker、宿主及模型记账：`25/25` 通过，覆盖 L2→L3 同租约、成功 L2 回执只补 L3、Worker 完成后收口、共享预算和 pending 幂等。
- 共享官方 DSH profile、分层回复读取、Skill 来源导航：`26/26` 通过（`9/9`、`17/17`），覆盖 6 次真实合成模型请求的 L2→L3、公开撤回、回复／审核来源的当前 generation 核验与冻结快照失效。
- 桌面类型检查通过；长期背景可见、引用、逐条修正／删除和整份撤回入口专项用例 `7/7` 通过。
- 后端全量回归：`1184` 项中 `1181` 通过；3 个失败均不在本票变更路径。`exploration-store` 与 `foreground-location-api` 单例复跑通过，`sync-incremental-reconnect` 的清理断言在共享工作树中仍失败，已作为剩余风险保留。
- `git diff --check`：通过。

### 数据与遗留

- 自动化只使用测试临时 PostgreSQL 与合成模型／来源；测试 fixture 自动销毁数据库，无真实消息发送或外部资料扩大。
- 正式数据库仅做只读状态核对，未写入画像、任务或验收结果。当前等待根线程复用已运行的 `npm run dev` 实例，从正式范围的有效性检查出发完成实际 App／微信恢复、画像查看／纠错／撤回和真实模型质量验收；不得用测试库结果代替。全量回归中的既有清理失败也须在最终验收前复查。
- 未执行打包、推送、远端分支、PR、外部消息或 DSH 核心修改。

### 真实验收阻塞诊断

- 现场：owner `6b0faa77-8bcf-4a14-a627-7629265624da`、task `0c5b9add-5006-4cfe-aef3-4c964b5d22ce`、job revision `13`、model calls `31/208`、`run_remaining=1`。唯一 profile batch 的 20 项输入与 59,328 字节 payload 已冻结，`output_payload=null`；4 个新增 receipt 全部成功，最后一次请求序列化 134,298 字节，随后在第五轮物理调用前触发 `l3_profile_context_budget_exceeded`。因此失败发生在多轮提案历史累积，不在核验、重试或初始输入。
- 修复：达到既有 `max_characters` 时保留初始任务消息和当前 `profile.md`，移除已执行且可由工作区重建的旧 tool-call 参数，只携带最后一次工具名称／错误；未提高或取消预算。先在快速回归中稳定复现同一错误，再通过 workspace 与合成 PostgreSQL 发布用例。
- 可重新 continue 的前置条件：当前 dev runtime 已加载本修复；正式 state 仍为 settings generation `0`、job revision `13`、job failed，且当前目标 key／资料集合未变化。根线程使用 revision `13` 发起 continue 后应得到 revision `14`、state active、step pending；新一轮模型调用上限会按既有合同增加 `16` 到 `224`。

### 第二轮真实验收阻塞与修复

- 根线程从 job revision `13` continue 后，正式 job 变为 revision `14`、state failed、`profile_status=failed`、`run_remaining=1`、model calls `36/224`；background task 为 failed、retry `13`、`last_error_code=l3_profile_document_round_limit`。新建 profile batch `c4712e14-460a-44d5-a641-2ec5b2e92e45` 为 `attempt_count=1`，输入 `59,328` 字节，`output_payload=null`，失败发生在独立核验和发布之前。
- 同一窗口新增的 5 条 model receipt 全部 `succeeded/response_observed`，请求序列化大小为 `110,819`、`112,122`、`124,421`、`136,558`、`124,348` 字节。receipt 不保存 tool 名称或参数，也没有可恢复的持久 agent journal，因此这里只确认五次物理提案调用及成功时序，不把未落盘的工具序列说成已取证。
- 代码根因：提案工作区的成功写入位在每轮开始时重置；首轮成功 `write` 后若末轮只成功 `read`，循环结束时写入位为 false、末轮错误位也为 false，已有合法工作区被误报为 `l3_profile_document_round_limit`。快速 workspace 用例先稳定复现同一错误，再由修复转绿。
- 修复提交：`9f8ec3ac36824845e5cd76314382bb9314aeb07b`。成功 `write/edit` 状态跨轮保留，后续只读确认不会撤销；末轮仍有真实工具错误时继续失败关闭，最终 proposal 仍经过完整编译、结构校验、独立核验和原子发布。五轮上限、字符预算及模型调用预算均未改变。
- 验证：L3 工作区、服务、公开 HTTP `28/28`；L2 服务、Worker、宿主及模型记账 `25/25`；共享官方 DSH profile `2/2`；TypeScript 类型检查通过。合成 PostgreSQL 用例明确经过 1 次写入、4 次只读、独立核验，再发布 generation，并断言 batch `attempt_count=1`、`output_payload` 非空。
- 正式数据库仅只读核对，未修改失败现场。修复尚需 dev runtime 实际加载后由根线程基于 revision `14` 再次 continue；只有真实模型完成画像提案及核验、实际 App／微信入口和用户可见纠错／撤回验收通过后，才能将本票改为 resolved。

### 第三轮现场与五轮协议收敛

- revision `14` continue 后得到 revision `15`；约 40 秒后再次 failed，`profile_status=failed`、`run_remaining=1`、model calls `41/240`、background task retry `14`，仍为 `l3_profile_document_round_limit`。新 profile batch `522cf488-3b51-41cb-a5de-4f2063dfe71b` 为 `attempt_count=1`，输入 `59,328` 字节，`output_payload=null`。
- `06:40:21–06:40:59` 的 5 条 receipt 全部为 `succeeded/response_observed`，依次记录 input/output tokens `52000/61`、`52363/3181`、`55591/3130`、`58768/2705`、`55028/37`，请求序列化 `110,819`、`112,122`、`122,967`、`133,604`、`120,471` 字节。前四轮产出量表明存在多次实质尝试，末轮只产生 37 个输出 token，但 receipt 不保存工具名或参数。
- DSH journal 不可恢复：该 host 使用临时 `$DSH_HOME`，revision 15 对应目录只有 profile 配置、legacy pid/info 与 host 配置，没有 `sessions/`、`logs/` 或 journal；L3 通过公开 `prepareCall/stream` 直接发起模型调用，只持久化 model receipt。因此无法对真实五轮断言“读取几次、写过几次、哪个参数执行失败”，不能根据 token 大小补造工具序列。
- 9f8ec3ac 仅保留“已有成功写入”，无法让持续无效的整份写入变成合法，也没有给模型确定的完成信号。此次增加无参数 `ProfileProposalComplete`、轮间进度提示、重复读取提示和精确档案模板；明确最多 16 条、合计最多 2,000 字且标题后不得出现二级标题，避免模型按未暴露上限重复整份重写。
- 修复提交：`a82f6f0c4c261c3ef00253408f1297e6911e58dd`。只有最后写入成功、没有后续未解决工具错误且工作区可编译时才接受完成；无写、错误写、空完成和只读代替完成均失败关闭。完成后的独立核验及原子发布未改变，五轮、字符和模型调用预算也未改变。
- 为让下一轮可直接定位真实工具行为，成功与失败批次的 `output_payload` 都增加 `proposal_trace`：仅含轮次、受限工具名、参数键名、profile/scenario/invalid 分类、结果、错误码和工作区是否变化；不保存画像正文、记忆正文或工具参数值。
- 验证：精确五轮“读→错误写→合法写→场景读→显式完成”回归通过，并在第 6 次调用执行独立核验后发布；五次均无合法写入及无写完成均在核验前失败。L3 工作区、服务、公开 HTTP `32/32`；L2 服务、Worker、宿主及模型记账 `25/25`；共享官方 DSH profile `2/2`；TypeScript 类型检查通过。
- 当前正式现场未修改，仍为 job revision `15`、failed、calls `41/240`、`run_remaining=1`。root 可重试条件：确认 dev runtime 已加载 `a82f6f0c` 且正式目标 key／资料集合未变化后，基于 revision `15` continue；预计得到 revision `16`、active、step pending，并沿用既有合同将模型调用上限增加 16 到 256。下一次失败应直接读取 `proposal_trace`，若成功则仍需真实 App／微信与用户可见纠错／撤回验收后才能 resolved。

### 第四轮字段级诊断

- 第四轮基于 revision `16` 现场读取 profile batch `190b33c2-804e-4cd5-876a-e9b42d5ce5ca` 的无正文轨迹：第 1、2、4、5 轮均为 `write/profile/tool_error/l3_profile_proposal_invalid`，第 3 轮为成功读取；所有轮 `completed_by=null`，`profile_changed` 依次为 `true/true/false/false/true`，画像始终不可编译。当前 job 为 revision `16`、failed、calls `46/256`、`run_remaining=1`，background task retry `15`。
- 持续重复且无法纠正的工程原因落在 `checkedEntry` 的错误映射：未知字段、`kind`、`section`、`temporal_status`、正文、依据和不确定性校验此前几乎统一抛 `l3_profile_proposal_invalid`，工具结果无法定位字段；模型虽然拿到允许字段说明，仍无法从同一粗码判断需要修哪一项。真实批次未保存参数正文，因此不能断言最初是哪个字段无效；此前首轮输入未枚举 `section` 等完整允许值，`section` 是当前最高风险项。
- 修复提交：`cf99f43270b369db1570c3fd2046d80a2903fa3e`。校验现区分 `document_header_invalid`、`document_format_invalid`、`entry_format_invalid`、`entry_metadata_invalid`、`unexpected_keys`、`kind_invalid`、`section_invalid`、`temporal_status_invalid`、`text_invalid`、`basis_invalid`、`uncertainty_invalid` 和已有的 `reference_invalid`；工具结果包含条目序号、允许枚举及纠正要求，未放宽任何字段或引用校验。
- 首轮输入现显式提供 ENTRY 元数据字段、`kind/section/temporal_status` 完整枚举、正文位置和精确引用规则。失败轨迹仍只保存受限错误码，不保存真实画像、记忆正文、工具参数值或本轮工具错误详情。
- 合成回归复现真实的 `write/write/read/write/write` 非收敛形状，并验证每轮均落到 `l3_profile_section_invalid`、画像不发布；另一条回归先写错误 `section`，从工具结果读到完整枚举后修正，在五轮内显式完成并在第 6 次调用核验发布。
- 验证：L3 工作区、服务、公开 HTTP `34/34`；L2 服务、Worker、宿主及模型记账 `25/25`；共享官方 DSH profile `2/2`；TypeScript 类型检查通过。
- revision `16` 重试条件：确认 dev runtime 已加载 `cf99f432`，正式 job 仍为 revision `16` failed、calls `46/256`、目标 key／资料集合未变化，再基于 revision `16` continue；预计得到 revision `17`、active、step pending，模型调用上限按既有合同增加 16 到 272。下一次若仍失败，`proposal_trace.profile_error_code` 应直接指出具体字段；成功仍需完成真实 App／微信与用户可见纠错／撤回验收后才能 resolved。

### 第五轮 quote 核验诊断

- revision `16` continue 后得到 revision `17`；提案通过字段级 schema 并进入独立核验，但约 17 秒后 failed，`last_error_code=l3_profile_quote_invalid`、calls `49/272`、`run_remaining=1`、`pending_receipt=true`、`profile_status=failed`，未发布。
- 最新 profile batch `1c4b71e6-dbcd-4af3-9a5c-b752b0707641` 输入 `59,328` 字节，`proposal_trace` 2 轮，`verification_result=null`。三条 receipt 均成功：`52444/1807` tokens、`112,877` bytes；`54346/23` tokens、`119,799` bytes；`30415/1500` tokens、`70,611` bytes。后两者对应提案完成和一次独立核验。
- verifier 的原始参数没有持久化，无法恢复实际 quote，不能断言它是提案正文、转述、拼接、错误 memory_id 还是包裹字符。原实现的工程缺口明确：`parseProfileVerification` 只调用一次并执行严格 `verbatim memory text.includes(quote)`，首次失败立即抛错，没有纠正文具。
- 修复提交：`198f15d781fecd684fa5abba52b05a134910c39f`。核验输入改称 `memories[].verbatim_text`，显式给出每条的 `allowed_memory_ids` 和逐字契约；无法确定时必须复制完整 `verbatim_text`，不得使用 proposal 正文或补造。
- 核验格式或 quote 非法时，仅在当前 job 实际剩余额度内进行一次有界重采样；最多两次核验。第二次仍非法、非可纠正核验错误或只剩一次核验额度时立即失败关闭。逐字子串校验、独立核验、五轮提案上限、模型总预算和原子发布条件均未放宽。
- `verification_trace` 仅记录尝试序号、`succeeded/tool_error`、具体错误码和 receipt id，不保存 quote、原文或工具参数；失败时与既有 `proposal_trace` JSON 合并，不覆盖提案取证。错误码区分 `quote_invalid`、`quote_memory_invalid`、`quote_proposal_invalid`、`quote_wrapper_invalid` 和 `verification_invalid`。
- 合成 PostgreSQL 回归覆盖：第一次 quote 非法→得到明确逐字规则与允许 memory_id→第二次成功并发布；连续两次非法→`quote_invalid` 失败且无版本；只剩一次核验额度→不再调用、轨迹仅一次失败。L3 工作区、服务、公开 HTTP `37/37`；L2 服务、Worker、宿主及模型记账 `25/25`；共享官方 DSH profile `2/2`；TypeScript 类型检查通过。
- revision `17` 重试条件：确认 dev runtime 已加载 `198f15d7`，正式 job 仍为 revision `17`、failed、calls `49/272`、`run_remaining=1`，目标 key／资料集合与冻结输入未变化，再基于 revision `17` continue；预计得到 revision `18`、active、step pending，模型调用上限按既有合同增加 16 到 288。下一次失败应读取 `verification_trace`；若成功仍需真实 App／微信与用户可见纠错／撤回验收后才能 resolved。
