# 确定记忆、版本、证据和完整追踪的关系模型

Triage: ready-for-agent
State: resolved
Type: grilling
Map: [SQLite 数据库重建设计决策地图](../map.md)
Blocked by: 03

## Question

候选、已采纳记忆、本人和联系人范围、记忆版本、证据与完整提取追踪应如何分表或共用结构？如何让版本只属于本记忆、证据有真实外键、完整参与窗口可删除，而不是使用模糊的多态 ID？

## 已有输入

- [schema-plan.md](../schema-plan.md)
- [data-model-draft.md](../data-model-draft.md)
- [009_memory_store.sql](../../../backend-ts/database/migrations/009_memory_store.sql)
- [039_memory_extraction_trace.sql](../../../backend-ts/database/migrations/039_memory_extraction_trace.sql)

## 完成条件

明确实体与版本、候选证据和版本证据的可执行关系；说明本人范围与 NULL 约束、人工修改与来源依赖、含正文追踪与无正文回执边界，并给出删除及更新不一致反例的处理。

## Proposal：身份、版本、事实依据与过程分层

以下为本轮关系模型基线，未执行 SQL。主键、类型沿用前项的 owner 范围、内部 UUID/TEXT 和系统时间 INTEGER 毫秒约定。时态内容保留来源支持的范围、精度和未知状态，不把系统保存时间伪装为事实时间。Q36 已确认共表，Q37 已确认新增恢复版本；这两项决定不等于所有字段和物理约束均已定稿。

### memory_candidate：一次待裁决主张

| 字段 | 含义与约束 |
| --- | --- |
| `owner_id`、`candidate_id` | 候选范围身份；主键 `(owner_id,candidate_id)`。 |
| `origin_contact_id` | 该聊天提取候选来自哪位联系人的会话，非空；不是最终记忆归属。 |
| `trace_id` | 产生本候选的提取追踪，非空，引用同 owner、同原会话的 trace。 |
| `subject` | `self`／`contact`／`shared`；表示事实主体。self 采纳到本人范围，其他两类采纳到原联系人的关系资料。 |
| `text_content`、`category` | 候选主张和既有分类；不是已确认事实。 |
| `decision_state` | pending／adopted／rejected／invalidated 等明确裁决状态。 |
| `verification_state`、`verification_rule_version`、`last_verified_at` | 当前来源核验资格、规则和时间；FK 存在不等于语义已获支持。 |
| `content_state`、`erased_at` | 若删除范围允许保留最小身份元数据，明确正文已擦除；否则连同本行及相应关系删除。已擦除状态下正文、条件及解释等敏感字段必须清空，不能只改状态。 |
| 主张的时间、条件及事件字段 | 候选中待核验的限定，与相应证据片段关联；不能仅采纳正文而丢限定。 |
| `created_at`、`decided_at` | 保存时间与可空裁决时间。 |

外键：`(owner_id,origin_contact_id) → contact`；`(owner_id,origin_contact_id,trace_id) → memory_trace` 对应唯一超键。这要求聊天候选来自实际单联系人窗口，不把多个聊天拼成一个联系人的输入。本人整理若基于已有本人资料形成合并版本，不能伪填一个原会话，应经版本父边和对应本人 trace 表达，实际生成入口在后续任务中核对。

不以正文建立 UNIQUE 或正文哈希去重；同一句话可能属于不同时间、条件和范围。模型是否把两项合为一项是有来源的业务裁决，不能由字符串相同替代。

### memory：一条可持续管理的记忆身份

Q36 已确认：本人和联系人记忆共用 head/version 结构，采用明确范围约束，不分成两套表。

| 字段 | 含义与约束 |
| --- | --- |
| `owner_id`、`memory_id` | 主键 `(owner_id,memory_id)`，稳定记忆身份。 |
| `scope_kind` | 明确为 owner 或 contact。 |
| `contact_id` | owner 范围必须 NULL；contact 范围必须非空。 |
| `current_version_no` | 当前选用的版本号，不只保存一个任意 version_id。 |
| `head_revision` | 乐观并发修订，切换当前版本及资格变化时使用；不能用版本数冒充集合修订。 |
| `created_at` | 首次建立此记忆身份的时间。 |

