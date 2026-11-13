# 确定表达偏好、Skill 和派生文档的持久化模型

Triage: ready-for-agent
State: resolved
Type: grilling
Map: [SQLite 数据库重建设计决策地图](../map.md)
Blocked by: 04

## Question

用户明确表达偏好、目录权威 Skill、场景文档、长期画像及无正文投影分别是什么事实或派生记录？哪些属性和版本真正同构，哪些有不同来源、失效及删除生命周期？

## 已有输入

- [schema-plan.md](../schema-plan.md)
- [065_expression_preferences.sql](../../../backend-ts/database/migrations/065_expression_preferences.sql)
- [073_layered_scenario_documents.sql](../../../backend-ts/database/migrations/073_layered_scenario_documents.sql)
- [103_skill_business_state_only.sql](../../../backend-ts/database/migrations/103_skill_business_state_only.sql)

## 完成条件

形成必要实体、版本和依赖的表合同；不把画像当事实，不把表达偏好与退役样本混淆，不把用户 Skill 文件因重建而删除；诊断和质量记录的保留或改造有使用者证据。

## Proposal：明确偏好、派生文档与目录策略分层

本项仍为关系模型讨论；未建库、读取用户目录或修改业务代码。内部 ID 为 TEXT，系统时间 INTEGER 毫秒；键／FK 省略写法均必须包含 owner 范围。Q40 已确认共表，Q41 按用户修正版接回保留目录、不默认全部停用；以下不是全部已定稿的 DDL 或新产品流程批准。

### 已核对的事实

- `preference-service.ts:74–84,129–138` 要求明确长期确认；manual 偏好可改变 contact/global 和 reply_mode，message 来源偏好不可换联系人，人工改文仍保留来源。065 的 revision 只是可变行数字，未提供可供历史上下文 FK 的版本实体。
- `CONTEXT.md:165–175,263–284` 区分主题／画像、概览、Skill 和明确表达偏好。077 已支持本人／联系人 L2/L3；L2 段与 L3 条目结构不同，推断及矛盾必须保留类型和不确定性。
- `074:18–29`、`scenarios/service.ts:682–699`、`profiles/service.ts:812–844` 保存一致 L2 版本集合及可选 L3，不能只靠各篇当前版本指针。
- `103:22–39` 已将发布 Skill 正文、描述、方法指令和资源清单移出数据库；数据库保留业务身份、不可变文件锚点、映射和资格。不能借重建恢复双份可改正文。
- DSH Skill 声明、锁与实际包为 0.2.1-rc.2；公开注册合同已与固定源码 687f282e8625c6b8d11ff58211a90524be2e4317 的 skill/src/index.ts:247–266,390–422 核对，制品与源码可复现等价未证明。本项不更改官方 provider API。
- `organization-quality-store.ts:42–151` 等存在质量数据消费者；不能把所有诊断表当日志删除。未发现 organization_quality_revocation 的 src/test 消费者，须列候选不建／待覆盖审计，不冒称已用。

### A. owner_collection_state：合并弱一对一集合状态

主键／FK：`owner_id → owner`。字段：`preference_set_revision,skill_catalog_revision,skill_policy_revision`，均非负、各自单调。

对应旧 065 expression_preference_state、008 skill_library 和 070 skill_policy_state 的同 owner 状态壳。只合并存储，不把三个含义合成一个 revision；偏好数、最大单条版本和最大政策版本都不能代替集合修订。新建 owner 时初始化，准备输入时即使选中零项也捕获集合修订，以识别随后新增的偏好／政策。

### B. 长期表达偏好

