# 从业务事实推导记忆与执行结构

状态：讨论提案；不是 DDL、实施指令或已验证实现。本文只覆盖记忆候选、采纳、版本、证据、完整提取追踪及处理执行。跨领域实体名称是接口占位，须与其他从零设计结果整合。

依据仅为本目录 `spec.md` 的需求与 Q29、Q36—Q38、Q42—Q43，以及 `../sync-memory-behavior/spec.md` 的手动启动、固定范围、完整流程、暂停、取消和未知调用要求。没有从旧 PostgreSQL 表、旧候选清单或表数目标裁剪；不迁入旧业务资料。

## 事实卡

### 记忆、候选、版本与采纳

1. 一条记忆是用户持续查看、修正、保护或撤销的业务对象；文本相同不能证明是同一记忆。唯一身份为 `memory_id`，不是正文、主题或联系人昵称。
2. `memory_id → owner_id, subject_kind, contact_id`。本人范围的 `subject_kind=self` 且 `contact_id IS NULL`；联系人范围为 `contact` 且 `contact_id NOT NULL`。Q36 要求两种范围共用 `memory`、`memory_version`。
3. 一条记忆有多个顺序版本；`(memory_id, version_no) → 该版正文、形成方式、保护状态、来源来历`。当前版本是身份对象的一个指针，历史版本不能通过改正文冒充新版本。
4. 自动提取的候选尚不等于已采纳记忆。候选可以被拒绝、编辑后采纳，或与已有记忆合并；候选身份、候选版本、采纳动作、正式记忆版本是不同事实。
5. 一个候选版本可参与一次合并产生多个记忆版本；一个记忆版本也可能合并多个候选。不能把候选到记忆约束成一对一。具体允许的产品操作仍由后续界面合同确定，结构不伪造已实现能力。
6. 用户修订自动内容并不消灭其聊天来源。`manual_edit` 描述操作方式，不等于 `independent_manual_entry`，也不等于对所有底层事实作用户确认。
7. 记忆版本和证据是多对多。某条证据可以支持不同版本，某版本可以有多个实际证据；证据来源联系人不等于记忆归属。本人版本可由多个已选联系人分别贡献，联系人版本只允许本联系人贡献。
8. Q37 的撤销自动更新是新增恢复版本；新版本引用被恢复版本和被撤销动作，保留自动来历。仅有旧版本文本不构成合法恢复资格，仍须核验来源及人工保护。

### 轮次、任务与输入

9. 一次用户开始操作有一个 `round_id`，固定点击时的联系人范围和已保存文字目标；后到消息不进入该轮。本人整理可汇总同轮各联系人合法贡献，但不能把不同联系人原始聊天混成某个联系人的提取窗口。
10. 一个规范消息的特定有效文字版本是跨轮可识别的处理对象。`(owner_id, contact_id, message_version_id)` 决定一个处理身份；换轮次、任务或请求编号不产生新的待处理资格。
11. 一轮对多个消息形成固定目标成员关系；消息也可能出现在失败后明确启动的后轮。固定集合和跨轮成功事实不能共用一张只有 `round_id` 的结果表，否则新轮会忘记成功和未知调用。
12. 提取目标和理解前文是不同角色。前文不计入目标总数或成功量，但属于实际输入和删除依赖；它也必须在点击前已保存、同联系人且有效。
13. Q38：一条任务只属于一个轮次，输入冻结后不追加。普通暂停或可恢复失败后继续沿用任务、输入和成功步骤，新增执行记录；新消息使用新轮次和新任务。
14. 任务、实际执行、步骤结果有不同基数：一任务多次执行，一执行运行若干未完成步骤，一步骤可有多次实际运行；已成功步骤不因继续而重发。固定步骤是直接执行合同，不另造可跨轮复用的 plan 壳。
15. 联系人取消或来源删除使原任务硬失效；不能把该任务改为可运行，再复制最新授权代次。本人聚合任务若包含失效贡献，也不能删掉一个输入标签后提交原混合结果。

### 调用、追踪与生命周期

