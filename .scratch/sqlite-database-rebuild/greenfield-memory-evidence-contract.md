# 记忆、证据与实际输入：关系收敛提案

2026-10-29，讨论稿。承接已确认的原聊天正文不直接编辑、不建聊天正文版本表，以及Q29完整追踪、Q36本人/联系人记忆共表、Q37追加恢复版本。以下字段/拆表为提案，不代表整套schema获批。

## 一、先区分四个问题

| 问题 | 保存的事实 | 不可替代它的东西 |
| --- | --- | --- |
| 这条记忆现在说什么、过去说过什么 | 稳定记忆身份及不可变内容版本 | 当前消息正文、模型调用结果 |
| 缺少哪条消息，这版内容就不再有依据 | 主张与必需消息的关系 | 展示了几个引句 |
| 用户看得到哪段具体依据 | 定位到消息片段及当时捕获的证据 | 整个上下文列表 |
| 这次处理实际看过什么、产生什么 | 精确实际输入、来源、完整事件载荷 | 当前数据库重新检索出来的内容 |

这四种事实的键和基数不同，不能用一个source_ids数组或一张任意entity_type/id表代替。

## 二、记忆身份和版本

### memory

一行表示一条长期记忆的稳定身份。字段：`owner_id, memory_id, scope_kind, contact_id?, current_version_no, head_revision, state, created_at`。

PK `(owner_id,memory_id)`；owner真实FK。scope_kind=self时contact_id必须NULL，contact时必须有同owner的contact FK。current_version以完整`(owner_id,memory_id,current_version_no)`引用版本；head_revision用于当前指针的并发比较，不等于内容版本号。

本人和联系人共表遵守Q36，但本人资料并不因此有权读取任意联系人。来源联系人在证据/输入中保留其真实身份，不把本人owner伪装成source_contact。

### memory_version

一行表示这条记忆的一版正文。字段：`owner_id,memory_id,version_no,body,formation_kind,adoption_mode,previous_version_no?,restored_from_version_no?,produced_execution_id?,decision_id?,created_at,content_state`。

PK `(owner_id,memory_id,version_no)`，memory真实FK；前序/恢复版本均为同memory完整自FK。来源于模型时真实执行FK必填，独立手录时真实用户决定FK必填；两者不由字符串注释代替。决定与执行的统一父实体名称由后续执行/人工操作项收敛，不凭字段名新增1:1表。

formation_kind区分提取、人工修改、独立手录、恢复；adoption_mode区分自动采纳和真实人工确认，不能合成一个manual标志。修改追加版本；Q37恢复形成新版本并指明恢复来源，不能把旧指针直接设回当前。

原先事实为“喜欢咖啡”，以后有合法新消息说“现在不喝咖啡”：改变的是记忆的内容版本，不改原聊天。若一段内容需要多条旧记忆联合推导，实际输入必须记录；是否还需独立多父语义谱系，需由真实合并/拆分功能证明，不能把所有输入都当父版本。

## 三、必需消息与展示证据分别建模

### memory_required_message

一行表示一版主张依赖的一条消息。字段：`owner_id, requirement_id, candidate_id?, memory_id?, version_no?, source_contact_id, message_id`。

PK `(owner_id,requirement_id)`。父引用严格二选一：真实候选FK，或完整memory_version FK；CHECK要求候选分支的memory/version全空，版本分支的candidate为空且memory/version全非空。每类父＋source_contact＋message分别唯一，防止SQLite NULL唯一性漏约束。

message使用真实完整FK `(owner_id,source_contact_id,message_id)`，不引用不存在的message_version。联系人主张只能本联系人来源，本人主张可有经资格核验的多个联系人来源。

候选与已采纳版本自然都有“这条主张需要哪条消息”的同粒度关系，可在本领域使用上述强类型共表；这是当前结构建议，不等于选择Q43跨业务共享材料。若候选允许独立多次编辑版本，必须挂明确候选版本，不能以候选当前内容覆盖历史；候选编辑需求与结构另行收敛。

同一主张的必需消息是AND：任一必需消息失去全部合法支持，就不能继续发布该正文。单条消息的多个合法capture_record则是OR：它们支持同一条消息，不因为重复捕获多就提高事实置信度。

### memory_citation

一行表示一个主张展示的一处真实消息片段。字段：`owner_id,citation_id,candidate_id?,memory_id?,version_no?,source_contact_id,message_id,record_id,span_start,span_end,explanation?`。

父分支形状与上表相同；message及capture_record都是完整真实FK。capture_record需有候选唯一键`(owner_id,contact_id,record_id,message_id)`，引用它保证record实际指向这条message，而不是任意同联系人的记录。跨度按统一Unicode码点定义，起止合法且落在文字正文范围内；实际实现须验证边界，不依赖SQLite字符串长度猜不同语言的偏移单位。

