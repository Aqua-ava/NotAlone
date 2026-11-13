# 明确表达偏好与场景、画像：版本和一致发布

2026-10-29，结构提案。Q40已确认场景与画像共memory_document/memory_document_version；一次性要求不能自动长期化，自动资料不能冒充用户确认。字段与内部结构仍待整体约束验证。

## 1. 三种事实不能只因有正文就放在一表

| 例子 | 性质 | 生效条件 |
| --- | --- | --- |
| 用户明确要求“以后给我的回复都简短一些” | 长期表达指令 | 真实明确确认、适用范围、当前有效版本 |
| “这次写短一点” | 本次请求约束 | 只属于当前请求，不自动创建长期偏好 |
| “对方最近在准备考试”及相关背景 | 场景资料 | 合法已采纳记忆的派生整理，来源和时效可核验 |
| “对方通常偏好直接沟通” | 画像中的概括或推断 | 必须标推断性质和实际依据，不能自动变成用户设置 |

偏好是用户的指令；场景/画像是系统对资料的组织。它们的形成方式、权限和失效原因不同。模型提出偏好建议并不满足明确确认，不能仅凭检测到“以后”二字建长期指令。

## 2. 偏好身份、版本、来源

### expression_preference

字段：`owner_id,preference_id,current_version_no,state,head_revision,created_at`。PK(owner,preference)，owner FK；current完整FK引用同preference的版本；head_revision负责并发切换，不是内容历史。state表达当前可用/撤销等状态，删除仍走统一删除操作。

同owner可有多条独立偏好；正文相同不自动合并，也不拿名称作为业务键。适用范围随版本保存，避免改变范围后旧调用引用漂移。

### expression_preference_version

字段：`owner_id,preference_id,version_no,instruction_text,scope_kind,contact_id?,reply_mode?,origin_kind,confirmed_at,confirmation_request_key,previous_version_no?,created_at,content_state`。

PK(owner,preference,version)，preference FK；前版完整自FK。scope=owner时contact为空，contact时真实同owner contact FK；可空reply_mode只表示明确未限模式，不能任意填未知值。confirmation_request_key按owner唯一并核重放参数；成功修改追加版本，确认元数据与这次版本同事实，不先加1:1确认头。

origin_kind区分真实独立设置、从明确讨论采纳、修改已有偏好；来源关系继续如下表保留。版本的适用范围可变，不改变其历史来源联系人。将联系人偏好改为全局，不会使原来来自该联系人讨论的文字免于删除。

### preference_source

一行是某版偏好实际继承的一个来源事实。字段：`owner_id,preference_id,version_no,source_no,kind,discussion_entry完整引用?,previous_preference/version引用?,message/contact/record引用?`。

PK版本键＋source_no；版本FK；各kind真实FK严格互斥。讨论来源必须确为用户的明确表达并有真实确认；渠道消息若参与说明，必须保留实际record且不把聊天中的普通表达自动视为对助手的设置。前版继承须为已存在合法版本且不得成环。

独立设置可无聊天/讨论来源，但必须有真实设置操作确认，不能给派生偏好把origin改成settings来切断旧来源。修改旧偏好仍继承实际来源；不因修改正文/范围或重新确认而洗掉历史依赖。

若最后证明每版永远只有一个直接来源，且无需多来源组合或传递关系，可用完整typed FK直接放version；当前明确列出多值关系及其纳入前提，不用JSON source_ids藏依赖。

## 3. 场景与画像的身份和内容

### memory_document

字段：`owner_id,document_id,scope_kind,contact_id?,kind,created_at,state`。

PK(owner,document)，真实owner/contact FK及scope形状；kind=scene/profile。标题不能决定同一主题；同名主题不猜合并。是否每范围严格一份画像须按最终产品合同约束，不能由kind名称推导唯一。

主体不另保存可变正文或独立current_version；对外使用哪一版由完整发布集合决定，避免每篇各自切换造成混搭。

### memory_document_version

字段：`owner_id,document_id,version_no,title,produced_execution_id,origin_kind,previous_version_no?,input_contract_version,created_at,content_state`。

PK(owner,document,version)，document FK及真实产生执行FK；普通前序为同文档版本自FK。Q40场景/画像共用身份与版本，kind由document确定，不复制两套历史。

未发布版本可以存在，但不能被回复检索当作当前资料。来源失效时即使曾发布也不能继续使用。直接人工改写文档的交互尚未确认，不能因加origin_kind便擅自开放编辑；若纳入，必须有真实用户操作和继续有效的来源，不自动把整篇自动资料标成用户确认。

### document_block

一行是版本内一个场景段落或画像条目容器：`owner_id,document_id,version_no,block_no,block_kind,heading?`。

PK版本键＋block_no；version完整FK；block_kind与document.kind匹配。block_no仅在该版本内定位，跨版引用必须带版本。这里只保存结构，不另存与下面陈述可分别修改的整段权威正文。