16. 一次逻辑模型操作与一次网络发送不同。逻辑操作可能有明确未发送的失败或待核验回执；已发送结果未知时，换 `task_id`、`execution_id`、`request_id` 不能绕过门禁。
17. 调用正常返回、解析成功、核验通过、业务提交成功、目标完整处理成功是不同事实。正常无新记忆也可以成功；失败、未知和阶段缺失不能用“记忆数量为零”代替。
18. 完整提取过程包含实际发送输入、实际返回输出、解析和核验阶段材料及结果，不只是 token、错误码或摘要。一个过程可能参与多个来源；其中仅作上下文的来源也能使过程正文失效。
19. 证据引用描述“该结论依靠什么”；完整输入依赖描述“该执行实际接触什么”。两者不能合并，否则删除未被引用的前文会漏删追踪。
20. 普通暂停只阻止新小批，已开始且仍合法的小批可以收尾；取消和删除立即阻止提交。同步总开关不控制记忆任务；退出后不自动发起模型调用，必须手动继续。
21. 清理会擦除候选、版本、证据和追踪中的敏感副本。可保留最小无正文操作状态用于拒绝迟到写入；“保留历史版本”不能凌驾于来源删除。

## 结构约定与跨领域接口

- 下列字段未标 `NULL` 即为 `NOT NULL`。标识符为不透明稳定 ID，时间字段是明确时区的时间点；编码和精度由运行时设计统一。正文、说明和错误详情都视为可能含敏感资料。
- `owner`、`contact`、`message_version`、`source_message_ref`、`deletion_operation` 是其他领域提供的实体接口，不在本文重复建模。`message_version` 必须提供 `(owner_id, contact_id, message_version_id)` 唯一键和文字类型、有效性；`source_message_ref` 必须提供同范围来源身份及删除状态。
- 子表通常保留 `owner_id` 并使用带 owner 的复合 FK；联系人输入还使用 `(owner_id, contact_id, …)` 复合 FK。此冗余用于数据库隔离，不以“ID 全局唯一”为由放弃约束。下面的 `FK X` 均指相应带范围键，具体复合列在整合时落实。
- `memory` 的本人分支不能用 `UNIQUE(owner_id, contact_id, …)` 的 NULL 行为表达唯一性；使用显式分支 CHECK、部分唯一索引及必要触发器。跨表“同轮、同范围、旧版本有效”约束须通过复合 FK、触发器和短事务共同实施，不能只靠调用者自觉。
- 所有正文关系禁止 `ON DELETE SET NULL` 后继续当成独立手录使用。删除采用 Q42 的同一 `deletion_operation`，先推进写入失效状态，再擦除依赖内容并复核；具体擦除目标接口由删除领域闭合。
- 本文不假定跨业务 `material_set`。任务自己的固定输入成员和模型调用自己的 payload 都是直接事实，并非认可 Q43 暂缓的共享材料层。

## 从事实推导表

### 固定轮次与跨轮处理身份

**`memory_round` — 一次用户开始操作。**

- 字段：`round_id PK`、`owner_id FK owner`、`requested_at`、`state`、`pause_requested_at NULL`、`pause_reason_code NULL`、`finished_at NULL`。
- 约束：`UNIQUE(owner_id, round_id)`；状态为 `preparing/running/pause_requested/paused/blocked/completed/cancelled`。`completed` 要求所有有效参与范围的适用阶段已完成或明确不适用；缺行不算完成。
- 独立理由：用户一次开始和后续多次实际执行不同；轮次自身不保存模型正文或重复目标列表。

**`memory_round_contact` — 点击时选中联系人的贡献资格。**

- 字段：`contribution_id PK`、`owner_id`、`round_id FK memory_round`、`contact_id FK contact`、`selection_authorization_id FK 授权记录`、`selection_generation`、`deletion_generation`、`state`、`invalidated_at NULL`、`invalidated_reason NULL`。
- 约束：`UNIQUE(owner_id, round_id, contact_id)`；`UNIQUE(owner_id, contribution_id, contact_id)`。捕获的授权和删除代次不可 UPDATE；`state=revoked` 为终态。
- 独立理由：本人与联系人的输出都可能依赖该联系人贡献；该事实同时是硬撤销的锚点，不属于某次租约。

**`memory_target_work` — 同一文字版本的跨轮处理身份与终局。**