| 表 | 字段与主键 | 关系与约束 |
| --- | --- | --- |
| `expression_preference` | PK owner/preference_id；`current_version_no,head_revision,state,created_at` | 独立 owner FK；当前版本完整 FK 到本 preference。只保存身份和当前指针，不保存第二份正文或永远固定的 contact。 |
| `expression_preference_version` | PK owner/preference/version_no；`scope_kind,contact_id,reply_mode,text_content,origin_kind,source_contact_id,source_message_id,confirmed_operation_key,confirmed_at,content_state,erased_at` | FK preference、可空真实 contact、明确确认 operation；来源为 message 时直接 FK 到唯一实际 origin message。scope/contact 与 origin 的形状 CHECK 明确，正常正文非空。 |
| `preference_version_source` | PK owner/preference/version/source_contact/record_id；`qualification_at_capture` | FK 具体版本与实际 source_record；必须核验 record 已 linked 到本版 origin message，不能仅凭 record 存在。保存当时实际完整捕获支持集合。 |
| `expression_preference_operation` | PK owner/operation_key；`preference_id,kind,input_digest,expected_head_revision,result_head_revision,result_version_no,confirmed_at` | FK preference、可空同 preference 结果版本；save/update/delete 形状明确，删除不伪造有正文版本。 |

适用联系人和 reply_mode 是具体版本属性。manual 偏好从联系人改全局需用户明确操作，新版保留新范围；旧版不能随 head 改动悄悄换范围。message 来源版始终限定原联系人，修改正文不转成独立 manual 根。reply_mode=NULL 是全部输入模式，不能当沟通场景。

当前 origin 严格一条 message，直接 FK 足够，不为了形式增加消息 M:N 壳。捕获支持则确有多份，单独关系。现行 `eraseSourcePreferences` 对当时实际来源任一相交即擦除；新库继续保留此边界，不能未经决定套用 memory 的 OR 捕获支持而宣称偏好必可保留。消息未删但旧证明失效时也须正确处理完整依赖和派生副本。

同操作键输入不同冲突；旧保存操作的结果已被更新时不能恢复旧版，已删返回失效，不因历史 FK 仍在就回退 current。擦除清正文、范围、来源和 operation 摘要，推进单条与集合修订；可保留的最小封存身份及联系人删除后合法 global manual 当前版的独立依据，归 08 校核。

### C. L2/L3：共用身份和版本，保留结构差异

Q40 已确认共表：L2/L3 共用身份／版本，以 kind 保留内容差异，并维护一致发布集合。

| 表 | 字段与主键 | 关系与基数 |
| --- | --- | --- |
| `document_collection` | PK owner/collection_id；`scope_kind,contact_id,settings_generation,dirty_revision,current_publication_no,state` | owner FK＋可空 contact FK＋范围 CHECK；每 owner 范围或 contact 范围唯一。current publication 完整 FK 到本 collection。 |
| `memory_document` | PK owner/document_id；`collection_id,document_kind,created_at` | FK 同 owner collection；kind=scenario/profile，建立后固定。profile 在 collection 内条件唯一；增加 owner/collection/document 唯一超键供发布成员引用，title 不作身份。 |
| `memory_document_version` | PK owner/document/version_no；`trace_id,schema_version,title,hint,qualification_state,content_state,created_at,erased_at` | FK 本 document、真实 memory_trace；生成 scope 必须匹配 collection。版本不再有互相独立的当前指针。 |
| `document_block` | PK owner/document/version/block_no；`block_kind,text_content,section,basis,temporal_status,uncertainty` | FK 具体版本；按 scenario/profile 及 schema 检查字段形状，明确 fact/preference/inference/narrative/evolution/contradiction 等类型。 |
| `document_version_parent` | PK owner/child_doc/child_version/parent_doc/parent_version；`relation_kind` | 两端真实版本 FK；continuation/merge/split 需同 collection、兼容 kind，禁止自环／循环。普通版本数字比较不足以防跨 document 环。 |

共用 head/version 不等于把 L2 段和 L3 条目变成一个无约束正文。跨段引用、推断限定及矛盾必须能查询、展示和删除；大段非引用结构值可受控 JSON 保存，引用不能藏在 JSON。手录表达偏好和 Skill 策略不放进此派生文档表，画像也不反向冒充底层事实。

### D. 完整输入和块级引用

