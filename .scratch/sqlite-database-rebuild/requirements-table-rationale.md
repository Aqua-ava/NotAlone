# 按实际需求审查数据库总表清单

> 当前方向：从业务事实重新设计。本文件仅为旧草案审查记录；54表视图未获认可，不是设计起点或目标。主入口：[全新设计](greenfield-design.md)。

2026-10-28 · 讨论稿。**撤回94表推荐，Q43暂缓；用户尚未批准新的表数或完整schema。**

前版把逻辑分层、旧实现细节和未定扩展能力混进了物理表清单。此次从真实需求重新判断，旧PG只作查漏。每个“保留/合并/不建”都是本轮建模建议，不把之前某个issue的resolved或单题选择扩大为批准整份提案。

本文先给当前基础范围的逐表工作清单，再列合并与条件范围；[完整112项审查附录](requirements-table-audit.md)对每个原候选逐项列用途、需求、理由、PK/FK、取舍和出处，[JSON](requirements-table-rationale.json)可校核覆盖。112是107逻辑草案加3查漏和2元数据的审查对象数，不是拟建数量。

## 用什么标准决定独立成表

- 一行先说明只表达什么事实；出现真实1:N、M:N、独立不可变历史或跨系统恢复进度，才有明确拆表理由。
- 严格1:1的当前状态可以并主体；1:1拆分并不违反范式，但需要安全隔离、独立保留或访问负载等具体依据，不能只因为代码分模块就拆。
- 相同粒度、相同关系可以有限类型共表，代价是额外CHECK/FK分支；不同事实不因“都有正文”或“都叫版本”而合并。
- 实体与版本、计划目标与实际输入、展示引用与全部依赖、事实证据与处理追踪分别判断。完整追踪是必须保存的数据，不意味着每类日志或输入各建一表。
- 数据库存储类型、业务权限和删除合同分别验证。正文载荷可有格式化JSON，实体引用不能用无FK的任意ID数组代替。

## 真实需求基线

| 编号 | 必须支持的需求 | 根据 | 设计区域 |
| --- | --- | --- | --- |
| R1 | 用户、渠道账号、联系人和已核验会话身份分开；改名不改身份，重新授权不冒充旧许可 | 用户Q30/Q34；产品隔离及已确认联系人边界 | 02、08 |
| R2 | 捕获页、原始出现和规范消息分层；身份不明隔离；非文字只占位 | 用户Q32/Q33/Q35 | 03 |
| R3 | 候选、已采纳记忆、不可变版本、具体证据与完整提取过程可查看、修正、删除 | 用户Q29/Q36/Q37；人工/auto不能混 | 04 |
| R4 | 一次点击固定范围与消息；任务一轮固定输入；暂停/失败继续有新执行；未知调用不盲重发 | 用户Q25/Q27/Q38及独立产品规格 | 05 |
| R5 | 联系人下讨论、候选原稿及编辑版本、显式选择和精确依据；用户手动发送 | 用户Q39；产品手动发送与候选可编辑边界 | 06 |
| R6 | 明确长期表达偏好与模型派生的场景/画像分开；文档版本发布配套 | 用户Q40；长期资料可查看、修正、删除 | 07 |
| R7 | Skill原目录、DSH官方加载、最小业务关联、防误删，按可证事实接回启停 | 用户Q41修正版 | 07 |
| R8 | 读取许可、取消/清空、排除与恢复分开；先撤销写入资格，再清数据库及文件并复核 | 用户Q24/Q26/Q34/Q42；精确渠道边界尚未被CLI证明 | 08 |
| R9 | 业务数据库与DSH运行副本有各自身份；材料删除可找到实际受管副本 | 用户旧会话副本清理决定；官方JSONL运行边界研究 | 06、08、09 |
| R10 | 安全辨认新业务库、隔离测试库与当前格式；升级策略尚待确定 | 单库决定与工程初始化约束，不是完整迁移平台需求 | 09、10 |
| RX | 高级Skill学习/方法继承/双侧审核、持续组织保护、诊断评估、投影缓存等需明确本次范围 | 查漏项与Agent提案；不能因旧PG有表/消费者就列必建 | 07、10 |

## 基础范围的工作清单

在下列假设下，工作视图为**53张业务表＋1张元数据表，共54张**。这是逐项审查后的可讨论方案，**不是新批准数，也不承诺自动保留全部RX扩展**。任何合并前提不成立或扩展明确纳入，都要改清单并重新核算；不能为了54硬合表。所有条件项在后文明列，没有把它们改名后藏到计数外。

1. 当前基础闭环含身份/同步、完整记忆处理、偏好及L2/L3、助手候选及DSH运行副本、Skill最小接回、删除；不把RX扩展自动加入。
2. 一个范围的一轮完整记忆管线由background_task表达，processing_round不再另造同义身份；一次点击processing_run可有多个范围任务。
3. 固定目标的最小提交结果保留在processing_input；不沿用旧90天修剪丢失证明。下一轮接受/领取目标时在同一提交门禁核验历史有效结果：成功排除，任一未结算unknown阻断，换task/request ID也不能绕过。若必须独立修剪执行主体，再拆receipt。
4. 手动确认是否跨多turn复用尚待真实入口核对；若需要可独立撤销的复用凭证，就加入独立confirmation，而非改变用户确认交互来免表。
5. 普通版本延续/撤销用完整自FK；多父记忆合并/跨文档拆合尚未确认，不能把输入参与都叫语义父边。
6. 候选多条消息保留每版消息行；只有固定位置、没有独立段属性时，segment_no即可，不单建位置身份表。
7. 删除目标的sealed_request是已完成的长期最小封存分支，不等待其被擦除；row/file计待清进度，复核另验拒绝索引。其父操作和read_exclusion依赖的操作不能普通剪枝/级联删除。若不满足，就不能合掉专用tombstone。
8. 本轮不提前建设性能投影；直接读取仍须符合既有概览时点合同，后续测量有需要可重新提出缓存；不宣称已测性能。
9. 使用用途专属输入关系作为当前工作视图；Q43仍未选。claim/trace等同域粒度合并只是提议，不等于选择跨用途material_set。
10. 当前版本位置可由单例元数据或PRAGMA记录；若需要逐脚本校验/历史审计，则增加schema_migration，不把user_version说成等价迁移历史。

下表每一行是本工作视图的一张物理表；完整字段DDL尚未形成。表间引用默认带owner范围，联系人资料另带contact；元数据及需在原对象删除后存活的封存/删除地址有明确例外合同。

### 身份（4，R1）