- 字段：`work_id PK`、`owner_id`、`contact_id`、`message_version_id FK message_version`、`state`、`success_kind NULL`、`completed_at NULL`、`completion_step_run_id NULL FK memory_step_run`。
- 约束：`UNIQUE(owner_id, contact_id, message_version_id)`；状态 `pending/in_progress/blocked_unknown/succeeded/deleted`；成功仅可为 `with_memory/no_new_memory`，两者均须完整适用流程完成。`deleted` 不通过重新选中改回 pending；明确恢复历史产生新来源／有效消息版本资格，具体身份规则交由消息领域证明。
- 独立理由：持久记住跨轮成功，禁止给同一消息换任务后重复提取；成功与候选数量没有函数依赖。成功内容若仅因后续主题阶段失败而未达整轮完成，已成功提取步骤仍可复用，但不能提前把整个 work 标成全流程成功。

**`memory_round_target` — 本轮固定目标。**

- 字段：`round_target_id PK`、`owner_id`、`contribution_id FK memory_round_contact`、`work_id FK memory_target_work`、`ordinal`、`state`、`result_step_run_id NULL FK memory_step_run`。
- 约束：`UNIQUE(contribution_id, work_id)`、`UNIQUE(contribution_id, ordinal)`；触发器核对 work 与贡献属于同一联系人。固定集合在轮次从 preparing 转运行时冻结，之后禁止增加成员或更换 work；删除可将成员变为 `deleted` 并擦除敏感引用。
- 独立理由：这是点击时目标快照；work 是跨轮处理身份，二者基数和保留周期不同。`state` 是本轮进度，不复制正文。

### 任务、阶段与实际执行

**`memory_round_phase` — 完整流程的阶段完成事实。**

- 字段：`phase_id PK`、`owner_id`、`round_id FK memory_round`、`subject_kind`、`contact_id NULL FK contact`、`phase_kind`、`state`、`not_applicable_reason NULL`、`completed_at NULL`。
- 约束：范围 CHECK 与 memory 相同；按 self/contact 分支对 `(round_id, subject范围, phase_kind)` 建唯一约束。`phase_kind=extract_verify/organize/overview`；`state=waiting/running/succeeded/not_applicable/blocked/invalidated`。not_applicable 必须有明确原因。
- 独立理由：一个阶段可以分为多个有限任务；没有任务或没有产出不能自动证明阶段完成。它不持有可变输入或跨轮 plan。

**`memory_task` — 一轮内输入固定的有限工作。**

- 字段：`task_id PK`、`owner_id`、`round_id FK memory_round`、`phase_id FK memory_round_phase`、`input_frozen_at`、`state`、`control_generation`、`created_at`、`invalidated_at NULL`、`invalidation_reason NULL`。
- 约束：`UNIQUE(owner_id, task_id)`；phase 必须属于同轮。状态 `ready/running/pause_requested/paused/failed/blocked_unknown/succeeded/invalidated`；invalidated 终态。输入冻结后的普通继续只新增 execution，不更新 input_frozen_at 或输入。控制代次可因暂停／租约失效递增，不能覆盖贡献授权代次。
- 独立理由：任务的固定输入生命周期与执行重试不同，且 Q38 要求直接归属一轮。

**`memory_task_contribution` — 任务实际依赖的联系人贡献集合。**

- 字段：`owner_id`、`task_id FK memory_task`、`contribution_id FK memory_round_contact`；`PK(task_id, contribution_id)`。
- 约束：同 owner、同 round；冻结后不增删。联系人任务恰好一个本联系人贡献；本人聚合任务可多个贡献。提交逐个复验贡献仍有效，不只核对本人范围的总开关。
- 独立理由：本人任务对联系人贡献为多对多，不能放在 JSON 标签中；任务租约更新不得把撤销资格刷新成新代次。

**`memory_task_input` — 该任务自己的有序固定输入成员。**