- 执行复用 05 的 task/step/step_attempt/model_call，完整过程复用 04 的 memory_trace/event，不再复制 scenario_batch/profile_batch 的租约、重试次数和台账。
- `trace_document_input`：PK owner/trace/input_no，字段 document_id/version_no/use_role，真实 FK 到 trace 和具体文档版本；记录 L3 实际看过的全部 L2、旧画像等版本，不只保留最终引句。
- `trace_feedback_input`：PK owner/trace/feedback_id，真实 FK 到 trace 与有效组织反馈。底层 memory_version、来源仍使用已有 trace_memory_input／trace_source_input，时点资格和全部实际参与输入不能省略。
- `document_block_reference`：PK owner/document/version/block/reference_no；字段 memory_id/memory_version_no 或 referenced_document_id/referenced_version_no，形状 CHECK 恰好一类，分别真实 FK 到具体版本。该输入必须属于本次实际 trace，展示引用不能代替完整参与窗口。当前 L2/L3 仅读取 active/latest 的已采纳记忆，不直接读取 pending candidate；source_candidate 沿既有 memory_version 来源链回查，不能伪造文档对未采纳候选的支持。

### E. document_publication：一次一致发布集合

| 表 | 字段与主键 | 关系与约束 |
| --- | --- | --- |
| `document_publication` | PK owner/collection/publication_no；`captured_dirty_revision,settings_generation,pipeline_state,created_at` | FK collection；保存一次实际发布，不能用版本数冒充来源集合修订。 |
| `document_publication_member` | PK owner/collection/publication/document_id；`version_no,member_kind,position` | 分别 FK publication、owner/collection/document 根超键及 owner/document/version 真实版本，复用同字段保证 collection 一致；一个 document 一次只选一版，profile 成员至多一个。 |

current_publication 指针决定当前 L2/L3 配套关系，各 document 不另存一套可独立修改的 current_version。新主题集合发布时画像可空；L3 完成后发布“同一 L2 集合＋新画像”的新 publication，CAS 原 publication、settings 和 dirty revision。不能把旧画像配上新主题。适用阶段未全结束，整轮仍未完成；不适用须显式 not_applicable。

dirty_revision 须随有关记忆、来源、反馈等真实变更维护；不能以通知时间或记录数冒充。旧自动 maintenance/debounce 不直接移植，新处理调度遵循已确认手动启动和暂停规则。

### F. 组织反馈与有限事实纠错保护

`organization_feedback`：PK owner/feedback_id；字段 scope、kind、operation_key、state、created_at/revoked_at、敏感 rejected_text／说明，以及两类明确目标之一：document/version/block 或 memory/version。真实 FK 与形状 CHECK 保证目标存在，纠错动作精确指向版本，不能退化成全局文本黑名单。

`organization_feedback_input`：PK owner/feedback/input_no；对保护消息、来源记录和具体记忆版本采用限定类型字段与真实 FK，记录实际保护窗口及资格。反馈不是正确事实，也不是长期表达偏好；只在仍适用的有限范围阻止旧错误重现。目标修订／退役后的撤销规则、真实删除后最小 guard 与封存键由 08 闭合，不把 078／085 的真实消费者当迁移残留省略。

### G. 无正文概览与导航投影

063 概览当前由 `overview/service.ts:23–89` 在读取时从合法底层资料派生，projection 保存指纹、来源清单和 built_at；它不是 L2/L3 正文版本。

暂保留最小 `overview_projection`：PK owner/projection_id；scope_kind/contact_id、projection_revision、rule_version、built_at、state，范围唯一。`overview_projection_member`：PK owner/projection/member_no，采用具体 memory_version／candidate／source_record 等真实类型 FK，按实际消费者保存无正文枚举和定位，不存概括正文或原话副本。

是否最终只计算不持久化，需核对 built_at/revision API 消费和实际负载再决定；本轮不做无测量的性能或删除改动。投影可重建不等于来源清理可异步漏掉它。

### H. 已发布 Skill：文件权威、数据库业务身份与锚点