外键：独立的 `owner_id → owner`；可空的 `(owner_id,contact_id) → contact`；`(owner_id,memory_id,current_version_no) → memory_version`。行内 CHECK 明确范围／NULL 组合。独立 owner FK 不能省略，否则 contact_id=NULL 时复合 FK 会跳过父记录存在检查。

head 不再复制当前正文、分类或来源数组，它们属于具体版本。scope_kind/contact_id 建立后不通过改 FK 来搬动私密事实；错误归属须先按删除合同处理，再明确创建正确范围的资料。

### memory_version：本记忆的一次内容与依据版本

| 字段 | 含义与约束 |
| --- | --- |
| `owner_id`、`memory_id`、`version_no` | 复合主键，version_no 为正整数；无需为每个版本再制造另一套脱离记忆的身份。 |
| `text_content`、`category`、`subject` | 此版主张、分类与主体；subject 与 head 范围必须兼容。 |
| `adoption_method` | auto／manual，auto 不等于用户确认。 |
| `origin_kind` | 候选采纳、独立手录、人工修正、合并或恢复等来历，和 adoption_method 不混同。 |
| `source_candidate_id` | 可空的真实候选 FK，按 origin_kind 约束；独立手录不能伪造候选。 |
| `created_from_trace_id` | 可空的真实 trace FK，单纯手录不伪造模型过程。 |
| `valid_at`、`invalid_at` | 来源支持的适用期间，可空；不默认以保存时间生效。 |
| 事件阶段、发生范围、精度、时区及条件值 | 保留现行时态合同；必要来源 ID 和片段不藏在值 JSON 中，而由正式证据关系表达。非引用的结构化条件整体值可按受控格式保存，独立查询的属性再规范化。 |
| `verification_state`、`verification_rule_version`、`last_verified_at` | 当前依据核验资格；内容已存在不等于可继续进入生成。合法手录根明确标为不适用聊天核验，不能把所有 manual 修正都视为独立手录。 |
| `retirement_reason`、`retired_at` | 区分未知、纠错和状态变化；记录退出当前资料的系统时点，不冒充事实失效时间。 |
| `content_state`、`erased_at` | 内容可用、待擦除、已擦除；真实删除须清正文、条件和解释等敏感值，元数据是否保留依删除范围决定。 |
| `created_at` | 此版保存时点。 |

外键：`(owner_id,memory_id) → memory`；`(owner_id,source_candidate_id) → memory_candidate`；`(owner_id,created_from_trace_id) → memory_trace`。对非空 source_candidate_id 建 owner 范围条件唯一，保证同一候选的采纳重试不会再创建第二份结果。

当前版本引用包含 memory_id，因此不能把 A 记忆指向 B 记忆的版本。head 与首版互相引用，可用当前版本 FK 的 `NO ACTION DEFERRABLE INITIALLY DEFERRED` 在同一事务内闭合；不能写 RESTRICT 再声称它会等到提交。物理行为仍需合成验证。

“版本不可变”限定为不得原地改写已形成的主张。人工修正创建新版本；核验失效、退役和依法定范围擦除属于生命周期元数据或隐私清理例外。历史版本不能成为恢复已删正文的后门。

候选和版本的正文列必须允许隐私擦除所需的 NULL，但正常可用记录应以 content_state 对应 CHECK 保证主张非空；不能一边要求正文永远 NOT NULL，一边声称保留已擦除的空壳记录。是否保留空壳由实际删除范围决定。

### memory_version_parent：明确的版本父边

一行表示一个新版本与一个前序／合并／恢复依据版本的关系。

- 字段：owner_id、child_memory_id、child_version_no、parent_memory_id、parent_version_no、relation_kind。
- 主键：上述 child 与 parent 的完整范围组合；两端分别真实 FK 到 memory_version。
- 同一 owner；普通修正属于同 memory；合并的不同 memory 也必须具有兼容范围，不允许跨联系人或 owner/contact 归属搬运。
- 禁止自环；同一记忆的普通前序号必须更小；跨记忆合并不能靠版本数字比较防环，需触发器／事务中的 DAG 校验。合并至少两个合法父版本等跨行规则也不能靠单行 CHECK 声称已保证。
- 父边解释版本来历，不自动等于正文依赖。人工修正继承原聊天依赖；自动状态更新的旧窗口可能只是证明背景；合并与恢复需分别复制／核验实际必需消息和合法手录根。
- Q37 已确认新增恢复版本，使用 origin_kind=revert 和父边关联恢复来源，不再次填写原候选的 source_candidate_id，以免破坏一次采纳的唯一约束。用户发起恢复由 memory_decision 记录；不能把原来的 auto 内容因此改称独立手录或用户已确认事实。