- 字段：`input_id PK`、`owner_id`、`task_id FK memory_task`、`ordinal`、`role`、`round_target_id NULL FK memory_round_target`、`context_message_version_id NULL FK message_version`、`candidate_version_id NULL FK memory_candidate_version`、`memory_version_id NULL FK memory_version`。
- 约束：`UNIQUE(task_id, ordinal)`；role 为 target/context/candidate/memory，并由 CHECK 保证对应 FK 恰好一个非空。各类按 `(task_id, 对应FK)` 部分唯一。冻结后不增删、更换引用；上下文须同联系人、点击前已保存且有效。candidate/memory 输入只能追溯到本轮授权贡献或本轮开始时允许的同范围既有资料，具体使用边界需业务接口闭合。
- 独立理由：输入角色是同一任务成员关系的判别类型，适合一张有强类型 FK 的表；没有无类型 `entity_id`。独立多值成员逐行保存，不存 JSON 数组，不上升为跨业务材料集合。
- 自身整理可在联系人提取完成后创建新的有限任务并一次性冻结候选输入；这些候选只能来自点击时固定目标的合法结果。新任务不等于给原任务追加消息，也不能自动重发失败或未知调用。

**`memory_task_step` — 任务需要执行的确定步骤及可复用成功位置。**

- 字段：`step_id PK`、`owner_id`、`task_id FK memory_task`、`step_no`、`step_kind`、`state`、`successful_step_run_id NULL FK memory_step_run`。
- 约束：`UNIQUE(task_id, step_no)`；步骤种类如 model_extract/parse/verify/persist/organize/publish，具体合同在实现前细化。任务冻结时确定本任务步骤；成功指针只指向本步骤且合法提交的 run。阶段间多个任务的依赖用下表表达，不藏在 step JSON。
- 独立理由：步骤已成功与“本次执行成功”不同；手动继续读取该事实跳过成功步骤，不复刻旧 plan 生命周期。

**`memory_task_dependency` — 有限任务间的先决结果。**

- 字段：`owner_id`、`task_id FK memory_task`、`required_step_id FK memory_task_step`；`PK(task_id, required_step_id)`。
- 约束：同轮、无循环，不能依赖失效贡献；自环拒绝。输入仍须冻结为具体有效版本，依赖完成不允许自动向已冻结输入追加结果。
- 独立理由：一任务可依赖多个提取结果，一个成功步骤可被联系人整理及本人整理同时使用；这是依赖图事实，不是通用材料壳。

**`memory_task_execution` — 一次用户继续后实际领取任务的执行。**

- 字段：`execution_id PK`、`owner_id`、`task_id FK memory_task`、`execution_no`、`trigger_kind`、`started_at`、`finished_at NULL`、`state`、`captured_control_generation`、`lease_token`、`lease_expires_at`、`heartbeat_at`、`failure_scope NULL`、`failure_code NULL`。
- 约束：`UNIQUE(task_id, execution_no)`；每任务至多一个存活租约。`trigger_kind=initial_start/manual_continue`，不提供自动重试触发；failure_scope 为 contact/shared，分别阻塞本联系人或暂停整轮。租约丢失不证明外部调用没发生。
- 独立理由：租约、时间和某次失败只属于执行，不污染固定任务及成功步骤；新增 execution 不授予新联系人贡献资格。

**`memory_step_run` — 一个步骤在一次执行中的实际运行。**

- 字段：`step_run_id PK`、`owner_id`、`execution_id FK memory_task_execution`、`step_id FK memory_task_step`、`started_at`、`finished_at NULL`、`state`、`outcome_code NULL`、`committed_at NULL`。
- 约束：`UNIQUE(execution_id, step_id)`；step 和 execution 必须同 task。成功需解析、核验或持久化等该 step 合同成立，不以模型返回成功代替；一次 execution 内再次运行同一步骤需新的 execution，不能覆写历史。
- 独立理由：成功步骤可跨执行复用，失败的具体发生位置和完整阶段产物也必须可追踪。

### 模型操作、回执和完整追踪

**`model_operation` — 一项不可因换请求编号而复制的逻辑调用。**

- 字段：`operation_id PK`、`owner_id`、`purpose_code`、`semantic_key`、`state`、`created_at`、`resolved_at NULL`、`resolution_code NULL`、`commit_forbidden_at NULL`。
- 约束：`UNIQUE(owner_id, purpose_code, semantic_key)`；semantic_key 由稳定业务身份推导，不含轮次／task／execution／request 的可替换编号。提取采用持久 work 身份；聚合采用确定的输入版本及阶段身份，具体编码须由业务存储统一生成，不接受调用者自报随机值。此键可用稳定 ID 的规范编码，不必保存正文哈希。
- 独立理由：同一逻辑操作可以有多次明确未发送的尝试；未知状态与业务提交资格也不同。该实体适用于实际模型调用的共同事实，但不能用它统一候选、删除审计或助手对话。