| 表 | 字段与主键 | 关系与边界 |
| --- | --- | --- |
| `reply_skill` | PK owner/skill_id；`name,catalog_state,current_version_no,head_revision,enabled,verification_state,source_kind,worktree_locator,created_at` | owner FK；proposed/installed/deleted 分开。retained_unverified 只用于无法确认来源／审核／启用资格的保留条目，不整体套用。enabled 的确认值 true/false 与未知 NULL 区分，未知不得伪装用户停用；已安装 name 在 owner 内唯一。current version 只可指本 Skill 的合法发布版。 |
| `reply_skill_version` | PK owner/skill/version_no；`origin_kind,file_state,content_locator,document_digest,content_digest,manifest_digest,method_manifest_locator,method_manifest_digest,review_id,approve_operation_key,scope_kind,contact_id,scene,created_at,erased_at` | FK Skill、可空 contact，明确 owner/contact/scene 范围形状；reviewed 版必有真实 review／批准操作及来源。独立目录包不伪造审核；正文、方法标题指令和资源清单由不可变文件提供，不复制进 DB。 |
| `reply_method` | PK owner/method_id；`birth_skill_id,semantic_key_digest,created_at` | FK 真实 Skill 根，允许 proposed 草稿预分配身份，避免指向尚不存在的 logical_skill。名称和语义摘要不替代身份。 |
| `skill_version_method` | PK owner/skill/version/method_id；`method_order` | 两端真实 FK 到 version 和 method，顺序在版本内唯一；方法正文由文件按需读。 |
| `skill_method_parent` | PK owner/child_method/parent_method；`relation_kind,approval_operation_key` | 两端真实 method FK＋批准操作 FK；跨 Skill 合并须合法同 owner，禁止自环／循环。 |
| `skill_parent` | PK owner/child_skill/parent_skill；`approval_operation_key` | 真实根身份和明确合并来历；配合方法父边继承祖先停用政策。 |

proposed Skill 根只是待审核身份，不提前占用已安装名称／启用资格；未批准策略不进入 provider。保留目录逐项核验：可可靠确认的业务关联和启用／停用状态按核验事实接回，不默认全部停用；来源、审核或启用状态无法确认的单独 unverified，并标明待核验原因，不能伪造 reviewed FK 或把未知写成已停用／已启用。方法更新、改名、合并或回滚不能绕过历史停用。发布版的完整私密取材链必须能从 review→draft revision→learning input 回查，不能只留下 source_locator 字符串。

### I. Skill 停用政策与实际使用

- `skill_scope_policy`：PK owner/policy_id；skill_id 必填，method_id 可空，scope_kind owner/contact/scene、contact_id、精确 scene、revision。FK 到真实 Skill／方法／可空 contact，额外验证方法属于目标 Skill 的当前或合法祖先关系。政策存在表达停用；撤销移除相应限制，不默认启用已全局关闭的 Skill。
- `skill_policy_operation`：PK owner/operation_key；policy_id、kind、request_digest、expected/result policy revision、确认时间，真实引用目标政策或可保留的最小决定身份。范围形状、含 NULL 唯一性和删除后封存须明确验证，不能用反馈原话建政策。
- `skill_use`：PK owner/use_id；使用场景、实际 Skill/version、catalog/policy revisions；以明确 FK 区分 assistant context 与 review side，恰好一个来源。`skill_use_method`：PK owner/use/method，真实 FK 到所用版本的方法成员。允许、读取和模型报告使用的含义区分，不声称读取或复制证明效果／发送。
- 即使没有选中 Skill，也在实际上下文记录 catalog/policy 集合修订及 none 结果，不能让准备后新增政策绕过复验。

### J. 授权经验、草稿与同输入审核

