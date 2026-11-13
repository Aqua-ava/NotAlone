# 确定处理轮次、任务和调用回执的关系模型

Triage: ready-for-agent
State: resolved
Type: grilling
Map: [SQLite 数据库重建设计决策地图](../map.md)
Blocked by: 04

## Question

范围控制、一次启动、固定轮次目标、逐目标成功、执行任务、步骤和物理模型尝试分别保存什么？哪些一对一状态可合并，哪些必须独立以保证恢复、租约、暂停、取消及未知调用不重放？

## 已有输入

- [schema-plan.md](../schema-plan.md)
- [data-model-draft.md](../data-model-draft.md)
- [110_model_call_receipt.sql](../../../backend-ts/database/migrations/110_model_call_receipt.sql)
- [124_memory_processing_lifecycle.sql](../../../backend-ts/database/migrations/124_memory_processing_lifecycle.sql)
- [126_memory_processing_round_targets.sql](../../../backend-ts/database/migrations/126_memory_processing_round_targets.sql)

## 完成条件

给出对象与状态区分、主外键和控制代次、成功与无产出回执、事务领取和提交边界；产品控制规则引用独立规格，不重新扩大范围或把调用成功当作业务成功。

## Proposal：固定工作范围、可恢复执行与独立调用事实

本轮仅讨论关系模型，未执行 SQL 或修改业务代码。沿用 owner 范围复合键、TEXT 内部 ID、INTEGER 毫秒系统时间。Q38 已确认任务固定归属一个轮次、消息输入不追加；以下字段是建模基线，不等于最终物理 DDL。

### 已确认输入与旧实现差异

- [产品规格](../../sync-memory-behavior/spec.md)已确认手动启动、点击时固定联系人和已保存文字、允许有界前文、同轮本人处理、暂停小批收尾、取消／删除立即失效、失败手动继续和重启暂停；关闭同步总开关不取消有效记忆处理。不重复询问这些规则。
- `control.ts:167–186` 的旧暂停会推进硬代次并撤销执行；`recovery.ts:33–38,99–106` 旧恢复会自动唤醒；`flow.ts:103–134` 仍存在模型自动重试。不能照搬到新库。与 ADR-107 的自动排队、重试和启动恢复冲突已记录于独立产品规格，实施前须正式修订，不以本草稿改写现行实现状态。
- `124:41–64` 的任务／轮次 N:M 与 `126:3–13` 的第二层目标快照，是为旧 task 跨轮复用、追加目标服务。新库按已确认 Q38 固定任务归属，改为直接 FK；`090` 的单 task plan 壳也无需独立保留。

### 1. processing_scope：跨轮稳定的处理范围

| 字段 | 含义／约束 |
| --- | --- |
| `owner_id, scope_id` | 复合主键。scope 不是一次按钮启动。 |
| `scope_kind, contact_id` | owner 范围 contact_id 必须 NULL；contact 范围必须非空。 |
| `revocation_generation` | 单调硬撤销代次，取消联系人、整联系人清空／删除或身份失效推进；普通暂停不推进。局部来源变化单独推进来源修订并复验实际依赖，不一律硬取消未受影响整轮。 |
| `created_at, updated_at` | 范围控制元数据时间。 |

独立 `owner_id → owner`，可空 `(owner_id,contact_id) → contact`，并有范围 CHECK。contact 范围用条件 UNIQUE(owner_id,contact_id)；owner 范围用条件 UNIQUE(owner_id)，不能依赖含 NULL 的普通唯一键。

本表不代替会话绑定、微信读取授权或来源删除协议；最新勾选、绑定、来源资格仍单独核验，不能把旧 generation 快照视为现时授权。后续 08 统一哪些事件推进本硬代次及与渠道控制的正式关系。

### 2. processing_run：一次用户启动

