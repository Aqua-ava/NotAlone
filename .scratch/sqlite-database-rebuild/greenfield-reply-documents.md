# 从事实重建：助手讨论、候选、明确偏好与关系文档

状态：逻辑设计首稿，接口待主设计整合。不是实施票、DDL、最终表数或已实现能力。本次只读两份 spec 和必要工作流，未读旧 PG 表、旧表盘点或旧候选设计；不迁旧业务资料，不以表数为目标。

## 依据与边界

- `.scratch/sqlite-database-rebuild/spec.md`：关系设计要求；Q29 完整追踪；Q30 同库隔离；Q36 本人与联系人记忆共结构；Q39 候选统一版本；Q40 场景／画像共结构及一致发布；Q42 删除；Q43 暂缓跨业务共享材料。
- `.scratch/sync-memory-behavior/spec.md`：US-17、US-26、US-27、US-28，记忆处理和清空与跨存储清理段落。处理范围、实际参与前文、手动模型调用门禁及来源删除继续适用。
- 根规则：回复属于已确认联系人；自动资料不冒充用户确认；一次性要求不静默转为长期偏好；最终消息由用户亲自发送。
- 下文明确区分已确认事实、满足事实的结构提案和待证事实。两份规格没有详细定义助手全部交互、偏好语法、持续组织纠错保护或诊断评估保留强度，不据此擅自删减，也不默认增加整套子系统。
- DSH、Skill、实际调用输入、运行时读取事件、消息／记忆版本、处理轮次和删除操作由其他分支设计。本文只给业务关联必须使用的准确键合同，不设计其运行时底层。

## 事实卡：先确认身份、函数依赖、基数和生命周期

| 事实卡 | 已确认事实与结构推导 | 唯一身份、函数依赖和基数 | 历史与生命周期 |
| --- | --- | --- | --- |
| F1 助手讨论 | 讨论及输入属于删除范围，回复必须绑定已核验联系人。建议业务讨论固定属于一个 owner＋contact，换人建立另一讨论；这是防串人的结构提案，不把它写成已确认的界面限制 | 讨论 ID、消息 ID、消息版本 ID。一个联系人 1:N 讨论，讨论 1:N 消息，消息 1:N 版本。message_id→discussion、role、position；(message_id,version_no)→body、origin | 修改不能重写已被调用引用的版本。联系人范围失效即停读停写；来源删除覆盖受影响正文版本及库外会话，不按 user／assistant 角色猜哪些可保留 |
| F2 候选版本 | Q39：模型原稿从 v1 开始，与手工编辑稿同结构；候选身份表不放正文 | 候选 ID、版本 ID。请求 1:N 候选，候选 1:N 版本，一次调用可输出多个候选。(candidate_id,version_no)→body、parent、origin。同文不是同身份 | 版本不可原地改文。version_no 表示保存次序，parent 表示从哪稿编辑，不能猜为上一版本；编辑不自动洗掉原来源依赖 |
| F3 明确选择 | 明确选择引用准确版本；选择、编辑、复制不证明外部发送 | selection_id→request_version、candidate_version、selected_at。版本 1:N 选择事件；同一请求可先后选择不同稿 | 编辑后旧选择不自动漂移到新稿。不建产品发送能力，不据复制写 sent／delivered。未证明需要复制账本 |
| F4 计划与真实输入 | 计划可用材料不等于真实调用最终输入。一个请求可能多次调用和动态读取 Skill | plan ID、call ID／input-part ID、read-event ID 分别唯一。一个计划可对应多个调用，但不默认其材料都实际使用。input_part_id→准确负载、顺序、版本与来源 | 动态读取需保留每次时点和准确文件版，不能拿当前文件反推。来源删除遍历完整实际输入窗口，不能只遍历展示引用 |
| F5 明确长期偏好 | 一次性策略只留在本次输入；只有明确长期意图或用户显式保存才形成持久偏好。这是满足根规则的提案，具体判定仍待确认 | preference_id→owner、scope；(preference_id,version_no)→instruction、explicit_origin。owner 可有多条全局／联系人偏好，偏好 1:N 版本；类别／正文不是唯一键 | 模型推断不能冒充用户表达；查看、修正、删除均应可行。改变作用域应有新的明确授权事实。旧版本不自动继续生效 |
| F6 文档与内部结构 | Q40：scene／profile 共 memory_document／memory_document_version，保留段落／条目、推断、矛盾和一致发布集合 | document_id→collection、kind；(document_id,version_no)→title、origin。范围 1:N 文档，文档 1:N 版本，版本 1:N 段落／条目；条目可有多项推断和矛盾；依据 M:N | 标题非身份；尚未证明每范围只能一份画像或场景有稳定 key，不加 UNIQUE(scope,kind) 或 UNIQUE(title)。内容修订新增版本 |
| F7 发布 | 文档生成成功和整组对外生效不同；只有适用阶段全完成才显示轮次完成 | 一个范围一个当前发布头；发布集合 M:N 文档版本。(publication_id,document_id)→version_id | 新版生成不单独替换旧版。完整成员和发布头原子提交；删除先阻止受影响集合读取，不以删除为由自动调用模型重建 |