| 表／关系 | 主键与主要字段 | 真正的独立意义 |
| --- | --- | --- |
| `skill_learning_scope` | PK owner/contact；enabled、revision、confirmed_at | 默认关闭的独立学习授权；同步或记忆处理按钮不提供该授权。 |
| `skill_learning_operation` | PK owner/contact/operation_key；enabled、expected/result revision | 明确授权动作幂等，旧动作不得覆盖后来关闭。 |
| `skill_learning_batch` | PK owner/contact/batch_id；batch_key、真实 task/step、state、outcome、可空 draft_id/revision | 有限实际批次，复用共享执行和调用账目；输出指针同范围 FK，允许与后生成草稿在事务末闭合。批次元数据不放完整聊天或 prompt。 |
| `skill_learning_input` | PK owner/contact/batch/input_no；material_key、kind、具体引用字段 | FK 本 batch 与同 batch 的材料 receipt 超键；assistant_turn、candidate_version、selection、可靠后续 message、memory_version、preference_version、source_record 和合法 Skill 版本分别真实 FK。 |
| `skill_learning_receipt` | PK owner/contact/material_key；batch_id、state、outcome、资格摘要 | material_key 由实际固定材料及用途合同定义，非随意 UUID；owner/contact/batch/material_key 为唯一超键供 input 引用，真实 FK 到 batch。准备时可 pending 预约；成功必须有本批对应的真实输入组件并完成资格复验，才可提交 draft/no_change/reuse，跨行约束不能只靠字符串约定。 |
| `skill_draft` | PK owner/contact/draft_id；logical_skill_id、current_revision、state | FK proposed/installed Skill 根；不与已发布版本混同。 |
| `skill_draft_version` | PK owner/contact/draft/revision；proposal_kind、strategy、private_evidence、batch_id、content_state | FK 真实 batch；清洗策略与私人依据分开值，不让私人依据进入发布正文或普通日志。 |
| `skill_draft_target` | PK owner/contact/draft/revision/target_skill/target_version | 两端真实 FK，替换 target_versions JSON；update/merge 的实际目标版本可核验。 |
| `skill_review` | PK owner/contact/review_id；draft_id/revision、operation_key、frozen_input、common_context、contract_version、catalog/preference/policy revisions、scope、state | 真实 FK draft revision；加 UNIQUE(owner,review_id) 供发布版引用，取材 contact 始终沿真实 review 回查。本次审核输入与共同上下文冻结一次，review_id 即冻结输入身份，不另造弱1:1壳。 |
| `skill_review_input` | PK owner/contact/review/input_no；kind、具体引用字段 | 对本次实际 memory/document/preference/Skill 版本和来源建立真实 FK；不是只继承旧助手材料清单。 |
| `skill_review_target` | PK owner/contact/review/skill/version | FK review 与真实目标版本，与冻结 draft／明确范围核对。 |
| `skill_review_side` | PK owner/contact/review/side；task_id/step_no、result_attempt_no、strategy_kind、published_skill_id/version_no 或 draft_id/revision、output | 两侧 FK 同一 review、真实 step 及真正产出结果的 step_attempt，策略 FK 指向具体 published version 或 draft revision；before 可 no_skill，形状 CHECK 保证类型。共同上下文只保存一次，不从后来变化的 current_attempt 猜旧输出。 |
| `skill_review_result_call` | PK owner/contact/review/side/call_id | FK side、真实 model_call 及 step_model_call 关联；验证消费链属于 side.result_attempt_no。复用相同执行字段的候选键或触发器实现，不存 call ID 数组。 |

review 当前允许用户新提供 incoming_text/intent/scene，`skill-review-service.ts:59–100,202–225,257–271` 并不要求已有助手会话；不得伪造 assistant_turn 来复用 06 的外键。它需要自己的冻结输入和类型关系，业务审核也不等同一次执行 attempt。来源、旧策略或草稿修订变化后旧审核不再直接可发布。

### K. 发布、回滚、工作目录投影与文件清理

`skill_catalog_operation`：PK owner/operation_key；kind、request_digest、expected_catalog_revision、expected_current_version、result_skill/version、可空 review_id、明确 scope 和 state。各引用均为完整 Skill/version 或 review FK，按 origin/kind CHECK；保存幂等批准、安装、更新、合并、删除和回滚的必要决定。版本的固定批准来历并入 version，不再照搬旧 1:1 publication 壳。操作删除／回滚不恢复已删文件、不重启停用、不把其他合并目标同时恢复。