| 字段 | 含义／约束 |
| --- | --- |
| `owner_id, run_id` | 复合主键，owner FK。 |
| `start_operation_id` | owner 内 UNIQUE；同一启动请求重放返回原 run。 |
| `dispatch_intent` | run／pause_requested／paused，控制是否派发新的小批。 |
| `intent_revision` | 控制操作 CAS；不等于硬撤销代次。 |
| `pipeline_contract_version` | 本轮确定性阶段合同，不由模型改写步骤。 |
| `accepted_process_epoch` | 最近显式启动／继续所对应的宿主运行代次。 |
| `pause_reason, created_at, finished_at` | 最小控制事实与时间；整体展示从分支状态聚合。 |

run 不保存所选联系人 ID 数组或消息正文。联系人选择由本轮分支行表达。宿主运行代次不匹配的旧 run 禁止派发；启动恢复先保守持久化暂停并淘汰旧租约，用户明确继续才绑定新代次。宿主代次的产生及多实例保护在运行时物理设计中验证。

### 3. processing_round：本次启动在一个范围上的固定分支

| 字段 | 含义／约束 |
| --- | --- |
| `owner_id, run_id, scope_id` | 复合主键；不再制造一份意义相同的 branch UUID。 |
| `accepted_revocation_generation` | 接受本分支时的硬代次快照，不能在继续时任意改成新值解除失效。 |
| `state, phase, reason_code` | waiting／running／paused／blocked／completed／cancelled／invalidated 等真实分支结果及阶段。 |
| `created_at, finished_at` | 分支时间。 |

复合 FK 分别指向同 owner 的 run 和稳定 scope；一个 run 对一个 scope 至多一个分支。run 1:N round，scope 1:N round。本人分支明确属于本次启动；scope 不提供读取未选联系人原始聊天的额外权限。

同一联系人未完成分支的排他、本人分支的排队应分别约束；不能对所有非终态 round 一律 UNIQUE(scope_id)，否则本人等待队列也被禁止。重叠启动时拒绝、继续既有轮次或排队的具体界面行为尚未确认；当前只要求不能重复派发相同有效工作、不能偷偷扩大旧集合，最终排他策略须在主设计闭合。

### 4. processing_input：点击时固定的可用消息集合

| 字段 | 含义／约束 |
| --- | --- |
| `owner_id, run_id, scope_id, message_id` | 复合主键，引用本分支。 |
| `source_contact_id` | 真实 message 联系人；与 contact scope 必须一致。 |
| `run_role` | target／context；前者计待处理量，后者只是本轮允许使用的前文集合。 |
| `message_digest_at_start` | 接受时内容摘要及合同；摘要不是消息身份。 |
| `extraction_task_id, extraction_step_no` | 成对可空；target 分配一个提取步骤后不再随意改派。context 不独占某个步骤。 |
| `eligibility_state` | eligible／removed，不能以删除正文后保留原快照代替清理。 |

FK 到 round、真实 `(owner_id,source_contact_id,message_id) → message`，以及成对的提取 step。目标分配须约束 step 属于同分支，不得跨联系人；使用受约束冗余 scope 候选键或触发器实现，最终 DDL 不留业务口头约定。

一条消息在本轮的主角色只记一次；同消息可在后续批次作为上下文出现，实际角色和顺序由 trace_message_input 表达，不重复增加目标数。这里只保存身份和接受时摘要，不另复制正文。目标与前文都必须在点击前已保存，不能用 occurred_at 上界替代真实集合。量大时可以事务内物化或可靠快照分段，但点击后补入的更早消息也不得混入。

本轮无文字输入不意味着可伪造提取成功。非文字和 Q32 未核验原始记录不进入本表。本人阶段消费本轮联系人提取形成的合法本人版本及允许的已有资料，具体版本用 trace_memory_input 冻结；不把多个人原始聊天拼为某个联系人的输入。

### 5. processing_receipt：逐消息的跨轮处理结果