## 逻辑字段、键与独立理由

### 共同约定与跨域接口

所有范围表带 `owner_id NOT NULL`；联系人资料通过 `(owner_id,contact_id)` 复合 FK 指向稳定 contact，不引用名称。时间不是唯一键、真实聊天顺序或版本顺序。序号是正整数。下文 `U(...)` 表示 UNIQUE，相关实体另提供 `U(owner_id,id)` 或更宽的归属键作为复合 FK 目标。

子表若保留 owner／contact／collection 等上级属性，是为复合 FK 执行隔离的约束冗余，不允许独立改归属。跨表需要核验 role、版本所属对象、作用域时，采用复合 FK 或明确触发器，不能只写应用层约定。

`model_call`、`actual_input_part`、`message_version`、`memory_version`、Skill 精确快照等名称是接口占位名，待主设计统一；不意味着已确认某个 DSH API。实际输入分段必须可追到准确负载、材料版本和完整参与窗口；仅有 call_id 和 token 数不足以满足完整追踪。

本人作用域用 `scope_kind=self, contact_id=NULL`；联系人作用域用 `scope_kind=contact, contact_id NOT NULL`，加 CHECK。本人不是“空联系人”，也不能用含 NULL 的普通 UNIQUE 假装本人范围唯一。

### A1 `assistant_discussion`：讨论身份

字段：`discussion_id PK`；`owner_id,contact_id,created_at NOT NULL`。

约束：`U(owner_id,contact_id,discussion_id)`；联系人复合 FK；联系人不可原地换绑。标题如果需要仅作展示，非候选键。

独立理由：讨论与消息、调用、候选都非 1:1。库外 DSH session 映射归运行时分支；会话是否可轮换尚待查证，不强加 discussion=session。

### A2 `assistant_message`：稳定角色和讨论位置

字段：`message_id PK`；`owner_id,contact_id,discussion_id,position,role,created_at NOT NULL`；`current_version_id NULL`。

约束：role=user／assistant；`U(owner_id,discussion_id,position)`；`U(owner_id,contact_id,message_id)`；复合 FK 到 A1；current 复合 FK 到本消息 A3，仅允许新建事务内暂空，提交后非空。工具／系统协议消息由运行时保存，不伪装用户业务消息。

独立理由：角色与位置不随编辑复制；正文属于版本。

### A3 `assistant_message_version`：准确讨论文字／输入

字段：`message_version_id PK`；`owner_id,contact_id,message_id,version_no,body_text,origin_kind,created_at NOT NULL`；`parent_version_id,origin_call_id NULL`。

约束：`U(owner_id,message_id,version_no)`；`U(owner_id,contact_id,message_id,message_version_id)`；FK 到 A2；父版本属于同一 message。origin_kind=user_input／user_edit／model_discussion；模型起源必须有真实调用 FK，用户起源不能伪挂模型调用；role 与起源匹配。允许哪些助手讨论编辑操作仍待交互确认。

正文仅存业务讨论文字；候选稿文统一属于 A6。展示候选按 A5 产生请求和位置组合，不在本表再存一份可独立修改的候选原稿。完整模型输出另由真实追踪保存，清理不能遗漏。

