# 领域与数据契约的历史记录

> 用途：追溯文档整理前的字段布局、阶段状态与显式历史协议。现行要求见[领域与数据契约](../current/domain-data.md)。下列摘录保留当时措辞；采纳、实施或未完成等状态只描述各自记录时点，不能作为当前要求或验收证明。

## 阶段状态与实施说明

原 `architecture/current/domain-data.md:3–13`：

> 微信重复扫描按 [ADR-128](../adr/128-deduplicated-wechat-message-storage.md)改为消息去重、保留必要来源及撤回状态；这是已采纳、待实施的目标，不要求为每次观察保留正文副本。

> 联系人身份与逐人授权按 [ADR-110](../adr/110-selected-sqlite-contact-read-grants.md)：不延续旧授权、不启用全部私聊，取消立即封禁旧资格；首用搁置不取消授权核验。

> 当前业务存储为受控本机 SQLite，由 TypeScript 后台注册迁移并装配联系人、来源、消息、记忆和删除操作；具体实现状态与验收范围见 [ADR-109](../adr/109-controlled-sqlite-storage-foundation.md)及切换记录。来源、范围、删除及 DSH 约束继续适用。

> 2026-10-21 决定收敛：新增联系人按 [ADR-087](../adr/087-wechat-confirmed-contact-onboarding.md)及 [ADR-089](../adr/089-all-private-wechat-sync-scope.md)从真实微信会话加入，支持逐会话确认或全部私聊范围授权，独立创建与导入新建的旧接口待退役；历史 `manual_create` 记录保留读取与删除语义。默认自动采纳按 [ADR-085](../adr/085-source-verified-automatic-adoption.md) 取消额外语用、置信度和风险人工门；下文标明的历史协议及评测不得当作默认流水线。

> 状态：已采纳的产品约束；当前独立版以本机 SQLite 作为业务存储，实例身份、迁移与具名动作见 [SQLite 存储合同](../../backend-ts/src/storage/sqlite/README.md)。本文描述关系数据边界，不代替代码与验收证明。

> 后续目标：记忆时间状态、可追溯概览与自动 Skill 生命周期由[ADR-048](../adr/048-memory-skill-evolution-lifecycle.md)及[正式规格](../../.scratch/memory-skill-evolution/spec.md)局部细化；独立集成候选现已完成联系人与本人概览的合成验证，下方 v1 数据对象仍描述基础约束；真实模型质量与实际 App／微信另验。

原 `architecture/current/domain-data.md:179–179`：

- 实现状态：ADR-081 是2026-10-20确认的后续目标，工程和质量结果见[实现索引](../../.scratch/memory-temporal-semantics/planning.md)。2026-10-05的旧默认期限提示与冻结评测保留为历史证据，不作为新默认规则；新代码逐票验证，不能用文档推断已上线。

原 `architecture/current/domain-data.md:200–200`：

固定 main 的独立集成候选现已复用源票01的读取时派生：`current_status` 区分历史、当前未核实、当期区间和稳定资料，原因随生成快照保留；当期区间只核实原话时间适用范围，不认证现实真伪。旧临时状态无结束时间保持当前未核实，稳定事实采用有限确定性识别，不为所有资料统一设置寿命。原事实、采纳决定、有效期及来源不回写，合成验证与真实语义质量分开。

原 `architecture/current/domain-data.md:243–245`：

[正式集成02](../../.scratch/memory-skill-integration-preparation/issues/02-correction-and-erasure.md)已接入人工纠错与否决保护；后续主线工程签收见[演进任务索引](../../.scratch/memory-skill-evolution/planning.md)，原独立候选状态仅属阶段记录。相同规范消息上的旧证据不能因正文、分类、主题或主体改写而重新自动采纳；新增来源引用不等于新增规范消息。真正新消息只产生带原人工决定的待确认差异，确认时在范围锁事务中复验完整参与窗口、来源世代和完整决定标识。自动替代只作用于原先确切的自动版本，新版本写入与旧版本失效同事务提交，不追随新人工叶版本。

该记录只说明当时的合成 HTTP 与页面验证行为；自动维护由 ADR-070 后续修订，不能据此认证真实模型质量或最终 App／微信能力。