| 序号/表 | 一行保存什么 | 为什么独立 | PK/FK与关系 |
| --- | --- | --- | --- |
| 1. `owner` | 一位本机资料所有者的内部身份与建立时间，不存微信账号、昵称或登录体系。 含本人处理/文档控制和各集合独立revision。 | owner 是账号、联系人及本人资料的共同父身份。将其等同微信账号会使账号撤销影响资料所有权；将 owner_id 仅写成常量则缺少范围外键的真实父行。当前只有一个 owner，不因此预建多租户。 | PK(owner_id)；联系人、账号及本人范围记录真实 FK 到此。 |
| 2. `channel_account` | 已核验的外部微信账号身份、状态与核验时点；可同时容纳本账号当前读取开关和开关代次。 含当前读取开关、范围与read_switch_generation。 | owner 与外部账号是不同身份；一个 owner 可留下先后核验的不同账号记录，账号属性不依赖某位联系人。开关当前值严格一账号一份，没有理由再拆 1:1 控制表。 | PK(owner_id,account_id)；FK owner；UNIQUE(owner_id,channel,external_account_id)；每 owner/channel 至多一 active 账号；read_switch_generation 随真实开关变化推进。 |
| 3. `contact` | 用户的一位联系人、当前展示名，以及本联系人的当前生命周期、数据代次和来源集合修订。 含当前数据代次、处理/文档控制；昵称仅展示。 | 联系人是独立业务主体，既不等于会话 locator，也不等于昵称。当前数据控制严格每联系人一行，依赖同一个键，可以放在主体中，不必用竖拆制造表。 | PK(owner_id,contact_id)；FK owner；display_name 不唯一；data_generation、source_set_revision 分列；current_clear_boundary_id 为有范围验证的可空 FK。 |
| 4. `conversation_binding` | 一个已核验微信账号内的私聊身份到 contact 的映射、核验快照和修订。 | 账号有多个会话；联系人和绑定有不同身份及历史。将 locator 直接塞 contact 会混淆账号命名空间，合进授权则每次重新授权都制造新身份。 | PK(owner_id,binding_id)；同 owner 的 account/contact 复合 FK；有效账号+locator 唯一；范围超键供 source_batch、message 和授权引用。 |

### 消息与来源（3，R2）

| 序号/表 | 一行保存什么 | 为什么独立 | PK/FK与关系 |
| --- | --- | --- | --- |
| 5. `source_batch` | 一次真实接收的单绑定、有界 CLI 返回页：适配器版本、请求和返回 cursor、捕获时点、授权及删除资格快照。 | 一页包含多条原始出现，页级 cursor 和资格事实不依赖单条 record。全部重复进 record 会制造更新异常，放 message 又无法表达多次捕获和待核验原始记录。 | PK(owner_id,contact_id,batch_id)；同范围 binding/grant/episode FK；同一次捕获重放沿用 batch_id；不以 cursor 或正文哈希唯一。 |
| 6. `source_record` | 一次捕获页中的原始消息事件出现、原始必要载荷、页内位置和核验状态；可靠时链接到规范 message。 | 原始出现与规范消息不是一对一：待核验 record 可无 message，多个 record 可支持同一个 message。合表无法同时正确表达隔离与去重后的单一消息。 | PK(owner_id,contact_id,record_id)；UNIQUE(owner_id,contact_id,batch_id,record_no)；真实 batch FK；可空同绑定 message FK。 |
| 7. `message` | 一条可靠身份的规范聊天消息，含文字或非文字类型、发送方、真实时间/顺序状态。 非文字text为NULL，仅留必要类型/位置元数据，不取媒体资源，不进入记忆。 | 它是来源核验后的业务事实，可被多条捕获记录支持；检索、目标和证据不应绑定到某次偶然捕获。非文字和文字共享相同身份及排序合同，不需要分媒体表。 | PK(owner_id,contact_id,message_id)；同范围 binding FK；UNIQUE(owner_id,contact_id,binding_id,identity_scheme,identity_key)，真实身份合同待证明。 |

### 记忆、证据与完整追踪（8，R3）

| 序号/表 | 一行保存什么 | 为什么独立 | PK/FK与关系 |
| --- | --- | --- | --- |
| 8. `memory_candidate` | 一条尚待采纳、拒绝或核验的提取主张；含原联系人、正文限定、产生执行和当前资格。 subject_kind明确self/contact/shared，与原始联系人和最终记忆范围分别表达。 | 候选可以被拒绝并永远没有已采纳版本；一个执行可产生多条候选。把候选与memory_version混为一行，会让未采纳内容拥有正式记忆身份或制造空head。 | PK(owner_id,candidate_id)；FK(origin_contact_id)→contact；产生执行FK→真实step_attempt；不得按正文唯一。 |
| 9. `memory` | 同一条已采纳记忆的稳定身份、owner/contact范围及当前版本指针。 | 一条记忆对应多版内容，稳定身份和当前指针的粒度不同于任一版正文；不是为了记录一个状态而另建重复正文表。 | PK(owner_id,memory_id)；独立owner FK；contact范围FK；current_version完整FK→memory_version(owner,memory,version)。 |
| 10. `memory_version` | 一条记忆的一版正文、限定、自动/人工采纳来历、来源资格及版本生命周期。 | memory 1:N version 是已确认的内容历史；人工修改与合法恢复都追加版本，不能只覆盖head正文。 | PK(owner_id,memory_id,version_no)；FK→memory、可空原候选、实际产生执行；origin_kind约束引用形状；同候选一次采纳条件唯一。普通前序与恢复来源为完整自FK，多父图单列条件项。 |
| 11. `claim_evidence` | 候选或某记忆版本的一处消息片段证据 | 主张1:N证据片段，消息也可支撑多个主张；两种父类型共享同一证据粒度，使用排他真实FK。 | PK(owner_id,evidence_id)；候选/记忆版本FK恰一组；来源message完整范围FK。 |
| 12. `claim_required_message` | 一个主张成立必须保留的一条规范消息依赖 | 主张N:M消息；必需消息为AND，消息的有效捕获为OR。与可有多个片段的展示证据不同，不可混成一表。 | 主张真实FK与message完整范围FK；每类主张+message唯一。 |
| 13. `memory_trace_event` | 一次实际执行中的一个阶段事件，含实际模型请求/返回或程序处理结果。 | 真实执行1:N事件，阶段和实际载荷具有顺序，不能以一个last_error或最终产出覆盖；也不能以无正文模型call替代。 | PK(owner_id,task_id,step_no,attempt_no,event_no)；FK→实际attempt；可空call FK；事件号保实际过程顺序。 |
| 14. `trace_input` | 一个真实执行实际使用的一项消息、捕获或具体版本材料 | 执行1:N实际输入；材料种类不是五种独立关系。有限typed FK分支统一同一用途，不等于选择Q43跨业务共表。 | PK(执行完整键,input_no)；真实阶段event及可空call FK；message/source_record/memory_version/document_version恰一真实FK分支。 |
| 15. `memory_decision` | 一次真实人工/自动裁决操作：采纳、拒绝、纠错、撤销或删除及其结果。 | 操作可有0个结果版本，因此不能只附在memory_version；一个候选或记忆可有多次操作。仅一次性记忆裁决可统一到此；持续生效、可撤销的组织反馈保护若确认需要，是另一生命周期实体，不能为减表强塞进同一头。 | PK(owner_id,decision_id)作为稳定重试键；candidate、目标/结果memory_version分别真实FK；action形状CHECK；expected_revision约束提交。 |