### 事实证据与正文必需消息：四张有类型关系表

| 表 | 一行代表什么 | 主键／唯一与真实外键 |
| --- | --- | --- |
| `candidate_evidence` | 候选引用的一处消息片段 | owner/candidate/evidence_id 为主键；同一候选、消息、片段范围和证据用途唯一；分别 FK 到实际候选和同原联系人 message。 |
| `candidate_required_message` | 某候选正文成立必须存在的一条消息 | `(owner_id,candidate_id,source_contact_id,message_id)` 为键；真实 FK 到候选及 message，并保证聊天候选来自同一原会话范围。 |
| `memory_version_evidence` | 某记忆版本引用的一处消息片段 | owner/memory/version/evidence_id 为主键；引用同 memory 的版本以及同 owner 的真实 message；同片段用途唯一。 |
| `memory_version_required_message` | 某版本正文成立必须存在的一条消息 | `(owner_id,memory_id,version_no,source_contact_id,message_id)` 为键；分别 FK 到版本与 message。 |

片段表共同字段包括 source_contact_id、message_id、char_start、char_end、evidence_purpose、message_digest_at_verification。片段采用明确的半开字符范围，Unicode 计数约定必须全链统一；CHECK 保证非负及 start < end，实际长度、摘要、文字类型、来源活动资格和语义支持须复验。摘要用于检测证据是否变化，不用于消息去重。

候选原会话范围可通过候选的 `(owner_id,origin_contact_id,candidate_id)` 唯一超键，与消息 FK 共用同一 contact 字段实现。本人版本证据可以指向同 owner 下不同联系人，但必须保留每条来源的真实 contact；联系人版本证据只能指向本联系人。

推荐同表方案下，“版本所属 memory 若是 contact，则证据 contact 必须相同；若是 owner，则只允许同 owner”涉及父表条件，普通 CHECK 不能查询父行。需要明确的约束触发器及事务复验，并禁止后来改 head 归属；不能仅凭一个可空 contact FK 就宣称全部隔离已成立。分表方案能让这一部分更多直接落在 FK 中。

证据片段和必需消息集合分开，因为一条消息可以有多个片段，片段用途不等于该消息是否为成立条件；把 required 标志重复存进每个片段会产生部分依赖和不一致。普通窗口背景也不放进正文必需集合。

### AND 与 OR 的位置

新记录明确列出的所有必需 message 是 AND：任一必需消息失去全部活动来源，会破坏该版正文资格。每条 message 对应的多个有效 source_record 是 OR：删除一份捕获来源但另一份仍能合法支持同一消息，不等于删除该消息。

这些关系不需要再以一列含糊的 source_ids 或 all_sources 表达。新空库也不迁移、补猜旧 any/all 历史；多父合并或本人处理当前程序存在的范围限制必须在实现覆盖时核对，不能把可存多个 source_contact_id 误当作已允许跨联系人拼接模型输入。

### memory_trace：一次完整处理过程的主体

| 字段 | 含义与约束 |
| --- | --- |
| `owner_id`、`trace_id` | 主键 `(owner_id,trace_id)`。 |
| `scope_kind`、`contact_id` | 本人或联系人执行范围，使用明确 CHECK 和独立 owner FK；不等于最终所有候选的采纳归属。 |
| 处理轮次／任务引用 | 后续执行模型的真实引用，正式 FK 在相关任务定义；不存聊天正文。 |
| `run_state` | running／succeeded／failed／cancelled 等真实执行结果；失败过程仍可保存。 |
| `content_state` | present／erase_requested／erased；历史执行成功不保证过程正文仍可读。 |
| `input_contract_version` | 输入及证据快照结构版本。 |
| `started_at`、`finished_at`、`error_code` | 时间与有界非正文原因。 |

独立 owner FK、可空 contact 复合 FK与范围 CHECK均须存在；提供 `(owner_id,contact_id,trace_id)` 唯一超键供单会话候选引用。本人 trace 不因此获得读取所有联系人的授权，实际输入仍须属于本轮允许范围。