原 `architecture/current/domain-data.md:305–305`：

- 08 的联系人物理清理适配入口先按 contact→owner 锁清理该联系人偏好的完整派生闭包，再去除无正文墓碑的联系人身份并物理清除联系人；保留owner级失效操作身份，拒绝旧全局保存操作重放。全局偏好曾用于其他联系人而后收窄范围的历史依赖同样清除。偏好外键使用 RESTRICT，避免直接 SQL 绕过闭包；当前没有整体联系人删除产品入口，该适配器不代表此产品流程已经交付。

## 旧对象字段与协议布局

原 `architecture/current/domain-data.md:31–54`：

| 对象 | 必要职责 | 关键关联 |
| --- | --- | --- |
| `owner` | 资料所属用户。 | `owner_id` 是所有私密数据的第一层隔离键。 |
| `owner_channel_identity` | owner 在外部聊天渠道中的已验证身份。 | 通过 `owner_id` 关联；`external_id` 是渠道标识，不是 `owner_id`；同一 owner/channel v1 只保留一个 active 身份。 |
| `owner_memory` | 用户本人的长期事实资料，跨联系人范围的回复都可使用（见 `CONTEXT.md` 的“本人记忆”）。 | 属于 owner，不绑定 `contact_id`；与联系人关系记忆使用同一评分器、阈值和排序，但使用独立的 3 条/240 字符预算，不固定全量加载。 |
| `contact` | 用户逐会话确认或在已授权全部私聊范围内按稳定渠道身份加入的真实关系对象；已有历史身份保留，不以任意展示名称或文件导入新建。 | `contact_id` 是 NotAlone 创建的稳定内部身份；昵称、备注和渠道身份是可变或可重新确认的信息。 |
| `conversation_binding` | 用户授权范围内经稳定身份核验的桌面聊天会话与联系人的绑定。 | 保存聊天 App、账号范围、外部会话定位标识、display name 映射、绑定状态与最近验证时间；历史选中会话元数据与视觉指纹字段仅供兼容，不构成当前采集授权；已建立且唯一的映射可自动切换，不能把 display name、视觉指纹或 `talker` 当作 `contact_id`。 |
| `sync_scope` | 用户确认的微信后台同步范围，默认仅所选会话，明确授权后可为全部私聊。 | 按 `owner_id + channel + account_scope` 保存；换账号不继承范围，撤销／删除排除决定独立保留；切回仅所选不删除有效绑定。 |
| `source_document` | 一次原始导入的文本、截图或语音原始引用。 | 属于一个联系人；保留来源定位、导入时间、导出器名称与版本（可获取时）、用户确认范围、确认时间、确认方式和删除状态。 |
| `FreshForegroundObservation` | 当前前台定位的一次瞬时内存结果，不是数据库实体。 | 含观察标识、时点、阶段及可选名称／置信度；仅 `confirmed` 阶段携带已核验的 `contact_id` 与 `binding_id`。owner／渠道账号范围由后端固定运行身份核验，不接受调用方注入；不保存原始帧或观察历史，不产生 CLI 消息正文。 |
| `local_wechat_observation` | 本地微信 CLI 从一个外部会话读取的一次文字增量来源记录。 | 显式关联 `owner_id + contact_id + conversation_binding`，保存外部会话定位标识、CLI 版本、`local_id`/`cursor`、读取时间、`from_me`/sender 和 `capture_mode`（live/cli_catchup）；不保存全量导出文件。 |
| `background_task` | 一次完整的长时后台工作，取代独立的导入/删除/重建任务表。 | `type` 区分 import/delete/reindex；`scope` 声明作用域（account/contact/source）；状态为 `queued/running/verifying/succeeded/failed/cancelled`，记录总体进度、失败原因、重试与关联来源。删除任务不得跨越隔离边界。 |
| `background_task_step` | `background_task` 下可恢复、可重试的固定执行步骤。 | 关联父任务并保存 `step_type`、顺序、状态、尝试次数、输入/输出业务引用、错误分类和 Worker 租约；不保存完整聊天正文。只用于确实需要逐步恢复或展示进度的长任务。 |
| `message` | 统一的规范化聊天消息，保留文字、图片等消息类型及来源关系。 | 显式冗余 `owner_id + contact_id`，并保存说话人、正文或明确的媒体占位信息、可用时间戳；来源字段（`source_document` 或 `local_wechat_observation`）仅用于定位与删除，不承担隔离过滤。渠道专属字段不是所有消息的必填字段。 |
| `memory_candidate` | 模型或规则从资料中提取的待采纳关系线索。 | 关联证据消息并保留 `self/contact/shared` 主体；不能被检索为已知事实。 |
| `confirmed_memory` | 自动采纳或手动录入的共同事实、偏好、禁忌、关系资料。 | 关联一个或多个来源证据、采纳方式（auto/manual）、删除状态、分类与有效期；不保存固定常驻模式。 |
| `contact_memory_index` | 当前联系人有效关系记忆的精简主题目录。 | 按 `owner_id + contact_id` 隔离，由固定主分类和系统自动生成的子主题组成；是可重建投影，不是新的事实源；召回第一期不再用它筛选候选，只提供 `memory_revision` 快照用于生成前后复验。 |
| `relationship_overview_projection` | 联系人与本人资料的可重建依赖清单。 | 联系人按 `owner_id + contact_id`、本人按 `owner_id` 独立构建；保存底层 ID、revision、状态、摘要、来源世代与实际构建时间，不保存正文、原话或模型摘要；回复只沿清单导航到合法底层依据。 |
| `reply_skill` | Skill 库中的一份独立回复策略目录项。 | 属于 owner；当前用户导入的 Skill 默认全局适用，名称在同一 owner 内唯一，保存简述、来源类型、状态和当前版本。一个 `reply_skill` 只代表一种策略。 |
| `reply_skill_version` | 一次不可变的回复 Skill 正文快照。 | 按 ADR-096，发布后文件快照不可修改；数据库保存受控文件定位、来源定位、内容摘要和校验结果，正文留在目录，更新产生新版本。删除清除文件、来源定位和关联资源，并保留最小删除记录。Skill 声明不能扩大可执行 Tool 或权限。 |
| `reply_skill_resource` | 与一个不可变 Skill 版本绑定的受控辅助资源。 | 保存包内相对路径、媒体类型、大小、内容哈希和内容定位；只允许按需只读加载，不能执行、外部下载或跨范围读取。 |
| `reply_request` | 一次面向已确认联系人的表达生成请求。正常工作区按 ADR-079 继续使用 `RewriteDraft`／`rewrite_draft` 请求外壳，以 `input_kind=workspace` 和 `workspace_action=express|suggest` 区分输入及动作；建议候选不预设用户已经确认其意图。旧 `draft`／`current_chat` 输入分支及旧回复／主动联系页面合同保留历史与内部兼容。 | 固定所属联系人，内嵌本次实际检索到的上下文快照（`retrieved_context`），并记录幂等请求键、请求状态、输入模式、动作与本次输入来源（草稿/直接输入/模型建议，明确区分是否经用户确认）、可空的显式前序候选、实际使用的 `skill_version_id`、选择原因与置信度。 |
| `reply_candidate` | 模型给出的可编辑候选回复及风险说明。 | 关联一次回复请求；不会自动发送。 |
| `retrieved_context` | 本次回复实际使用的检索上下文快照（作为 `reply_request` 内嵌结构）。 | 含隔离键、检索条件（时间窗口、关键词、limit）、引用列表与排序分数，用于"为什么用了这些上下文"的回看。 |