**`memory_operation_work` — 该逻辑操作锁住的提取／处理目标。**

- 字段：`owner_id`、`operation_id FK model_operation`、`work_id FK memory_target_work`、`state`；`PK(operation_id, work_id)`。
- 约束：当 state 为 reserved/sent/unknown 时，对 work_id 建“同一处理阶段不可有另一在途效果”的唯一门禁；更保守的实现可在完整流程结束前保持 work 的任务保留资格。此门禁与 semantic_key 同时存在，防止把未知批次拆成单条或换分组绕过。已处理前文仅属于删除依赖，不因此重新成为 target work 或增加计数。
- 独立理由：批次的操作和逐消息处理对象是多对多，单独对 batch 哈希去重无法阻止拆批重发。阶段锁键及多步骤流转须在整合时明确；至少提取效果必须按 work 跨轮独占，不能只按 task 独占。

**`model_call` — 一次实际外部发送尝试及无正文回执。**

- 字段：`call_id PK`、`owner_id`、`operation_id FK model_operation`、`attempt_no`、`provider_code`、`request_id`、`provider_receipt_id NULL`、`state`、`prepared_at`、`sent_at NULL`、`received_at NULL`、`input_tokens NULL`、`output_tokens NULL`、`error_code NULL`。
- 约束：`UNIQUE(operation_id, attempt_no)`、`UNIQUE(provider_code, request_id)`；状态至少区分 prepared/definitely_not_sent/sent_unknown/returned/known_failed。只有明确可证明未发送或有安全恢复依据时才能新增发送尝试；timeout 或租约过期不得推导 definitely_not_sent。
- 独立理由：传输回执可以无正文保留，但不能替代完整 payload；一个逻辑操作不是一次网络尝试。

**`memory_step_call` — 模型调用在记忆步骤中的使用位置。**

- 字段：`owner_id`、`step_run_id FK memory_step_run`、`call_id FK model_call`、`ordinal`；`PK(step_run_id, call_id)`；`UNIQUE(step_run_id, ordinal)`。
- 约束：同 owner；只有合法接续或复用同一已知回执才能连接既有 call。无须将所有模型执行强行从属于 memory_task，其他领域可自行提供受约束的使用位置。
- 独立理由：通用调用主体与记忆的具体执行上下文不同；此关联让正文删除可以回到正确业务范围。

**`model_call_payload` — 真正发送和返回的完整内容。**

- 字段：`payload_id PK`、`owner_id`、`call_id FK model_call`、`side`、`part_no`、`content_type`、`body`、`recorded_at`。
- 约束：`UNIQUE(call_id, side, part_no)`；side=request/response。body 保存实际序列化输入／输出，包括系统与用户输入、实际窗口、工具输入输出等真实执行材料；格式本身可以是协议 JSON，但其中来源集合、业务关联或多值成员仍单独成关系。
- 独立理由：实际调用内容的一对多顺序结构与无正文回执不同；不能只留提示模板编号或输出摘要。本文不要求提供商未暴露的内部思维链。

**`model_call_source` — 调用完整参与窗口的来源依赖。**

- 字段：`owner_id`、`call_id FK model_call`、`source_message_ref_id FK source_message_ref`、`input_role`；`PK(call_id, source_message_ref_id, input_role)`。
- 约束：role=target/context/derived；逐一包含实际输入和派生输入的传递来源。联系人提取不允许跨联系人；本人聚合可以多个合法贡献，但不扩大开始范围。
- 独立理由：一调用多来源，一来源多调用；未被最终引用的前文也必须能定位并擦除整次敏感 payload。没有仅对“最终证据”做删除的捷径。

**`memory_step_artifact` — 解析、核验与保存过程的完整阶段材料。**

