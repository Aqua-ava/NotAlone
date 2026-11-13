# 助手讨论、候选回复、实际上下文与运行副本

2026-10-29，结构提案。Q39已确认回复原稿及手工编辑稿统一版本；Q43未决定跨用途共享材料；最终微信发送始终由用户完成。本项不改变记忆候选不存采纳前多稿历史的选择。

## 1. 四类事实

| 事实 | 例子 | 保存位置 |
| --- | --- | --- |
| 用户的业务讨论 | “这句话怎样回应”“再简短一点” | SQLite讨论记录 |
| 可选择的回复及版本 | 候选C的模型v1、手改v2，用户选了v2 | SQLite候选及选择记录 |
| 生成时实际使用的材料 | 当时的消息、记忆v3、偏好v2和Skill具体内容锚点 | SQLite精确输入关系与完整载荷 |
| DSH执行状态与历史文件 | 实际SDK session、工具事件、持久化文件 | 官方运行时文件＋SQLite受管映射 |

业务讨论不是SDK session的别名；一个讨论可以有多次请求、重建的运行副本。保存了业务回复也不等于运行文件已经持久化完毕。

## 2. 讨论、请求与执行

以下PK/FK均含owner；联系人业务还含contact。?为可空，正文等敏感值允许按删除合同擦除但不得伪装成正常空正文。

### assistant_discussion

字段：`owner_id,contact_id,discussion_id,title?,created_at,state,current_runtime_copy_id?`。

PK(owner,contact,discussion)，真实contact FK；归属联系人不可原地更换。标题仅展示，不判重。current_runtime完整FK限同讨论副本；可以为空，不能为占位捏造DSH实例。

### discussion_entry

一行是一条实际业务发言。字段：`owner_id,contact_id,discussion_id,entry_id,position,role,body,origin_request_id?,origin_call_id?,created_at,content_state`。

PK(owner,contact,discussion,entry)，讨论内position唯一，真实discussion FK。role=user/assistant；模型生成助手发言须有真实请求/调用来历，用户发言不伪挂模型call；系统/工具协议消息不伪装成用户业务发言。

本稿先按不可原地覆盖的发言建模，后续补充通过新发言表达；是否允许编辑旧业务发言并保留分支，需要单独确认。未经确认不默认增加discussion_entry_version。这个未决项不影响Q39候选版本，也不是已获批准限制用户交互。

候选正文不再另复制为一条可独立编辑的assistant发言；界面按请求关联展示候选。模型完整原始输出另属执行载荷，两处用途及删除范围明确。

### reply_request

一行是一次明确的业务请求：`owner_id,contact_id,discussion_id,request_id,request_key,trigger_entry_id,request_kind,carried_selection_id?,identity_origin,binding_id?,manual_confirmation_id?,confirmation_snapshot?,state,created_at`。

PK(owner,contact,discussion,request)，请求键在该讨论内唯一；真实用户发言FK。一个发言可能触发明确的重新生成，因此请求身份不同于发言身份。request_kind区分讨论回答/生成候选/按新要求重写等实际用途，不自动建立后台请求。

携入候选须引用真实选择事件及其精确版本，不能仅引用候选head或默认带上上一轮。手动确认与已核验绑定按origin互斥；单次确认可存正式字段，跨请求可撤销确认若确有复用需求才独立实体。不能为免表改变既有确认交互。

### reply_attempt

一行是请求的一次实际运行：`owner_id,contact_id,discussion_id,request_id,attempt_no,started_at,finished_at?,state,lease_token,accepted_data_generation,control_revision,error_code?`。

PK完整request键＋attempt_no，request真实FK。请求可能尚无执行，失败执行可能没有候选；因此request 0:N attempt，attempt 0:N产物。重试不改原输入、不自动绕过unknown。

共享model_operation的回复分支必须真实FK到reply_request及固定操作槽；model_call真实发起者指reply_attempt。与记忆step父分支互斥，不能伪造memory_task复用字段。是否统一实际执行的物理主体须看最终同构合同，本稿不同时建通用execution和同义reply_attempt两套头。

## 3. 候选版本与选择

### reply_candidate

字段：`owner_id,contact_id,discussion_id,candidate_id,request_id,candidate_no,created_at`。

PK完整讨论键＋candidate_id；真实request FK；UNIQUE(request完整键,candidate_no)。这里只存候选身份和产生位置，没有original_text/edited_text/v0。

模型重新生成按新的明确请求产生新候选，手工编辑追加同候选版本；此为当前结构建议，不用不同身份掩盖一次实际重试产生的重复输出，幂等仍以真实请求/调用输出位置判断。

### reply_candidate_version

字段：`候选完整键,version_no,origin_kind,parent_version_no?,producing_call_id?,output_no?,edited_at?,created_at,content_state`。

PK候选完整键＋version_no；候选FK；父版本完整自FK限同候选。v1为模型原稿，须真实call及输出位置；手工编辑须有父版，不能伪造新的生成call。模型输出位置按真实call唯一约束，不按正文hash去重。

### reply_version_part

一行是一版候选中的一条可发送文字：`候选版本完整键,part_no,text_body`，PK版本键＋part_no，真实version FK。一个候选可能有多条短消息，所以逐条保存；若产品只支持单条，这个1:N前提需在最终接口核对，不能仅为格式排版增表。