原 `architecture/current/domain-data.md:113–115`：

- v1 只实现单用户、单微信账号下的联系人导入，不实现跨账号或跨渠道联系人合并。即使如此，`contact_id` 仍由 NotAlone 创建；`sender_wxid` 等外部标识只作为渠道身份或来源元数据保存（见 ADR-008）。
- `owner_id` 只能来自 NotAlone 当前运行身份：本地个人版本可读取受控配置，服务器版本必须来自已验证登录身份。首次导入可以在用户显式初始化动作中生成 owner，并把文件中的本人渠道身份保存为 `owner_channel_identity`；导入文件不能直接指定或覆盖 `owner_id`。
- App 首次连接微信也可按 [ADR-095](../adr/095-first-wechat-connection-and-account-grant.md)从已配置工具的只读核验结果建立本人渠道身份，用户一次明确确认后与全部私聊范围和开启状态原子保存；不接受任意填写的账号，不以展示名称匹配本人，不覆盖已撤销、其他 owner 或不同账号身份。重复恢复保留授权起点、排除记录及用户后续开关决定。

原 `architecture/current/domain-data.md:126–126`：

- `background_task` 表示用户看到的一次完整工作；`background_task_step` 表示其中一个可单独恢复的执行单元。短回复和单次轻量操作不得为了统一形式强行拆步骤。