### 处理与调用（8，R4）

| 序号/表 | 一行保存什么 | 为什么独立 | PK/FK与关系 |
| --- | --- | --- | --- |
| 16. `processing_run` | 一次用户点击启动的协调身份、派发/暂停意图与本轮合同。 | 一次点击1:N各范围有限task，协调状态和某个联系人的执行状态粒度真实不同；不可合为单个task，否则复制全局暂停意图并产生不一致。 | PK(owner_id,run_id)；owner FK；UNIQUE(owner_id,start_operation_id)；intent_revision做CAS；task真实FK→run。 |
| 17. `background_task` | 一次run内一个固定范围的一轮完整有限处理管线及接受时控制快照。 | run 1:N task，task 1:N可恢复step，是真实不同粒度；将同范围round合入这里，不再为每阶段另造task。 | PK(owner_id,task_id)；run FK；独立owner与有约束contact FK；同run同contact/本人范围条件唯一；accepted硬代次建立后不刷新解除旧失效。 |
| 18. `processing_input` | 某个固定task接受的一条可用消息及target/context角色；目标的实际处理结果。 | task N:M message，并且同消息在不同轮可能作为前文或失败后目标；只记时间上界或一个message.last_processed布尔不能表达点击时的真实集合。 | PK(owner_id,task_id,input_no)；UNIQUE(owner_id,task_id,message_contact_id,message_id)；task与message完整范围FK；target/context角色及目标分配step同task；producing_attempt与blocking_request为真实FK。target行承接最小提交结果、真实产生执行与unknown阻塞request。 |
| 19. `background_task_step` | 一个task中的可独立恢复/提交的小批或阶段。 | 一个task有多个真实小批/阶段，且失败位置和成功状态不同；不能只靠task一个last_stage，也不应为每个内部函数建步骤。 | PK(owner_id,task_id,step_no)；task FK；task内order_no唯一；step_kind、state、当前attempt完整FK。 |
| 20. `step_attempt` | 同一步骤的一次真实领取/执行：宿主与租约、结果、时间、完整追踪主体元数据。 同时承接完整追踪头与敏感内容状态；不删追踪事件。 | 同一步骤可失败并多次手动继续，存在真实1:N执行事实；覆盖step.last_error会丢掉发生过的执行及旧调用归属。将memory_trace头并入本真实执行主体。 | PK(owner_id,task_id,step_no,attempt_no)；step FK；lease_generation同step唯一；events/inputs/calls/产物实际FK到该执行。 |
| 21. `step_attempt_guard` | 一次执行依赖的owner/contact硬门禁快照，含本run贡献联系人。 | 一次执行可能同时受写入范围、多个当轮贡献联系人的原始授权代次约束，执行对门禁为1:N。门禁是接受资格快照，不只是材料清单。当前尚未证明所有资格都可沿输入无损推导，因此先保留显式关系，不以未证推导减表。 | PK(owner_id,task_id,step_no,attempt_no,guard_no)；执行真实FK；owner/contact真实类型FK；原run/task、accepted_generation和用途严格约束。 |
| 22. `model_request` | 一次固定工作与操作槽的逻辑模型操作身份、不可变输入合同及重试政策。 | 逻辑操作1:N真实call，操作身份与各次供应商响应事实不同；先建一个稳定逻辑操作作为unknown隔离和重试归属，避免每次call复制可变政策。这里只保留最小规范身份，不另存第二份提示正文。 | PK(owner_id,request_id)；背景请求完整FK到固定background_task_step（不绑某次attempt），助手请求完整FK到turn及固定输入合同/上下文；两类真实父排他。固定父+invocation_slot唯一，输入seal不可替换；call的真实producer attempt必须属于该父与同一范围。 |
| 23. `model_call` | 一次真实物理模型尝试的发送/结算、实际模型、用量及费用，含真实生产执行FK。 | 逻辑request 1:N call，物理尝试有独立时间、结果、token和费用；事件/响应条数不等于调用次数，也不能把模型成功当业务提交成功。 | PK(owner_id,call_id)；request FK；UNIQUE(owner,request,call_no)；同逻辑request至多一个在途/unknown；真实producer执行FK，多个执行类型用排他CHECK。直接排他FK到真实step_attempt或assistant_attempt，具体上下文固定。 |

### 助手、候选与运行副本（12，R5、R9）

