# 确定助手会话、候选和依赖记录的关系模型

Triage: ready-for-agent
State: resolved
Type: grilling
Map: [SQLite 数据库重建设计决策地图](../map.md)
Blocked by: 04

## Question

用户可见助手历史、输入、候选及版本、选择和编辑、上下文依赖、DSH 运行关联与库外文件分别如何建模？如何保留真实外键、版本归属和来源删除路径？

## 已有输入

- [schema-plan.md](../schema-plan.md)
- [048_assistant_sessions.sql](../../../backend-ts/database/migrations/048_assistant_sessions.sql)
- [117_persistent_assistant_runtime.sql](../../../backend-ts/database/migrations/117_persistent_assistant_runtime.sql)
- [assistant-runtime.ts](../../../backend-ts/src/reply/runtime/assistant-runtime.ts)
- [assistant-runtime-erasure.ts](../../../backend-ts/src/reply/runtime/assistant-runtime-erasure.ts)

## 完成条件

确定业务记录与运行文件的权威边界、实体及版本、来源引用和删除／恢复合同；涉及 DSH API 先按源码查证工作流核验，不假定已能移入 SQLite，也不改变人工发送边界。

## Proposal：业务讨论、版本草稿、实际上下文与运行副本

本轮仍是设计讨论，未建库。以下键均带 owner/contact 完整范围；内部 ID 为 TEXT，系统时间为 INTEGER 毫秒。Q39 已确认原稿与手工编辑稿统一存入候选版本结构，不把该决定等同于所有字段和物理约束均已定稿。

### 已查证边界

- `048:18–39`、`051:7–35` 与 `007:3–41` 当前把 generation 输入、turn、逻辑 reply_request 分为多层一对一；它们可收敛为一条逻辑 assistant_turn，真正独立的执行由 0:N attempt 承接。
- `053:10–40,125–126` 的原版正文在 reply_candidate，v0 是无正文引用，编辑版另存正文；Q39 已确认统一版本正文，消除特殊读取分支。
- `assistant-discussion-service.ts:507–563` 当前候选编辑是纯用户编辑，不调模型；模型改写是新生成轮次。编辑须保留原消息组的稳定消息身份、数量和顺序，沿现行合同 1–8 条，不以本草稿扩张编辑能力。
- `CONTEXT.md:227–248`：助手历史与真实外部聊天、关系事实各有身份；复制、回看、编辑不代表显式选择或已发送。助手讨论不自动进入长期记忆。
- [运行边界研究](../../../research/sqlite-assistant-runtime-boundary.md)已核对声明、锁、实际包及固定源码：DSH/session/persistence/jsonl/agent-loop 为 0.2.1-rc.2，Cordis 4.0.5；固定参考 commit 687f282e8625c6b8d11ff58211a90524be2e4317，未证明 npm 制品与源码可复现等价。正式助手仍显式使用官方 JsonlPersistence；公开存储接口无 delete，不宣称业务 SQLite 已接管 SDK 文件或事务。

### 1. assistant_session：一个联系人下的业务讨论

| 字段 | 含义／约束 |
| --- | --- |
| `owner_id, contact_id, session_id` | 复合主键；真实 FK 到 contact。 |
| `is_current` | owner/contact 内条件唯一。回看不改变它，明确继续或新开才改变。 |
| `current_turn_id` | 可空；完整范围 FK 到本 session 的 assistant_turn。 |
| `current_selection_no` | 可空；完整范围 FK 到本 session 的 selection。 |
| `current_runtime_id` | 可空；完整范围 FK 到本 session 的 runtime_instance。 |
| `head_revision` | 当前指针及用户操作的 CAS；不能与删除撤销代次混同。 |
| `erasure_generation, deletion_state` | 使旧生成和运行写入失效；与 08 的删除控制正式闭合。 |
| `created_at, last_user_activity_at` | 建立时间和真实用户动作时间；不能用通用 updated_at 代替活跃时间。 |

联系人 1:N session；每位联系人至多一个 current session。保留现行空闲分段、显式继续和不自动摘要／截断合同，本项不重新讨论界面策略。当前输入／选择被清理时置空，不自动回退旧值。循环指针采用有明确事务顺序的 NO ACTION 或延迟 FK，不能对复合 FK 笼统 SET NULL 而把 owner/contact 一起清空。

### 2. assistant_turn：一次明确提交的输入及其逻辑处理