主张可有多处证据，一条消息也可有多个片段；因此不能把required标志复制在每个引句上。没有展示引句不等于没有正文依赖，删除判断不能只遍历citation。

本提案直接让片段属于具体主张，不先建立全局可复用evidence身份。只有存在独立证据编辑/复用生命周期时才需另一证据主体；相同offset出现两次本身不构成拆表理由。

## 四、实际输入不再引用虚构消息版本

### execution_message_input

一行表示某次真实执行/调用实际使用的一条消息及一份真实捕获依据。字段：`owner_id,execution_id,input_no,call_id?,event_no,source_contact_id,message_id,record_id,input_role,presentation_no,accepted_interpretation_revision`。

PK `(owner_id,execution_id,input_no)`；真实执行、阶段事件、可空物理调用FK；message及record复合FK核对真实关联。call若存在必须属于该执行。input_role区分target/context/evidence等有限用途；presentation_no只是实际呈现顺序，不冒充渠道时间顺序。

同一消息用到两份真实捕获依据可以有两行；这些是实际采用的来源，不从当前所有有效record自动补齐。多次调用输入不同，分别关联实际call/event，不将整个执行的输入并集冒称每次调用都看过。

accepted_interpretation_revision是接受时的值快照，供提交复验；没有历史消息版本表，故它不是到`message_id+revision`的历史外键。当前revision变化后，旧未提交结果必须重新核验或失效，不能刷新快照值让旧结果通过。

### 实际旧记忆/文档输入

如果处理还看了旧记忆，必须有真实关系引用`memory_version`的完整版本键；用了场景/画像就引用具体文档版本。消息记录不能伪装成记忆版本。不同输入类型是否共一张有限分支表，待执行模型确认后决定，本项不预选Q43。

### execution_event（完整过程载荷）

一行是一次真实执行中的有序事件：`owner_id,execution_id,event_no,event_kind,call_id?,payload,payload_format,created_at,content_state`。完整执行FK，可空真实call FK；PK为执行完整键＋event_no。

payload保存当时真正送入模型的文字、实际返回和程序处理结果；这是Q29明确要求的历史快照。消息和record FK负责可查询的来源关系，payload负责真实当时内容，二者不能互相替代。敏感载荷随相关来源清除，不用无正文调用账替代完整追踪。

该名称表示所需事件事实，执行首稿若已有相同粒度的事件/载荷结构应统一命名，不再额外创建一套记忆专用重复日志。

## 五、用一个例子检查删除

假设M1为“我不吃香菜”，先后由R1、R2两次合法捕获支持。一次提取用R1，并把另一消息M2仅作背景。生成记忆V1“不吃香菜”。

- V1的required关系指向M1；citation指向M1的片段及实际R1。
- execution输入记录实际M1/R1与背景M2的捕获；完整事件保留当时真实请求和输出。
- **删R1这个来源**：擦除包含R1的旧追踪载荷与旧citation；R2仍合法时，M1可保留。V1能否继续可用要复验真实正文依赖，不自动把旧R1引用改成R2，也不重新伪造旧提取过程。
- **删背景M2的来源**：包含该背景的完整请求/输出仍须擦除；V1是否保留取决于它的真实正文依赖，而非“输入里出现过就一定是事实依据”。如果模型实际推断依赖M2，它也必须列入required，不能借context标签免除依赖。
- **删M1消息本身或清空聊天**：覆盖R1/R2所有相关支持，V1及其历史副本按依赖清理，不能用R2留下被主动删除的消息。

来源删除后继续保留的事实，必须建立在仍合法且可核验的支持上。旧追踪始终是旧追踪，不能替换来源后恢复被删载荷。判断不了是否仍有完整支持时，先停止发布，不能默认为可用。

## 六、人工操作与提交约束

人工确认或修改聊天提取出的记忆，仍保留真实消息依赖。只有明确独立手录的事实才可没有聊天来源，不能把点击确认或改几个字当作新的独立来源。恢复旧版也须复核当前来源资格与人工保护，已删正文不恢复。

采纳/修改事务先核验候选、当前版本、范围、来源及实际执行资格，再写新版本、required/citation关系和真实决定，最后以期望head_revision切换当前指针；任一步失败整体回滚。模型调用在事务外。

完整提取执行、模型call与记录用户决定的实体名称/键尚需与执行模块统一。本项明确了事实粒度与引用合同，不增加调用归属壳、全局证据壳或虚构消息版本表。

## 本次结论与后续

本提案收敛了三条不同关系链：记忆版本→必需消息；记忆版本→展示片段/捕获；实际执行→真正输入/捕获及完整载荷。与Q29/Q36/Q37及已确认消息编辑边界一致，字段和物理结构仍待整体校核。

下一项可收敛候选的生命周期和人工操作：候选是否有独立编辑历史、一次采纳是否真的可合并多个候选、哪些操作不产生内容版本。只有这些事实明确后，才决定候选版本表和独立操作表，不能因首稿列出就默认建。