字段：`owner_id, contact_id, message_id` 为主键；`completion_state`、`result_kind`、`producing_run_id, producing_scope_id`、`trace_id`、可空 `blocking_request_id`、`processing_contract_version`、`completed_at`。

- 真实 FK 到 message、产出分支、trace 及可空 blocking_request_id 对应的 model_request；不伪造 producer task ID。仅 succeeded 必须具有相符的范围、实际目标、成功提交事件及非空 completed_at；unknown_hold 必须关联实际未结算请求／调用与固定工作，completed_at 为空，不能伪造成功事件。任务归档后仍可经 trace、分支回查合法完成依据。
- completion_state 至少区分 succeeded／unknown_hold／invalidated。只有 succeeded 才减少未成功数；unknown_hold 阻止盲重放但不计成功。
- result_kind 区分新建或更新记忆、正常无新记忆、仅形成待裁决候选等适用结果，枚举须与实际输出合同核对。不能仅凭候选数或 HTTP 成功判定。来源／解析／核验流程异常不写“正常无新记忆”。
- 回执表示该消息的提取核验已提交，不代表主题、画像和本人整理都完成。主题等阶段仍由真实任务结果判定。
- 同消息正常跨轮不重复提取；合同升级不自动取消旧成功。未知请求必须真实结算并按资格恢复后才可解除 hold，不能手动清个状态就重发。来源失效对回执的保留／失效及删除范围在 08 统一。

### 6. background_task：有限、归属固定的工作

| 字段 | 含义／约束 |
| --- | --- |
| `owner_id, task_id` | 复合主键。 |
| `scope_id, task_type` | 稳定范围、确定性任务类型。 |
| `processing_run_id` | 记忆任务必填；其他领域任务可空，但不能借此绕过所属领域的真实输入引用。 |
| `task_role, input_contract_version` | 本轮提取／主题／画像等角色与固定输入合同。 |
| `state, reason_code, created_at, finished_at` | 当前执行状态及最小非正文原因。 |

scope 复合 FK；记忆 task 的 `(owner_id,processing_run_id,scope_id)` 直接 FK 到 round，类型／NULL 形状 CHECK。确定性任务角色和任务序号构成分支内候选键，防止重复创建同一份阶段工作；模板确需多个任务时使用有定义的序号而非任意 UUID 绕过幂等。

Q38 已确认：一条 task 的 run、scope 和消息集合固定。普通暂停／失败后的手动继续复用 task 及成功步骤；新到消息属于新一轮的新 task。取消／删除失效的旧 task 不因重新勾选而复活。删除、重建和 Skill 等其他类型的具体输入关联留各自后续任务，不使用 type + 任意 record_id 的多态伪 FK。

### 7. background_task_step：具有独立恢复价值的步骤

字段：`owner_id,task_id,step_no` 为主键；`step_kind, order_no, state, lease_generation, current_attempt_no, reason_code`。task FK 非空，task 内 order_no 唯一；仅拆确有独立恢复或提交边界的阶段／批次，不给每个函数建步骤。

提取 task 可以包含多个有界批次步骤；主题和画像 task 有自己的确定性步骤。所有必需步骤通过程序校验后 task 才成功；不适用阶段显式 not_applicable，缺少步骤不等于完成。实际聊天进度按成功消息回执统计，不能把步骤权重当聊天完成率。

### 8. step_attempt：一次领取和执行历史

字段：`owner_id,task_id,step_no,attempt_no` 为主键；`lease_generation, worker_id, process_epoch, lease_expires_at, started_at, finished_at, outcome, reason_code, trace_id`。

FK 到 step、可空 trace；同 step 的 lease_generation 唯一且严格递增。step.current_attempt_no 只能引用本 step 的 attempt，可用事务末闭合的延迟 NO ACTION FK，不使用会立即拒绝的 RESTRICT 假装延迟。每次领取新建 attempt，失败记录不靠覆盖 last_error 丢失；续租更新同次 lease_expires_at，不算新执行或模型调用。