| 序号/表 | 一行保存什么 | 为什么独立 | PK/FK与关系 |
| --- | --- | --- | --- |
| 24. `assistant_session` | 同一联系人下可继续或回看的一个业务讨论。 | 一个联系人可有多段讨论，每段有自己的有序输入、当前选择及运行副本；它不是联系人的一对一属性，也不是一次模型请求。 | PK(owner_id,contact_id,session_id)；FK contact；当前turn、selection、runtime均指本session。 |
| 25. `assistant_turn` | 一次不可变的明确提交输入及逻辑处理结果。 | session 1:N turn；同一输入可能尚未执行或有多次实际执行。把输入与模型call混为一行会丢掉零调用输入及逻辑请求的幂等身份。 | PK(owner,contact,session,turn)；FK session；UNIQUE(session,turn_no)与业务范围operation_key；携入指具体候选版本及真实选择。；手动确认若只属本turn，正式确认字段与binding来源排他，不伪造绑定。 |
| 26. `assistant_attempt` | 同一逻辑turn的一次真实执行、租约与提交资格。 | turn 0:N attempt；一次执行还可能有0:N检索和模型调用。它与物理调用不是一对一：调用账不能代替整次执行的租约和结果提交资格。 | PK(owner,contact,session,turn,attempt_no)；FK turn；租约代次单调。 |
| 27. `reply_candidate` | 某次生成产出的一个稳定候选身份与展示顺序。 | turn/attempt 1:N candidate，candidate 1:N version；身份不随正文编辑改变，且Q39明确要求身份与所有正文版本分离。 | PK(owner,contact,session,candidate)；FK origin assistant_attempt；UNIQUE(origin_turn,ordinal)。 |
| 28. `reply_candidate_version` | 同一候选原稿或用户编辑稿的一次不可变版本及版本元数据。 | 同一候选存在多个内容版本，旧选择不能随当前编辑被改写；一行可变candidate无法表达。 | PK(owner,contact,session,candidate,version_no)；FK candidate与同候选parent_version；正文子项由version_message保存。 |
| 29. `reply_candidate_version_message` | 某候选版本中固定序号的一条待发送消息正文。 | version 1:N message item，是实际重复值，不是一对一壳；用单独行保存可约束单条内容和引用位置。可承接segment的固定序号。 | PK(owner,contact,session,candidate,version_no,segment_no)；FK candidate_version；citation可FK具体version_message。；固定segment_no，不另建只有位置映射的segment身份表。 |
| 30. `assistant_selection` | 用户一次明确选择某个具体候选版本的事实。 | 同一generation turn下允许0:N次选择与改选，所选版本也可跨turn；它不是turn的一对一扩展。只留current指针会丢失先前合法选择及携入来历，改成通用turn事件流又扩大turn语义。 | PK(owner,contact,session,selection_no)；FK具体candidate_version；session.current_selection指本session选择；携入完整FK选择及其版本。 |
| 31. `assistant_context_snapshot` | 某次实际构造的不可变有界上下文和序列化敏感载荷。 | attempt可构造多份上下文，runtime_rebuild还可能没有模型attempt；一份上下文可进入运行副本。不能直接变成attempt的一组可变字段或只留内容哈希。 | PK(owner,contact,session,context_id)；请求型FK本attempt，重建型不伪造attempt；具体call指向其实际最终snapshot。 |
| 32. `assistant_context_item` | 某快照中一项具体材料及版本、用途和捕获时资格。 | snapshot 1:N item，材料又可被多次输入使用，是真实关联；payload或hash不能代替消息、来源、记忆、文档、偏好及Skill版本的关系。 | PK(owner,contact,session,context,item_no)；每种材料独立typed FK，形状CHECK恰好一种；支持source item有同context自FK。 |
| 33. `candidate_version_citation` | 某候选版本或其中一条消息展示的依据定位。 | 候选版本与实际输入之间是0:N展示引用，且只是全部输入依赖的子集；把它当作context item标志会把多个候选的不同引用混在一起。 | PK(owner,contact,session,candidate,version,citation_no)；FK具体版本、可空version_message、具体context_item。 |
| 34. `assistant_runtime_instance` | 一个业务session的某个真实DSH UUID运行副本、受管定位及ready/dirty资格。 | 一个业务session可有多个真实运行实例，各实例的配置、已提交边界、文件定位和写入资格可独立变化；session的一组current_runtime字段不足以枚举旧副本。 | PK(owner,contact,session,runtime_id)且runtime_id全局唯一；FK session及可空已提交turn；managed_locator限受管根和已核验目录。 |
| 35. `assistant_runtime_context` | 某个运行副本实际纳入的业务上下文及事件范围。 | runtime 1:N context且同一合法context可被多个重建实例引用，属于材料与副本的真实M:N关系。仅在runtime记最后一个context或摘要无法反查早先材料。 | PK(owner,contact,session,runtime,context)；两端完整真实FK；event_range可空但必须标来历。 |

### 明确表达偏好（3，R6）

| 序号/表 | 一行保存什么 | 为什么独立 | PK/FK与关系 |
| --- | --- | --- | --- |
| 36. `expression_preference` | 一条被明确确认为长期表达偏好的稳定身份及当前版本。 | owner 1:N长期偏好，每条可修改多版；身份与适用范围的版本变化分离。它是用户明确指令，不应塞入模型推断画像或一次回复输入。 | PK(owner,preference_id)；FK owner；current_version完整FK同preference；正文及范围在版本。 |
| 37. `expression_preference_version` | 偏好某次明确确认的正文、适用范围和唯一消息来源。 | preference 1:N version，contact/global及reply_mode可随合法手工修改而变化，不能只放在head随时覆盖。 | PK(owner,preference,version_no)；FK preference、可空contact、来源message；确认operation_key和时间可直接保存本版。；成功保存操作键与确认元数据随版本存；删除走Q42并保留最小重放拒绝键。 |
| 38. `preference_version_source` | 某偏好版本当时采用的各份实际source_record捕获支持。 | 一条源消息可由多次捕获证明，同一版本会实际采用多条source_record，存在1:N；不是版本的一组固定单值属性。 | PK(owner,preference,version,source_contact,record_id)；FK版本及实际source_record；验证该record确实linked到origin message。 |

### 场景与画像（6，R6）

| 序号/表 | 一行保存什么 | 为什么独立 | PK/FK与关系 |
| --- | --- | --- | --- |
| 39. `memory_document` | 同一范围内一个稳定主题或长期画像身份及kind。 | 同范围存在1:N主题和至多一个画像，且每篇文档有多次版本。不是整个联系人一行摘要，也不是普通memory事实。 | PK(owner,document_id)；owner/contact范围真实FK和形状CHECK；kind固定；profile在范围内条件唯一。 |
| 40. `memory_document_version` | 主题或画像某次生成的具体结构版本和真实trace。 | document 1:N version；某次生成尚未发布的版本也不等于当前发布成员，执行与发布不能混为一行。 | PK(owner_id,document_id,version_no)；真实FK到document及产生step_attempt的完整执行键；单父延续直接完整parent_version FK。 |
| 41. `document_block` | 具体文档版本内可定位的主题段落或画像条目及结构类型。 | 一版有N个有序块，块有自己的类型和引用关系；若整篇都塞text/JSON，块级引用与目标就失去真实FK。 | PK(owner,document,version,block_no)；FK具体版本；kind与父document kind匹配；结构普通值可受控JSON，实体引用另表。 |
| 42. `document_block_reference` | 文档具体块显示依据或支持的具体已采纳记忆/文档版本。 | block 0:N references；同一输入可支撑不同块，块与材料之间是真实M:N。不能用trace的全输入关系代替具体块的支持关系。 | PK(owner,document,version,block,reference_no)；FK block，typed FK具体memory_version或document_version；输入必须属于实际trace。 |
| 43. `document_publication` | 某本人或联系人范围一次实际发布的L2/L3配套集合。 | 一轮可产生未发布/部分成功的文档，最终一次发布又选N篇具体文档版本；publication是对外可用集合的业务事实，不等于task状态或某个文档的head。 | PK(owner,publication_id)或完整scope/publication_no；真实范围FK；记录发布基线dirty/settings代次；当前指针同scope。 |
| 44. `document_publication_member` | 一次一致发布中选用某文档的哪一版本及顺序。 | publication N:M document_version，且在同次发布每document只选一版，是实际集合成员关系。把版本ID数组塞JSON会丢FK与范围约束。 | PK(owner,publication,document_id)；FK publication、具体document_version和其scope；同集合画像至多一项。 |

