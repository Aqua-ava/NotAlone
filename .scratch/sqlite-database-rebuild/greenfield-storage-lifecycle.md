# 文件、Skill与删除：从事实推导存储

讨论稿；以下结构是建模建议，未执行建库。根据Q29/Q41/Q42、保留用户Skill原目录及清理应用旧副本的决定推导，不以旧表为依据。

## 事实卡

| 事实 | 唯一身份与函数依赖 | 基数与历史 | 生命周期 |
| --- | --- | --- | --- |
| 用户保留的一个Skill包 | 内部包身份决定所属用户、核验后的原目录身份；名字不决定身份 | 用户有多个包；当前启停属于包，已知启用/停用/未知分开 | 文件仍由官方DSH加载；缺数据库行不是删除授权 |
| 一次使用的具体Skill内容 | 包身份＋内容修订决定摘要与已核验来源 | 一个包有多次内容变化；历史引用不能随当前文件变化 | 只保存完整性锚点不代表旧文件仍可读取；不存在时不得用现文件冒充 |
| 一个实际运行副本 | 运行实例身份决定业务归属、受管定位及写入代次 | 同一讨论可能有多个重建副本 | 旧副本需被找到、撤销写入并按范围清理 |
| 某个副本含某次实际输入 | 副本＋输入身份决定实际纳入位置及确认状态 | 同输入可进入不同重建副本；一副本可含多个输入 | 输入来源删除需要反向找到副本；最后一次上下文不足以表达 |
| 用户发起一次删除 | 操作身份决定原请求范围、接受代次与计划修订 | 一次操作涉及多个存储目标，可多次重试 | 被删主体消失后仍须继续，不依赖live主体级联 |
| 一项具体清理目标 | 删除操作＋目标序号决定存储位置、预期身份、进度 | 每操作多目标，部分可失败 | 擦除正文后只留必要无正文结果；不得把同路径的新文件误删 |
| 一次删除复核 | 操作＋计划修订＋复核面决定结果 | 一个操作须核验多个存储面与旧写入者 | SQL删除成功不能证明文件、WAL或在途写入均已清理 |

## 从事实推导的结构

以下逻辑类型：`ID`为不含业务语义的稳定内部标识；所有业务引用含`owner_id`，联系人内容另带真实`contact_id`。时间用统一整数精度。最终SQLite类型及完整CHECK另行落DDL。

### skill_package

一行是一个经用户范围核验的目录包。字段：`owner_id, package_id, directory_identity, display_name, enabled_state, verification_state, verification_reason, current_revision, revision_counter`。

PK `(owner_id,package_id)`；owner为真实FK；目录身份在同owner有效包内唯一。`enabled_state`仅允许enabled/disabled/unknown；核验状态与启停状态分别保存。当前修订指向同包修订完整FK。名字可变且不作为外部权限键。当前状态全部依赖包键，没有独立状态表的需求。

### skill_package_revision

一行是一个包的具体内容锚点。字段：`owner_id,package_id,revision_no,manifest_digest,content_digest,source_kind,verification_state,verified_at,availability`。PK `(owner_id,package_id,revision_no)`，包FK；内容锚点接受后不可原地修改。

包与修订是1:N，因此分开；正文不复制进数据库。实际输入须引用具体修订，并在读取时核验内容，不能只引用包的current指针。是否保存不可变旧文件与保留多少历史，需要明确产品/文件合同，当前不擅自创建副本。

学习、方法继承、细粒度政策、发布审核是另一些业务事实，Q41并不一并批准或否定。若产品要求保留，先补“谁授权学习、一次消费单位、草稿怎样编辑、审核比较什么、谁批准发布”的事实卡，再推导对应关系；不能通过默认关闭这些能力来宣称减少表数。

### runtime_copy

一行是一个实际DSH运行实例。字段：`owner_id,contact_id,discussion_id,copy_id,managed_locator,expected_file_identity,write_generation,state,last_committed_event`。

PK `(owner_id,copy_id)`；真实讨论及联系人完整FK；实际SDK实例身份唯一。受管定位不是用户任意路径。ready状态需要可核验的提交边界，重建前可以尚无事件，但不能伪造SDK事件号。业务讨论与运行副本为1:N，不能只在讨论上放当前文件路径。

### runtime_copy_input

字段：`owner_id,copy_id,input_id,incorporation_no,event_start,event_end,provenance_state`。PK `(owner_id,copy_id,incorporation_no)`；真实副本和精确实际输入FK。输入实体由回复模块定义，属于接口待整合项，不预设Q43共享材料结构。

输入与副本是多对多；事件边界未知时NULL并标明未知，不能编造位置。清理可以保守重建整份受影响副本，但必须保留反向依赖以找到它。

官方DSH JSONL持久化与SQLite是独立存储；现有查证未发现公开delete接口。设计要求受管文件清理协议，不臆造官方接口或宣称数据库事务覆盖文件。

### deletion_operation

Q42已确认统一操作身份。一行字段：`operation_id,request_key,scope_kind,subject_identity_snapshot,accepted_generation,state,plan_revision,created_at,completed_at`。

PK `operation_id`；请求键在明确命名空间内唯一。原主体的最小身份快照不是可任意查询的通用对象ID，更不是原聊天正文；字段按owner/contact/source/discussion等有限范围分别约束。原对象删除后账本仍有效，不强制FK到将消失的live对象。

### deletion_target

一行字段：`operation_id,target_no,storage_kind,expected_identity,plan_revision,state,attempt_count,last_error_code,completed_at`。PK `(operation_id,target_no)`，operation真实FK。

row与file使用各自正式地址字段及互斥CHECK，不能仅有任意字符串target_id。字段必须表达预期代次/文件身份，防止重试误删新内容。只有相同目标在同一计划内才幂等，第二次用户清空是新操作。

长期读取排除和旧请求拒绝属于持续约束，是否与本表共用须另证粒度和保留期；当前不为少表直接塞入目标进度。若共用，封存必须为已完成且持续有效的类型，父操作不得常规剪枝，完成聚合不能等待封存键被擦除。

### deletion_check

一行字段：`operation_id,plan_revision,check_kind,check_no,result,checked_at,verifier_version,minimal_proof`。PK上述操作/修订/复核面/序号，operation FK。必要复核面由具体范围决定，不能用无关检查凑全通过。

同一目标已删与整存储面无残留是不同事实，因此复核有独立1:N关系。`minimal_proof`不保存原文；完成必须对应当前计划、已撤销旧writer、全部必需面通过。

## 事务与失效

1. 短数据库事务接受删除并撤销原写入代次，固定范围。
2. 在撤销保护下确定依赖闭包、登记目标；未登记完前不得先删除唯一依赖边。
3. 事务外停止运行副本写入、执行文件清理；数据库行清理按固定代次，不能扩大到新数据。
4. 分面复核，失败沿原操作继续；仅全部条件成立后标完成。

这些是数据库设计要求，未验证跨存储实现。用户原始Skill目录、外部原始文件和模型密钥不因“无新库引用”成为清理目标。
