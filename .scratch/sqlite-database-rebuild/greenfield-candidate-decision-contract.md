# 记忆候选、采纳与人工操作

2026-10-29，结构提案。本项讨论记忆候选；Q39已确认的回复候选版本不受此项改变。本人候选去重/合并属于已有产品需求，不为减少表数省略。

## 1. 候选的事实与待确认边界

模型提出一个主张、用户最终采纳一版内容、用户曾在编辑框中输入几次，是不同事实。

建议：记忆候选保留模型原稿；用户修改后点击采纳，直接形成正式memory_version。原稿继续通过候选及完整执行追踪可查，不用修改稿覆盖原稿。尚未提交的编辑不默认建立持久多版本历史。

2026-10-29用户选择A：保留模型原稿，修改并采纳后形成正式memory_version，不保存采纳前多稿历史，因此当前不建memory_candidate_version。此决定不额外承诺未提交草稿跨重启恢复，也不改变Q39回复候选版本。

## 2. memory_candidate：一次提出的主张

字段（默认非空，?可空）：`owner_id,candidate_id,origin_contact_id,scope_kind,target_contact_id?,proposed_body,produced_execution_id,output_no,state,state_revision,created_at`。

PK `(owner_id,candidate_id)`；真实owner、原始贡献contact、产生执行FK；UNIQUE(owner_id,produced_execution_id,output_no)。scope=self时目标contact为空，scope=contact时必须有同owner联系人FK。原始贡献人与主张最终范围不同，不以一个contact_id混用。

proposed_body是模型原稿，普通操作不可覆盖；合法来源删除可擦除。state是pending/adopted/rejected/invalidated/erased等当前资格状态，state_revision用于CAS。状态不是独立历史，历史动作在下述decision记录。

一个执行可以提出多条候选；候选可被拒绝、失效而永远没有正式记忆，不能先伪造一条已采纳memory。原稿模型响应在完整追踪中也存在，是Q29要求的实际载荷，不是两份可独立修改的权威正文；两处删除路径均需覆盖。

候选证据和必需消息引用本候选的固定原稿。若选择支持持久候选版本，就改为引用具体候选版，不允许证据随当前编辑文本悄悄变化。

## 3. memory_decision：一次真实处理决定

字段：`owner_id,decision_id,request_key,action_kind,actor_kind,execution_id?,target_memory_id?,expected_version_no?,result_memory_id?,result_version_no?,restored_from_version_no?,created_at,outcome`。

PK `(owner_id,decision_id)`，UNIQUE(owner_id,request_key)。actor_kind=user/system；system动作须有真实执行FK，user须来自真实受理的用户操作，模型输出不能自称用户确认。

目标及结果分别完整FK到memory/memory_version；恢复来源必须同目标memory。各action的NULL形状用CHECK和明确事务接口限定，不能任意拼字段：

| action | 输入/目标 | 结果 | 来源与权限要求 |
| --- | --- | --- | --- |
| adopt / adopt_edited | 一条或多条合法候选；可更新既有memory | 一条新memory_version | 修改稿重新核验，继承真实来源，不变独立手录 |
| reject | 明确候选集合 | 无内容版本 | 记录真实拒绝动作，不把候选标成已确认 |
| correct | 既有memory及预期当前版 | 同memory新增版本 | 保留来源依赖及真实人工保护 |
| manual_entry | 用户明确独立输入 | 新memory及首版 | 不伪造聊天或模型执行；与修改提取结果分开 |
| restore | 当前版本及合法可恢复旧版 | 同memory新增恢复版 | 复核来源、保护和操作顺序；不复活已删正文 |

一次决定只产生一条正式内容版本，或没有版本；一次处理批可包含多次决定。若以后明确需要一个用户动作原子修改多个memory，再定义真正的操作组，不预建空壳。

拒绝不产生版本，因此决定不能全塞进memory_version；同一候选可经历多次真实决定，同一memory也可被多次修改，因此也不能仅在主体上留last_action。另一方面，只记录成功采纳的1:1 memory_adoption壳没有新增必要事实，可由decision的adopt分支表达。

正文版本保留形成方式，decision记录谁做了什么；user发起restore不自动使恢复内容成为user_confirmed，必须保留内容的原采纳性质。

## 4. memory_decision_candidate：决定实际涉及哪些候选

字段：`owner_id,decision_id,candidate_id,relation_kind,accepted_state_revision`。PK `(owner_id,decision_id,candidate_id)`；两端真实完整FK。relation_kind可为adopted/rejected/considered，具体枚举按实际动作约束。

一条本人记忆可能合并多个合法候选，故不能只在decision放一个candidate_id。一次拒绝后可能有新的明确操作，因此历史关系不等于候选只能出现在一行。

同一候选的同一有效贡献不得重复采纳；以明确采纳唯一约束与候选状态CAS共同保证，不靠正文相似度判断。恢复引用旧memory_version，不重新消费旧候选。采纳目标scope/owner一致；本人多联系人贡献保留原联系人及原授权资格，取消A后不能删掉A标签就提交旧混合结果。

多个候选共同形成一版记忆时，result_version由decision确定；因此从这张关系及decision能查询该版由哪些候选形成，无须再复制一张同义“版本候选映射”。

## 5. 证据如何从候选进入正式版本

采纳不是把candidate_id填进version就结束。必须把最终正文的必需消息与展示片段建为新版本的真实关系，并保留原候选/执行来历。

编辑可能缩小、扩大或改变语义，不能机械复制原证据后宣称新内容已核验。无法证明新增内容时不自动通过；要求重新核验或由用户明确建立独立手录事实。界面点击确认不具备切断原来源依赖的效果。

独立手录可没有候选；修正已从聊天提取的事实仍携真实来源。修改内容、调整证据和切换当前版在同一短事务提交，避免新正文配旧依据。

## 6. 操作幂等、拒绝与删除

同request_key重放且参数相同，返回原决定结果；同键不同输入必须冲突。原始请求比较信息与敏感正文分开管理，删除后保留何种最小拒绝键由删除合同决定，不靠删除记录释放唯一键使旧请求重建资料。

reject不等于清除所有敏感副本，也不自动形成永远禁止同类事实的全局规则。持续纠错保护是另一明确需求，不能从一次reject推导。erase/delete走统一deletion_operation完成跨数据库和文件清理，不再建立第二套“记忆删除已完成”账本；需要显示删除动作时引用该真实操作。

来源删除覆盖候选原稿、已保存编辑稿（若该能力纳入）、相应证据、完整执行载荷和受影响正式版本。decision保留的最小身份/结果不得夹带被删正文；恢复动作不得读取已擦除载荷。

## 7. 原子提交示例

1. 接受request_key，核验原动作/请求一致性。
2. 核验候选state_revision、来源、贡献资格及目标memory的expected_version。
3. 建立decision、实际候选关系和新memory_version，写入对应必需消息/证据。
4. 原子更新候选状态和memory当前指针；不满足CAS则整体回滚，不留下幽灵采纳。
5. 若只是reject，只写决定、候选关系和状态；不生成空正文版本。

version与decision若双向引用，DDL须明确延迟FK及事务闭合，或只保留一个权威方向加唯一约束反查，不能用无外键字符串避免循环。本项先确定事实，不为双向便利预设额外表。

## 用户决定（2026-10-29）

已选择A：候选保留模型原稿，修改并采纳后形成正式记忆版本，不保存采纳前的多稿历史。

未采用B：候选阶段的多稿保存/恢复及独立候选版本表。本次不据此扩展需求。

两者都保留模型原稿、正式记忆版本、真实决定与完整来源；Q39回复候选仍按已确认的版本结构执行。