原 `architecture/current/domain-data.md:204–224`：

`GET /api/memories/owner/overview` 使用相同版本一投影合同，`scope_kind=owner`、
`contact_id=null`，每项沿用现有本人记忆 DTO、来源与真实当前叶。只水合本人资料表中
已保存的 `common_fact`、`preference`、`taboo` 及其合法历史，不汇总联系人资料或
pending 候选，不将近期状态或关系备注归纳为人格。原 `stable`、`historical`、
`current_unverified` 分别保留，矛盾主张按原条目呈现，不生成新的性格、动机或事实结论。

已知原候选必须仍属同 owner 的 SELF；修正后也沿真实原版本链核对该身份。旧候选、
事件及版本依据 NULL 保持未知，不用当前引用或后续人工决定填补过去窗口。手录来历
须有合法本人手录根链；含聊天依据的后续版本继续继承聊天删除依赖。逐项查看、修正、
删除沿既有本人版本与资料入口进行，概览没有独立事实写入接口。

本人来源只返回真实来源、消息、引用 ID 和经核对的原 `contact_id`，手录根为 null；
`locator` 固定为 null，不复制另一关系的原话、姓名或定位文本。原话和提取过程仍须
回到该已确认联系人范围逐项查看，不能用当前联系人或昵称猜原范围，不能自动切换。

canonical 062 为本人资料集合保存单调 `memory_revision`，实际写入、修正和删除在原
owner 锁事务中递增，回滚及真实 no-op 不递增。旧集合从 0 开始，不重解释资料；
此数字表示整个本人资料集合修订，不能当成条目计数。canonical 061 无正文依赖清单继续共用，
来源、完整原窗口、人工决定或本人版本变化后原子失效，`projection_revision` 再绑定
完整参与资料与当前时间投影。回复可在独立本人预算内沿其导航到合法本人资料，
不向模型复制概览、不追原 contact 补查原话，也不自动建立长期表达偏好。

原 `architecture/current/domain-data.md:249–264`：

v1 逻辑上每位联系人只有一份当前 `contact_memory_index`。具体使用单表还是关联表留到实现时确定，但必须包含：

- `owner_id + contact_id`：目录所属范围。
- `built_from_memory_revision`：生成目录时对应的联系人记忆版本。
- `status`、`created_at`、`updated_at`：目录是否可用及其生成时间。
- `topics`：自动生成的主题目录；每项只含 `category`、一行 `topic_summary` 和对应的 `memory_ids`。
- 目录最多保留少量主题入口（v1 建议上限 20 个）；它不复制记忆正文，命中后按 `memory_ids` 重新读取事实。

每位联系人的关系记忆集合维护单调递增的 `memory_revision`。新增、修正、删除、重新分类或修改有效期时必须递增；版本号只用于检测目录是否过期，不要求每次变化都立即完整重建。只有 `status` 可用且 `built_from_memory_revision` 等于当前 `memory_revision` 的目录才参与版本复验，否则标记待更新并由合并后的任务处理。

召回第一期的候选直接来自 L1 的当前有效记忆，由正文词法评分选择；`topic_summary` 仍只是导航提示，不是关系事实，也不再是选择的必经路径。任何进入回复上下文的记忆都必须重新校验 `owner_id + contact_id`（本人记忆只校验 `owner_id`）、状态和有效期；目录版本通过 `memory_revision` 快照在生成前后复验。本人记忆由 owner 范围单独选择，不复制到每位联系人的目录中。