准备不可变文件后，短事务复验授权、目标当前版本、草稿修订、review、集合修订和全部来源，原子发布版本、方法映射、批准回执及当前指针。文件已准备而事务失败的暂存同样受管；不能声称文件和 SQLite 天然共享事务。

工作目录回写若需要恢复，保留 `skill_worktree_projection`：PK owner/operation_key/skill_id；真实 published version FK、expected_worktree_digest、state。它是非权威投影任务，不覆盖用户并发修改；可复用 05 任务步骤，不能变成第二份可修改正文权威。

`skill_file_cleanup_target` 归 08 删除操作：真实 FK 到删除操作，独立保存受管定位、同操作身份和结果，不随 live Skill/version 级联消失。先撤销资格并登记清理，再事务外清盘；失败保留目标。来源、偏好、记忆或助手删除会穿透草稿、审核、已发布文件／方法、跨联系人使用及恢复副本；去身份不提供独立保留例外。用户原始目录和外部文件按既有范围保护，不擅自扩张清理目标。

### L. 空库与保留 Skill 目录：阻止孤儿误删及来源洗白

`skill-library.ts:200–207,239–252` 扫描前会 reconcile，并做缺数据库引用的隐藏快照／暂存清理（`skill-cleanup.ts:73–83`）；文件路径含旧 owner/skill/version 身份。空库不能原样运行这条路径，缺行不等于授权删除。

实施前必须：识别用户确认保留的原始目录与应用敏感副本、核验 owner／路径／manifest 身份、确定新身份映射和最小目录索引重建规则，在完成前关闭孤儿删除。不可仅按目录名认领旧 owner；不能假装恢复已清空的启停政策、审核或私密来源链。旧 reviewed 文件也不能被普通扫描改称独立导入包绕过来源。

Q41 按用户明确修正版：继续使用 DSH 官方插件加载 Skill，保留原目录，只重建必要业务关联并防止误删；不默认全部停用，无法确认来源、审核或启用状态的条目单独待核验。官方加载通过既有受控 provider／薄适配接入，业务保留必要身份、范围、版本完整性锚点、启停／审核和删除关联，不另造并行加载体系，不把 Skill 正文搬进 SQLite 或因换库移动原目录。

已知启用、已知停用、启用未知是不同事实；逐项有可信证据才接回相应状态，文件存在或 manifest 完整本身不证明旧业务授权／审核。缺失来历不通过普通扫描洗成独立包，也不借“未知”给全部条目强制写 disabled。实际可证状态、未知原因及官方插件的准入适配应在 10 覆盖验证。

本轮不读取用户目录或正文，不迁入旧 PG 业务资料；保留原目录也不把应用旧敏感副本一概变成永久保留例外。实际目录身份／完整性核验、切换操作和验证在 08／10，本项不执行。

### M. 质量／诊断记录：有消费者的能力不能静默丢失

079 的 case/run/attempt 由 diagnostics 的 store/service/runtime/report/API 及正式宿主读写；fact_intent 也有 snapshot/store 消费。最小关系应保留 `quality_run`（数据集、预算、用途及报告）、`quality_case`（冻结输入和人工标注）、`quality_attempt`（case、真实调用、输出／审阅）、`quality_fact_intent`（精确纠错目标及有限衔接），全部有真实 run/case/memory version 等 FK，实际调用改接共享 model_call；敏感输入输出不是普通日志。

run 当前硬性要求 current_database 后缀 _test 且 data_kind=fixed_synthetic（store:122–142）；SQLite 不能照搬 PG 库名判断，须用隔离测试库角色／实例身份和固定合成数据门禁。本项不授权把私人案例送模型。最终主设计须核对独立诊断库或隔离测试 schema 的接线及字段覆盖，不把单业务库决定误解为测试连接用户库。

未找到消费者的 organization_quality_revocation 列候选不建；style_sample 偏好依赖已随样本退役，不因065存在就重建。其余有消费者的 feedback、保护、质量与数据依赖不能仅以“派生”省掉。

### N. 衔接前项与验证边界