独立理由：调用与显式偏好来源必须固定到当时版本，不能引用可变当前消息。

### A4 `reply_context_plan`、`reply_context_plan_item`：拟取材的目的内关系

`reply_context_plan`：`plan_id PK`；`owner_id,contact_id,request_message_version_id,plan_no,created_at NOT NULL`。`U(owner_id,request_message_version_id,plan_no)`；`U(owner_id,contact_id,plan_id)`；请求 FK 到准确用户消息版本并核验联系人。计划不可覆盖。

`reply_context_plan_item`：`plan_item_id PK`；`owner_id,contact_id,plan_id,position,kind NOT NULL`；`message_version_id,memory_version_id,document_version_id,preference_version_id,discussion_message_version_id NULL`。五种 typed FK 恰好一个非空并匹配 kind；`U(owner_id,plan_id,position)`；FK 到计划及准确业务版本。本人资料可以在同 owner 合法范围内引用，其他联系人私域版本不作为本联系人回复依据。

独立理由：计划是独立意图集合，不是候选正文或真实调用输入；计划项 1:N，不塞 ID 数组。这里只建立回复目的内结构，不批准 Q43 跨业务共享材料表。Skill 的拟选择与实际动态读取由运行时接口区分：逻辑 Skill ID 不等于准确读取版。

### A5 `reply_candidate`：身份与产生位置

字段：`candidate_id PK`；`owner_id,contact_id,request_message_version_id,candidate_position,created_at NOT NULL`。

约束：`U(owner_id,contact_id,candidate_id)`；`U(owner_id,request_message_version_id,candidate_position)`；请求准确版本 FK，核验 role=user 和同联系人。candidate_position 是业务候选排列，不冒充模型输出位置。

独立理由：候选身份不随稿文修改。本表无 original_text、edited_text 或 v0。模型重新生成是新候选还是同候选新版本尚待确认；本提案按新产生位置建新候选，手工改写新增其版本。

### A6 `reply_candidate_version`：从 v1 开始的统一正文

字段：`candidate_version_id PK`；`owner_id,contact_id,candidate_id,version_no,body_text,origin_kind,created_at NOT NULL`；`parent_version_id,origin_call_id,output_position NULL`。

约束：`U(owner_id,candidate_id,version_no)`；`U(owner_id,contact_id,candidate_id,candidate_version_id)`；FK 到 A5，父版本属于同候选。origin_kind=model／user_edit；model 要求 call 与 output_position 非空并有部分唯一键 `U(owner_id,origin_call_id,output_position)`；user_edit 必须有父版，调用位置为空。v1 必须是模型稿；不靠时间找最新稿。若以后允许用户从空白写候选，需要明确新增起源。

产生调用必须消费对应请求的准确版本；一个请求多调用不混依据。选择只引用具体版本 ID。手工编辑不自动变成人工确认事实或来源豁免。

独立理由：正文、父稿、产生调用是版本事实；放身份表会造成 v0 特例、更新异常和选择漂移。

### A7 `reply_candidate_basis`：可展示的准确版本依据

字段：`basis_id PK`；`owner_id,contact_id,candidate_version_id,position,actual_input_part_id,relation_kind,explanation_text NOT NULL`。

约束：`U(owner_id,candidate_version_id,position)`；FK 候选版本及真实输入分段；relation_kind=support／contradiction／context。实际输入分段进一步关联准确消息／记忆／文档／偏好／Skill 快照和真实来源窗口。

生成稿依据必须实际参与产生调用，或在其输入中保留了准确上游材料沿革；不能拿仅在早前调用读过却未参与本次产生的材料补依据。模型解释本身不证明内容真实。编辑新版本须重新关联仍适用的证据；未重核的父稿依据不能标成已证实新稿支持。父稿完整依赖仍用于删除。

独立理由：一个版本多依据，同一输入可支持多个版本，是 M:N；少量展示依据不等于完整删除依赖，后者遍历真实输入与沿革。

### A8 `reply_selection`：选择事件

字段：`selection_id PK`；`owner_id,contact_id,request_message_version_id,selection_no,candidate_version_id,selected_at NOT NULL`。