### Skill最小业务关联（2，R7）

| 序号/表 | 一行保存什么 | 为什么独立 | PK/FK与关系 |
| --- | --- | --- | --- |
| 45. `reply_skill` | 一个目录包的稳定业务身份、原目录定位、可证的启停与待核验状态 | 同owner可有多个独立目录包，每包身份和启停会独立变化；不能把包当用户的一组字段，也不能靠目录名猜旧身份 | PK(owner_id,skill_id)；owner FK；当前版本完整FK；安装目录身份受控唯一 |
| 46. `reply_skill_version` | 一个已核验或待核验的具体文件版本锚点、摘要、来源状态 | 一包可被修改多次，旧候选/调用引用的版本不能随当前文件变化。不可变摘要及合法来源是不同于包身份的1:N事实 | PK(owner_id,skill_id,version_no)；FK包；可空真实审核FK仅扩展启用后 |

### 读取边界与授权（4，R8）

| 序号/表 | 一行保存什么 | 为什么独立 | PK/FK与关系 |
| --- | --- | --- | --- |
| 47. `conversation_read_grant` | 一次明确授权读取某已核验绑定的凭证：授权代次、契约版本、受理操作和撤销状态。 | 一条 binding 可先后有多份授权，已捕获来源要回指当时授权；不是 binding 的一个重复 enabled。只在 binding 留当前开关无法表达来源到底依据哪次同意。 | PK(owner_id,grant_id)；完整 contact/binding FK；UNIQUE(owner_id,binding_id,grant_no)；同 binding 至多一份 current active grant；提供 batch 用范围超键。 |
| 48. `conversation_clear_boundary` | 某可信渠道会话在一次清空操作建立的无正文、可核验历史截断边界及适配器契约版本。 | 一个渠道会话可以多次清空，边界被后续读取 episode 与排除规则引用；它不是当前 contact 的一个时间字段。不能依赖已删消息行或当前授权存在。 | PK(owner_id,boundary_id)；同 owner 的 account FK、operation FK；正式会话 identity scheme/key；不 FK 会被删除的 live contact/binding。 |
| 49. `sync_episode` | 一次合法读取流的固定授权与代次、有限目标及当前检查点 | 授权可有多次读取流，一流多页；恢复同意与该次流一一绑定，无须单独授权头再连检查点。 | PK(owner_id,episode_id)；grant/binding/contact/boundary真实FK；batch FK episode，UNIQUE(episode_id,page_no)；开关代次固定在每次batch。 |
| 50. `read_exclusion` | 账号稳定会话中的捕获、消息或整会话读取排除 | 同一渠道命名空间内的有限类型禁止规则可共表；规则有0:N条且须跨contact删除继续阻止旧历史复入。 | PK(owner_id,exclusion_id)；真实account/clear_operation；类型形状和各分支唯一。 |

### 统一删除与复核（3，R8、R9）

| 序号/表 | 一行保存什么 | 为什么独立 | PK/FK与关系 |
| --- | --- | --- | --- |
| 51. `deletion_operation` | 一个已受理删除操作的请求身份、范围快照、计划进度、撤销写入资格和最终结果。 | 一次删除有多个目标且跨数据库与文件系统，不能在普通业务删除事务中原子完成；被删对象消失后操作仍须继续，不能挂在会一起被删的联系人任务上。 | PK(operation_id)；唯一 request_key；已核验的最小范围地址为清理快照，不 FK 将消失的 live owner/contact；不得 UNIQUE(contact_id) 阻止再次清空。 |
| 52. `deletion_target` | 一次删除的行/文件目标进度，或必须长期保留的最小请求封存键 | operation1:N目标；具体存储清理器仍分开。封存键清除正文后按资格保留，不能随短期清理状态回收。 | PK(operation_id,target_no)；operation FK；row/file/sealed_request有限类型；文件预期身份与请求拒绝唯一键；sealed为已完成封存，父操作按拒绝资格保留。 |
| 53. `deletion_verification` | 一次操作在一个存储面/门禁上的复核结果，含计划修订、校验器版本、pass/fail/not_applicable 及有界无正文证明。 | 操作与复核面是 1:N；复核还可能检查不存在于目标表的残留或未停 writer，不能简单当某个 target 的完成时间。分表允许增补明确复核面，不向 operation 增加一串重复状态列。 | PK(operation_id,check_kind) 或加 plan_revision 的历史键；FK deletion_operation；完成判定只取本计划本代次的必要面。 |

### 数据库元数据（1，R10）

| 序号/表 | 一行保存什么 | 为什么独立 | PK/FK与关系 |
| --- | --- | --- | --- |
| 54. `database_instance` | 本数据库实例的随机身份、格式家族、用途角色及建立时点等单例元数据。 | 数据库身份不是 owner 或微信账号身份；一个 owner 可出现在多个隔离测试/业务实例。单例元数据与业务主体不同，单独一张小表比把数据库归属塞进 contact/owner 更清楚。 | 单例 PK(slot) 且 CHECK(slot=1)；UNIQUE(database_id)；role/format 有限枚举；外部预期实例身份与受管根另行校验。；当前schema位置可存本表或PRAGMA，是否另建迁移历史未定。 |

## 具体哪些合并，合并后仍保存什么