### document_statement

一行是块内一个有明确认识性质的陈述：`版本/块完整键,statement_no,kind,body?,rationale?,left_claim?,right_claim?,resolution_state?,resolution_text?`。

PK块完整键＋statement_no，block FK。kind为summary/inference/contradiction等有限分支：普通概括有body；推断有body并明确推断说明；矛盾有左右两侧及状态，不能只有has_conflict布尔。矛盾resolved才允许必要解决说明，unresolved不伪造解决结果。分支字段用CHECK互斥。

一段/条目可包含多个推断或矛盾，故存在真实1:N；不因每个陈述kind不同就分别复制一套相同身份表。若业务要求同一矛盾跨文档版本单独流转，则出现独立业务身份，需另证并建模，当前只是版本内内容。

渲染正文由有序block/statement生成；需要缓存Markdown时只能是可重建副本，不能和结构形成两个可独立编辑的权威来源。

### document_basis

一行是某陈述的一条真实依据：`陈述完整键,basis_no,actual_input引用,memory_id/version引用?,referenced_document/version引用?,relation_kind,contradiction_side?`。

PK陈述键＋basis_no；statement及真实实际输入FK；明确来源类型的完整FK。引用须确实属于该版本的产生执行，不能事后检索到一条相关资料就补作当时依据。

场景/画像的事实基础是合法已采纳记忆；待采纳候选不能冒充已确认事实。旧文档可作组织上下文，但不能循环引用给自己制造事实依据；真实来源链必须可达底层记忆及消息。矛盾两侧分别用left/right标记依据，不能混成一个无方向source列表。

展示依据仍不等于完整参与窗口；未显示的理解上下文也记录在真实执行输入中，来源删除照样清理完整载荷。

## 4. 发布集合为什么是另一种事实

假设上轮可用集合包含“考试场景v2＋画像v4”。本轮生成“考试场景v3”，但新画像尚未完成。若把两篇各自current指针独立更新，就会对外变成“场景v3＋画像v4”，未必有一致来源和推导关系。

### document_publication

字段：`owner_id,publication_id,scope_kind,contact_id?,publication_no,run_id?,input_contract_version,expected_source_revision,published_at`。

PK(owner,publication)，真实owner/contact范围和适用run FK；本人/联系人范围的publication_no分别条件唯一。该行只在完整发布事务里建立，不以半成品成员集合冒充已发布。

### document_publication_member

字段：`owner_id,publication_id,document_id,version_no`。PK(owner,publication,document)，publication、具体document_version完整FK并保证同一范围。一次发布每个document只选一版；成员是完整清单，不能让读者递归猜哪些沿用上次。

新集合可继承未变化且仍合法的旧版本，但“仍合法”不等于“与其他成员配套”：必须按输入合同核验画像实际采用的场景/记忆版本与本集合兼容。不能只比较时间戳或文档最新版本号。

当前发布指针属于资料范围。在当前每owner本人/每contact各一个资料集合的需求下，可分别存owner/contact的`current_document_publication_id`及文档修订控制字段；不先新增只有1:1属性的collection表。若以后确有多个独立命名资料集合，再产生独立集合身份。

## 5. 发布、引用和删除合同

发布短事务：核验原范围修订、实际来源和执行贡献资格、所有适用阶段完成或明确not_applicable → 写publication及完整members → CAS切换范围current指针。部分生成成功不发布半套；没有画像/主题的适用理由必须可查，缺行不当完成。

回复准备时一次读取current publication及其成员，冻结引用具体版本；不能逐篇查询“最新版本”拼上下文。偏好另读取其当前合法版本及独立集合修订，不能把资料发布时间当偏好版本。

来源删除使某个当前成员失效：先停止该集合的相关可用资格，撤销旧生成/发布写入，按依赖清理正文、版本、完整追踪和助手副本。替代集合须重新核验兼容性，不能任意回滚旧集合恢复已删资料；需要新模型调用时遵守手动入口。

偏好删除覆盖其当前/历史正文、真实输入和运行副本；已被实际引用的旧版本不能悄悄改为新版本逃避删除。持续读取排除、操作拒绝键等最小状态仍依统一删除合同，不保存原文残片。

## 收敛结果和待证项

偏好是明确指令，场景/画像是派生资料；各自身份/版本不同。场景与画像按Q40共表，内部结构保留推断和矛盾，一致发布用完整集合而非独立当前指针。

仍需闭合：偏好冲突优先级与停用交互；多来源偏好是否实际需要；画像数量/跨版条目身份；文档直接编辑与持续纠错保护；actual_input与执行模块的正式键；发布兼容性合同及来源修订事务。均不能因本稿列字段就当用户批准。

下一项收敛Skill：保留原目录、官方加载所需的最小业务身份，及学习/审核/发布能力分别产生哪些真实事实。不能把官方加载目录自动扩成自建Skill平台，也不能为减表默认丢弃实际所需能力。