- 字段：`artifact_id PK`、`owner_id`、`step_run_id FK memory_step_run`、`artifact_kind`、`ordinal`、`content_type`、`body`、`created_at`。
- 约束：`UNIQUE(step_run_id, artifact_kind, ordinal)`；kind 如 parsed_candidates/validation_input/validation_result/adoption_result/organize_result，实际已发生什么就保存什么。阶段失败也保留实际输入、输出、错误位置；不伪造缺失产物。
- 独立理由：解析和核验可能在本地完成，其完整过程不一定对应模型调用；不能挤进无正文回执，也不能用一串“成功”日志替代阶段材料。

**`memory_artifact_source` — 阶段材料的传递来源。**

- 字段：`owner_id`、`artifact_id FK memory_step_artifact`、`source_message_ref_id FK source_message_ref`；`PK(artifact_id, source_message_ref_id)`。
- 约束：完整继承输入依赖；只有敏感 body 被实际擦除并复核后，才能把删除目标标为完成。保留无正文成功步骤元信息时不得保留被删 artifact 的可复原副本。
- 独立理由：阶段产物可合并多个调用／来源，不能假定其来源恰好等于某个 call。它是本领域追踪关系，不是默认通用材料集。

### 候选、正式记忆与证据

**`memory_candidate` — 一次提出的待采纳记忆身份。**

- 字段：`candidate_id PK`、`owner_id`、`subject_kind`、`contact_id NULL FK contact`、`produced_step_run_id FK memory_step_run`、`output_ordinal`、`state`、`created_at`。
- 约束：范围 CHECK 同 memory；`UNIQUE(produced_step_run_id, output_ordinal)`；状态 proposed/rejected/adopted/invalidated。产生位置不是正文唯一性，也不承担跨轮消息成功去重。
- 独立理由：提取有候选并不等于已采纳；候选被删除也不能使已处理目标回到待提取。

**`memory_candidate_version` — 候选原稿及用户修改稿。**

- 字段：`candidate_version_id PK`、`owner_id`、`candidate_id FK memory_candidate`、`version_no`、`previous_version_id NULL FK memory_candidate_version`、`body`、`edit_kind`、`created_at`。
- 约束：`UNIQUE(candidate_id, version_no)`；从 v1 开始、链须同候选；edit_kind=model/manual_edit。用户编辑继承原依赖，不能改成 independent_manual_entry；删除来源时连同已编辑敏感副本清理或按独立支持重新核验。
- 独立理由：候选身份、可编辑文本与每版证据是不同关系；不覆写模型原稿。

**`memory` — 本人与联系人共用的正式记忆身份。**

- 字段：`memory_id PK`、`owner_id`、`subject_kind`、`contact_id NULL FK contact`、`current_version_id NULL FK memory_version`、`state`、`created_at`。
- 约束：`UNIQUE(owner_id, memory_id)`；明确 self/contact CHECK；current_version 必须属于本 memory。创建与首版提交同事务完成，只有事务内短暂草建允许 current_version 为 NULL；对外有效行必须有当前版本。
- 独立理由：稳定业务身份可跨多个版本，Q36 不为本人复制另一套表。

**`memory_version` — 不可原地改写的正式内容版本。**

- 字段：`memory_version_id PK`、`owner_id`、`memory_id FK memory`、`version_no`、`previous_version_id NULL FK memory_version`、`body`、`formation_kind`、`adoption_mode`、`manual_protection`、`restored_from_version_id NULL FK memory_version`、`reversed_adoption_id NULL FK memory_adoption`、`created_at`。
- 约束：`UNIQUE(memory_id, version_no)`；所有前驱／恢复引用同 memory；formation_kind=auto/manual_entry/manual_edit/restoration，adoption_mode=auto/user_confirmed/manual_entry，两个维度分别描述形成方式和确认事实。restoration 必须有恢复版本与被撤销动作；不得把自动恢复写成 manual_entry 或 user_confirmed。对 auto 内容，manual_protection 只能由真实用户操作改变。
- 独立理由：内容变化、来源变化或 Q37 恢复均追加版本；人工保护属于该版本的真实状态，不是来源删除豁免。`manual_entry` 只用于用户真实独立录入，不能作为聊天派生内容脱离删除的转换器。

**`memory_adoption` — 一次采纳、修订或恢复操作。**