part_no只表示该版本内顺序；跨版本定位必须带版本号。没有独立跨版段身份需求时不再建segment头。Q39统一正文落在这套版本成员中，原稿和手改稿用同一读取/删除规则。

### reply_selection

字段：`owner_id,contact_id,discussion_id,selection_id,request_id,selection_no,candidate_id,version_no,selected_at`。

PK完整讨论键＋selection_id；请求内selection_no唯一；真实request和候选版本FK并核同请求/范围。改选新增事件，旧选择永远指旧版；编辑后不自动改写旧选择。

选择、复制、展示都不证明微信发送，不设置由这些动作推导的sent_at/delivered。撤销选择是否作为独立动作需按实际产品合同确认，不以删候选伪造撤销事件。

## 4. 实际上下文和展示依据

### reply_context

一行是某次实际输入的冻结快照：`owner_id,contact_id,discussion_id,context_id,request_id?,attempt_no?,origin_kind,frozen_at,preference_revision,skill_catalog_revision,policy_revision,content_state`。

PK完整讨论键＋context_id；请求执行型有真实attempt FK；运行重建型明确origin_kind并绑定真实讨论，不伪造attempt。集合修订即使选中零项也记录，防准备后新增禁用/偏好绕过复验。

一个attempt可以形成多个context，每次call指向实际最终使用的那个。动态检索/Skill读取会产生新的实际输入，不能将开始时的拟选清单冒称全程输入。

### reply_context_item

字段：`context完整键,item_no,kind,role,presentation_no,message_contact_id?,message_id?,record_id?,accepted_interpretation_revision?,memory_id/version?,candidate_id?,document_id/version?,preference_id/version?,skill_package_id/revision?,discussion_entry_id?,selected_reply_version引用?`。

PK context完整键＋item_no；context FK；每种kind只允许对应的完整真实FK分支。message使用真实message与capture_record键，解释修订仅为快照；记忆候选引用固定原稿，不再有候选版本占位FK。已有记忆候选若允许作为回复参考，必须显式标记未采纳性质，不能冒充已确认事实。

本人资料可在同owner合法范围内引用，但不开放任意其他联系人聊天。版本引用固定到具体内容，不能挂会变化的head。selected/loaded/model_reported等事实严格区分，Skill被拟选或模型自报不代表实际读取。

跨业务material_set继续未决；本稿仅定义回复实际输入所需事实。没有独立持久保存拟取材计划/审批计划需求时，不再默认建reply_context_plan及其成员；如果确需回看检索计划，必须明确它与实际输入不同的生命周期。

### reply_basis

字段：`候选版本完整键,basis_no,context_id,item_no,relation_kind,explanation?`。

PK版本键＋basis_no；精确候选版、真实context_item FK。生成稿引用必须属于其产生call实际参与的材料或已记录的上游依赖，不能从其他上下文临时补一条看似相关证据。

手工编辑继承的依据要标明继承/未复核，不能宣称模型已审核新稿。展示依据只是完整依赖的子集；删除还要遍历所有实际输入及上游来源。

## 5. 运行副本与跨存储完成

沿用文件事实稿的runtime_copy及runtime_copy_input概念：前者一行一个实际SDK实例，后者记录该副本纳入哪些reply_context。关系为真实多对多，不能只存最后一个context摘要。引用均使用上文同讨论完整键，不用无类型input_id。

新库不会自动把DSH的JSONL改成SQLite。此前固定版本查证显示官方接口有create/open/flush/stat/list，未发现公开delete；close或live session消失不代表文件已擦除。实施前仍须复验锁定版本，不臆造接口。

副本状态建议至少区分preparing/dirty/ready/blocked/retired。ready必须同时满足：业务提交存在、真实文件持久化屏障完成、实际事件边界/配置/材料资格匹配。DB事务与文件flush不具备天然原子性。

- 文件已写但业务未提交：副本保持dirty，不从中恢复成已完成回复。
- 业务已提交但文件未确认持久化：保留业务结果，副本不标ready；按合法业务历史重新构建，不能重复模型生成来修文件。
- 旧材料失效：先撤销旧副本写入资格，再按实际context关系找全部受影响副本，不只清current副本。
- 删除目标独立于将被删除的讨论/副本行，登记完成前不先移除唯一依赖；清完文件与数据库并复核后才报告完成。

重建只能采用仍合法的业务历史，不恢复已删消息/版本/输入，也不能利用未知SDK事件位置猜测某份文件已经干净。数据错误、锁未知或身份不匹配时应阻断复用。

## 本次收敛与下一项

已经给出讨论→请求→实际执行→候选版本/选择，以及实际context→运行副本的关系提案。去掉首稿中无确认需求支撑的默认“所有讨论文字均多版本”和“拟选材料计划”前置；它们仍是待产品事实核对项，不代表已获准删除现有功能。

尚须核对旧发言编辑/分支、候选多条消息与改选携入的实际交互；跨域调用父键和正式偏好/文档/Skill版本键继续整合。没有执行DDL或App验证。

下一项收敛明确表达偏好与场景/画像：为什么不是一份通用memory正文，以及版本和发布集合怎样避免混用。