| 字段 | 含义／约束 |
| --- | --- |
| `owner_id, contact_id, session_id, turn_id` | 复合主键；session FK。 |
| `turn_no` | session 内 UNIQUE，保存讨论顺序；不冒充微信消息顺序。 |
| `kind` | generation／response_exploration／purpose_exploration／candidate_carry。 |
| `operation_key, submitted_digest` | owner/contact 内 key 唯一；同键不同提交返回冲突。 |
| `requested_session_id` | 可空的同联系人 session FK，保存原请求地址；实际 session_id 是已受理的归属。 |
| `scope_origin, binding_id, binding_revision_at_accept` | 区分已验证绑定与用户明确手动联系人确认；绑定模式真实 FK 到同 owner/contact 的 binding，手动模式不伪造 binding。 |
| `input_payload, response_payload` | 输入只保存一次，区分本人草稿、用户粘贴当前聊天、表达方向及补充要求；粘贴方向保留用户声明来历，不冒充渠道消息或记忆。非引用的结构化值用受控格式，候选正文不再复制进 response。 |
| `state, content_state, reason_code` | 准备／排队／执行／完成／失败／中断与正文可用／擦除分别表达。 |
| `execution_generation, current_attempt_no` | 撤销在途执行及指向本 turn 的真实 attempt。 |
| `origin_session_id, origin_candidate_id, origin_version_no, origin_selection_no` | candidate_carry 时完整且匹配的真实候选版本与 selection FK；其他 kind 按形状约束。 |
| `created_at, accepted_at, completed_at, erased_at` | 明确时间，擦除同时清输入、响应、摘要等敏感值。 |

input_version_id 不再额外制造一套等价身份；turn_id 就是这份不可原地修改的已提交输入身份。用户改要求或明确重新生成建立新 turn，网络同键重放返回原受理决定；不得因重放时空闲超时而重新选 session 或回退 current_turn。

candidate_carry 可以没有模型 attempt。携入时核验同 contact 的当前显式 selection，两个 FK 以包含 candidate/version 的候选键保证选择匹配；其余 origin turn/request 可沿关系推导，不再在 JSON 重复十个可变 ID。候选继续按实际显式输入固定版本，不以复制动作推断选择。

### 3. assistant_attempt：短请求的一次真实执行

字段：`owner_id,contact_id,session_id,turn_id,attempt_no` 为主键；`worker_id,process_epoch,lease_generation,lease_expires_at,state,reason_code,started_at,finished_at`，真实 FK 到 turn。

turn 0:N attempt，同 turn 租约代次单调；仅准备但未启动的输入不伪造执行。跨联系人任务保持原归属，切换界面不重新分配结果。结果只能提交原 turn；current_turn 已前进不等于旧结果可把指针退回。取消／删除检查独立硬代次、租约和上下文资格，不能把纯导航 head_revision 当作全部业务许可。

未提交的中断不自动重发模型，旧操作键封存及删除抑制沿 08 统一。短回复不为了统一形式强塞进 background_task/step；复用 05 的 model_request/model_call 物理调用事实。

### 4. reply_candidate：生成出的一个稳定候选身份

字段：`owner_id,contact_id,session_id,candidate_id` 为主键；`origin_turn_id,origin_attempt_no,ordinal,created_at`。

FK 到同 session 的真实 assistant_attempt；UNIQUE(owner,contact,session,origin_turn,ordinal)。一轮可有多个候选，实际候选数量按既有输出合同；ordinal 是备选展示顺序。候选不重复保存正文、当前编辑正文或 source_ids。

### 5. reply_candidate_version：候选正文的一次保存版本

| 字段 | 含义／约束 |
| --- | --- |
| `owner_id,contact_id,session_id,candidate_id,version_no` | 复合主键，version_no 从 1 开始。 |
| `parent_version_no` | 可空，真实 FK 到同候选的版本；编辑父号小于新号。 |
| `origin_kind` | generated／user_edit；模型重新生成产生新 turn/candidate，不冒充用户手改。 |
| `edit_operation_key, edit_digest` | 用户编辑幂等，非空时候选内唯一；同键不同内容冲突。 |
| `requirements, rationale, risk_notes` | 有定义的非引用值；模型原版的生成依据不被编辑版冒称为已重新核验的结论。 |
| `content_state, qualification_state, created_at, erased_at` | 正文保留和当前可用资格分开。 |

第一版与编辑版使用同一正文结构；generated 首版无 parent，user_edit 必须有合法父版。版本号不同于前项 memory_version：这里记录待发送草稿的变化，不是长期事实变化。正文普通更新不可覆盖，真实删除按闭包清理全部编辑／携入副本。

### 6–7. 候选消息组：稳定段身份与每版正文