- 字段：`adoption_id PK`、`owner_id`、`memory_version_id FK memory_version`、`action_kind`、`actor_kind`、`step_run_id NULL FK memory_step_run`、`created_at`。
- 约束：`UNIQUE(memory_version_id)`；自动动作必须有关联合法执行；人工动作和自动动作分开记录。用户动作不得由系统代填；恢复指针形成有向既往引用，不允许循环。
- 独立理由：谁在何时采纳与最终版本正文不同；该操作是撤销追溯的身份，不是用正文相等推断的事件。

**`memory_adoption_candidate` — 一次采纳实际使用的候选版本。**

- 字段：`owner_id`、`adoption_id FK memory_adoption`、`candidate_version_id FK memory_candidate_version`；`PK(adoption_id, candidate_version_id)`。
- 约束：同 owner、同合法 subject；一次合并可有多候选，独立手录可以没有候选。不能引用已失效贡献的候选。
- 独立理由：采纳与候选为多对多；不以一个可空 candidate_id 丢失合并来历。

**`memory_evidence` — 可回到具体来源的支持片段。**

- 字段：`evidence_id PK`、`owner_id`、`contact_id`、`source_message_ref_id FK source_message_ref`、`message_version_id FK message_version`、`contribution_id NULL FK memory_round_contact`、`span_start NULL`、`span_end NULL`、`rationale NULL`、`created_at`。
- 约束：source_ref 与 message_version 必须在相同 owner/contact 且真实关联；跨度全空或同时有效，采用明确文本偏移单位。自动本轮证据必须引用 contribution；独立用户录入本身没有聊天证据，不伪造一条。rationale 可能敏感，随来源清理。
- 独立理由：证据是对来源片段的定位，不复制聊天全文；多个候选／记忆版本可以共享同一证据定位，证据数量不等于有效支持强度。

**`memory_candidate_evidence` 与 `memory_version_evidence` — 版本拥有的支持关系。**

- 前者字段：`owner_id`、`candidate_version_id FK memory_candidate_version`、`evidence_id FK memory_evidence`；`PK(candidate_version_id, evidence_id)`。
- 后者字段：`owner_id`、`memory_version_id FK memory_version`、`evidence_id FK memory_evidence`；`PK(memory_version_id, evidence_id)`。
- 约束：联系人版本只能连本联系人证据；本人版本可连多个合法联系人。编辑／采纳复制的是明确支持关联，不是抹掉源头。部分来源删除后立即撤下失效证明，剩余支持必须重新核验才能继续发布；不凭“还有一行”推断仍然成立。
- 独立理由：候选版和正式版的支持成员有各自生命周期；使用两张强 FK 关联表避免通用 target_type/target_id 悬空引用。证据共用只来自相同支持事实，并不批准跨业务共享材料表。

## 生命周期和必须成立的事务