ADR-048 的概览导航继续复用上述检索接口和词法排序；请求指定的底层 ID 有界，
历史模式不能变成全历史扫描。快照保存生成时的导航修订及全部实际参与依赖，外部
回执只描述模型可见的最终输入。缺失或 null 的旧回执不补成“已查空”或“已查到”，
原版本证明缺失也不能借新来源恢复；实际底层读取仍是正文和来源的权威。

## 显式历史采纳与有限证明协议

原 `architecture/current/domain-data.md:136–143`：

- [ADR-047](../adr/superseded/047-bounded-source-semantic-proof.md)已批准版本二的可空语义依据合同，现已实现并完成隔离验证；由服务端独立核完整关系，未名指称不能靠模板推归属。另按[ADR-060](../adr/superseded/060-author-arrival-quote-representation.md)增加可信单消息完整作者引句的有限包装分支，该分支单独保存无正文的来源全文／包装全文与内外层作者定位，能力由服务端逐项核定，不因依据非空或引句对齐即签全部维度。版本1／旧NULL不升级，业务迁移与真实质量资格分别验证。
- [ADR-063](../adr/063-bounded-runtime-evidence-and-source-dependencies.md)已采纳并完成隔离工程验证的新记录合同，将完整窗口的新鲜度依赖与正文成立的必需消息区分。新evidence4记录原target集合并逐项核能力，候选、确认资料及本人资料持久保留一组必需消息的合取依赖；同消息的多个有效来源仍互为替代。确认、修正版、拒绝指纹及owner回退不得丢失该依赖；旧记录继续沿原替代来源语义，不回填或重解释。
- 显式历史采纳协议允许满足置信度与风险门槛、并落在**已放行维度**上的模型提取记忆自动写入（见 ADR-002、ADR-024、ADR-036）：必须带来源证据、标记 `auto`、可一键撤销；带敏感或未知风险标签的候选必须先留在 `pending`，用户手动录入或修正时标记 `manual`。模型不能未经来源证据直接写入。
- `confirmed_memory` 保留候选来源链：记录从哪个 `memory_candidate` 采纳而来（`source_candidate_id`，手动创建时为空），同时保留来源证据列表；采纳后仍可回看候选证据与采纳方式。
- 显式历史语用协议（非所有默认直接提取的统一流水线）：模型必须在有限的同联系人窗口中结构化标记说话行为、断言状态和修辞状态；确定性规则只允许“确定、字面、非歧义陈述”进入自动采纳门，计划、假设、条件、转述、纠正和未知状态只能留在 `pending`，问题、玩笑、讽刺和夸张默认不生成长期候选（见 [语用解释规格](../current/pragmatic-interpretation.md) 与 ADR-026）。
- 语用解释不能证明现实世界真伪；模型不返回记忆状态或写库动作。当前实现将语用阻塞原因以 `pragmatic:*` 风险标签保留在候选中，结构化备选解释和用户可见理由属于提取结果，不得写入完整模型提示词或内部推理。
- 来源语义核验逐条核对正文、主体与限定，核验证据片段必须来自候选既有来源且包含主消息。显式历史协议按 ADR-033 在支持时继续原采纳门，未知追加 `semantic:*` 风险，无支持拒绝；默认路径按 ADR-085 自动裁决，失败终结且保留关系矛盾待定例外。所有路径中未核验候选均不得自动采纳。不新增永久“已核验正确”标签，不回填旧资料。核验正文的临时留存限制已由 ADR-037 修订为独立、可删除的完整提取追踪，要求见 [记忆提取完整追踪](../current/memory-extraction-trace.md)，实现状态以代码与验证为准。
- `rejected`/`invalidated` 候选随其来源删除，或短期保留供用户复核后清除；不长期堆积，与来源级删除语义一致。

## 旧前台与待决记录

原 `architecture/current/domain-data.md:280–280`：

`message` 必须显式冗余 `owner_id + contact_id`，不得仅通过 `source_document` 或 `local_wechat_observation` 间接推导；检索过滤必须基于 `message` 自身携带的隔离键，而不是依赖来源关联。

原 `architecture/current/domain-data.md:309–310`：

- 业务库主键的具体编码、本机加密方式和备份策略；云端对象存储已随云端工程取消。
- 高风险规则的具体关键词/类型枚举（见 ADR-024；判定放独立适配层，实现时细化）。
