# 固定处理目标、实际执行与模型调用

2026-10-29，结构收敛提案；遵守Q25固定消息与有界前文、Q27同步开关仅停读取、Q38任务固定一轮与手动继续。表名和字段仍为建议，不设表数目标，不执行建库。

## 1. 用一次操作确定粒度

用户选择A、B并点击开始，得到一个run。点击时接受的消息集合固定；之后新增消息留给下一轮。联系人处理及本人整理分别有固定范围task。一个task可有多个可恢复step，例如一批提取、核验、组织、发布。某step实际运行一次产生attempt；失败后人工继续，可以新增attempt，但成功且仍合法的步骤不重跑。

run、task、step、attempt分别回答“一次启动”“一个范围的工作”“可恢复位置”“实际运行过哪一次”。不能为每个内部函数建step，也不能给同一个范围再建立与task一一对应的round壳。

本人整理用到本轮联系人结果时，只能取自点击时固定的合法贡献。可在前序结果形成后建立新的固定step并一次冻结该step的具体版本输入，但不能向已冻结step追加材料，不能从运行中新增聊天取材。task的范围和接受消息集合始终不变；这区分固定任务边界与稍后生成的确定中间产物。

## 2. 控制、工作与执行的具体结构

以下主键和外键均带owner范围；联系人引用含contact。INTEGER计数非负；?表示可空。对本人范围contact为空需显式CHECK，不能利用NULL绕过owner FK。

| 主体 | 一行事实及主要字段 | 主键/关系/独立理由 |
| --- | --- | --- |
| processing_run | 一次点击：run_id、owner_id、start_request_key、started_at、state、intent_revision、pause_requested_at? | PK(owner,run)；启动键唯一；run 1:N task，全局暂停意图不能在每任务复制一份权威值 |
| run_contact | 本轮某联系人贡献：run/contact、原grant_id、accepted_selection_generation、accepted_data_generation、state | PK(owner,run,contact)；真实授权及contact FK；原代次不可刷新；每人可独立撤销，存在真实1:N |
| processing_item | 一条消息的持久处理身份：item_id、contact/message、purpose、extraction_state、pipeline_state、completed_at?、completion_attempt_id? | PK(owner,item)；完整message FK；UNIQUE(owner,contact,message,purpose)；跨run保持同一身份，不引用不存在的message_version |
| run_target | 点击时固定目标成员：run/contact/item、ordinal、accepted_interpretation_revision | PK(owner,run,item)；真实run_contact和item复合FK并核同联系人；目标N:M轮次，失败/暂停不能靠换轮跳过旧状态 |
| processing_task | 本轮固定范围：task_id、run_id、scope_kind、contact_id?、state、control_revision、resume_no | PK(owner,task)；真实run及范围FK；同run同范围/用途唯一；控制修订不替换原联系人许可代次 |
| task_contribution | 任务依赖本轮哪些联系人贡献：task_id、run_id、source_contact_id | PK(owner,task,source_contact)；task与run_contact真实FK且同run；联系人任务单人，本人任务可多人；固定贡献不得通过重试删标签洗掉 |
| processing_step | 可恢复小批或阶段：task_id、step_no、kind、input_state、state、successful_attempt_no? | PK(owner,task,step_no)；task FK；成功指针完整FK指本step的实际attempt；失败发生在步骤，不等于全task重做 |
| step_input | 此步骤的有序冻结成员：task/step/input_no、role、run_target引用?、context_message引用?、candidate_id?、memory_id/version?、document_id/version?、accepted_revision? | PK(owner,task,step,input_no)；有限类型真实FK恰一分支；候选是已确认的固定原稿，不引用候选版本表；消息修订是快照，不是历史FK |
| step_attempt | 步骤一次真实运行：task/step/attempt_no、resume_no、lease_token、lease_expires_at、captured_control_revision、state、started_at、finished_at?、error_code? | PK(owner,task,step,attempt_no)；step FK；每步至多一个有效租约；重试增加实际attempt，不覆盖历史，也不更新step输入 |

purpose是明确业务处理用途，不是每次部署版本、随机请求号或解析器版本，不能随意换值重提同一消息。解释/排序修订变化触发过期复验，不自动产生一个新processing_item。

processing_item的extraction_state与pipeline_state分开：提取已合法提交可以复用，即使后续组织失败；只有所有适用阶段确实结束才标全流程成功。没有新记忆也可成功，候选数量不代表处理完成。成功状态须有真实产生执行及结果，不只存布尔值。

固定前文只在合法输入范围内作为context，不成为run_target，不增加待处理/成功目标计数。step_input是该步冻结成员；实际调用可能只用其子集，实际输入/完整载荷按已建立的追踪关系另记，不能互相代替。

## 3. 本轮不先建通用调度图

提取、组织、发布若是确定的业务顺序，步骤kind和完成条件即可表达。没有独立可配置依赖图需求，不先建立任意task_dependency/phase_definition/plan体系。本人阶段依赖哪些真实联系人产出，须由实际贡献和精确版本输入表达。

“没有任务”“没有候选”不等于阶段完成：每个适用阶段必须有succeeded或带理由的not_applicable结果。若事实证明同阶段必须有多个独立任务或动态依赖图，再为该多值关系建模；不能仅为删表隐藏依赖。

## 4. 模型逻辑操作与物理发送分开

### model_operation