| 原候选 | 工作清单中的位置 | 原因与必须保留的边界 |
| --- | --- | --- |
| account_sync_control | channel_account字段 | 严格一账号一份当前控制；读取总开关、范围、read_switch_generation仍为不同字段。 |
| contact_data_control | contact字段 | 严格一联系人一份当前数据资格；硬撤销代次与来源局部修订分开。 |
| owner_collection_state、document_collection、processing_scope | owner/contact的不同控制字段 | 不造多个1:1范围壳；memory、preference、Skill、document revision各有含义，不能合成一个版本号。 |
| processing_round | background_task | task就是一个固定范围的一轮完整管线；run仍是一次点击，step仍是真实阶段/小批次。 |
| processing_receipt | processing_input的target结果 | 不维护两份成功状态；保留产生执行/阻塞request，已处理证明不能先被任务修剪。 |
| memory_trace | step_attempt追踪头字段 | 只消除1:1重复头；完整输入、输出、事件及敏感清除状态继续保存。 |
| candidate_evidence＋memory_version_evidence | claim_evidence | 相同片段证据粒度，父FK二选一；不能只剩摘要。 |
| 两种required_message | claim_required_message | 相同主张-消息依赖；AND依赖与捕获OR分层，不能并进展示引句。 |
| 三种trace输入＋document输入 | trace_input | 只统一同一执行的typed输入关系；Q43跨用途共享仍未选。 |
| step_model_call＋assistant_attempt_model_call | model_call的真实producer FK | 一次物理call只能属于一个执行；没有M:N，不再建两份1:1归属表。 |
| reply_candidate_segment | version_message的固定segment_no | 只有位置映射时无独立属性；如支持跨版增删重排/独立段身份则重新审查。 |
| expression_preference_operation | 版本确认字段＋删除账本/封存 | 保存即新版本；删除不用假正文版本；同键异输入冲突、旧保存重放仍须拒绝。 |
| skill_use | 相应用途的实际输入项 | 具体Skill版本、使用角色及时间点在实际输入关系表达；selected/读取/模型自报不混，不能推断已发送。 |
| deletion_row_target＋deletion_file_target | deletion_target | 同一操作的目标进度共表，row/file有严格分支；各领域清理器和文件身份核验不省。 |
| assistant_request_tombstone | deletion_target的长期sealed_request分支 | 保留拒绝键与索引；sealed分支不等待擦除，父操作不普通剪枝/级联；完成不释放重放封锁。若合同不满足，恢复专表。 |
| ingestion_tombstone＋conversation_exclusion | read_exclusion | 同账号稳定会话命名空间内的有限排除类型；整会话、消息、捕获不能互相替代。 |
| history_restore_authorization＋sync_checkpoint | sync_episode | 一次明确恢复对应固定grant/data代次与有限目标；读取开关代次在每batch固定，原流可合法续读，旧batch不能刷新代次；不变长期恢复许可。 |

step_attempt_guard暂时保留：它可能表达多个当轮联系人原始资格快照，不能只凭“沿输入应该能推导”就省掉。待证明完整依赖推导、删除后fail closed和重试不刷新旧资格，才考虑视图替代。

## 哪些尚不应默认纳入

以下为**32项原候选的范围/必要性待定**，不是另外32张已决定要建的表。若纳入某能力，仍要按该能力内部真实粒度合并或派生；不意味着本轮授权删掉既有功能。