trace 对应本次有界输入及其处理过程；一轮可有多个批次、多个失败／恢复 trace。可以先记录实际构造的请求载荷，再由调用账目说明是否已发送，不能把“有输入快照”说成模型已收到。

### 9. step_attempt_guard：本次执行依赖的硬门禁

字段：`owner_id,task_id,step_no,attempt_no,guard_scope_id` 为主键；`expected_revocation_generation, guard_role`、可空 `contribution_run_id`，以及确需冻结的绑定／来源资格版本。

FK 到真实 attempt 与同 owner 的 processing_scope；记录执行范围、实际写入范围及贡献联系人的控制快照。selected_contribution 的 contribution_run_id 必填，且 `(owner_id,contribution_run_id,guard_scope_id)` 真实 FK 到本次 run 的联系人 round；该分支必须未取消／未失效，期望代次必须等于其 accepted_revocation_generation，提交时还须等于 scope 当前代次。不能在 owner 任务重试时取最新 scope 代次，给旧 run 已取消的 A 贡献重新放行。已有合法本人记忆的其他来源只可经实际版本／来源路径核验，不开放任意其他人原始聊天。

本人 task 不能只校验 owner scope：取消 A 后，A 贡献的本人在途结果也须被拦截；仅 B 的合法工作可以继续。混合结果不能删个 A 标签就提交，须拒绝旧尝试并按剩余合法输入重建／复验。门禁快照是时间语义明确的受控重复，不能在重试时覆盖旧 attempt 的值。

### 10. model_request：一次稳定的逻辑模型操作

字段：`owner_id,request_id` 为主键；`scope_kind,contact_id,operation_kind,operation_key,input_contract_version,logical_budget_policy,created_at`。独立 owner FK、可空 contact 复合 FK 与明确范围 CHECK；联系人／本人分别建立范围内 operation_kind/operation_key 条件唯一。共享调用不直接依赖记忆处理 scope 的控制状态，关联执行通过其真实 owner/contact 范围核验。

operation_key 根据真实固定工作、操作槽及输入合同定义，不能每次领取随意新建 UUID。模型、参数和最终序列化请求变化时，须明确仍是同一操作的合法尝试，还是新操作，并先检查已有 unknown。换 task、batch、lease 或 request ID 均不能绕过同一有效目标的未知隔离。

request 保存逻辑政策和归属；实际模型、序列化请求摘要和测量预算属于物理 call。一项逻辑操作可以有多次物理尝试；重试须用户明确继续且核验安全，不能因可以存多行就默认自动重试。

### 11. model_call：一次物理调用的最小无正文事实

| 字段 | 含义／约束 |
| --- | --- |
| `owner_id, call_id` | 复合主键；call_id 即物理 attempt 身份。 |
| `request_id, call_no` | 真实 request FK；UNIQUE(owner_id,request_id,call_no)，与步骤执行的 attempt_no 区分。 |
| `provider, model_name` | 本次实际供应商和模型。 |
| `dispatch_state, outcome` | 是否确定未发、授权未确认、已见响应等；与 pending／success／failed／unknown 结果分开。 |
| `request_digest, input_budget_measurement` | 实际序列化请求的摘要、测量方式及预算；有界结构值不装实体引用。 |
| `authorized_at, response_at, latency_ms` | 可确认的调用时间。 |
| `input_tokens, output_tokens, cache_read_tokens, cache_write_tokens` | 未知 NULL；缓存量不得超过实际输入，输入输出是否成对已知沿合同。 |
| `cost_status, amount_units, amount_scale, currency, pricing_version` | unknown／estimated／known；用受约束整数金额与明确十进制尺度，不用 REAL 假装精确金额。 |

金额非负、尺度范围受控以防溢出；费用未知时金额／币种／价格版本为空，不同币种分开汇总。调用记录不含 prompt、response、正文错误、联系人展示名或来源文件名。关联 ID、摘要仍是范围资料，不外泄到普通日志。