一行是一个固定输入和效果的逻辑模型操作。字段：`owner_id,operation_id,purpose,producer_task_id,producer_step_no,invocation_slot,input_seal,state,resolution_code?,created_at`。

PK(owner,operation)，背景任务有真实step复合FK；固定step+slot唯一；input_seal只用于检查输入不变，不充当权限或唯一业务身份。当前提案针对记忆处理；回复/审核的真实父关系须分别整合，不能为了共表伪造记忆task。

同一operation可能有多次明确允许的发送尝试，因此operation与call不能合为一条可覆盖记录。已知响应但提交失败时可以沿原响应重新核验并尝试提交，不能自动再调模型。

### operation_item

一行表示逻辑操作占用的一条目标及效果阶段。字段：`owner_id,operation_id,item_id,effect_kind,reservation_state`。PK(owner,operation,item,effect_kind)，operation与processing_item真实FK。

在reserved/sent/unknown等活动状态，对`(owner_id,item_id,effect_kind)`建立唯一占用约束。更新占用与operation状态须同事务完成；这是用于跨批次互斥的明确受控冗余，不允许两个状态各自随意更新。

为什么独立：一个提取批次有多个item，一个item可能经过不同效果阶段。只保证operation唯一，仍会被“换task、换请求号、把未知批次拆成单条”绕过；逐item占用才阻止同一效果重复发送。已成功阶段仍由item/成功步骤阻止重做，不因释放在途占用而变成待处理。

组织阶段的效果身份不能假称一条聊天；需固定其真实输入版本与目标范围，涉及未知调用时不得换输入分组盲重发。该阶段的跨重组等价合同仍待单独证明，不能凭一个hash字段宣称所有用途都安全。

### model_call

一行是一回真实外部发送尝试。字段：`owner_id,call_id,operation_id,attempt_no,producer_task_id,producer_step_no,producer_attempt_no,provider,request_id,provider_receipt_id?,state,prepared_at,sent_at?,received_at?,token_usage?,error_code?`。

PK(owner,call)，operation真实FK；UNIQUE(owner,operation,attempt_no)，供应商请求键按实际命名空间唯一。producer完整FK到真实step_attempt，并与operation所属step一致。

每次物理发送只有一个实际发起执行，直接持FK，不另建1:1调用归属表。后续attempt复用已知响应，不修改call的原发起者；复用事实由该attempt的过程事件明确引用原call，不伪造成新发送。

state至少区分prepared、definitely_not_sent、sent_unknown、returned、known_failed。超时、断网、进程退出、租约丢失均不证明没发送。允许新增发送的条件须有明确未发送证据、供应商安全幂等/恢复合同或明确允许的已知终局，不能仅靠用户点继续清除unknown。

## 5. 暂停、撤销和未知结果

| 情形 | 行为与记录 |
| --- | --- |
| 普通暂停 | run记录暂停意图，当前仍有效小批完成后不再领取下一批；不凭暂停把在途call改成未发送 |
| 手动继续 | 复用原run/task/目标与成功步骤；增加resume_no及真实新attempt，不重发已知成功调用 |
| 关闭同步 | 停止微信读取；已保存资料处理按原合法数据资格继续，与记忆暂停不同 |
| 取消联系人A | 撤销本轮A贡献；A及依赖A的混合结果不得提交；B独立工作可继续 |
| A/B本人混合结果遇A撤销 | 不能去掉A标签后当B-only结果提交；后续B-only必须有新的合法固定输入和执行，仍受原轮范围及unknown约束 |
| 已返回响应、数据库提交失败 | 沿原响应重新核验；只有提交资格仍有效才复用，不再调用模型 |
| 模型结果未知 | operation/逐item占用保持阻断；先核回执，不能换编号或拆批重发 |
| 退出/崩溃恢复 | 恢复为等待人工继续；旧租约失效不等于外部调用失败 |

## 6. 事务与完整追踪

启动事务固定run联系人/目标、原许可及消息解释快照。接纳/领取下一轮目标前必须跨旧run检查item成功和unknown，不仅检查本task状态。

发送前事务核验固定输入、全部贡献和当前控制代次，建立operation及逐item占用，记录call准备状态；外部请求在事务外。结果提交事务再次核验资格、真实来源和租约，并原子提交产物、成功步骤和相应状态；晚到响应不得凭仍有call_id绕过硬撤销。

完整请求/返回和本地解析、核验、采纳过程沿实际attempt/call/events保留，依照上一项的实际输入来源关系删除。不另建重复的“记忆trace头”和“task运行头”来表达同一次step_attempt；真正不同的业务决定仍独立。

删除时先撤销资格，再清敏感输入输出和依赖。保留无正文回执不代表可以恢复旧正文，也不意味着owner/contact整体删除时所有账目永远保留；保留范围由统一删除合同决定。

## 收敛结果和未闭合点

本稿给出可恢复处理的最小事实层级与字段提案，替代首稿中虚构message_version、candidate_version输入引用及未经需求证明的通用调度壳。不是完整可执行schema。

仍须统一：范围表/授权键的最终名称；phase完成与item全流程终局的事务更新；聚合操作跨分组的unknown等价门禁；全领域model_operation的真实父形状；删除后最小拒绝状态的保留合同。不能以此次结构讨论替代这些证明。

下一项建议收敛助手讨论、候选回复及实际上下文：哪些业务历史属于数据库，哪些只是DSH运行副本，以及删除如何同时覆盖。