| 原候选 | 何时才需要、怎样落地 | 不纳入或合并的取舍 |
| --- | --- | --- |
| `manual_contact_confirmation` | 助手不能把未核验的前台名称当联系人，也不能为手动确认伪造 conversation_binding；一次有效手动确认可服务多轮请求。后一基数需实现前在产品入口核实。；单次确认默认并入 assistant_turn 的正式确认字段；确有跨多轮复用才独立。确认是安全需求，独立表不是天然需求。如果每次请求都重新确认，turn 上正式保存 origin=manual、confirmed_contact_id、confirmed_at、客户端/进程与接受代次即可；不能伪造 binding ID。只有实际确认 1:N turn、可被单独撤销的复用凭证，才保留独立表。旧消费者的复用方式只能作查漏，不能替用户确认新入口合同。 | 单次方案接受后仍须复验当前 contact/data/binding 资格，不能靠一份永久确认跳过身份冲突；复用方案还须明确确认失效和重新打开后的再次选择规则。 本项不改变前台再次确认或已核验绑定规则；需先核验真实入口是否跨turn复用，不能为了免表改成每次都让用户确认。 |
| `schema_migration` | 需要可靠结构版本管理；逐脚本历史、分支迁移或逐次校验和审计尚未成为明确需求。；默认可由 database_metadata 当前版本或 PRAGMA user_version 承担版本位置。空库重建加单一有序迁移链可用一个当前版本和事务升级保证，不必为了照搬旧迁移器增加历史表。只有需要逐脚本一致性校验/迁移审计，才有 1:N 历史事实值得独立。 | 采用仅当前版本会放弃逐脚本运行历史，应在实施前明确是否需要；无论选择哪种，版本未知/较新时拒绝误初始化，绝不自动清库。 user_version 不保存失败、时间或逐文件校验信息，不能宣称与完整迁移账本等价；具体升级策略仍待定。 |
| `memory_version_parent` | Q37只确认追加恢复版本及保留来历；没有单独确认任意多父、跨memory合并图。；普通前序与恢复来源先存memory_version的完整自FK；确认多父合并后才建立本表。。普通修改至多一个前序，恢复再有一个明确恢复来源，两组完整版本FK即可表达。只有确需一个结果依赖任意N个父版本时，1:N父边才是独立关系；不能把草案中的多父能力当已确认需求。 | 不建不影响Q37；暂不支持未经确认的多父版本合并。若业务确认该能力，必须保留父边、正文依赖与来源资格的区别，不能把来源消息塞入父边。 |
| `processing_operation` | 暂停与继续须防陈旧请求改变新状态；旧PG有操作账本，但用户未单独确认历史控制动作回放/审计需求。；默认先由processing_run的start_operation_id + intent_revision CAS及实际执行记录承载安全语义。。启动重放可用run唯一start键，暂停/继续携expected intent_revision做CAS可安全拒绝重复或陈旧动作；只有要求任意历史operation_id重放返回原响应、或可回看每次控制操作时，才需要独立1:N操作账本。 | CAS失败不能默认为执行成功，客户端需读当前状态。未知调用、取消/删除硬失效仍由固定task/实际call规则保护，不能靠清operation状态重发。 |
| `document_version_parent` | 普通文档版本延续已需要；任意多父、跨主题拆分/合并历史尚未由用户确认必须保存为独立图。；单父延续放memory_document_version.parent_version_no；完整旧文档参与输入放trace_input。只有真实多父/跨文档语义来历及可查询合并拆分操作，才产生必须独立的N:M边。完整输入追踪已经保存实际看过的旧版本，不能把所有输入重复叫语义parent。 | 本轮不默认建立多父图；没有该图仍保留实际输入和单父版本来历。以后若要求恢复拆分/合并关系，再建立而非藏JSON。 |
| `trace_feedback_input` | 如果纳入持续纠错保护，必须记录当次实际采用哪项反馈，不能把反馈仅藏在提示词。；启用反馈时合入trace_input的feedback typed FK分支。复杂持久反馈能力未获独立批准；若采用，仍与其他trace输入同一粒度，不需要专用输入表。 | 不建专表不代表可漏掉实际反馈输入；若组织反馈本轮不纳入，此分支也无需先占位建表。 |
| `organization_feedback` | 用户需能纠正及删除资料；纠错以后自动处理是否持续抑制相同错误、如何退役保护，是比单次修改更强的能力，尚需确认。；只做一次裁决用memory_decision；需要持续保护实体时单独organization_feedback。持续保护有当前有效/撤销状态、目标与有效输入窗口，可能跨多轮执行；它不同于append-only的一次memory_decision动作。不能仅为减表把两者塞成宽操作表，也不能从旧消费者推定此复杂能力必保留。 | 本轮先保留基本查看/修正/删除路径，持续反馈保护列为范围待确认；若最终保留，应独立追踪与来源清理。 |
| `organization_feedback_input` | 若启用持续保护，必须限定什么输入上的错误不能再现，不能变成全局文本黑名单或永久偏好。；organization_feedback启用后保留本关系；不得用正文哈希替代。一个反馈保护窗口可含N个材料，且需随来源与修订变化失效，具有独立多值关系。若没有持续反馈实体，本轮不单独建这张表。 | 若Q43以后统一材料关系可再比较；当前不能为预期的未来能力先建占位空表。 |
| `quality_run` | 自动化评估/诊断的历史保存是否属于正式产品必保留功能，用户尚未明确；旧代码有消费者仅说明可能遗漏，不构成需求批准。；若仅开发测试则使用测试资产/临时结果；正式产品确需持久评估再纳入业务库。若需同一数据集多次运行并比较，有独立运行粒度；但不能为了保留旧诊断存储，把它算作本轮必需业务表。 | 不以移到另一个生产数据库隐藏数量；在用户未确认评估产品功能前不默认建。 |
| `quality_case` | 只有用户需要持久数据集及跨次重评时，才需要稳定案例身份；尚未纳入当前明确需求。；正式评估数据集获确认后再建；纯合成测试用仓库测试资产。一个案例可被多次run/attempt使用时具有独立身份，不能简单当call日志；但旧消费者不证明真实用户库必须保存它。 | 冻结人工标注也有来源和删除责任；仅当前请求临时诊断无需案例库。 |
| `quality_attempt` | 仅在持久质量运行获确认时需要；物理模型调用仍必须准确记账。；正式评估获确认后建执行记录并复用model_call。run/case可各有N次实际尝试，业务评分及人工审阅不完全是model_call属性；该能力本轮不能凭旧结构自动加入。 | 不能复制模型调用账、租约或完整实际输入多份；不启用质量功能时不先造空表。 |
| `quality_fact_intent` | 基本资料纠错已由memory_decision及可能的组织反馈负责；没有确认需要独立诊断纠错闭环。；若与普通纠错同一事实，复用memory_decision/organization_feedback并加真实quality_case/attempt关联；否则再证明独立实体。“来源是诊断界面”不是新的业务实体理由。只有有独立生命周期和多次履行关系的纠错意图才值得单独建表。 | 四张旧诊断表不是四条已批准需求；此项随正式质量功能范围一起决定，不先默认保留。 |
| `reply_method` | 仅方法级独立停用、跨包复用或继承需要；Q41未确认方法平台纳入本次；—。普通目录包加载只需包和文件版本；方法身份只有需单独被引用/迁移/设政策时才是业务实体 | 不纳入不影响DSH按文件读取说明；若保留方法级业务能力，不能用名称代替稳定身份 |
| `skill_version_method` | 依赖方法级实体与多版本成员关系，当前属扩展范围；—。若一个方法跨多个包版本复用，版本与方法才构成M:N；若只是文件中的段落，DB不另建成员目录 | 仅在方法平台纳入时建；正文仍文件权威 |
| `skill_method_parent` | 方法级停用需要跨继承保留时才需；未被Q41一并批准；—。只有多父祖先图才需要边表；普通单父延续可在方法或版本放一个parent FK | 不能以少表把多父ID放JSON；先确认是否有多父合并和继承需求 |
| `skill_parent` | 跨包合并、继承停用政策属于旧能力查漏，尚未定为新库基础范围；—。目录加载和当前启停不需要包祖先图；确认多父合并才独立存M:N边，普通版本延续无需此表 | 若保留祖先政策，不能省边导致通过合并绕过停用；未纳入前不默认开放合并 |
| `skill_scope_policy` | Q41需保留可证启停，但不等于批准联系人/场景/方法三级政策；—。整包当前启停放reply_skill足够；同一包对多个范围有独立规则，才有0:N政策事实 | 不允许把未知旧政策猜成允许；细粒度范围若保留，必须独立复验，不被全局enabled代替 |
| `skill_policy_operation` | 仅在细粒度政策纳入且需保留可重试控制动作时需要；skill_operation（条件替代）。同Skill领域的安装/政策/学习许可动作可以共用有限kind操作账本；政策本身与操作历史仍分开。只有当前CAS启停时，不为一对一状态新建动作表 | 共享仅限同领域明确操作合同，不建立任意entity_type/id总日志；旧启用动作不得覆盖新停用 |
| `skill_use_method` | 仅方法级实际使用追踪纳入后需要，普通Skill版本引用不要求；—。若需要列出真正使用的多个方法，是使用与版本成员的0:N关系；若模型只自报方法名，不应当作已验证调用事实落表 | 精确区分允许、读取、模型报告；没有方法级需求就不建 |
| `skill_learning_scope` | 学习是独立授权，不能由同步/记忆处理授权推得；本次是否接回学习能力未确认；contact中的独立学习授权字段（如需历史再用授权记录）。若只是每联系人唯一一份当前enabled/revision，可并contact；授权语义独立不等于必须独立表。若需多份许可/不可变历史才再拆 | 不纳入学习时没有隐式授权；纳入后开关默认关闭，撤销立即失效 |
| `skill_learning_operation` | 仅学习能力与可重试授权控制纳入后需要；skill_operation（条件替代）。与政策/目录操作同领域控制回执可共有限类型表，无须每种按钮一张表；当前许可仍在独立语义字段 | 必须保留旧启用重放拒绝；不是把同步许可转成学习许可 |
| `skill_learning_batch` | 仅已授权经验学习纳入后需要；background_task_step的skill_learning类型；学习结果指向真实草稿版本。若一个batch恰是一项固定输入step，重复batch身份/状态没有新事实；只有业务batch需跨多step独立归属时才另建batch头 | 不能给学习伪造记忆round或assistant_turn；统一执行需正式支持该kind |
| `skill_learning_input` | 仅学习能力纳入后必须有真实材料关系；本次Q43不作选择；用途专用输入表；共享材料方案待Q43。一个工作单元可有多种多份真实材料，是0:N输入关系；不能从当前候选/联系人重算历史。是否结构共用另议 | 不按内容hash跨范围共权限；可靠后续聊天不能由复制候选推断发送 |
| `skill_learning_receipt` | 仅学习纳入且要求跨启动不重复消费时需要；—。学习组合材料与单message消费粒度不同，不能未定义单位就并processing_receipt；确认组合消费合同才独立建或正式扩展公共receipt | 组合材料ID不可只是无FK字符串；若只有幂等step重试，可复用执行结果，不必额外全局receipt |
| `skill_draft` | 仅纳入经验学习/人工草稿审核流程后需要；—。同草稿会被反复编辑并多次审核，身份与0:N内容修订分离有意义；Q41保留目录不要求重建草稿流程 | 草稿不是可加载的已发布Skill，不能因复用版本表而提前启用 |
| `skill_draft_version` | 仅草稿流程纳入后需要；—。多版草稿及审核冻结需要不可变版本；私人依据与发布文件的生命周期不同，不能并已发布版本伪造发布 | 私人依据受来源删除；只有清洗策略可获批发布，不把原聊天塞Skill正文 |
| `skill_draft_target` | 仅更新/多目标合并草稿纳入后需要；—。一个草稿可针对N个目标，目标是可复验关系；若只新建独立包，没有目标无需此表 | 不存target_versions JSON；后续审核可以沿不可变草稿关系读取，无需再复制 |
| `skill_review` | 双侧审核/人工批准属于未确定纳入的扩展范围；—。一次审核可产生多侧结果和多次执行，业务审核不等于物理调用；若保留该产品能力有独立实体价值 | 目录已有文件不代表历史审核通过；新用户输入审核不能伪造assistant_turn |
| `skill_review_input` | 只有双侧审核纳入才需要；Q43仍未选；用途专用审核输入表；可否共享材料待Q43。审核需要独立冻结的0:N材料，不可默认继承某次旧回复输入或读取当前内容 | 共同上下文只冻结一次，两侧引用同份；精确来源删除仍穿透审核和文件 |
| `skill_review_side` | 仅双侧比较流程纳入后需要；—。同一review有before/after等多侧，是1:N，不能把结果列无限加在review或用数组藏执行引用 | before无Skill与published/draft分支严格区分；失败/unknown不能当可批准比较 |
| `skill_catalog_operation` | Q41当前要求保留目录和最小接回；完整受管写目录流程是否纳入待定；skill_operation（条件替代）。纯目录核验/映射只需稳定包身份、版本锚点和CAS；若App执行跨文件发布/回滚，则需要可恢复操作账本，可与同领域政策/授权动作共有限kind | 不把数据库事务当文件原子事务；保留原目录不授权自动改写文件 |
| `skill_worktree_projection` | 只有确认需要App回写目录/崩溃恢复才存在，本次Q41不要求；background_task_step（file_projection）与deletion_file_target等文件账目。一次投影若就是一个恢复步骤，不另造相同任务状态头；有多个文件时用已有typed文件目标明细；用户目录不能变成App可随意覆盖的投影 | 必须发现并发用户修改并停止覆盖；不能以减少表替代所需文件身份及恢复信息 |