### memory_trace_event：阶段事件和敏感载荷

- 字段：owner_id、trace_id、event_no、stage、payload_json、recorded_at、rule_version、可空 model_attempt_id。
- 主键：`(owner_id,trace_id,event_no)`；trace FK 必填；model_attempt_id 是后续物理模型调用的真实 FK，不用字符串类型加任意 ID 替代。
- payload 保存实际模型输入、返回和程序结果等完整过程，不进入普通日志；普通更新不得替换历史输入输出。隐私清理允许清空敏感载荷并保留合法的最小事件元数据，具体保留依删除范围。
- 一次物理模型调用可关联请求、响应等多个事件；模型成功、候选获支持、记忆提交和整轮完成仍是不同事实。无正文调用回执和费用由后续 model_call 模型保存，不复制到过程正文作为唯一凭证。

### 追踪输入：三张有类型关系表

| 表 | 字段与主键草图 | 外键与边界 |
| --- | --- | --- |
| `trace_message_input` | owner_id、trace_id、input_no、input_role、source_contact_id、message_id、消息摘要与当时排序依据；PK owner/trace/input_no | 真实引用 trace 与完整范围 message；input_role 区分目标、仅作上下文等。input_no 保存实际呈现给模型的顺序，不冒充已证明的微信时间顺序。 |
| `trace_source_input` | owner_id、trace_id、source_contact_id、record_id、当时来源摘要／资格；PK owner/trace/source_contact/record | 真实引用 trace 与 source_record；记录当时实际依赖的捕获来源，不能后来换个来源恢复原证明。 |
| `trace_memory_input` | owner_id、trace_id、input_no、input_memory_id、input_version_no、用途及当时资格；PK owner/trace/input_no | 真实引用 trace 与某个 memory_version，区分所用旧本人资料与原始聊天；不能只挂到会持续变化的 memory head。 |

联系人 trace 的原始聊天窗口不能越过该联系人；所用合法本人资料可能来自其他联系人，故 trace_source_input 的 source_contact_id 不必等于 trace.contact_id，但必须经真实本人版本路径和当次授权核验，不能借此开放任意其他人的聊天。若是本人阶段，来源同样须满足本次处理选择及来源资格。

候选通过 trace_id 连接产生过程；版本通过 created_from_trace_id 连接生成过程，不需要另造一个 record_kind + record_id 的无外键输出表。多个候选或版本可以来自同一 trace。

### 人工决定与合法手录根

需保留独立的 `memory_decision` 操作事实，尤其拒绝、纠错、撤销或删除不一定都产生新版本。候选字段：owner_id、decision_id、action_kind、actor_kind、created_at、expected_head_revision，以及可空 candidate_id、target_memory_id/target_version_no、result_memory_id/result_version_no。

主键 owner/decision_id 同时作为该操作重试的稳定身份；candidate、目标版本和结果版本分别定义真实 FK，并用 action 对应的形状 CHECK 约束哪些引用必填，而不是 entity_type/entity_id 的多态伪引用。决定引用的完整保护窗口及来源资格需能经真实候选／版本／追踪依赖回查；若既有人工保护使用了额外冻结输入，则应增设明确的输入关系，不能塞回无约束 JSON。本项不宣称这一组核心字段已经覆盖所有旧纠错协议。

独立手录由 origin_kind=manual_entry 的合法用户操作明确建立，不把 owner_id 伪装成 source_id。人工修正已有聊天提取结果仍继承该聊天的正文依赖；adoption_method=manual 本身不能切断来源。版本父边和必要消息集合共同支持手录根／来源合法性校验。

### 写入、失效和真实删除