- 06 的 assistant_context_item 扩展 preference_version、document_version、skill_version 的明确字段／真实 FK，保持恰好一类；另已补上回复检索实际使用的 memory_candidate 类型，必须保留待确认属性，不能冒充已采纳版本或回复草稿。Skill 方法实际使用通过 skill_use_method 核验。snapshot 捕获三个集合 revision，空选择也捕获；不能只存 head ID 或当前正文。
- 04 的 trace 增补文档和反馈的真实版本输入，05 承接组织／学习／审核执行元数据。复用执行机制不改变各自模型用途授权或来源范围。
- 删除先在事务持久化意图、硬门禁并捕获完整依赖／文件目标，再清派生与库外副本，防止迟到入库；08 统一封存键、联系人删除、手录独立根、失败重试和最小元数据规则。
- 复合 FK 的 NULL 跳过、范围条件、类型排他、发布集合一致、版本父图无环、文件身份及双重 CAS 均须逐项物理验证；本文没有运行合成 SQLite 或端到端验收。
- 索引按实际反向查找建在偏好来源、文档版本输入／发布成员、方法祖先、政策范围、草稿／审核目标、真实使用与待清文件，不把 source_ids 或 target_versions JSON 当可执行关系。

## 本轮决定与后续校核

- Q40 已确认 A：场景文档和长期画像共用 memory_document / memory_document_version，以 kind 区分并保留块结构和依赖；publication/member 保证版本配套。
- Q41 已确认用户修正版 A：继续用 DSH 官方插件，保留原目录，只重建必要业务关联并防止误删；不默认全部停用，仅无法确认来源、审核或启用状态的条目标为待核验。实际扫描与切换留后续实施。

## Answer

2026-10-28，本项形成删除一致性与物理主设计使用的偏好、派生文档和 Skill 逻辑基线。

**用户明确决定**：Q40 选择 A，L2/L3 共用身份与版本表。Q41 在 A 上明确修正：“继续用 DSH 官方插件加载 Skill，保留原目录，只重建必要的业务关联并防止误删。不默认全部停用；无法确认来源、审核或启用状态的，单独标为待核验。”按此原意执行，不保留原提案的旧包一律停用默认。

**工程建模结论**：明确表达偏好独立身份、版本及来源，适用范围随版本保存；三个集合计数器共用 owner_collection_state 但含义独立。主题／画像共用文档根、版本和类型化块，以 publication/member 固定一致集合，执行／完整追踪复用前项。Skill 正文仍以原目录和不可变文件合同为权威，业务保留必要版本／方法／政策、草稿／审核及真实来源关系；官方 provider 加载不由另一套目录加载机制替代。可核验的启用／停用按事实接回，无法核验的状态单独记录 unknown／待核验，不能整体置 disabled，也不能猜测为已启用。

**必须继续闭合的合同**：08 的来源删除闭包、封存键、独立手录根和库外目标；10 的保留目录／owner 身份映射、最小关联重建、逐项状态证据与未知项准入、禁用孤儿误删、官方插件接线、诊断测试库门禁及全部字段／FK／触发器与访问负载验证。resolved 只表示本轮逻辑决定完成，不表示实际 Skill 已核验或已开始切换。

**验证**：三项独立只读代码／固定版本接口查证和文档审查；修正审核范围超键、真实结果 attempt/call、材料预约依赖与 pending 记忆候选类型，并检查链接、空白、状态和依赖。未执行 SQL／模型／App，未扫描用户目录、改动原 Skill 文件或读取旧 PG 资料。

## Comments

- 本任务只产生设计决定或事实查证；表数不是硬指标。沿用仓库隐私、手动发送和桌面热更新约束，不读取私人资料，不执行真实删库，不做远端操作。
- 三项独立只读查证与文档审查完成：偏好来源和集合修订、L2/L3一致发布与质量消费者、Skill目录／政策／审核来源均有代码依据；已补齐review owner唯一超键、结果attempt/call链和材料预约到实际输入的约束，并修正06中pending记忆候选的真实类型引用。未运行SQL／App，未扫描用户目录。