| 表 | 字段与键 | 关系 |
| --- | --- | --- |
| `reply_candidate_segment` | PK owner/contact/session/candidate/segment_id；`position` 在 candidate 内唯一 | 真实 FK candidate；稳定的候选内消息身份和顺序，不是微信 message_id。 |
| `reply_candidate_version_message` | PK owner/contact/session/candidate/version_no/segment_id；`text_content` | 分别真实 FK 同 candidate 的 version 和 segment；不重复保存 position 或拼接后的整组正文。 |

显示整组正文由各段按 position 组装，避免整组 JSON、拼接 text、逐段 text 三份可改正文。沿现行规则每版必须覆盖相同的 1–8 个 segment，不增删重排；跨行完整性由事务／触发器及提交校验保证，普通 CHECK 不足。擦除需清全部段正文而不只改版本状态；是否保留空壳按删除范围决定。

### 8. assistant_selection：一次显式选择事实

字段：`owner_id,contact_id,session_id,selection_no` 为主键；`selection_key,candidate_id,version_no,created_at`。selection_key 在 session 内唯一。

完整范围 FK 到具体候选版本；提供包含 candidate/version 的唯一超键供携入核对。session.current_selection_no 指向实际选择，不另复制 is_current 标志。编辑、默认展示、复制均不产生假选择；没有 sent/sent_at 字段，产品最终消息仍由用户手动发送。

### 9. assistant_context_snapshot：一次实际构造的有界上下文

字段：`owner_id,contact_id,session_id,context_id` 为主键；`context_kind,turn_id,attempt_no,context_no,contract_version,payload,material_digest,content_state,created_at,erased_at`。

context_kind 区分 request 与 runtime_rebuild；request 必须真实 FK 到本 session 的 attempt，重建可不挂伪造 attempt。一次查询循环可构造多个不可原地改写的 snapshot，实际序列化载荷保存为敏感快照，是否已发送／收到响应由 call 账目证明。实体 ID 与来源关系不能只藏在 payload。

### 10. assistant_context_item：带真实类型外键的材料条目

主键：`owner_id,contact_id,session_id,context_id,item_no`；必填 context FK。共同字段包括 `item_kind,use_role,qualification_rule_version,digest_at_capture` 及有定义的片段位置。

| kind | 实际引用字段 | 外键与边界 |
| --- | --- | --- |
| user_input | `input_turn_id,input_component` | 真实 FK 到本次 turn 的不可变用户输入，component 限定草稿／粘贴当前聊天／表达方向等已定义字段；保留用户声明身份，不伪造 message。它引用输入侧，不能借此读取本轮尚未形成的输出。 |
| message | `message_id` | 同 owner/contact 的 message。非文字至多遵守占位合同，不取媒体或猜内容。 |
| source_record | `source_contact_id,record_id,supports_item_no` | 真实 source_record；自 FK 到本 context 的实际消息或本人记忆材料，记录捕获支持，不声称原始记录已作为模型正文发送。 |
| memory_version | `memory_id,memory_version_no` | 同 owner 的具体 memory_version；只允许当前联系人或合法本人范围。 |
| memory_candidate | `memory_candidate_id` | FK 到同 owner、同原联系人 memory_candidate 的范围超键；回复检索按既有规则保留待确认／核验属性，不冒充已采纳记忆或 reply_candidate_version。 |
| assistant_turn | `history_session_id,history_turn_id` | 同 contact 的实际历史 turn；新 session 不借此自动带入旧讨论。 |
| candidate_version | `candidate_session_id,candidate_id,candidate_version_no` | 同 contact 的具体候选版本，保存实际继续／显示所用的版本。 |

这是一种有固定类型集合的关系条目，不是 entity_type + 任意 entity_id：各引用有独立明确字段及真实 FK；形状 CHECK 要求恰好一类引用完整非空，其余为空。跨表范围、上下文实际内容匹配、supports_item 类型、时序和语义资格仍由触发器／事务核验。当前任务只定义这些已知材料，07 补上文档／偏好／Skill 的真实版本合同，不能声称当前已覆盖全部输入。

source_record 跨 contact 只可经本 context 合法本人 memory_version 的真实支持路径，不开放其他人原始聊天窗口。材料摘要不是资格证明；FK 存在也不代表仍有效。历史依赖须向先前 turn／version，不得建立循环；携入和手改继续继承原来源，不能成为独立手录事实。

### 11. candidate_version_citation：候选显示依据的具体定位

字段：PK owner/contact/session/candidate/version_no/citation_no；`segment_id` 可空，`context_id,item_no,citation_role` 及必要片段范围。