1. 采纳时，在短事务中复验候选、主体、目标范围、完整输入及活动来源；建立或复用 memory，写入版本、证据、必需消息、父边和人工／自动决定，再以期望 head_revision 更新当前指针，失败整体回滚。模型调用不在写事务内。
2. 普通修正新增版本，旧版本退出当前资料但可按合法来源回看。恢复必须校验当前版本、人工保护及旧版本的当前来源资格，不能仅改 pointer 就绕过被删依据。
3. 一个仅作窗口背景的来源失效：撤下旧证明，并清除受影响整份追踪的正文、模型输入输出及解释；仍有合法正文依据的记忆可保留记录，但不能继续拿旧证明放行。
4. 任一正文必需消息失去全部合法来源：收集并清理依赖的候选、当前与历史版本正文、主题、画像、助手及恢复副本；人工确认不豁免。其他有效来源仍支持同一 message 时不误删消息，但实际依赖了被删来源的旧追踪不能复活。
5. 主动删除追踪不等于删除独立合法的记忆事实；正文证据和来源关系不能只藏在追踪 payload。保留的最小追踪元数据／调用关系不含敏感正文，具体资格与删除动作在后续删除任务中统一验证。
6. 删除跨域闭包先收集再清理，不先无条件 CASCADE 丢掉反查边。普通依赖先 RESTRICT；head/current version 的循环引用须采用可在事务末闭合的明确方案，不能统一 RESTRICT。整联系人或账户删除的最小调用记录也按相应范围清除。

### 索引与数据库检查的能力边界

- 索引依据实际入口：当前范围记忆列表、同 memory 版本顺序、候选状态、按 message/source_record/version 反查全部支持与追踪。所需反向关系不能仅依赖 JSON 全表扫描。
- 片段长度、语义支持、当前来源、条件范围、父图无环、至少一份有效支持、人工保护和跨文件删除不能全部用 FK/CHECK 表达。应分别说明触发器、事务复验和调用前后资格校验；不能笼统宣称“全靠外键”或“全部由业务约定”。
- 主张、证据定位、实际模型过程和调用台账具有不同用途与删除规则，允许的快照重复必须说明时间语义和失效方式，不把多份副本当作多个可独立修改的事实源。
- SQLite 复合 FK 的 NULL 行为、CHECK 不支持子查询以及延迟 FK 与 RESTRICT 的差别，依据[官方外键说明](https://www.sqlite.org/foreignkeys.html)和[官方建表约束](https://www.sqlite.org/lang_createtable.html)；尚未执行本 schema 的合成验证。

## 本轮决定与后续校核

- Q36 已确认 A：本人记忆和联系人记忆共用 memory/memory_version，以明确 scope、条件约束及触发器保障差异。
- Q37 已确认 A：撤销一个仍可合法恢复的自动更新时，追加一条恢复版本并将其设为当前；恢复属于同一 memory 的版本变化，不新建第二条记忆。仍须重新核验来源、并发修订及人工保护；受撤销／删除合同要求擦除的内容仍必须擦除，不因版本留存而保留。
- 字段为当前建模基线；时态协议、人工保护额外冻结输入和实际旧模块映射还须后续完整覆盖，不把结构讨论等同实施完备。

## Answer

2026-10-28，本项形成后续任务、助手记录与删除设计所用的记忆／证据逻辑基线。

**用户明确决定**：Q36 选择 A，本人和联系人记忆共用 memory/memory_version，以明确范围字段、约束与必要触发器隔离。解释版本指同一条已采纳记忆的内容变化后，用户对 Q37 回复“按推荐”，采用 A：撤销可合法恢复的自动更新时，在同一 memory 下新增恢复版本并切为当前，不直接回指旧版本。

**工程建模结论**：稳定记忆身份、具体版本、候选、片段证据、正文必需消息、版本父边、完整追踪及有类型输入关系分别表达。当前版本必须属于本 memory；候选保留原会话，self 主张可采纳到本人范围；实际模型输入输出独立保存，来源删除可反查清理。恢复使用 origin_kind=revert、父边及决定记录，重新核验全部资格，不重复采用原候选，不把自动内容转换成独立手录或用户确认事实，不恢复已删内容。

**必须继续闭合的合同**：处理轮次与模型调用的正式外键、时态字段与人工保护冻结输入、实际旧模块覆盖、跨域删除闭包及 SQLite 触发器／延迟外键的物理验证，分别在后续任务与主设计中完成。此项 resolved 表示本轮逻辑决策完成，不表示所有字段定稿或可直接实施。

**验证**：结合既有代码和关系研究复核模型；检查文档链接、状态及依赖，未执行 SQL、运行 App／微信、读取真实聊天或修改业务代码。

## Comments

- 本任务只产生设计决定或事实查证；表数不是硬指标。沿用仓库隐私、手动发送和桌面热更新约束，不读取私人资料，不执行真实删库，不做远端操作。