同一逻辑 request 至多一个仍在途／未知的物理尝试，条件唯一及事务共同防重复授权。迟到真实结果可把 unknown 结算为真实终态、补齐用量，但不得被旧 pending 降级或让已知用量被 NULL 覆盖；结算不提供业务写入权限。预留 ACK 重放不授权第二次发送。

来源或追踪正文删除可以保留合法最小调用记录；整联系人／owner 删除按范围清理，迟到结果不得重建已删范围。拟收敛旧 outbound_ledger 投影与 model_call_receipt 的重复物理调用状态，非模型出站事项是否仍有独立账目待实际覆盖核对。

### 12. step_model_call：调用授权与真实执行的关联

字段：`owner_id,call_id` 为主键并 FK model_call；另有 `task_id,step_no,step_attempt_no,invocation_slot`。外键仅为 `(owner_id,task_id,step_no,step_attempt_no) → step_attempt`，invocation_slot 不属于该 FK。一个 call 至多归属一次真实执行，不能挂给两位联系人或两个 lease。

UNIQUE(owner_id,task_id,step_no,step_attempt_no,invocation_slot)；一个提取步骤可能有提取、核验、仲裁等多个稳定槽，不能照搬仅适用于旧 Skill propose 的“每租约总共一次调用”。复合候选键／触发器保证 request 的 scope 与执行 scope 相符。

单独保留关联是生命周期需要：任务元数据可归档／清理，但累计 call 不随之级联删除或退款。仍有 pending／unknown 或恢复依赖的工作不能按普通已结算终态记录清理，必须保留固定工作归属与阻重放路径；不允许先删关联再声称只凭一个随机 request_id 就足够。保留资格和最小关系边在 08 作删除验证。

### 四个提交事实与事务边界

1. **接受启动**：复验勾选与身份，幂等建立 run、round、固定 input，设置分支硬代次快照；点击后目标不扩张。
2. **领取执行**：短事务比较派发意图、宿主代次、范围和来源，CAS step 并增加 lease_generation，新建 attempt 及 guard；所有授权租约字段统一归此 attempt。
3. **授权模型调用**：短事务复验真实租约及所有门禁、unknown 和累计预算，建立／复用 request，原子预留 call、关联 invocation_slot 并扣相应额度。只有明确持久化 ACK 后才允许一次发送；网络和模型等待不占写事务。
4. **结算调用**：独立保存响应／unknown 和费用事实。HTTP 成功只说明收到响应，不代表输出、候选或记忆合法。
5. **提交业务**：短事务再次复验 step 当前 attempt、worker、process epoch、lease_generation／有效期、全部 guard、来源、候选和记忆修订；原子写候选／版本／证据、trace 提交事件、逐消息 receipt 和步骤提交结果。失败整体回滚；旧 lease 可结算 call，不能补写记忆。

普通暂停只禁止新的批次派发，已领取且仍有效的当前小批允许完成其必要模型步骤和提交；不是在每个模型调用前无条件要求 dispatch_intent=run。取消／删除推进硬代次，立即拒绝相应读取、调用授权及业务提交；同步总开关不作为此处派发门禁。

一次模型成功、一次业务批次提交、某条消息完成、某个 task 完成和整轮全部适用阶段完成分别统计。失败联系人不阻断其他联系人；共用模型配置故障按已确认规则暂停整体。本人整理的依赖及阶段排队按确定性模板声明，不能因某分支失败就把整个流程标成成功。

### 索引、保留与需要验证的反例