真实 FK 到候选版本、可选同候选 segment，以及具体 context_item；该 context 必须属于候选真实生成 attempt 或合法继承路径。全输入依赖用于删除，citation 是展示／支持定位，两者不能互相替代。手改版不能仅复制原 citation 就宣称对新措辞重新核验；若显示原依据，需保留其原版归属。

### 12. assistant_attempt_model_call：短请求与共享调用账目

字段：`owner_id,call_id` 为主键且 FK model_call；另有 `contact_id,session_id,turn_id,attempt_no,context_id,invocation_slot`。到 assistant_attempt 的 FK 不包含 slot；到 context_snapshot 的完整范围 FK 包含 turn/attempt/context，保证本次实际请求快照属于同 attempt。一个物理 call 固定一份最终有界输入快照，其他检索中间快照通过实际调用链追溯，不凭摘要猜；同 attempt 的调用槽唯一，一个 call 不能同时归属不同执行或两个领域。

复用 05 的 model_request/model_call；逻辑请求记录 owner/contact 或本人业务范围，不绑定记忆处理的 run/pause。助手门禁依据本次回复确认、删除及输入资格，不要求当前同步勾选或记忆处理正在运行。同一物理 call 跨 step_model_call 与本关联的互斥需触发器／统一预约事务验证。

只有当前有效 attempt 可以原子提交 turn 结果、候选首版／段／依据和上下文；迟到结果可结算原 call，但不得复活被取消或删除的轮次。已完成重放返回已有结果，同键异输入冲突，unknown 不盲重发、不退款或清累计。

### 13–14. 运行实例与其材料关联

| 表 | 字段与键 | 关系／用途 |
| --- | --- | --- |
| `assistant_runtime_instance` | PK owner/contact/session/runtime_id；`configuration_digest,origin,state,writer_generation,committed_turn_id,committed_event_count,committed_event_digest,qualification_rule_version,managed_locator,created_at,retired_at` | FK session、可空同 session 已提交 turn。session 1:N 实例，current_runtime_id 只能指本 session；runtime_id 就是实际 DSH UUID，另加全局 UNIQUE。 |
| `assistant_runtime_context` | PK owner/contact/session/runtime_id/context_id；可空 `event_range`、`projection_origin` | 两端真实 FK，保存实际纳入运行副本的 context；业务重建也要有真实材料清单，不能只保存一个资格哈希。未作为 SDK 事件写入的伴随业务材料 event_range 为空，不伪造事件位置。 |

映射及实例目录保留可靠 owner/contact/session 身份；managed_locator 限受管根下的已核验定位，不接受任意绝对路径。新建实例不授权无限保留旧副本，删除或失效处理必须覆盖当前和旧实例及同业务会话目录中的遗留文件。

state 至少区分 dirty／ready／blocked／erase_requested。业务 SQLite 提交与 JSONL 写入不是同一原子事务。generated 路径先保存业务结果，释放／flush 运行写入，再核对同 session 真实已提交 turn、配置、材料资格、事件数量与摘要，最后置 ready。business_bootstrap/rebuild 可令 committed_turn_id=NULL，凭合法业务 snapshot、资格及实际文件 seal 就绪；不伪造 turn 或 SDK 事件。中断／不一致继续 dirty 或 blocked，不用文件补造未提交候选。业务引用重建不冒充真实 SDK 轮次、外部聊天或长期记忆。

运行恢复是现有受管文件能力，不宣称已能把 DSH 文件移入 SQLite。必要时按当前有效业务资料重建，不能从旧日志恢复已删正文；关闭／dispose 也不等于删除文件。实际公开接口、当前接线与验证限制见研究。

### 删除、失效与库外目标

- 在接受删除的短事务内先持久化删除意图、推进硬门禁并捕获完整上下文、历史引用、候选父版／携入闭包、runtime_context 及目录目标，阻止新的 writer／正文提交；事务外停止并排空旧写入者，再清业务正文与受管副本并验证。不能等 drain 后才撤销许可，也不能先 CASCADE 丢掉反查边。
- 来源或记忆只是失效／过期时，有合法来源的历史可按现行规则回看，但不可再进入生成，运行材料须禁用或安全重建。真实删除清所有受影响输入、上下文、候选版本／段、携入、运行副本及恢复副本；手工编辑不豁免。
- 当前 turn／selection 被清理时置空，不回退旧项；旧幂等键不能让客户端重放重建已删结果。封存键与擦除操作在 08 建正式合同。
- `assistant_runtime_deletion_target` 在 08 归删除操作管理：FK 只指向可重试的删除操作，独立保存 owner/contact/session/runtime 目标地址快照、同操作目录身份和清理状态。它故意不 FK 到将被删除的 live session，避免级联先删目标导致无法清文件；这类 ID 是清理地址而非活业务引用或生成授权。
- 官方 SessionPersistence 未提供 delete；应用负责同操作身份核验和安全清盘。目录身份也不能被当作来源、恢复或外发许可；删除失败保留目标并阻断成功声明。