约束：`U(owner_id,request_message_version_id,selection_no)`；复合 FK／触发器确保所选版本确属同请求、owner、contact。最新选择按 selection_no 求得；编辑后旧事件不改指新版本。

独立理由：选择是独立用户事实，bool 无法保留改选次序。不设 sent_at／delivered。若界面需要“撤销选择”，再明确带动作的事件语义，不以删候选模拟用户撤销。复制未证明需持久账本。

### P1 `reply_preference`、P2 `reply_preference_version`：明确长期意图

`reply_preference`：`preference_id PK`；`owner_id,scope_kind,created_at NOT NULL`；`contact_id,current_version_id NULL`。作用域 CHECK 及联系人 FK；`U(owner_id,preference_id)`。current 只能在原子新建事务内暂空。范围固定，多条同类偏好可并存；不靠语义／正文相似猜合并。

`reply_preference_version`：`preference_version_id PK`；`owner_id,preference_id,version_no,instruction_text,explicit_origin_kind,asserted_at NOT NULL`；`expression_message_version_id NULL`。`U(owner_id,preference_id,version_no)`；`U(owner_id,preference_id,preference_version_id)`；FK preference；current 回指本 preference 的版本。explicit_origin_kind=explicit_message／settings_action：前者必须引用准确用户消息版，后者只能由可信用户设置操作入口产生，来源字段为空；模型不能冒充该操作。

联系人偏好表达来源限于同联系人讨论；全局偏好若来自某联系人讨论，仍保留该实际来源并承受删除依赖。一次性话语不建本表。模型推断风格建议属于其他自动资料，不能直接写成长期人工偏好。

独立理由：长期意图、作用域、明确表达来源和自动记忆／本次输入的生命周期不同。版本保存修订和历史引用，删除须清旧版本及副本，不能把版本史当隐形永久保留。长期意图判定、冲突优先级及停用／恢复历史待证，不先建规则引擎。

### D1 `memory_document_collection`：范围与共同发布头

字段：`collection_id PK`；`owner_id,scope_kind,created_at NOT NULL`；`contact_id,current_publication_id NULL`。

约束：作用域 CHECK；本人 `U(owner_id) WHERE scope_kind=self`，联系人 `U(owner_id,contact_id) WHERE scope_kind=contact`；联系人 FK；`U(owner_id,collection_id)`；current 复合 FK 到本 collection 的 D7。空范围可以无发布头。

独立理由：共同生效头属于范围内多文档，不能放某一个文档。若主设计已有同构稳定资料 scope，可复用其身份；共同发布头这个事实仍须保留。不能把 NULL 普通 UNIQUE 误当本人唯一。

### D2 `memory_document`、D3 `memory_document_version`

`memory_document`：`document_id PK`；`owner_id,collection_id,kind,created_at NOT NULL`；kind=scene／profile；FK collection；`U(owner_id,collection_id,document_id)`。无正文，无独立 current_version。没有证据证明 `U(scope,kind)` 或标题唯一。

`memory_document_version`：`document_version_id PK`；`owner_id,collection_id,document_id,version_no,title_text,origin_kind,created_at NOT NULL`；`origin_call_id,processing_round_id NULL`。`U(owner_id,document_id,version_no)`；`U(owner_id,collection_id,document_id,document_version_id)`；复合 FK document。origin_kind=model／user_revision；模型版有实际 call；本轮整理关联准确轮次，用户修订可以无轮次。用户修订不自动把整份自动资料改标人工确认。

独立理由：满足 Q40 共身份／版本；生成版本和发布集合不同。正文权威在 D4，不另存一份可与结构不一致的可变整篇 Markdown；若要渲染副本，须明确可重建、一致性及删除路径。

### D4 `memory_document_part`：场景段落和画像条目

字段：`part_id PK`；`owner_id,collection_id,document_version_id,position,kind,body_text NOT NULL`；`heading_text NULL`。

约束：`U(owner_id,document_version_id,position)`；`U(owner_id,document_version_id,part_id)`；FK 准确文档版本；kind=scene_section／profile_item，跨表校验与 document.kind 匹配。position 只在本版有意义，不冒充跨版条目身份。