1. **启动快照**：短事务读取已选且已核验联系人、当前授权及删除代次；为尚未成功且没有在途／未知门禁的文字 work 建轮次目标，记录同联系人前文并冻结成员。媒体占位、后到消息、未选联系人不进入；同步总开关不参与此记忆资格判断。输入预算仍待实现查证，不拍定固定条数。
2. **发送前**：领取合法任务，新增 execution/step_run，核验所有贡献、输入来源及 work 门禁；为实际效果绑定持久 operation 和逐 work 关系后再离开事务发请求。不得在写事务中等待模型。
3. **未知保护**：发出后超时或崩溃设 unknown 并持久保留 work 门禁。手动继续先恢复同 operation 回执；证明未发送才允许新 call，已返回则复用，仍未知就受阻并给可识别原因。换轮次、拆批、换模型配置或 request_id 不能解除未知门禁。提供商核验能力未查证，不能宣称 unknown 自动可恢复。
4. **提交前**：短事务重新核对全部贡献原始代次、source 有效性、task 非 invalidated、execution 租约／控制代次、版本前驱和人工保护。普通 pause_requested 允许已开始小批提交；取消、删除、源失效一律拒绝。call 已返回不构成提交资格。
5. **完整成功**：分别提交步骤结果、候选／采纳版本及证据；只有适用的提取核验、主题与概览完成才提交 work 全流程成功和阶段完成。无新记忆同样走已完成流程并记 no_new_memory，不反复提取。进度由固定成员和阶段结果求得，缓存计数若后续需要必须给一致性依据。
6. **暂停与继续**：普通暂停阻止新小批，当前有效批结束后 paused；退出／异常恢复到等待人工继续。继续新增 execution，复用成功步骤和合法回执，不创建新任务来回避错误，不修改 task 输入或贡献代次。
7. **硬撤销**：取消 A 时将其 contribution 终态撤销，并使依赖 A 的任务和未提交混合结果失效。B 的独立任务继续；已经混合 A/B 的本人任务不能剪掉 A 后提交。B-only 后续工作必须是原轮固定合法 B 输入的新有限任务，并遵循手动继续及 unknown 门禁；不得自动为 A 刷新授权，旧任务永久不可恢复。
8. **来源删除**：先推进清空／来源失效代次，撤销旧提交资格；根据完整 call_source/artifact_source 擦除相关输入输出及阶段正文，即使该来源只作理解上下文。清理候选所有版本、证据、受影响正式版本及其他派生副本；有其他有效来源的内容先撤下并重新核验。恢复不读回已删版本；无正文任务／回执状态保留范围由 deletion_operation 明确列目标和复核，不能只靠 FK 删除报告成功。
9. **人工编辑和恢复**：编辑自动内容追加版本并继承真实来源；确认是独立动作。撤销合法自动更新时，检查旧版所有当前来源、手工保护与被撤销操作顺序，追加 restoration 版本并原子切换 current_version，不把原版直接设当前，也不复活被删正文。

## 合并、不建及仍待整合

- 本人／联系人 memory 和版本按 Q36 合并，因为字段、版本和删除语义自然同构；来源所属联系人仍保留在证据与贡献关系中。
- 模型逻辑操作、网络调用和完整 payload 可以提供自然统一的执行事实；不因“都叫日志”把业务采纳、控制变化、正文过程和删除复核混成任意 JSON 事件表。
- 不建跨轮 task 复用关系、plan 壳、正文哈希身份、候选数量成功标记、自动重试队列；也不为仅减少表数合并不同多值关系。
- Q43 未决：本文没有统一跨业务 material_set；如以后提出共享结构，须逐项证明身份、基数、生命周期和删除边界相同，而不是从字段看起来相像推导。
- 待主设计闭合：消息版本及 source_ref 的准确身份；规范消息多来源时证据如何选择当前有效支持；逐 work 阶段门禁与聚合 semantic_key 的规范编码；主题／概览发布版本的 FK；统一删除目标与文件擦除接口；人工确认／独立手录具体交互；提供商 unknown 核验能力。这些是接口前置条件，不是允许省略约束。
- 文档交叉核验项：同消息换轮／换 task 仍不重提成功目标；未知批次拆分仍拒绝；暂停后成功步骤不重发；取消 A 后旧本人混合结果不得靠新 execution 恢复；删除仅作上下文的来源会擦除完整追踪；manual_edit 不洗掉来源；Q37 追加合法恢复版；退出后不自动调用。

本次仅完成需求到关系的文档推导；未执行 DDL、未连接数据库、未读旧结构、未操作 App 或微信、未打包。上述约束尚需后续临时 SQLite 合成测试及实际集成验证。

## 2026-10-29引用合同修订

消息正文版本表已确认不建；本首稿中message_version/source_message_ref等未整合占位引用，须按[记忆证据收敛提案](greenfield-memory-evidence-contract.md)改为message及capture_record真实引用。候选版本、全局evidence身份、采纳1:1操作壳均仍是未批准建议，不自动纳入最终表单。

2026-10-29用户已选记忆候选方案A：本首稿的memory_candidate_version不再纳入当前设计；候选保留固定模型原稿，修改采纳形成正式memory_version。候选关系引用candidate真实身份，不再引用候选版本占位键；详情见[候选与操作提案](greenfield-candidate-decision-contract.md)。

处理结构后续以[固定处理与调用收敛提案](greenfield-processing-contract.md)为最新讨论稿；原文message_version/candidate_version及通用调度关系不自动纳入。尚未闭合的聚合门禁与跨域父键以新稿明确列项为准。