### 规范化、索引与验证边界

- 三层逻辑输入合成 turn；原版和编辑正文统一版本；segment.position 独立于每版 text；current 指针不再复制当前正文；引用有真实 FK。只有实际输入及运行投影因时间语义允许保存敏感快照，并保留清理路径。
- 索引围绕当前会话、session turn 顺序、操作幂等、当前执行、候选版本／选择、context_item 各类型反向依赖、runtime_context 反查和待清理目标；不对全部 JSON 值泛建索引。
- 合成验收至少覆盖：同键重放不回退、空闲分段后重放归属稳定、跨联系人／跨 session 版本拒绝、父版正确、段组完整、复制不算选择、携入匹配、来源删除穿透手改和文件、dirty 不恢复、业务已提交而文件失败、迟到结果不复活以及手动模式不伪造绑定。
- 尚未执行 SQLite SQL、App、微信、模型或真实用户文件验收。包／源码查证证明的是当前存储合同，不等于可接入新后端或整个集成已验证。

## 本轮决定与后续校核

- Q39 已确认 A：原始候选和手工编辑版都把正文存入同一候选版本结构，从第 1 版开始，reply_candidate 只保存身份和产生位置；统一读取、引用和删除规则，不保留旧 v0 正文特例。显式选择、来源依赖和用户手动发送规则继续有效。
- 合并逻辑 turn、类型化上下文及运行文件关系为当前工程建模基线，最终字段、07 的其他材料版本、08 的删除协议及 SQLite 物理校验仍需后续闭合。

## Answer

2026-10-28，本项形成后续偏好／文档／Skill、删除一致性及物理主设计使用的助手记录逻辑基线。

**用户明确决定**：Q39 选择 A。所有候选正文统一存入候选版本结构；v1 保存模型原稿，后续手工编辑形成新版本，reply_candidate 只保留身份和产生位置。选择必须指向具体版本，编辑／复制不代表已发送，真实来源删除继续穿透编辑和携入副本。

**工程建模结论**：原 generation 输入、turn 与逻辑 reply_request 收敛为 assistant_turn，实际执行历史由 0:N assistant_attempt 承接。稳定候选、统一版本、段身份／每版段正文和显式选择分别表达；实际上下文通过固定类型字段与真实 FK 可反查，物理调用真实关联本 attempt 的实际快照。业务 session 与 DSH JSONL 运行实例分层，ready 资格按生成／业务重建来历区分；删除先建立硬门禁并捕获闭包，再排空写入与清盘，库外删除目标独立于活业务行。

**必须继续闭合的合同**：07 中偏好／文档／Skill 的具体版本输入关系、08 的封存键／硬代次／副本清理与删除操作、版本段组和类型排他 CHECK／触发器、运行材料资格及新 SQLite 持久化接线仍须后续设计和验证。当前官方 JSONL 后端未改为 SQLite，不宣称公开 delete 或跨文件共享事务。resolved 只表示本项逻辑决策完成，不表示全部字段和实现已获批准或完成。

**验证**：两项独立只读代码／固定版本源码查证及草稿审查，已修正调用到快照的关联、撤销先于 drain、重建来历与目录身份；文档链接、空白、任务状态及依赖检查通过。未执行 SQL、App／微信、模型调用或真实会话文件读取，未修改业务代码。

## Comments

- 本任务只产生设计决定或事实查证；表数不是硬指标。沿用仓库隐私、手动发送和桌面热更新约束，不读取私人资料，不执行真实删库，不做远端操作。
- 两项独立只读查证及文档审查完成；已补充物理调用到实际 context 的完整范围 FK、先撤销后 drain 的删除次序、重建不伪造 turn／事件，以及 DSH UUID 的明确唯一身份。另补用户输入类型引用，保留粘贴文字的用户声明来源。未运行 SQL／App 或读取真实会话文件。
- 07覆盖查证发现reply-context.ts:95–109确实检索pending_candidate，故补memory_candidate的独立真实FK及待确认身份；L2/L3仅读已采纳版本，不能混淆两条输入合同。Q39统一候选正文的已确认决定不变。