独立理由：文档 1:N 段落／条目，需要逐项引用、纠正和依据；不用 JSON 数组掩盖关系。是否有嵌套和跨版稳定条目尚待证。

### D5 `memory_document_inference`、D6 `memory_document_contradiction`

`memory_document_inference`：`inference_id PK`；`owner_id,document_version_id,part_id,position,claim_text,rationale_text NOT NULL`。`U(owner_id,part_id,position)`；FK 同版 part。记录明确标为推断的结论及推导说明；真实支持由 D9 关联，不自动标用户确认。

`memory_document_contradiction`：`contradiction_id PK`；`owner_id,document_version_id,part_id,position,left_claim_text,right_claim_text,state NOT NULL`；`resolution_text NULL`。`U(owner_id,part_id,position)`；FK 同版 part；state=unresolved／resolved；resolved 要求 resolution_text，unresolved 要求其为空。两侧真实依据分别关联，不只保存“有矛盾”摘要。

独立理由：一个段落／条目多推断、多矛盾；矛盾含两个方向与处理结果，不能压成 bool，也不与单推断强合并。解决或修订新增文档版本。固定置信分数、推理图、多级矛盾不是已确认需求。

待整合：这是保留 Q40 结构的具体字段提案，两份 spec 未定义更细的命题身份。若实际需直接引用 memory_version 或不同文档条目作命题，应增加明确 typed FK，不能凭 claim_text 相同猜同一命题。

### D7 `memory_document_publication`、D8 `memory_document_publication_member`

`memory_document_publication`：`publication_id PK`；`owner_id,collection_id,publication_no,published_at NOT NULL`；`processing_round_id NULL`。FK collection／适用轮次；`U(owner_id,collection_id,publication_no)`；`U(owner_id,collection_id,publication_id)`。本提案行存在即已原子发布；准备中只存未发布文档版本，不用 draft 状态混不完整集合。

`memory_document_publication_member`：`owner_id,collection_id,publication_id,document_id,document_version_id NOT NULL`；`PK(publication_id,document_id)`；复合 FK publication、document 及该文档的准确 version，全部同 collection。旧而仍合法的版本可以被新集合明确继承；集合保存完整成员，不让读者递归猜本次未变化文档。

发布事务：复验来源、阶段完成及控制／删除代次 → 写完整 publication 和 members → 以旧 head 作比较更新推进 current → 提交。并发发布／删除已改 head 则拒绝提交并重核。是否每集合都要 scene 和 profile 及无适用文档的状态，需要处理阶段结果明确，不把缺记录当完成。

独立理由：共同一致可见性及每文档所选版本是 M:N 事实，各文档独立 current_version 无法表达。collection 头、publication 和 membership 均无正文副本。

### D9 `memory_document_basis`：文档目的内依据

字段：`basis_id PK`；`owner_id,document_version_id,part_id,position,actual_input_part_id,relation_kind NOT NULL`；`inference_id,contradiction_id,contradiction_side,explanation_text NULL`。

约束：`U(owner_id,part_id,position)`；FK 同版 part、真实输入分段；inference／contradiction 至多一个非空，并与 part／version 一致。contradiction 非空时 side=left／right，其他情形 side=NULL；两者均空表示普通 part 依据。relation_kind=support／contradiction／context。实际输入进一步准确关联 memory_version、message_version、被参考 document_version 及完整来源窗口，不只指当前 memory_id。

独立理由：单条目多依据，单依据可支持多条目／推断／矛盾；两侧支持方向不能混。只服务文档目的，不批准 Q43 共享表。用户修订保持真实沿革，用户文字是新来源事实，不证明全部旧推断均获确认。

## 跨域准确性与删除不变量