## 建议不单独建的4项

| 原候选 | 建议与理由 | 不丢失什么 |
| --- | --- | --- |
| `overview_projection` | 本轮读取合法底层资料时计算；有性能或跨请求稳定快照需求再提缓存；概览不增加新的业务事实，旧built_at/revision API字段不能单独证明必须独立建表。先明确其时点语义并直接计算，避免将旧缓存结构当需求。 | 这是新库初始不建缓存的设计提议，不是未经测量宣称性能更好；上线前用实际负载验证读取成本。 |
| `overview_projection_member` | 按读取时合法查询返回定位；依附overview_projection的条件缓存方案；父缓存不建时，成员表也无独立事实或生命周期。不能为了保留旧接口字段而先存一份额外的所有材料清单。 | 若概览被实际输入模型，其实际材料必须进入相应context/trace；这条删除依赖不能因无缓存而省略。 |
| `skill_review_target` | 从skill_review.draft_id/revision → skill_draft_target派生；审核已固定草稿修订，目标集合相同，重复存储产生两份可不一致事实；无须独立成表 | 若未来允许审核另选目标集合，则出现新事实，必须重新建模；不默许扩大审核范围 |
| `skill_review_result_call` | 沿skill_review_side.result_attempt → model_call的执行FK派生；call已有唯一真实执行归属，若侧就是执行结果，重复列一份调用链无新事实；调用的实际输入/输出仍在call和完整事件中 | 若业务需要表达“只消费其中几次调用”的独立选择，再建立精确结果依赖边，不能直接把所有attempt调用等同采纳证据 |

“不独立建表”不等于删除数据需求：review_target与result_call来自已存在的真实关系；overview两表是暂不预建的派生缓存，不是把记忆、文档或导航功能删除。若真实时点合同要求固定概览，应先证明并修订方案。

## 关系如何闭合

- owner → account/contact；account＋已核验会话 → binding；binding 1:N read_grant；grant 1:N sync_episode；episode 1:N source_batch（每batch固定当次读取代次，不刷新旧批次；已提交来源不会因同步关而失去记忆处理资格）；batch 1:N source_record；record N:1 message且未核验可为空。
- run 1:N固定task；task N:M message由processing_input表达；task 1:N step；step 1:N attempt；attempt 1:N完整事件、实际输入与门禁。model_request 1:N实际call，call恰有一个真实执行归属。
- memory 1:N version；候选/版本 N:M消息的必需依赖和0:N片段证据分别保存；单父延续和恢复自FK不伪装多父合并。
- session 1:N turn，turn 0:N attempt；attempt 0:N candidate；candidate 1:N version 1:N逐条消息；selection精确选版本。实际context 1:N item，候选展示引用只是其子集；删除检查所有实际依赖。
- document 1:N version 1:N block；publication N:M具体document_version，保证同次可用L2/L3配套；块引用指具体合法输入版本。
- deletion_operation 1:N target与verification；复核包含DB、WAL/运行文件/缓存等实际存储面，不能把SQL行已删当全部完成。删除地址与封存键在live对象删除后仍需存活，因此不是普通可级联live FK。

## 仍要验证的物理合同

当前只有逐项设计审查，不是完整54表DDL。typed FK分支、NULL形状、范围触发器、唯一性、不可变约束、所有实际生产者、完整删除闭包和事务边界仍须逐一落为DDL/接口并用合成数据验证。

尤其需要先闭合手动确认复用方式、处理结果保留期限、封存键生命周期、候选段身份合同与RX范围。CLI可靠消息身份和精确历史清空边界也仍未证，不能拿字段、local_id、秒级时间或raw隔离作为替代证明。

此前11/11 SQLite代表性能力探针仍有效，但不是本清单的全量DDL/业务/性能验证。未建库、迁移、删真实资料、扫描Skill目录、修改业务代码或操作App。物理技术研究见[原入口](physical-schema-plan.md)，旧PG[历史覆盖](physical-coverage.md)仅供查漏。

Q43保持未决：先审本文基础事实、合并前提与扩展范围，再讨论材料是否共表。