- 索引按实际操作建立：scope 唯一、分支待派发、step 当前租约、input 目标分配、跨轮 message 回执、request 未结算调用、按 source／scope 反查全部 attempt guard。不要索引所有状态字段或靠 JSON 全表扫描关系。
- 函数依赖明确：scope 控制独立于某次 run；round 是启动与范围的组合；目标成员独立于处理结果；step 状态独立于多次执行历史；request 政策独立于物理调用；调用账目独立于可清理任务。输入摘要和代次快照只表示当时事实。
- 旧任务“终态 90 天清理”不能直接级联删未知调用、成功回执或完整追踪。具体清理时长与引用保留在物理主设计和删除任务核对；不以此草稿新增无限保存敏感内容的授权。
- 合成验证至少包含：暂停与领取竞争、取消 A 与本人写入竞争、同一启动重放、续租／租约过期、迟到响应只结算、unknown 跨 task／lease 不能绕过、无新记忆成功、前文不计目标、重启不派发、旧任务不接收新到消息，以及任务清理不抹累计预算。

## 本轮决定与后续校核

- Q38 已确认 A：一条 task 只属于一个固定轮次，消息输入不追加；普通暂停或失败后的手动继续沿用原 task 和成功步骤，新建执行 attempt；下一轮消息使用新 task。去掉旧 task／round 多对多归属和单独 plan 壳；取消／删除失效的任务不在可恢复范围内，unknown 仍不能盲目重发。
- 重叠启动冲突的具体响应、本人分支排队及最终 DDL 仍是建模建议；不把用户对 Q38 的选择解释为对所有新交互或字段的批准。

## Answer

2026-10-28，本项形成后续助手记录、删除一致性与物理主设计使用的处理任务逻辑基线。

**用户明确决定**：Q38 选择 A。每条任务固定属于一个轮次，消息输入不追加；普通暂停或失败后手动继续保留原任务及成功步骤，新增执行记录。下一轮消息建立新任务。取消／删除失效任务不能恢复，未知模型调用不能盲目重发。

**工程建模结论**：稳定范围、一次启动、范围内轮次、固定消息成员、跨轮回执、任务、步骤、执行尝试、贡献范围门禁、逻辑模型请求和物理调用分层。记忆 task 直接 FK 到一个 round，不保留为旧跨轮追加语义服务的 N:M 归属与 plan 壳。普通暂停控制派发，硬撤销拒绝旧提交；本人写入逐一复验贡献联系人，不能通过重试刷新旧贡献的代次。成功、正常无新记忆与 unknown 隔离分别统计，结算调用不提供业务写入权限。

**必须继续闭合的合同**：重叠启动的具体响应、本人分支排队及调度模板、最新选择／渠道／删除控制的正式关系、逻辑操作键和调用槽编码、跨域清理与留存、宿主运行代次及 SQLite 原子领取／触发器／外键的物理验证仍待后续设计。resolved 只表示本项逻辑决策完成，不表示用户已批准所有新交互、字段或实施。

**验证**：两项独立只读代码查证与草稿审查，修正回执条件约束、执行与调用序号和取消贡献代次问题；检查文档链接、任务状态、依赖及空白。未执行 SQL、模型调用、App／微信或用户库操作，未修改业务代码。

## Comments

- 本任务只产生设计决定或事实查证；表数不是硬指标。沿用仓库隐私、手动发送和桌面热更新约束，不读取私人资料，不执行真实删库，不做远端操作。
- 两项独立只读查证分别核对控制／租约和调用／回执，并审查本轮草稿；已补上 unknown_hold 的条件约束、step 与 call 序号区分，以及取消联系人的贡献不能通过重试刷新代次放行。仅文档审查，不代表 SQLite 约束或运行行为已验证。
- 06 查证共享调用也服务助手短请求，故细化 model_request 为直接 owner/contact／本人业务范围 FK，避免要求助手建立记忆轮次或继承记忆暂停／勾选门禁；Q38 固定任务归属的确认不变，物理约束仍待验证。
- 08细化硬事件与局部source修订，未受影响固定目标可新attempt实际复验；已取消round仍不得刷新接受代次放行。删除账本需独立于即将清除的owner任务生命周期，执行代码可复用，不能把跨存储目标随task级联抹除。