1. 运行时必须提供每次 call 的准确最终输入／输出、有序分段、提示及相关版本，以及每个动态 read-event 的时点和准确材料快照。不能给整个讨论挂一份“使用过 Skill 清单”代替逐调用事实。A6／A7／D3／D9 接真实键，A4 只表示计划。
2. 直接证据、仅作理解上下文和上游工具结果的沿革要区分；删除遍历完整参与窗口，展示依据只是子集。一个请求多个调用的输入不得合成一份冒充每次调用输入。
3. 同 owner 本人资料可用于不同联系人的合法回复，但来源权限不因归属 owner 消失；A 的私域正文不能借本人摘要自动成为 B 的可读资料。本人资料的跨联系人来源逐项核验和删除。
4. 删除先撤销旧读取、写入及发布资格，再清讨论／候选版本、选择关联、偏好来源、文档与依据、完整调用追踪、库外会话及缓存。其他合法来源仍支持的资料重新核验，不能只删标签后沿用旧证明；需新模型调用时遵守手动入口。
5. 选择或手工编辑不是删除豁免。无法可靠区分混合正文中已删资料时，清整个受影响版本；保留纯手录片段需有独立真实来源。最小无正文审计是否保留接统一删除设计，不能留悬空 FK 或稿文快照。
6. 当前发布引用受影响成员时立即撤下／禁读；切换替代集合必须重新证明全部成员合法，不能任意回滚旧集合冒充恢复。
7. Q42 `deletion_operation` 负责明确数据库／文件目标、重试与复核；本文不另造领域删除平台。FK 级联成功不证明库外清完，文件归属不能靠名称扫描猜测。

## 待证事实与纳入条件

| 待证事实 | 不能擅自删掉的要求 | 纳入独立结构的条件 |
| --- | --- | --- |
| 持续组织中的人工纠错／保护是否跨轮生效 | 不将人工纠正简化为下轮可覆盖的生成文本 | 若有持久逐条／逐字段保护，补准确对象／版本、动作、作用域及撤销历史；单次修稿可用版本，不默认整套保护引擎 |
| 诊断、对照、评估的保留强度 | Q29 完整提取追踪及实际调用输入输出继续保留 | 只有明确需命名实验、固定样本、独立评分与比较时增实体；普通排查用真实调用和阶段追踪，不默认评估平台 |
| 候选依据核验及编辑后重核交互 | 不能把编辑视为证据自动通过 | 明确主体、适用版本及通过／失败／未核验生命周期后增核验记录；先保留真实输入和编辑沿革 |
| 讨论分支、撤销选择、重新生成交互 | 不覆盖被引用、被选择的准确正文 | 有独立分支／恢复语义再建控制事实；普通请求和版本无需预建会话树 |
| 长期意图判定、偏好优先级、停用／恢复 | 一次性要求不能自动长期化，模型建议不能标人工确认 | 用户确认这些操作后决定控制事件／覆盖关系，不先建偏好规则系统 |
| 画像唯一性、稳定场景／条目身份 | 不凭 kind／标题合并，不丢 Q40 结构 | 有稳定业务键和跨版身份合同后加候选键／稳定条目；当前仅 document ID 与版内 part ID |
| Q43 跨业务共享材料 | 来源、准确版本和完整参与窗口不能因未共享而缺失 | 有自然同构的函数依赖、保留和删除合同且获确认后再抽公共结构；当前目的内 plan／basis |
| DSH session 映射及 Skill 动态快照键 | 不把 session 当讨论身份，不用当前文件倒推历史 | 主分支查证官方接口后接入；本分支不臆造 DSH 方法或技术日志模型 |

## 首稿核验与限制

设计逐项核对：候选原稿从 v1 开始、显式选择固定版本、计划与真实调用分离、Q40 共文档／版本并保留内部结构和一致发布、本人与联系人隔离、用户亲自外部发送、完整窗口删除、Q43 不先批准共享结构。没有从旧结构裁剪或预设表数。

本次只写设计文件，未运行 SQLite／DDL、业务测试、真实 App、微信、打包或数据库操作，未访问私人资料。跨域实际输入键、来源可达性、处理轮次作用域和发布适用阶段仍待主设计整合；本文不宣称系统已实现或端到端可用。

助手部分后续以[助手收敛提案](greenfield-assistant-contract.md)为最新讨论稿；message_version占位、默认讨论全版本和拟取材计划表不自动纳入。回复候选Q39版本决定继续有效，偏好/文档部分待下一项收敛。

偏好/文档部分后续以[偏好与文档收敛提案](greenfield-preference-document-contract.md)为最新讨论稿；范围、正文权威及发布头的物理位置按新稿收敛，当前不预设1:1 collection壳。
