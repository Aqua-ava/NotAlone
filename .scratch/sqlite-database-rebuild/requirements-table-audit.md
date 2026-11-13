# 原112项候选逐表必要性审查附录

> 当前方向：从业务事实重新设计。本文件仅为旧草案审查记录；54表视图未获认可，不是设计起点或目标。主入口：[全新设计](greenfield-design.md)。

2026-10-28 · 全部结论都是设计建议，未获用户逐项批准。主入口为[按需求总清单](requirements-table-rationale.md)。旧PG仅查漏；resolved不表示批准每张物理表。

112为审查对象，分类为49项建议独立、27项建议合并、32项条件范围、4项不独立建。这些分类不能相加当新表数：多项可合成一张、保留项可能改名，条件项也可能合并/派生。基础54表视图与适用假设见主文档。

## owner

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一位本机资料所有者的内部身份与建立时间，不存微信账号、昵称或登录体系。
- 实际需求：已确认所有联系人资料按 owner_id + contact_id 隔离；本人记忆也需要独立于具体联系人的归属。
- 独立或合并理由：owner 是账号、联系人及本人资料的共同父身份。将其等同微信账号会使账号撤销影响资料所有权；将 owner_id 仅写成常量则缺少范围外键的真实父行。当前只有一个 owner，不因此预建多租户。
- 主键、外键、关系：PK(owner_id)；联系人、账号及本人范围记录真实 FK 到此。
- 取舍与前提：表可很小；不复制旧 owner.display_name，也不预建用户设置表。
- 根据：.scratch/sqlite-database-rebuild/spec.md:31；.scratch/sqlite-database-rebuild/issues/02-contact-identity-model.md:36。

## channel_account

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：已核验的外部微信账号身份、状态与核验时点；可同时容纳本账号当前读取开关和开关代次。
- 实际需求：同步必须知道数据来自哪个真实账号，账号撤销与资料 owner 不同；Q27 又要求微信读取开关不控制已保存资料的记忆处理。
- 独立或合并理由：owner 与外部账号是不同身份；一个 owner 可留下先后核验的不同账号记录，账号属性不依赖某位联系人。开关当前值严格一账号一份，没有理由再拆 1:1 控制表。
- 主键、外键、关系：PK(owner_id,account_id)；FK owner；UNIQUE(owner_id,channel,external_account_id)；每 owner/channel 至多一 active 账号；read_switch_generation 随真实开关变化推进。
- 取舍与前提：将身份状态和读取开关分成明确列与操作，不能因为共表就共用一个状态或代次。
- 根据：.scratch/sqlite-database-rebuild/issues/02-contact-identity-model.md:47；.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:85；.scratch/sync-memory-behavior/spec.md:68。

## contact

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：用户的一位联系人、当前展示名，以及本联系人的当前生命周期、数据代次和来源集合修订。
- 实际需求：所有回复必须映射到真实已确认联系人；重名和改名不改变 contact_id；整联系人清空与局部来源删除需使用不同资格修订。
- 独立或合并理由：联系人是独立业务主体，既不等于会话 locator，也不等于昵称。当前数据控制严格每联系人一行，依赖同一个键，可以放在主体中，不必用竖拆制造表。
- 主键、外键、关系：PK(owner_id,contact_id)；FK owner；display_name 不唯一；data_generation、source_set_revision 分列；current_clear_boundary_id 为有范围验证的可空 FK。
- 取舍与前提：昵称历史仍未决定，不预建历史表；数据代次与来源修订不能合并为一个通用 revision。
- 根据：.scratch/sqlite-database-rebuild/issues/02-contact-identity-model.md:69；.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:87。

## conversation_binding

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一个已核验微信账号内的私聊身份到 contact 的映射、核验快照和修订。
- 实际需求：Q34 确认取消后重新选中同一已核验会话沿用 binding_id；身份映射不能因读取授权撤销而消失。
- 独立或合并理由：账号有多个会话；联系人和绑定有不同身份及历史。将 locator 直接塞 contact 会混淆账号命名空间，合进授权则每次重新授权都制造新身份。
- 主键、外键、关系：PK(owner_id,binding_id)；同 owner 的 account/contact 复合 FK；有效账号+locator 唯一；范围超键供 source_batch、message 和授权引用。
- 取舍与前提：当前不建额外 contact_channel_identity；只有证明对方身份与私聊 locator 非一对一时才补该实体。
- 根据：.scratch/sqlite-database-rebuild/spec.md:78；.scratch/sqlite-database-rebuild/issues/02-contact-identity-model.md:84；.scratch/sqlite-database-rebuild/issues/02-contact-identity-model.md:131。

## source_batch

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一次真实接收的单绑定、有界 CLI 返回页：适配器版本、请求和返回 cursor、捕获时点、授权及删除资格快照。
- 实际需求：同一已捕获页提交重试要幂等；真实再次读取是另一份来源；必须追溯原始记录何时、依据哪次授权进入系统。
- 独立或合并理由：一页包含多条原始出现，页级 cursor 和资格事实不依赖单条 record。全部重复进 record 会制造更新异常，放 message 又无法表达多次捕获和待核验原始记录。
- 主键、外键、关系：PK(owner_id,contact_id,batch_id)；同范围 binding/grant/episode FK；同一次捕获重放沿用 batch_id；不以 cursor 或正文哈希唯一。
- 取舍与前提：不保存可从明细计算的处理计数；原始协议确实声明的 reported_record_count 是不同事实，可保留。
- 根据：.scratch/sqlite-database-rebuild/issues/03-message-source-model.md:30；.scratch/sqlite-database-rebuild/issues/03-message-source-model.md:41；.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:89。

## source_record

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一次捕获页中的原始消息事件出现、原始必要载荷、页内位置和核验状态；可靠时链接到规范 message。
- 实际需求：Q32 允许合法来源范围内的身份不完整记录隔离待核验；一条规范消息可能被不同批次反复捕获，来源级删除不能误删其他有效捕获。
- 独立或合并理由：原始出现与规范消息不是一对一：待核验 record 可无 message，多个 record 可支持同一个 message。合表无法同时正确表达隔离与去重后的单一消息。
- 主键、外键、关系：PK(owner_id,contact_id,record_id)；UNIQUE(owner_id,contact_id,batch_id,record_no)；真实 batch FK；可空同绑定 message FK。
- 取舍与前提：raw_payload 可存原协议载荷，但内部 ID、状态和范围必须正式列；不能借隔离重新保存已删历史或其他联系人正文。
- 根据：.scratch/sqlite-database-rebuild/spec.md:76；.scratch/sqlite-database-rebuild/issues/03-message-source-model.md:31；.scratch/sqlite-database-rebuild/issues/03-message-source-model.md:65；.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:109。

## message

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一条可靠身份的规范聊天消息，含文字或非文字类型、发送方、真实时间/顺序状态。 非文字text为NULL，仅留必要类型/位置元数据，不取媒体资源，不进入记忆。
- 实际需求：聊天去重、文字检索和固定处理目标需要稳定消息身份；Q33 要求图片等仅占位，Q35 允许可靠消息的顺序明确未知。
- 独立或合并理由：它是来源核验后的业务事实，可被多条捕获记录支持；检索、目标和证据不应绑定到某次偶然捕获。非文字和文字共享相同身份及排序合同，不需要分媒体表。
- 主键、外键、关系：PK(owner_id,contact_id,message_id)；同范围 binding FK；UNIQUE(owner_id,contact_id,binding_id,identity_scheme,identity_key)，真实身份合同待证明。
- 取舍与前提：非文字 text_content 为空，只存类型与位置；不建 media、image、placeholder 表；未知顺序不以 UUID 或提交顺序冒充。
- 根据：.scratch/sqlite-database-rebuild/spec.md:77；.scratch/sqlite-database-rebuild/spec.md:79；.scratch/sqlite-database-rebuild/issues/03-message-source-model.md:90。

## deletion_operation

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一个已受理删除操作的请求身份、范围快照、计划进度、撤销写入资格和最终结果。
- 实际需求：Q42 明确统一操作账本、同操作重试、先撤销旧写入资格再清数据库和文件并复核。
- 独立或合并理由：一次删除有多个目标且跨数据库与文件系统，不能在普通业务删除事务中原子完成；被删对象消失后操作仍须继续，不能挂在会一起被删的联系人任务上。
- 主键、外键、关系：PK(operation_id)；唯一 request_key；已核验的最小范围地址为清理快照，不 FK 将消失的 live owner/contact；不得 UNIQUE(contact_id) 阻止再次清空。
- 取舍与前提：成功后清不再需要的敏感地址；账本只授权既受理清理，不是通用读取或执行任意 SQL/路径的能力。 被sealed_request或read_exclusion依赖的最小操作父行不能普通剪枝或级联删除，直至合法撤销这些拒绝规则并证明旧请求不可接纳。
- 根据：.scratch/sqlite-database-rebuild/spec.md:86；.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:50。

## deletion_row_target

**状态：建议合并。** 去向：deletion_target（有限 row/file 类型分支）。

- 一行存什么：删除操作中的一个数据库目标地址、预期数据代次/修订及逐目标清理状态。
- 实际需求：Q42 要求明确类型目标与进度，避免重试重新选择当前新数据。
- 独立或合并理由：与文件目标都是 operation 下可幂等重试的一项目标，状态、错误和预期身份语义相同；共用一张目标表不取消领域清理器。独立两表不是已确认需求。
- 主键、外键、关系：合并后 PK(operation_id,target_no)，FK deletion_operation；row 分支只允许正式定义的表类型与地址字段，并保存 expected_data_generation/object_revision。
- 取舍与前提：有限类型分支必须有互斥 CHECK，不用任意 entity_type+entity_id 或 SQL；若字段组合验证明显更复杂，保留两张也是有效物理选择，不以表数强行合并。 若同表承接sealed_request，封存是已完成的最小拒绝规则，不等待擦除；普通待清目标聚合只统计row/file，复核另确认封存生效。
- 根据：.scratch/sqlite-database-rebuild/spec.md:86；.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:69。

## deletion_file_target

**状态：建议合并。** 去向：deletion_target（有限 row/file 类型分支）。

- 一行存什么：一个受管文件/目录目标的根类型、定位、预期文件身份、manifest 指纹及清理/复核状态。
- 实际需求：删除须覆盖 DSH JSONL、受管缓存和派生 Skill 副本；路径本身不足以安全重试。用户 Skill 原目录受保护。
- 独立或合并理由：与数据库目标共享一次 operation 的独立目标进度，文件身份字段可用严格 file 分支表达；不必为每种运行时/缓存/Skill 再各建目标表。
- 主键、外键、关系：合并后 PK(operation_id,target_no)，FK deletion_operation；file 分支要求 root_kind、受管 locator、expected_identity，按类型要求 manifest_digest。
- 取舍与前提：共表不能降级受管根、符号链接、inode/marker 和用户并发编辑保护；数据库目标删完也不说明文件目标完成。 若同表承接sealed_request，封存是已完成的最小拒绝规则，不等待擦除；普通待清目标聚合只统计row/file，复核另确认封存生效。
- 根据：.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:74；.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:79；.scratch/sqlite-database-rebuild/spec.md:85。

## deletion_verification

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一次操作在一个存储面/门禁上的复核结果，含计划修订、校验器版本、pass/fail/not_applicable 及有界无正文证明。
- 实际需求：Q42 不允许凭数据库行已删宣称删除完成；还要检查缓存、文件、索引和旧 writer。
- 独立或合并理由：操作与复核面是 1:N；复核还可能检查不存在于目标表的残留或未停 writer，不能简单当某个 target 的完成时间。分表允许增补明确复核面，不向 operation 增加一串重复状态列。
- 主键、外键、关系：PK(operation_id,check_kind) 或加 plan_revision 的历史键；FK deletion_operation；完成判定只取本计划本代次的必要面。
- 取舍与前提：当前结果若足够，不额外再建 verification_attempt/history 表；无界日志或正文不得作为证明永久保留。
- 根据：.scratch/sqlite-database-rebuild/spec.md:86；.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:75。

## account_sync_control

**状态：建议合并。** 去向：channel_account 的读取控制列。

- 一行存什么：账号当前 read_enabled 与 read_switch_generation。
- 实际需求：真实开关关闭即停微信读取，off→on 不能让旧页复活；记忆处理不受此开关阻断。
- 独立或合并理由：当前提案严格一账号一行，没有独立历史、多个控制者或不同保留期限需求。它全部依赖 channel_account 的键，拆为 1:1 表仅是代码组织选择。
- 主键、外键、关系：合并后随 channel_account PK；source_batch 保留捕获时代次，入库与发起均核验；不新增 control_id。
- 取舍与前提：读取总开关代次、账号身份修订及记忆暂停仍分语义，不能合成一个 enabled。
- 根据：.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:85；.scratch/sync-memory-behavior/spec.md:68。

## conversation_read_grant

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一次明确授权读取某已核验绑定的凭证：授权代次、契约版本、受理操作和撤销状态。
- 实际需求：Q34 要求绑定身份保留而重新选中建立新授权，旧请求不能借同一 binding_id 恢复。
- 独立或合并理由：一条 binding 可先后有多份授权，已捕获来源要回指当时授权；不是 binding 的一个重复 enabled。只在 binding 留当前开关无法表达来源到底依据哪次同意。
- 主键、外键、关系：PK(owner_id,grant_id)；完整 contact/binding FK；UNIQUE(owner_id,binding_id,grant_no)；同 binding 至多一份 current active grant；提供 batch 用范围超键。
- 取舍与前提：不授予跨联系人范围，不把 CLI 读取授权当助手手动联系人确认；新授权不刷新旧批次资格。
- 根据：.scratch/sqlite-database-rebuild/spec.md:78；.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:86。

## contact_data_control

**状态：建议合并。** 去向：contact 的数据控制列。

- 一行存什么：联系人当前硬数据代次、来源集合修订、当前清空边界和生命周期状态。
- 实际需求：清空/整联系人删除要挡住旧写入；局部来源变化要复核受影响依赖，不应取消无关整轮。
- 独立或合并理由：这些均为每联系人唯一当前状态，未确认独立控制历史或一联系人多控制行；与 contact 同键同生灭，独立成表无必要。
- 主键、外键、关系：合并后 contact PK；可空 clear_boundary 真 FK；CAS 按 data_generation/source_set_revision 的具体用途执行。
- 取舍与前提：仍保留硬 data_generation 与软 source_set_revision 两种字段，禁止用一个 revision 代替不同失效规则。
- 根据：.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:87；.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:91。

## conversation_clear_boundary

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：某可信渠道会话在一次清空操作建立的无正文、可核验历史截断边界及适配器契约版本。
- 实际需求：用户明确清空要覆盖尚未读入的旧历史，之后新消息继续同步；边界必须跨重启及 contact 删除存活。
- 独立或合并理由：一个渠道会话可以多次清空，边界被后续读取 episode 与排除规则引用；它不是当前 contact 的一个时间字段。不能依赖已删消息行或当前授权存在。
- 主键、外键、关系：PK(owner_id,boundary_id)；同 owner 的 account FK、operation FK；正式会话 identity scheme/key；不 FK 会被删除的 live contact/binding。
- 取舍与前提：字段存在不代表 CLI 已支持准确分界；当前能力缺口仍是实施门禁，不能以 local_id、秒级时间或普通 cursor 替代。
- 根据：.scratch/sync-memory-behavior/spec.md:61；.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:93。

## ingestion_tombstone

**状态：建议合并。** 去向：read_exclusion（capture/message/conversation 有限分支）。

- 一行存什么：明确禁止重放的一次旧捕获或一条可靠渠道消息的最小无正文身份。
- 实际需求：来源删除后，换 batch UUID 或重新抓取不能把删除内容当新来源写回。
- 独立或合并理由：与整会话排除同为账号+稳定会话命名空间中的读取禁止规则；一行一种精确作用域可共用执行入口和 operation/boundary 关联，不需两份当前排除账本。
- 主键、外键、关系：PK 可为 rule_id，另建按 capture/message/conversation 类型的条件唯一；真实 account/operation FK；各分支的 scheme/key 字段形状用 CHECK 限制。
- 取舍与前提：capture 规则只防同捕获重放，message 规则才防新捕获；两者都不能替代未读历史的 clear boundary；不能按内容 hash 猜身份。 抑制是长期最小控制，不随短期 deletion_target 计划清理；若复用目标存储，必须另有明确封存和去身份期限。
- 根据：.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:103；.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:105。

## conversation_exclusion

**状态：建议合并。** 去向：read_exclusion（capture/message/conversation 有限分支）。

- 一行存什么：一个可信渠道会话被取消/删除后的当前排除原因、代次及保留的清空边界。
- 实际需求：删除 contact 后自动建联不得立即重建；重选也不能无声解除先前清空边界。全部私聊模式只有另行授权后才启用。
- 独立或合并理由：是读取排除规则的整会话分支；与细粒度抑制共享真实账号和会话命名空间，独立表不是产品必需。
- 主键、外键、关系：conversation 分支 UNIQUE(owner_id,account_id,conversation_identity_scheme,conversation_identity_key)；同账号的 boundary/operation FK；故意不 FK 已删 contact。
- 取舍与前提：新 contact/grant 建立前必须查询既存渠道排除和边界，不能由默认 generation=0 绕过；会话排除与消息排除仍有不同解除规则。 抑制是长期最小控制，不随短期 deletion_target 计划清理；若复用目标存储，必须另有明确封存和去身份期限。
- 根据：.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:107；.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:111。

## history_restore_authorization

**状态：建议合并。** 去向：sync_episode 的 history_restore 分支。

- 一行存什么：用户对一位联系人发起一次恢复全部本机可读历史的明确同意、接受代次和执行状态。
- 实际需求：Q26 确认恢复全部本机可读历史，普通重选、重启和补齐均不能代替这次同意。
- 独立或合并理由：每次明确恢复本来就是一次独立读取 episode；授权范围与该 episode 一一绑定，未确认同一恢复授权可供多个 episode 或跨期复用。可在该正式父行保存明确确认字段，避免单独的授权表再一对一连检查点。 每个 episode 只有一个 authorizing action；明确恢复的同意与该流固定绑定，不构成长期恢复许可证。
- 主键、外键、关系：同sync_episode正式父行：真实grant/binding/contact/boundary FK；授权动作、data_generation和有限恢复目标固定；每次source_batch真实FK episode并固定当次read_switch_generation。
- 取舍与前提：一条恢复同意不跨grant/data_generation或无限扩大读取目标。只关闭/开启读取开关时，仍有效的episode可在原有限目标内续读；新batch接受当下读取代次，旧batch不能刷新代次。已提交合法来源仍可供记忆处理，Q27不被读取开关改变。
- 根据：.scratch/sync-memory-behavior/spec.md:63；.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:113。

## sync_checkpoint

**状态：建议独立。** 去向：建议更名 sync_episode，并收纳该次恢复同意。

- 一行存什么：一次首次历史、增量/补齐或明确恢复读取流的身份、输入范围、有效 cursor、规范化与覆盖状态。
- 实际需求：取消重选后续读、清空换代次、失败恢复都不能依赖最大消息 ID 或已保存条数；来源页和检查点要原子提交。
- 独立或合并理由：同一绑定/授权可有不同代次与多次恢复流，一个当前 cursor 不能表达有限目标及终止历史。它不是 batch：一个 episode 有多页，每页捕获后才获准推进同一个有效位置。
- 主键、外键、关系：PK(owner_id,episode_id)；同范围grant/binding/contact/boundary真实FK；data_generation、stream_kind、有限恢复目标固定；source_batch FK episode，UNIQUE(episode_id,page_no)。
- 取舍与前提：授权动作、grant/data_generation与有限目标在episode固定；read_switch_generation在每次capture/batch接受时固定并于发起/落库复核。off→on可在仍有效原流内续读，不能刷新旧batch或跨撤销恢复权限。capture/normalization/coverage分开，has_more=false不自动证明完整。
- 根据：.scratch/sqlite-database-rebuild/issues/03-message-source-model.md:136；.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:119。

## manual_contact_confirmation

**状态：条件范围／需补必要性。** 去向：单次确认默认并入 assistant_turn 的正式确认字段；确有跨多轮复用才独立。

- 一行存什么：一次用户在前台/手动模式明确选择联系人的确认身份、进程/客户端归属、代次、有效状态与确认时点。
- 实际需求：助手不能把未核验的前台名称当联系人，也不能为手动确认伪造 conversation_binding；一次有效手动确认可服务多轮请求。后一基数需实现前在产品入口核实。
- 独立或合并理由：确认是安全需求，独立表不是天然需求。如果每次请求都重新确认，turn 上正式保存 origin=manual、confirmed_contact_id、confirmed_at、客户端/进程与接受代次即可；不能伪造 binding ID。只有实际确认 1:N turn、可被单独撤销的复用凭证，才保留独立表。旧消费者的复用方式只能作查漏，不能替用户确认新入口合同。
- 主键、外键、关系：单次方案：turn 以同范围 contact FK 和 CHECK 保存正式手动确认事实，binding 字段为空；复用方案：PK(owner_id,confirmation_id)，contact FK，turn 的 manual_confirmation_id 真 FK 且与 binding 按 origin 互斥。
- 取舍与前提：单次方案接受后仍须复验当前 contact/data/binding 资格，不能靠一份永久确认跳过身份冲突；复用方案还须明确确认失效和重新打开后的再次选择规则。 本项不改变前台再次确认或已核验绑定规则；需先核验真实入口是否跨turn复用，不能为了免表改成每次都让用户确认。
- 根据：AGENTS.md:7；.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:61；.scratch/sqlite-database-rebuild/physical-schema-plan.md:86。

## database_instance

**状态：建议独立。** 去向：可统一命名 database_metadata；当前 schema 版本也可存此或 PRAGMA user_version。

- 一行存什么：本数据库实例的随机身份、格式家族、用途角色及建立时点等单例元数据。
- 实际需求：必须把用户业务库和开发/测试库区分，初始化失败不能被当作新库清空；清库和切换必须核对真实实例。具体元数据载体是工程选择。
- 独立或合并理由：数据库身份不是 owner 或微信账号身份；一个 owner 可出现在多个隔离测试/业务实例。单例元数据与业务主体不同，单独一张小表比把数据库归属塞进 contact/owner 更清楚。
- 主键、外键、关系：单例 PK(slot) 且 CHECK(slot=1)；UNIQUE(database_id)；role/format 有限枚举；外部预期实例身份与受管根另行校验。
- 取舍与前提：role=test 不能单独授权破坏操作，仍核验路径/预期身份；这是一张工程元数据表，应与业务表分别报告。
- 根据：.scratch/sqlite-database-rebuild/spec.md:31；.scratch/sqlite-database-rebuild/spec.md:36；.scratch/sqlite-database-rebuild/physical-schema-plan.md:61。

## schema_migration

**状态：条件范围／需补必要性。** 去向：默认可由 database_metadata 当前版本或 PRAGMA user_version 承担版本位置。

- 一行存什么：每个已执行迁移的编号、文件校验和和执行时间。
- 实际需求：需要可靠结构版本管理；逐脚本历史、分支迁移或逐次校验和审计尚未成为明确需求。
- 独立或合并理由：空库重建加单一有序迁移链可用一个当前版本和事务升级保证，不必为了照搬旧迁移器增加历史表。只有需要逐脚本一致性校验/迁移审计，才有 1:N 历史事实值得独立。
- 主键、外键、关系：若启用：PK(migration_no)，checksum、applied_at 非空；与当前结构版本同事务提交；不建通用 key/value 元数据或 JSON 伪历史。
- 取舍与前提：采用仅当前版本会放弃逐脚本运行历史，应在实施前明确是否需要；无论选择哪种，版本未知/较新时拒绝误初始化，绝不自动清库。 user_version 不保存失败、时间或逐文件校验信息，不能宣称与完整迁移账本等价；具体升级策略仍待定。
- 根据：.scratch/sqlite-database-rebuild/spec.md:16；.scratch/sqlite-database-rebuild/physical-schema-plan.md:61。

## memory_candidate

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一条尚待采纳、拒绝或核验的提取主张；含原联系人、正文限定、产生执行和当前资格。 subject_kind明确self/contact/shared，与原始联系人和最终记忆范围分别表达。
- 实际需求：原资料、规范消息、候选与已采纳记忆分层；自动采纳不等于用户确认。
- 独立或合并理由：候选可以被拒绝并永远没有已采纳版本；一个执行可产生多条候选。把候选与memory_version混为一行，会让未采纳内容拥有正式记忆身份或制造空head。
- 主键、外键、关系：PK(owner_id,candidate_id)；FK(origin_contact_id)→contact；产生执行FK→真实step_attempt；不得按正文唯一。
- 取舍与前提：候选不是永久备份；来源删除时清正文与受影响追踪。候选与正式版本可以共用有类型的证据关系，主体仍分层。
- 根据：.scratch/sqlite-database-rebuild/issues/04-memory-evidence-model.md:28-45；.scratch/sqlite-database-rebuild/spec.md:74。

## memory

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：同一条已采纳记忆的稳定身份、owner/contact范围及当前版本指针。
- 实际需求：Q36确认本人和联系人共表；Q37确认恢复属于同一记忆的新版本。
- 独立或合并理由：一条记忆对应多版内容，稳定身份和当前指针的粒度不同于任一版正文；不是为了记录一个状态而另建重复正文表。
- 主键、外键、关系：PK(owner_id,memory_id)；独立owner FK；contact范围FK；current_version完整FK→memory_version(owner,memory,version)。
- 取舍与前提：head只放身份、范围和并发修订；正文、分类、证据在版本，不重复保存当前正文。
- 根据：.scratch/sqlite-database-rebuild/spec.md:80-81；.scratch/sqlite-database-rebuild/issues/04-memory-evidence-model.md:47-62。

## memory_version

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一条记忆的一版正文、限定、自动/人工采纳来历、来源资格及版本生命周期。
- 实际需求：Q36/Q37；用户可查看、修正、撤销且不能把自动资料变成用户确认。
- 独立或合并理由：memory 1:N version 是已确认的内容历史；人工修改与合法恢复都追加版本，不能只覆盖head正文。
- 主键、外键、关系：PK(owner_id,memory_id,version_no)；FK→memory、可空原候选、实际产生执行；origin_kind约束引用形状；同候选一次采纳条件唯一。
- 取舍与前提：版本不可原地改写主张，但来源删除仍须真实擦除正文和限定；历史不是恢复已删资料的豁免。普通前序和恢复来源可先用本表完整自FK表达。
- 根据：.scratch/sqlite-database-rebuild/spec.md:80-81；.scratch/sqlite-database-rebuild/issues/04-memory-evidence-model.md:64-87。

## memory_version_parent

**状态：条件范围／需补必要性。** 去向：普通前序与恢复来源先存memory_version的完整自FK；确认多父合并后才建立本表。。

- 一行存什么：版本到前序、恢复来源及可能多个合并父版本的边。
- 实际需求：Q37只确认追加恢复版本及保留来历；没有单独确认任意多父、跨memory合并图。
- 独立或合并理由：普通修改至多一个前序，恢复再有一个明确恢复来源，两组完整版本FK即可表达。只有确需一个结果依赖任意N个父版本时，1:N父边才是独立关系；不能把草案中的多父能力当已确认需求。
- 主键、外键、关系：若不建：memory_version.previous_version_no及restore_from_memory_id/version_no完整FK；若建：PK(owner,child_memory,child_version,parent_memory,parent_version,relation_kind)，两端版本FK与防环校验。
- 取舍与前提：不建不影响Q37；暂不支持未经确认的多父版本合并。若业务确认该能力，必须保留父边、正文依赖与来源资格的区别，不能把来源消息塞入父边。
- 根据：.scratch/sqlite-database-rebuild/spec.md:81；.scratch/sqlite-database-rebuild/issues/04-memory-evidence-model.md:89-98。

## candidate_evidence

**状态：建议合并。** 去向：claim_evidence（候选或记忆版本二选一真实父FK）。

- 一行存什么：某候选引用的一个文字片段及证据用途。
- 实际需求：可追溯事实依据，能查看具体消息片段；一条消息可有多个片段。
- 独立或合并理由：候选片段与正式版本片段都具有消息、字符区间、用途和核验摘要；可在同一关系表用两组真实父FK和排他CHECK统一，不需候选专属复制一张。
- 主键、外键、关系：共享表PK(owner_id,evidence_id)；候选FK或memory/version FK恰一组；message完整owner/contact FK；各父类型分别建立片段用途条件唯一。
- 取舍与前提：统一后约束稍复杂；必须确保候选证据只能来自原会话，联系人版本只能本联系人，owner版本可用同owner的合法来源。不是无外键entity_type/id。
- 根据：.scratch/sqlite-database-rebuild/issues/04-memory-evidence-model.md:100-115。

## candidate_required_message

**状态：建议合并。** 去向：claim_required_message（候选或记忆版本二选一真实父FK）。

- 一行存什么：某候选正文成立必须保留的一条规范消息依赖。
- 实际需求：所有正文必需消息是AND；同一规范消息的有效捕获来源是OR。
- 独立或合并理由：候选和版本的必需消息关系同粒度、同删除语义，可共表；但不能并进证据片段表，因为一条消息有多个片段，而是否必需属于父主张+消息。
- 主键、外键、关系：共享表PK(owner_id,dependency_id)；恰一组候选或版本父FK；message完整范围FK；每种父+message条件唯一。
- 取舍与前提：显式消息依赖不会因为只有展示引句而丢失；不能用JSON source_ids代替，也不能按有几个片段重复存required标志。
- 根据：.scratch/sqlite-database-rebuild/issues/04-memory-evidence-model.md:100-121。

## memory_version_evidence

**状态：建议合并。** 去向：claim_evidence。

- 一行存什么：某一正式记忆版本引用的一处文字片段。
- 实际需求：版本须有真实可核验依据；本人版本仍保存各来源联系人。
- 独立或合并理由：与candidate_evidence同一类片段关系；主张种类不同由真实父FK排他区分，无需重复四周字段和逻辑。
- 主键、外键、关系：见claim_evidence；版本父FK必须包含owner_id,memory_id,version_no；来源message FK包含实际source_contact_id。
- 取舍与前提：不能把版本证据改挂在会变化的memory head；删除旧捕获所支持的敏感证明仍需清理。
- 根据：.scratch/sqlite-database-rebuild/issues/04-memory-evidence-model.md:100-115。

## memory_version_required_message

**状态：建议合并。** 去向：claim_required_message。

- 一行存什么：某一正式记忆版本正文成立所需的一条规范消息。
- 实际需求：部分来源删除时按真实正文依赖决定是否保留记忆；人工确认不切断原聊天依赖。
- 独立或合并理由：与candidate_required_message同粒度；只合并候选/版本两种父关系，不合并正文依赖与展示证据。
- 主键、外键、关系：见claim_required_message；版本与message分别用完整真实FK；本人版本必须同owner，联系人版本还须同contact。
- 取舍与前提：来源捕获OR与消息依赖AND的层级必须保留；多父版本来历不是正文依赖集合。
- 根据：.scratch/sqlite-database-rebuild/issues/04-memory-evidence-model.md:100-121；.scratch/sqlite-database-rebuild/issues/04-memory-evidence-model.md:156-169。

## memory_trace

**状态：建议合并。** 去向：step_attempt（自动记忆的真实执行主体；必要时统一命名execution_attempt）。

- 一行存什么：一次实际记忆处理的追踪头：范围、执行结果、合同版本、时间及敏感内容状态。
- 实际需求：Q29要求完整实际输入、输出、阶段及来源，可回看且随来源清理。
- 独立或合并理由：当前草案一份有界记忆过程与一次实际step_attempt重合；attempt已有执行身份、结果、时间和trace链接。将trace头字段并入真实执行主体，可省去1:1身份与重复状态；Q29要求完整过程，不要求第二个头表。
- 主键、外键、关系：产生候选/版本、事件与输入关系均FK到真实执行PK(owner_id,task_id,step_no,attempt_no)；保留content_state、input_contract_version及敏感清理资格。
- 取舍与前提：必须保留事件中的完整实际载荷，不能只保留call摘要。所有记忆入口应有真实执行主体；若有无step的合法执行入口，需扩展统一执行主体的真实父类型，不得捏造task/step。如确认同一执行下有多个独立trace再拆。
- 根据：.scratch/sqlite-database-rebuild/spec.md:74；.scratch/sqlite-database-rebuild/issues/04-memory-evidence-model.md:123-154；.scratch/sqlite-database-rebuild/issues/05-processing-task-model.md:122-128。

## memory_trace_event

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一次实际执行中的一个阶段事件，含实际模型请求/返回或程序处理结果。
- 实际需求：Q29明确完整过程；一次物理调用有请求、响应等多个事件，失败过程也要可回看。
- 独立或合并理由：真实执行1:N事件，阶段和实际载荷具有顺序，不能以一个last_error或最终产出覆盖；也不能以无正文模型call替代。
- 主键、外键、关系：PK(owner_id,task_id,step_no,attempt_no,event_no)；FK→实际attempt；可空call FK；事件号保实际过程顺序。
- 取舍与前提：payload可为有格式版本的完整输入/输出值；实体依赖仍有正式输入关系FK。来源删除可清敏感载荷，是否留最小事件身份按删除范围。
- 根据：.scratch/sqlite-database-rebuild/spec.md:74；.scratch/sqlite-database-rebuild/issues/04-memory-evidence-model.md:137-142。

## trace_message_input

**状态：建议合并。** 去向：trace_input（仅记忆执行的有类型输入关系；不预选Q43跨业务材料共表）。

- 一行存什么：一个实际执行实际使用的一条规范消息、目标/前文角色及呈现顺序。
- 实际需求：Q25允许有界前文；Q29完整输入与来源删除；点击后新消息不进入本轮。
- 独立或合并理由：消息、捕获记录和旧记忆版本都是某次实际执行的输入，可用一张表分别定义真实类型FK和排他CHECK；保留不同类型的必要字段，不要求全系统材料共表。
- 主键、外键、关系：PK(owner_id,task_id,step_no,attempt_no,input_no)；执行FK；message/source_record/memory_version等真实FK恰一组；角色和呈现序号。 输入还须有真实阶段event和可空call FK，以区分一次attempt内不同调用的实际输入，不能将并集冒充每次调用的输入。
- 取舍与前提：固定本轮可用集合不等于实际模型输入；processing_input与这里粒度不同，不能因都引用message而合并。显示顺序不冒充微信可靠因果顺序。
- 根据：.scratch/sync-memory-behavior/spec.md:129；.scratch/sync-memory-behavior/spec.md:146-150；.scratch/sqlite-database-rebuild/issues/04-memory-evidence-model.md:144-152。

## trace_source_input

**状态：建议合并。** 去向：trace_input。

- 一行存什么：一个实际执行真实依赖的一份捕获来源及当时资格。
- 实际需求：Q29完整参与窗口随实际来源删除；不能事后换来源复活旧证明。
- 独立或合并理由：与其他实际输入共同属于执行1:N输入关系；source_record引用分支仍必须真实保留，不能只通过message的当前活动来源反推历史实际来源。
- 主键、外键、关系：trace_input的source_record分支完整FK(owner,source_contact,record_id)，与执行FK同时存在；对同来源/用途做受控唯一。 输入还须有真实阶段event和可空call FK，以区分一次attempt内不同调用的实际输入，不能将并集冒充每次调用的输入。
- 取舍与前提：同message另有合法捕获可支持事实，不表示旧trace仍有资格。source输入和message输入可以各有一行；两者含义不合为一个模糊source_id。
- 根据：.scratch/sqlite-database-rebuild/spec.md:74；.scratch/sqlite-database-rebuild/issues/04-memory-evidence-model.md:148-152；.scratch/sqlite-database-rebuild/issues/04-memory-evidence-model.md:164-170。

## trace_memory_input

**状态：建议合并。** 去向：trace_input。

- 一行存什么：一个实际执行实际使用的一版已有本人/联系人记忆及用途。
- 实际需求：同轮整理本人资料及利用合法已有资料时，必须冻结确切版本，而非读取变化中的head。
- 独立或合并理由：仍是实际执行的有类型输入集合；与消息/捕获分支统一关系骨架，具体版本FK保留，不能用摘要代替。
- 主键、外键、关系：trace_input的memory_version分支FK(owner,input_memory_id,input_version_no)；实际贡献若来自本run，能沿版本产生执行回到本run的联系人的固定task。 输入还须有真实阶段event和可空call FK，以区分一次attempt内不同调用的实际输入，不能将并集冒充每次调用的输入。
- 取舍与前提：本人资料不扩大到任意未选联系人原始聊天；旧合法本人材料与本run新贡献需有不同输入角色，逐项复验实际来源。
- 根据：.scratch/sqlite-database-rebuild/issues/04-memory-evidence-model.md:144-152；.scratch/sync-memory-behavior/spec.md:150。

## memory_decision

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一次真实人工/自动裁决操作：采纳、拒绝、纠错、撤销或删除及其结果。
- 实际需求：用户可修正/拒绝/撤销；拒绝和删除可能没有新版本，仍需记录真实操作和防旧结果复活。
- 独立或合并理由：操作可有0个结果版本，因此不能只附在memory_version；一个候选或记忆可有多次操作。仅一次性记忆裁决可统一到此；持续生效、可撤销的组织反馈保护若确认需要，是另一生命周期实体，不能为减表强塞进同一头。
- 主键、外键、关系：PK(owner_id,decision_id)作为稳定重试键；candidate、目标/结果memory_version分别真实FK；action形状CHECK；expected_revision约束提交。
- 取舍与前提：记录人工操作不把聊天提取内容变独立手录；组织反馈是否形成持续保护需要另审。操作内容及保护窗口也要遵守来源删除，不建立通用任意entity_id账本。
- 根据：.scratch/sqlite-database-rebuild/issues/04-memory-evidence-model.md:156-162；.scratch/sqlite-database-rebuild/spec.md:81。

## processing_scope

**状态：建议合并。** 去向：owner / contact_data_control（按已存在的稳定owner/contact身份保存控制字段）。

- 一行存什么：跨轮的owner/contact处理范围身份与硬撤销代次。
- 实际需求：取消/清空立即阻止旧执行写入；普通暂停不能等同硬撤销。
- 独立或合并理由：scope与owner或contact是1:1，没有独立用户可管理实体；重复制造scope_id后再回查owner/contact增加一层。硬代次可放其真实身份/控制行，task保存接受时快照。
- 主键、外键、关系：owner控制用owner_id FK/PK；contact控制用(owner_id,contact_id)；task直接有scope_kind/contact_id约束及对应真实FK，不用无类型scope_id。
- 取舍与前提：读取授权代次与数据/处理撤销代次仍不同字段；同步开关关闭不影响已保存资料处理。局部来源修订也不自动使整联系人所有工作失效。
- 根据：.scratch/sqlite-database-rebuild/issues/05-processing-task-model.md:35-46；.scratch/sync-memory-behavior/spec.md:68；.scratch/sync-memory-behavior/spec.md:74-77。

## processing_run

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一次用户点击启动的协调身份、派发/暂停意图与本轮合同。
- 实际需求：一次启动含多个联系人及本人分支；可暂停整轮、单联系人失败其他继续。
- 独立或合并理由：一次点击1:N各范围有限task，协调状态和某个联系人的执行状态粒度真实不同；不可合为单个task，否则复制全局暂停意图并产生不一致。
- 主键、外键、关系：PK(owner_id,run_id)；owner FK；UNIQUE(owner_id,start_operation_id)；intent_revision做CAS；task真实FK→run。
- 取舍与前提：run不另存联系人ID数组或整体重复进度；联系人集合由task行体现，进度由实际任务/目标聚合。
- 根据：.scratch/sqlite-database-rebuild/issues/05-processing-task-model.md:48-60；.scratch/sync-memory-behavior/spec.md:67-77。

## processing_round

**状态：建议合并。** 去向：background_task。

- 一行存什么：一次run在一个固定owner/contact范围上的分支及其接受代次、状态。
- 实际需求：Q38要求任务不跨轮复用且输入固定，但未要求分支和task有两个物理身份。
- 独立或合并理由：让一条background_task就是本run中某范围的一轮完整有限管线，提取/核验/主题/画像及批次作为step；round与该task变为同一粒度，没必要1:1两张状态表。
- 主键、外键、关系：background_task含run_id、scope_kind、contact_id、accepted_revocation_generation；按owner/run/contact与owner/run本人分别条件唯一；scope直接FK真实owner/contact。
- 取舍与前提：若今后确认一范围一轮必须有多个可独立管理的管线task，才恢复独立round；当前多个阶段/小批已经由step表达，不自行假设需要多task壳。
- 根据：.scratch/sqlite-database-rebuild/spec.md:82；.scratch/sqlite-database-rebuild/issues/05-processing-task-model.md:62-73；.scratch/sqlite-database-rebuild/issues/05-processing-task-model.md:102-120。

## processing_input

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：某个固定task接受的一条可用消息及target/context角色；目标的实际处理结果。
- 实际需求：点击时固定已保存目标和允许前文；新消息等下一次；保留每条成功/失败/未知目标状态。
- 独立或合并理由：task N:M message，并且同消息在不同轮可能作为前文或失败后目标；只记时间上界或一个message.last_processed布尔不能表达点击时的真实集合。
- 主键、外键、关系：PK(owner_id,task_id,input_no)；UNIQUE(owner_id,task_id,message_contact_id,message_id)；task与message完整范围FK；target/context角色及目标分配step同task；producing_attempt与blocking_request为真实FK。
- 取舍与前提：仅保存身份、角色及资格摘要，不复制正文。可将processing_receipt的结果列合到该目标行；每个目标仍有真实产生执行与提交事实。 新建/领取下一轮目标需在同一提交门禁核验该消息以往有效target结果：成功排除、任一未结算unknown阻断，不能换task/request ID绕过。
- 根据：.scratch/sync-memory-behavior/spec.md:34；.scratch/sync-memory-behavior/spec.md:77；.scratch/sync-memory-behavior/spec.md:146-148；.scratch/sqlite-database-rebuild/issues/05-processing-task-model.md:75-90。

## processing_receipt

**状态：建议合并。** 去向：processing_input（target行保存提交结果，跨轮状态由索引查询或视图获得）。

- 一行存什么：某消息跨轮的成功/unknown/失效结果投影及产生执行。
- 实际需求：已经成功的消息不重复作为新目标；unknown阻止盲重发；失败不算成功。
- 独立或合并理由：当前草案已要求每轮固定目标和结果；另建每message一行receipt会成为第二份权威结果。保留target行的真实结果与request/attempt FK即可跨轮查成功或unknown，暂不另维护投影表。
- 主键、外键、关系：processing_input按owner/contact/message、role、completion_state建立查询索引及必要条件唯一；结果的producing_attempt、blocking_request都是实际FK。
- 取舍与前提：用于判定成功的最小task/input记录须随仍存在的消息保留，不能先按旧90天任务清理删掉证明；独立结果生命周期若将来确为需求，再拆receipt。成功是提取结果提交，不代表整个主题/画像管线完成。 跨轮接受/领取时在同一提交门禁复核历史有效结果；不是每request分别唯一就足够。
- 根据：.scratch/sqlite-database-rebuild/issues/05-processing-task-model.md:92-100；.scratch/sync-memory-behavior/spec.md:72；.scratch/sync-memory-behavior/spec.md:77。

## background_task

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一次run内一个固定范围的一轮完整有限处理管线及接受时控制快照。
- 实际需求：Q38固定归属、固定输入、继续沿用合法成功步骤；整轮含提取/核验/主题/画像。
- 独立或合并理由：run 1:N task，task 1:N可恢复step，是真实不同粒度；将同范围round合入这里，不再为每阶段另造task。
- 主键、外键、关系：PK(owner_id,task_id)；run FK；独立owner与有约束contact FK；同run同contact/本人范围条件唯一；accepted硬代次建立后不刷新解除旧失效。
- 取舍与前提：这里先只承诺已确认记忆管线；其他后台领域若使用task必须有各自真实父FK与生命周期，不用task_type+任意id制造通用假外键。
- 根据：.scratch/sqlite-database-rebuild/spec.md:82；.scratch/sync-memory-behavior/spec.md:70-77；.scratch/sqlite-database-rebuild/issues/05-processing-task-model.md:102-120。

## background_task_step

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一个task中的可独立恢复/提交的小批或阶段。
- 实际需求：普通暂停允许当前合法小批完成，继续保留成功步骤；全部适用阶段结束才整轮成功。
- 独立或合并理由：一个task有多个真实小批/阶段，且失败位置和成功状态不同；不能只靠task一个last_stage，也不应为每个内部函数建步骤。
- 主键、外键、关系：PK(owner_id,task_id,step_no)；task FK；task内order_no唯一；step_kind、state、当前attempt完整FK。
- 取舍与前提：先按实际独立提交/恢复边界划分步骤；不存一个估算总进度冒充成功聊天数，实际消息进度来自target结果。
- 根据：.scratch/sync-memory-behavior/spec.md:43；.scratch/sync-memory-behavior/spec.md:70；.scratch/sync-memory-behavior/spec.md:75；.scratch/sqlite-database-rebuild/spec.md:82；.scratch/sqlite-database-rebuild/issues/05-processing-task-model.md:116-120。

## step_attempt

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：同一步骤的一次真实领取/执行：宿主与租约、结果、时间、完整追踪主体元数据。
- 实际需求：Q38明确暂停/失败后继续新增执行记录；退出后保持暂停，旧租约不得提交。
- 独立或合并理由：同一步骤可失败并多次手动继续，存在真实1:N执行事实；覆盖step.last_error会丢掉发生过的执行及旧调用归属。将memory_trace头并入本真实执行主体。
- 主键、外键、关系：PK(owner_id,task_id,step_no,attempt_no)；step FK；lease_generation同step唯一；events/inputs/calls/产物实际FK到该执行。
- 取舍与前提：租约续期是本次执行字段更新，不制造新attempt；失败、模型已发送、业务提交和事件正文擦除是不同事实。合法无step入口如存在，需统一实际执行主体而非伪造step。
- 根据：.scratch/sqlite-database-rebuild/spec.md:82；.scratch/sqlite-database-rebuild/issues/05-processing-task-model.md:122-128；.scratch/sync-memory-behavior/spec.md:74-77。

## step_attempt_guard

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一次执行依赖的owner/contact硬门禁快照，含本run贡献联系人。
- 实际需求：取消A后，A的在途本人贡献不能借重试刷新代次；B的合法工作可继续。
- 独立或合并理由：一次执行可能同时受写入范围、多个当轮贡献联系人的原始授权代次约束，执行对门禁为1:N。门禁是接受资格快照，不只是材料清单。当前尚未证明所有资格都可沿输入无损推导，因此先保留显式关系，不以未证推导减表。
- 主键、外键、关系：PK(owner_id,task_id,step_no,attempt_no,guard_no)；执行真实FK；owner/contact真实类型FK；原run/task、accepted_generation和用途严格约束。
- 取舍与前提：可研究从固定task与实际输入推导；只有证明来源清理后仍能fail closed、重试不刷新原贡献代次、无独立门禁时，才用视图替代。输入缺失不能按空集合全通过。
- 根据：.scratch/sqlite-database-rebuild/issues/05-processing-task-model.md:130-136；.scratch/sync-memory-behavior/spec.md:150；.scratch/sync-memory-behavior/spec.md:154-156。

## model_request

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一次固定工作与操作槽的逻辑模型操作身份、不可变输入合同及重试政策。
- 实际需求：同一有效目标的unknown不能通过换租约或request ID盲重发；一个逻辑操作可有经核验允许的多次物理尝试。
- 独立或合并理由：逻辑操作1:N真实call，操作身份与各次供应商响应事实不同；先建一个稳定逻辑操作作为unknown隔离和重试归属，避免每次call复制可变政策。这里只保留最小规范身份，不另存第二份提示正文。
- 主键、外键、关系：PK(owner_id,request_id)；背景请求完整FK到固定background_task_step（不绑某次attempt），助手请求完整FK到turn及固定输入合同/上下文；两类真实父排他。固定父+invocation_slot唯一，输入seal不可替换；call的真实producer attempt必须属于该父与同一范围。
- 取舍与前提：这张表是建模建议而非用户已逐表批准；若最终可由真实执行主体+稳定slot完整承载同一逻辑身份，可再合并，但必须证明跨attempt重试仍同一操作、unknown仍阻断且输入不被替换。 更换task/request ID不能绕过同一消息的未结算unknown；接纳下一轮目标需跨旧target结果复核，不仅检查本request状态。
- 根据：.scratch/sync-memory-behavior/spec.md:77；.scratch/sqlite-database-rebuild/issues/05-processing-task-model.md:138-144。

## model_call

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一次真实物理模型尝试的发送/结算、实际模型、用量及费用，含真实生产执行FK。
- 实际需求：unknown不是未发生；迟到响应可结算但不能恢复旧写入权。完整敏感追踪清理后，依法允许的最小调用事实仍可保留。
- 独立或合并理由：逻辑request 1:N call，物理尝试有独立时间、结果、token和费用；事件/响应条数不等于调用次数，也不能把模型成功当业务提交成功。
- 主键、外键、关系：PK(owner_id,call_id)；request FK；UNIQUE(owner,request,call_no)；同逻辑request至多一个在途/unknown；真实producer执行FK，多个执行类型用排他CHECK。
- 取舍与前提：不保存prompt、response或正文错误；这些在追踪事件。来源删除与整联系人/owner删除的保留资格不同；迟到结算不授权重新建立已删资料。
- 根据：.scratch/sqlite-database-rebuild/issues/05-processing-task-model.md:146-163；.scratch/sync-memory-behavior/spec.md:77；.scratch/sqlite-database-rebuild/spec.md:44。

## step_model_call

**状态：建议合并。** 去向：model_call（直接保存有类型producer FK与invocation_slot）。

- 一行存什么：一条物理调用到真实step_attempt及操作槽的归属。
- 实际需求：需要确知哪次真实执行授权了每个物理调用；一个call不能属于两个lease/联系人。
- 独立或合并理由：当前定义call至多归属一次执行，实为1:1从属字段，不是N:M；将其真实FK放在model_call可同样保证唯一归属。旧任务90天清理并非已确认需求，不能单凭这种生命周期假设加表。
- 主键、外键、关系：model_call直接FK(owner,task,step,attempt)→step_attempt，slot和该执行条件唯一；与助手等producer分支用恰一组完整FK CHECK。
- 取舍与前提：不能删掉调用的最小生产执行身份后丢失unknown阻重放路径；保留必要执行行或另行证明受控断开协议。不会因为合并而让所有call强制关联记忆step。
- 根据：.scratch/sqlite-database-rebuild/issues/05-processing-task-model.md:165-171；.scratch/sqlite-database-rebuild/issues/05-processing-task-model.md:146-163。

## processing_operation

**状态：条件范围／需补必要性。** 去向：默认先由processing_run的start_operation_id + intent_revision CAS及实际执行记录承载安全语义。。

- 一行存什么：暂停/继续等控制动作的幂等操作键、预期修订和结果账本。
- 实际需求：暂停与继续须防陈旧请求改变新状态；旧PG有操作账本，但用户未单独确认历史控制动作回放/审计需求。
- 独立或合并理由：启动重放可用run唯一start键，暂停/继续携expected intent_revision做CAS可安全拒绝重复或陈旧动作；只有要求任意历史operation_id重放返回原响应、或可回看每次控制操作时，才需要独立1:N操作账本。
- 主键、外键、关系：若建立：PK(owner_id,operation_id)，run真实FK，action、expected_revision、result_revision与最小结果；若不建立，控制更新必须比较预期修订，不仅写最后operation_id。
- 取舍与前提：CAS失败不能默认为执行成功，客户端需读当前状态。未知调用、取消/删除硬失效仍由固定task/实际call规则保护，不能靠清operation状态重发。
- 根据：.scratch/sync-memory-behavior/spec.md:74-77；.scratch/sqlite-database-rebuild/issues/05-processing-task-model.md:48-60；.scratch/sqlite-database-rebuild/legacy-coverage.md:81。

## assistant_session

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：同一联系人下可继续或回看的一个业务讨论。
- 实际需求：候选讨论必须属于已确认联系人，能在历史中回看及继续，不混入其他联系人的讨论。
- 独立或合并理由：一个联系人可有多段讨论，每段有自己的有序输入、当前选择及运行副本；它不是联系人的一对一属性，也不是一次模型请求。
- 主键、外键、关系：PK(owner_id,contact_id,session_id)；FK contact；当前turn、selection、runtime均指本session。
- 取舍与前提：当前指针需同范围约束；只保留一次讨论的实现可更少，但会缩减已有会话历史语义，不能默认这么做。
- 根据：.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:37；.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:47。

## assistant_turn

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一次不可变的明确提交输入及逻辑处理结果。
- 实际需求：生成、追问、意图探索及明确携入须有自己的输入身份、顺序与重放判定。
- 独立或合并理由：session 1:N turn；同一输入可能尚未执行或有多次实际执行。把输入与模型call混为一行会丢掉零调用输入及逻辑请求的幂等身份。
- 主键、外键、关系：PK(owner,contact,session,turn)；FK session；UNIQUE(session,turn_no)与业务范围operation_key；携入指具体候选版本及真实选择。
- 取舍与前提：输入内容只存一次；结构化普通值可受控JSON，实体引用必须真实FK。不要为少表把所有用户操作都改造成turn。
- 根据：.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:52；.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:70。

## assistant_attempt

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：同一逻辑turn的一次真实执行、租约与提交资格。
- 实际需求：取消或删除后迟到结果不能写回；恢复或重复执行须能分清是哪一次实际执行。
- 独立或合并理由：turn 0:N attempt；一次执行还可能有0:N检索和模型调用。它与物理调用不是一对一：调用账不能代替整次执行的租约和结果提交资格。
- 主键、外键、关系：PK(owner,contact,session,turn,attempt_no)；FK turn；租约代次单调。
- 取舍与前提：若未来统一执行引擎确能表达相同资格，可与公共执行实体合并；本轮不为形式强塞后台任务。
- 根据：.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:72；.scratch/sqlite-database-rebuild/spec.md:82。

## reply_candidate

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：某次生成产出的一个稳定候选身份与展示顺序。
- 实际需求：同轮有多个备选，每个候选能单独选择、编辑及精确引用。
- 独立或合并理由：turn/attempt 1:N candidate，candidate 1:N version；身份不随正文编辑改变，且Q39明确要求身份与所有正文版本分离。
- 主键、外键、关系：PK(owner,contact,session,candidate)；FK origin assistant_attempt；UNIQUE(origin_turn,ordinal)。
- 取舍与前提：表内不保存一份原稿或当前正文；避免head与version互相覆盖。
- 根据：.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:80；.scratch/sqlite-database-rebuild/spec.md:83。

## reply_candidate_version

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：同一候选原稿或用户编辑稿的一次不可变版本及版本元数据。
- 实际需求：Q39明确：原稿从v1开始，与编辑稿统一版本存储；选择、引用和删除指向具体版本。
- 独立或合并理由：同一候选存在多个内容版本，旧选择不能随当前编辑被改写；一行可变candidate无法表达。
- 主键、外键、关系：PK(owner,contact,session,candidate,version_no)；FK candidate与同候选parent_version；正文子项由version_message保存。
- 取舍与前提：版本是回复草稿版本，不是长期记忆版本；删除必须清各版实际正文而不是只改状态。
- 根据：.scratch/sqlite-database-rebuild/spec.md:83；.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:86。

## reply_candidate_segment

**状态：建议合并。** 去向：reply_candidate_version_message（固定segment_no作为候选内稳定身份）。

- 一行存什么：候选内跨版本不变的消息段身份和位置。
- 实际需求：一组候选含1–8条消息；手工编辑保持条数、顺序与各条稳定身份。
- 独立或合并理由：现行合同禁止增删和重排，位置本身可作为稳定段键。若segment_id仅是位置的代理ID，就没有必须独立保存的一组可变属性；每版正文按同一个segment_no关联即可。
- 主键、外键、关系：version_message以(candidate,version_no,segment_no)为键；segment_no为1..8且各版覆盖相同连续集合；外部段ID可由candidate与固定序号稳定编码。
- 取舍与前提：提交校验仍须保证条数和序号集合相同；若未来允许重排或段独立生命周期，才恢复独立segment实体。不得因合表允许编辑悄悄增删消息。
- 根据：.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:99；.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:106。

## reply_candidate_version_message

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：某候选版本中固定序号的一条待发送消息正文。
- 实际需求：多条消息需要逐条显示、编辑、复制及定位依据；正文不能同时存整组JSON和单条可修改副本。
- 独立或合并理由：version 1:N message item，是实际重复值，不是一对一壳；用单独行保存可约束单条内容和引用位置。可承接segment的固定序号。
- 主键、外键、关系：PK(owner,contact,session,candidate,version_no,segment_no)；FK candidate_version；citation可FK具体version_message。
- 取舍与前提：每版仅存逐条正文，显示时组装；组完整性用事务校验，不将多条实体引用藏进JSON。
- 根据：.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:99；.scratch/sqlite-database-rebuild/spec.md:83。

## assistant_selection

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：用户一次明确选择某个具体候选版本的事实。
- 实际需求：显式选择可发生多次；编辑、默认展示与复制不能推断为选择，后续携入应能核对当时的选择。
- 独立或合并理由：同一generation turn下允许0:N次选择与改选，所选版本也可跨turn；它不是turn的一对一扩展。只留current指针会丢失先前合法选择及携入来历，改成通用turn事件流又扩大turn语义。
- 主键、外键、关系：PK(owner,contact,session,selection_no)；FK具体candidate_version；session.current_selection指本session选择；携入完整FK选择及其版本。
- 取舍与前提：保存用户选择不代表已发送；若产品明确只需当前选择而不需历史引用，可另讨论缩减，不能从Q39擅自推出。
- 根据：.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:108；.scratch/sqlite-database-rebuild/spec.md:83。

## assistant_context_snapshot

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：某次实际构造的不可变有界上下文和序列化敏感载荷。
- 实际需求：要说明候选实际用了什么、处理到什么时点，并把删除传播到所有输入副本；运行重建也须有合法材料快照。
- 独立或合并理由：attempt可构造多份上下文，runtime_rebuild还可能没有模型attempt；一份上下文可进入运行副本。不能直接变成attempt的一组可变字段或只留内容哈希。
- 主键、外键、关系：PK(owner,contact,session,context_id)；请求型FK本attempt，重建型不伪造attempt；具体call指向其实际最终snapshot。
- 取舍与前提：Q43共享材料未决，先保留用途专属表。动态检索/Skill读取必须产生后续实际快照或事件，不能把最初选择清单当全程输入。
- 根据：.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:114；.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:146；.scratch/sqlite-database-rebuild/spec.md:37。

## assistant_context_item

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：某快照中一项具体材料及版本、用途和捕获时资格。
- 实际需求：来源可反查，生成范围要限定在当前联系人及合法本人资料，删除不能漏掉未显示为引句的参与输入。
- 独立或合并理由：snapshot 1:N item，材料又可被多次输入使用，是真实关联；payload或hash不能代替消息、来源、记忆、文档、偏好及Skill版本的关系。
- 主键、外键、关系：PK(owner,contact,session,context,item_no)；每种材料独立typed FK，形状CHECK恰好一种；支持source item有同context自FK。
- 取舍与前提：可承接skill_use的实际材料关系，但selected、loaded、reported等role必须分清；是否与其他用途共表留待Q43，不先通过此处偷选。
- 根据：.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:120；.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:134；.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:176。

## candidate_version_citation

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：某候选版本或其中一条消息展示的依据定位。
- 实际需求：产品明确候选带依据；展示依据需要指出具体材料及版本，并区分原稿依据与手工修改后的状态。
- 独立或合并理由：候选版本与实际输入之间是0:N展示引用，且只是全部输入依赖的子集；把它当作context item标志会把多个候选的不同引用混在一起。
- 主键、外键、关系：PK(owner,contact,session,candidate,version,citation_no)；FK具体版本、可空version_message、具体context_item。
- 取舍与前提：引用不是完整删除依赖；编辑后沿用原依据须标明原版归属，不能冒称重新审核。
- 根据：.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:138；.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:142。

## assistant_attempt_model_call

**状态：建议合并。** 去向：model_call（typed assistant_attempt FK、context FK和invocation_slot）。

- 一行存什么：某个物理call的助手执行归属、实际上下文和调用槽。
- 实际需求：物理调用需要归属唯一执行及具体输入，不可同时属于后台步骤和助手执行。
- 独立或合并理由：每个物理call恰好只有一个执行归属，本关联本身是以call_id为PK的一对一扩展，且没有独立业务身份。可直接把其受约束字段并入call，省去跨两张关联表保证互斥的复杂度。
- 主键、外键、关系：model_call保留assistant_attempt完整FK与实际snapshot FK；与step_attempt/其他producer分支做排他CHECK和跨表资格校验；槽唯一。
- 取舍与前提：独立生命周期不是自动拆表理由；若需要先剪执行记录，必须先定义最小归属保留/清理协议，而不是照搬旧90天修剪规则。
- 根据：.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:144；.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:148。

## assistant_runtime_instance

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一个业务session的某个真实DSH UUID运行副本、受管定位及ready/dirty资格。
- 实际需求：业务SQLite之外仍有官方JSONL，删除及失效必须覆盖实际当前与旧副本，不能假定删业务行就删了文件。
- 独立或合并理由：一个业务session可有多个真实运行实例，各实例的配置、已提交边界、文件定位和写入资格可独立变化；session的一组current_runtime字段不足以枚举旧副本。
- 主键、外键、关系：PK(owner,contact,session,runtime_id)且runtime_id全局唯一；FK session及可空已提交turn；managed_locator限受管根和已核验目录。
- 取舍与前提：保留该索引不是重建SDK会话表；官方API无delete，具体文件清理需按Q42目标处理与复核，不声称SQLite和JSONL共享事务。
- 根据：.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:34；.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:152；.scratch/sqlite-database-rebuild/spec.md:37。

## assistant_runtime_context

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：某个运行副本实际纳入的业务上下文及事件范围。
- 实际需求：来源删除需要知道哪些外部运行文件受影响；重建或复用也必须按实际纳入材料证明资格。
- 独立或合并理由：runtime 1:N context且同一合法context可被多个重建实例引用，属于材料与副本的真实M:N关系。仅在runtime记最后一个context或摘要无法反查早先材料。
- 主键、外键、关系：PK(owner,contact,session,runtime,context)；两端完整真实FK；event_range可空但必须标来历。
- 取舍与前提：未进入SDK事件的伴随业务材料不得伪造event_range；若改成彻底无持久SDK副本的产品才可重新审查，不因SQLite重建默认取消。
- 根据：.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:156；.scratch/sqlite-database-rebuild/issues/06-assistant-history-model.md:157。

## owner_collection_state

**状态：建议合并。** 去向：owner（各自独立revision字段）。

- 一行存什么：同一owner下偏好集合、Skill目录及策略集合各自单调修订。
- 实际需求：输入准备时须识别随后新增、删除或启停的材料，包括当时选择零项的情况。
- 独立或合并理由：本表与owner严格一对一、无独立身份、无多行历史或独立删除流程；这是owner作用域的一组控制属性。没有必要只为三个字段再造一张状态壳。
- 主键、外键、关系：PK/FK owner_id消失；各revision成为owner非负单调字段，并与相应业务变更同事务推进。
- 取舍与前提：三个含义不能合成一个revision，集合revision也不能用记录数或最大单条版本替代；并字段不会降低隔离或资格检查。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:37；.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:41。

## expression_preference

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一条被明确确认为长期表达偏好的稳定身份及当前版本。
- 实际需求：一次性回复要求不能静默变成长期偏好；长期偏好需可查看、修正、删除并保留实际输入版本。
- 独立或合并理由：owner 1:N长期偏好，每条可修改多版；身份与适用范围的版本变化分离。它是用户明确指令，不应塞入模型推断画像或一次回复输入。
- 主键、外键、关系：PK(owner,preference_id)；FK owner；current_version完整FK同preference；正文及范围在版本。
- 取舍与前提：是否只有当前值而不留版本会影响历史输入追踪；保留版本是为了具体输入/来源而非无目的审计堆表。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:43；.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:52。

## expression_preference_version

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：偏好某次明确确认的正文、适用范围和唯一消息来源。
- 实际需求：过去输入要指向当时的偏好文本及范围；手改来源偏好不能洗成无来源独立事实。
- 独立或合并理由：preference 1:N version，contact/global及reply_mode可随合法手工修改而变化，不能只放在head随时覆盖。
- 主键、外键、关系：PK(owner,preference,version_no)；FK preference、可空contact、来源message；确认operation_key和时间可直接保存本版。
- 取舍与前提：来源目前最多一条message，直接FK，不另建来源消息M:N表；真实删除清除正文及派生副本。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:48；.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:52；.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:54。

## preference_version_source

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：某偏好版本当时采用的各份实际source_record捕获支持。
- 实际需求：消息型偏好必须追踪实际来源，删来源时清理偏好及所有使用副本，不能只留message_id而失去捕获关联。
- 独立或合并理由：一条源消息可由多次捕获证明，同一版本会实际采用多条source_record，存在1:N；不是版本的一组固定单值属性。
- 主键、外键、关系：PK(owner,preference,version,source_contact,record_id)；FK版本及实际source_record；验证该record确实linked到origin message。
- 取舍与前提：当前任一实际来源相交即清理的规则应单独评估确认；本表必要性来自多份真实捕获，不以旧PG已有该表为依据。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:49；.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:54。

## expression_preference_operation

**状态：建议合并。** 去向：expression_preference_version（保存/修改）＋deletion_operation及其最小封存目标（删除）。

- 一行存什么：偏好save/update/delete的幂等身份和结果。
- 实际需求：明确确认需能去重，删除后的旧保存请求不得复活被删偏好。
- 独立或合并理由：每次成功保存或修改恰好形成一个版本，operation_key、确认时间与结果版本不必再一对一存第二行；删除本就由Q42统一账本负责，无须伪造正文版本。
- 主键、外键、关系：版本增加保存key候选键与确认元数据；删除FK归Q42；已删保存key通过版本空壳或typed长期封存目标拒绝重放。
- 取舍与前提：若将来明确需要保存无效/拒绝操作的完整历史，才补独立操作表；不是仅靠删版本后释放唯一键。同键不同输入冲突规则保留。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:50；.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:56；.scratch/sqlite-database-rebuild/spec.md:86。

## document_collection

**状态：建议合并。** 去向：owner / contact（各自文档控制字段，不新增contact_data_control壳）。

- 一行存什么：某本人或联系人范围的文档控制状态与当前一致发布指针。
- 实际需求：Q40需要同范围L2/L3版本配套，输入变更应使当前发布失效或待更新。
- 独立或合并理由：当前每个owner本人范围或contact范围至多一个集合，无多集合名称、独立成员授权或1:N集合生命周期需求。其scope、dirty_revision、settings_generation和current_publication都是已有范围的一对一属性。
- 主键、外键、关系：本人控制FK owner；联系人控制FK(owner,contact)；publication及memory_document保留明确scope形状、owner FK与contact FK；当前指针必须同scope。
- 取舍与前提：合并只是移除一对一壳，发布集合及成员仍独立；若确认一个联系人需多套可独立发布文档集合，才保留collection_id实体。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:64；.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:79；.scratch/sqlite-database-rebuild/spec.md:84。

## memory_document

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：同一范围内一个稳定主题或长期画像身份及kind。
- 实际需求：Q40明确主题与画像共身份/版本表，多个主题需要可单独延续和引用，不能以会变的标题作身份。
- 独立或合并理由：同范围存在1:N主题和至多一个画像，且每篇文档有多次版本。不是整个联系人一行摘要，也不是普通memory事实。
- 主键、外键、关系：PK(owner,document_id)；owner/contact范围真实FK和形状CHECK；kind固定；profile在范围内条件唯一。
- 取舍与前提：集合控制可并scope，但稳定文档身份不可省；不将用户明确偏好或Skill正文塞进派生文档。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:65；.scratch/sqlite-database-rebuild/spec.md:84。

## memory_document_version

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：主题或画像某次生成的具体结构版本和真实trace。
- 实际需求：Q40需要具体版本及配套发布；Q29要求完整实际过程，历史引用不能随当前文档改写。
- 独立或合并理由：document 1:N version；某次生成尚未发布的版本也不等于当前发布成员，执行与发布不能混为一行。
- 主键、外键、关系：PK(owner_id,document_id,version_no)；真实FK到document及产生step_attempt的完整执行键；单父延续直接完整parent_version FK。
- 取舍与前提：没有独立可任意更新的current正文；当前文档版本由一致publication决定。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:66；.scratch/sqlite-database-rebuild/spec.md:84；.scratch/sqlite-database-rebuild/spec.md:74。

## document_block

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：具体文档版本内可定位的主题段落或画像条目及结构类型。
- 实际需求：Q40保留各自段落/条目、推断、不确定性与矛盾，依据和纠错需能定位具体块。
- 独立或合并理由：一版有N个有序块，块有自己的类型和引用关系；若整篇都塞text/JSON，块级引用与目标就失去真实FK。
- 主键、外键、关系：PK(owner,document,version,block_no)；FK具体版本；kind与父document kind匹配；结构普通值可受控JSON，实体引用另表。
- 取舍与前提：不能为压表数丢掉结构差异，也不必每一种块单独建表。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:67；.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:70；.scratch/sqlite-database-rebuild/spec.md:84。

## document_version_parent

**状态：条件范围／需补必要性。** 去向：单父延续放memory_document_version.parent_version_no；完整旧文档参与输入放trace_input。

- 一行存什么：文档版本跨身份延续、合并、拆分的语义来历边。
- 实际需求：普通文档版本延续已需要；任意多父、跨主题拆分/合并历史尚未由用户确认必须保存为独立图。
- 独立或合并理由：只有真实多父/跨文档语义来历及可查询合并拆分操作，才产生必须独立的N:M边。完整输入追踪已经保存实际看过的旧版本，不能把所有输入重复叫语义parent。
- 主键、外键、关系：若启用：PK(child_document,child_version,parent_document,parent_version)并完整scope FK，禁止自环及图循环。
- 取舍与前提：本轮不默认建立多父图；没有该图仍保留实际输入和单父版本来历。以后若要求恢复拆分/合并关系，再建立而非藏JSON。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:68；.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:75。

## trace_document_input

**状态：建议合并。** 去向：trace_input（仅统一同一trace的输入；不预选跨用途material_set）。

- 一行存什么：一次完整处理trace实际看到的某篇文档具体版本及用途。
- 实际需求：Q29完整追踪和Q40画像依据要求记录全部实际文档输入，不只最终显示引句。
- 独立或合并理由：与trace_message/source/memory_input具有同一个行粒度：trace中一个实际输入引用。可以用固定typed FK分支合在trace_input，不必每种材料一张表。
- 主键、外键、关系：PK(owner,trace,input_no)；FK trace；文档分支FK(document,version)，与其他分支做完整非空/排他CHECK。
- 取舍与前提：这是同用途多材料类型的收敛；是否把助手、偏好、审核等也共享material表仍由Q43另决。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:75；.scratch/sqlite-database-rebuild/spec.md:74。

## trace_feedback_input

**状态：条件范围／需补必要性。** 去向：启用反馈时合入trace_input的feedback typed FK分支。

- 一行存什么：trace实际采用的有限反馈/保护记录。
- 实际需求：如果纳入持续纠错保护，必须记录当次实际采用哪项反馈，不能把反馈仅藏在提示词。
- 独立或合并理由：复杂持久反馈能力未获独立批准；若采用，仍与其他trace输入同一粒度，不需要专用输入表。
- 主键、外键、关系：PK(owner,trace,input_no)；FK trace与具体反馈身份/修订，资格需与执行时点匹配。
- 取舍与前提：不建专表不代表可漏掉实际反馈输入；若组织反馈本轮不纳入，此分支也无需先占位建表。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:76；.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:94；.scratch/sqlite-database-rebuild/spec.md:74。

## document_block_reference

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：文档具体块显示依据或支持的具体已采纳记忆/文档版本。
- 实际需求：Q40结构中的事实、推断与矛盾需要可追溯依据，且显示引用与所有实际输入不同。
- 独立或合并理由：block 0:N references；同一输入可支撑不同块，块与材料之间是真实M:N。不能用trace的全输入关系代替具体块的支持关系。
- 主键、外键、关系：PK(owner,document,version,block,reference_no)；FK block，typed FK具体memory_version或document_version；输入必须属于实际trace。
- 取舍与前提：L2/L3仅采用合法已采纳记忆，不把待采纳candidate直接伪装成事实；引用删除/失效与正文资格一并处理。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:77；.scratch/sqlite-database-rebuild/spec.md:84。

## document_publication

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：某本人或联系人范围一次实际发布的L2/L3配套集合。
- 实际需求：Q40明确发布集合必须保证主题与画像具体版本配套，不能拼接新主题和旧画像。
- 独立或合并理由：一轮可产生未发布/部分成功的文档，最终一次发布又选N篇具体文档版本；publication是对外可用集合的业务事实，不等于task状态或某个文档的head。
- 主键、外键、关系：PK(owner,publication_id)或完整scope/publication_no；真实范围FK；记录发布基线dirty/settings代次；当前指针同scope。
- 取舍与前提：先发布L2而L3尚不适用可明确无画像；补L3形成新的配套集合，不能原地换一篇member制造隐式历史变化。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:79；.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:86；.scratch/sqlite-database-rebuild/spec.md:84。

## document_publication_member

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一次一致发布中选用某文档的哪一版本及顺序。
- 实际需求：一个集合包含多个主题及可选画像；每篇只选一版，所有成员属于同一范围。
- 独立或合并理由：publication N:M document_version，且在同次发布每document只选一版，是实际集合成员关系。把版本ID数组塞JSON会丢FK与范围约束。
- 主键、外键、关系：PK(owner,publication,document_id)；FK publication、具体document_version和其scope；同集合画像至多一项。
- 取舍与前提：publication只保存集合元数据，member只存关系，不复制文档正文。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:84；.scratch/sqlite-database-rebuild/spec.md:84。

## organization_feedback

**状态：条件范围／需补必要性。** 去向：只做一次裁决用memory_decision；需要持续保护实体时单独organization_feedback。

- 一行存什么：对具体记忆版本或文档块、在有限窗口持续生效的纠错/不采纳保护。
- 实际需求：用户需能纠正及删除资料；纠错以后自动处理是否持续抑制相同错误、如何退役保护，是比单次修改更强的能力，尚需确认。
- 独立或合并理由：持续保护有当前有效/撤销状态、目标与有效输入窗口，可能跨多轮执行；它不同于append-only的一次memory_decision动作。不能仅为减表把两者塞成宽操作表，也不能从旧消费者推定此复杂能力必保留。
- 主键、外键、关系：若启用：PK(owner,feedback_id)；具体memory_version或document/version/block typed FK、scope和动作形状CHECK；保护输入另表。
- 取舍与前提：本轮先保留基本查看/修正/删除路径，持续反馈保护列为范围待确认；若最终保留，应独立追踪与来源清理。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:90；.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:94；.scratch/sqlite-database-rebuild/spec.md:29。

## organization_feedback_input

**状态：条件范围／需补必要性。** 去向：organization_feedback启用后保留本关系；不得用正文哈希替代。

- 一行存什么：一项持续纠错保护实际覆盖的消息、来源和记忆版本窗口。
- 实际需求：若启用持续保护，必须限定什么输入上的错误不能再现，不能变成全局文本黑名单或永久偏好。
- 独立或合并理由：一个反馈保护窗口可含N个材料，且需随来源与修订变化失效，具有独立多值关系。若没有持续反馈实体，本轮不单独建这张表。
- 主键、外键、关系：PK(owner,feedback,input_no)；FK反馈及固定typed材料FK；引用/资格随反馈窗口规则校验。
- 取舍与前提：若Q43以后统一材料关系可再比较；当前不能为预期的未来能力先建占位空表。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:94；.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:96。

## overview_projection

**状态：建议不独立建。** 去向：本轮读取合法底层资料时计算；有性能或跨请求稳定快照需求再提缓存。

- 一行存什么：可重建概览结果的无正文指纹、构建时点与状态。
- 实际需求：页面需要概览或导航，不自动等于需要持久化缓存；当前未有新库负载测量证明持久投影必要。
- 独立或合并理由：概览不增加新的业务事实，旧built_at/revision API字段不能单独证明必须独立建表。先明确其时点语义并直接计算，避免将旧缓存结构当需求。
- 主键、外键、关系：本轮无表；若后续建缓存需scope唯一键、规则版本、来源修订和失效合同。
- 取舍与前提：这是新库初始不建缓存的设计提议，不是未经测量宣称性能更好；上线前用实际负载验证读取成本。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:96；.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:102。

## overview_projection_member

**状态：建议不独立建。** 去向：按读取时合法查询返回定位；依附overview_projection的条件缓存方案。

- 一行存什么：持久概览缓存的各来源成员与无正文定位。
- 实际需求：只有持久化某一份概览快照，才需要长期保存它的N项来源集合。
- 独立或合并理由：父缓存不建时，成员表也无独立事实或生命周期。不能为了保留旧接口字段而先存一份额外的所有材料清单。
- 主键、外键、关系：本轮无表；未来持久缓存才以(projection,member_no)及真实typed FK建关系。
- 取舍与前提：若概览被实际输入模型，其实际材料必须进入相应context/trace；这条删除依赖不能因无缓存而省略。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:100；.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:102。

## quality_run

**状态：条件范围／需补必要性。** 去向：若仅开发测试则使用测试资产/临时结果；正式产品确需持久评估再纳入业务库。

- 一行存什么：一次可回看的质量评估运行、预算和数据集元数据。
- 实际需求：自动化评估/诊断的历史保存是否属于正式产品必保留功能，用户尚未明确；旧代码有消费者仅说明可能遗漏，不构成需求批准。
- 独立或合并理由：若需同一数据集多次运行并比较，有独立运行粒度；但不能为了保留旧诊断存储，把它算作本轮必需业务表。
- 主键、外键、关系：若启用：PK(owner,quality_run_id)，真实用途/数据集标识；敏感材料仍走实际输入关系与Q42删除。
- 取舍与前提：不以移到另一个生产数据库隐藏数量；在用户未确认评估产品功能前不默认建。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:166；.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:168；.scratch/sqlite-database-rebuild/spec.md:31。

## quality_case

**状态：条件范围／需补必要性。** 去向：正式评估数据集获确认后再建；纯合成测试用仓库测试资产。

- 一行存什么：某个评估案例的冻结输入和人工标注。
- 实际需求：只有用户需要持久数据集及跨次重评时，才需要稳定案例身份；尚未纳入当前明确需求。
- 独立或合并理由：一个案例可被多次run/attempt使用时具有独立身份，不能简单当call日志；但旧消费者不证明真实用户库必须保存它。
- 主键、外键、关系：若启用：PK(owner,case_id)；数据集归属及实际材料typed FK；真实敏感输入不可标成synthetic绕过清理。
- 取舍与前提：冻结人工标注也有来源和删除责任；仅当前请求临时诊断无需案例库。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:168；.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:170。

## quality_attempt

**状态：条件范围／需补必要性。** 去向：正式评估获确认后建执行记录并复用model_call。

- 一行存什么：某案例在某次质量运行的一次真实执行、输出和审阅结果。
- 实际需求：仅在持久质量运行获确认时需要；物理模型调用仍必须准确记账。
- 独立或合并理由：run/case可各有N次实际尝试，业务评分及人工审阅不完全是model_call属性；该能力本轮不能凭旧结构自动加入。
- 主键、外键、关系：若启用：PK(owner,run_id,case_id,attempt_no)；FK run、case；物理call从model_call typed producer FK反查。
- 取舍与前提：不能复制模型调用账、租约或完整实际输入多份；不启用质量功能时不先造空表。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:168；.scratch/sqlite-database-rebuild/spec.md:29。

## quality_fact_intent

**状态：条件范围／需补必要性。** 去向：若与普通纠错同一事实，复用memory_decision/organization_feedback并加真实quality_case/attempt关联；否则再证明独立实体。

- 一行存什么：诊断质量案例对具体事实修正的意图与有限目标关联。
- 实际需求：基本资料纠错已由memory_decision及可能的组织反馈负责；没有确认需要独立诊断纠错闭环。
- 独立或合并理由：“来源是诊断界面”不是新的业务实体理由。只有有独立生命周期和多次履行关系的纠错意图才值得单独建表。
- 主键、外键、关系：若复用，保留具体memory_version/目标及质量case typed FK；不能用generic entity_type+id。
- 取舍与前提：四张旧诊断表不是四条已批准需求；此项随正式质量功能范围一起决定，不先默认保留。
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:168；.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:172。

## assistant_request_tombstone

**状态：建议合并。** 去向：deletion_target中的长期sealed_request类型；最小请求拒绝键独立于清理进度保留。

- 一行存什么：清理后仍拒绝重放的旧助手请求键最小封存身份。
- 实际需求：取消/删除后的旧请求不能因turn或正文已删而重新执行，迟到请求不能复活已删内容。
- 独立或合并理由：Q42统一账本的目标原本就独立于live业务行存活，可保存被封存子请求键并提供唯一拒绝索引。只保留deletion_operation自己的删除操作key不够，但无需因此必然再建一张助手专用表。
- 主键、外键、关系：typed目标保存请求namespace、最小稳定范围和request_key，唯一拒绝键；仅FK删除操作，不FK已删turn；不得保存原文/输入摘要。
- 取舍与前提：前提是完成清理后也保留该类型最小封存行；如果统一目标按完成即剪除，则此建议不成立，必须明确单独封存表，不能悄悄丢掉重放抑制。 sealed_request为已完成封存的长期分支，不是待擦除目标；完成聚合不等待它被删除，复核要确认拒绝索引成立。父操作最小行不得普通剪枝/级联移除，直到证明旧请求永不可接纳；read_exclusion引用的操作同样保护。
- 根据：.scratch/sqlite-database-rebuild/legacy-coverage.md:23；.scratch/sqlite-database-rebuild/issues/08-deletion-consistency.md:164；.scratch/sqlite-database-rebuild/spec.md:86。

## reply_skill

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一个目录包的稳定业务身份、原目录定位、可证的启停与待核验状态
- 实际需求：Q41：保留原目录，官方DSH加载，重建最小关联、防误删；已知启用/停用/未知有区别
- 独立或合并理由：同owner可有多个独立目录包，每包身份和启停会独立变化；不能把包当用户的一组字段，也不能靠目录名猜旧身份
- 主键、外键、关系：PK(owner_id,skill_id)；owner FK；当前版本完整FK；安装目录身份受控唯一
- 取舍与前提：只存业务元数据；不复制正文、不新造Skill加载器。状态未知必须保留原因，不一律disabled
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:108。

## reply_skill_version

**状态：建议独立。** 去向：基础工作清单同名表。

- 一行存什么：一个已核验或待核验的具体文件版本锚点、摘要、来源状态
- 实际需求：生成依据需要指向实际使用的Skill内容；Q41不允许凭文件伪造旧审核
- 独立或合并理由：一包可被修改多次，旧候选/调用引用的版本不能随当前文件变化。不可变摘要及合法来源是不同于包身份的1:N事实
- 主键、外键、关系：PK(owner_id,skill_id,version_no)；FK包；可空真实审核FK仅扩展启用后
- 取舍与前提：版本行不等于另存一份Skill文件；旧文件不可读时标不可用，不能用现文件冒充旧版本。是否持久保存旧文件另定
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:109。

## reply_method

**状态：条件范围／需补必要性。** 去向：基础工作清单同名表。

- 一行存什么：方法的跨Skill、跨版本稳定身份
- 实际需求：仅方法级独立停用、跨包复用或继承需要；Q41未确认方法平台纳入本次
- 独立或合并理由：普通目录包加载只需包和文件版本；方法身份只有需单独被引用/迁移/设政策时才是业务实体
- 主键、外键、关系：若纳入PK(owner_id,method_id)；birth_skill FK
- 取舍与前提：不纳入不影响DSH按文件读取说明；若保留方法级业务能力，不能用名称代替稳定身份
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:110。

## skill_version_method

**状态：条件范围／需补必要性。** 去向：基础工作清单同名表。

- 一行存什么：某个Skill版本包含的方法及顺序
- 实际需求：依赖方法级实体与多版本成员关系，当前属扩展范围
- 独立或合并理由：若一个方法跨多个包版本复用，版本与方法才构成M:N；若只是文件中的段落，DB不另建成员目录
- 主键、外键、关系：若纳入PK(owner_id,skill_id,version_no,method_id)；版本和方法FK；版本内序号唯一
- 取舍与前提：仅在方法平台纳入时建；正文仍文件权威
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:111。

## skill_method_parent

**状态：条件范围／需补必要性。** 去向：基础工作清单同名表。

- 一行存什么：方法跨更新/合并的祖先关系
- 实际需求：方法级停用需要跨继承保留时才需；未被Q41一并批准
- 独立或合并理由：只有多父祖先图才需要边表；普通单父延续可在方法或版本放一个parent FK
- 主键、外键、关系：若纳入两端同owner方法FK；PK(child,parent)；防环
- 取舍与前提：不能以少表把多父ID放JSON；先确认是否有多父合并和继承需求
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:112。

## skill_parent

**状态：条件范围／需补必要性。** 去向：基础工作清单同名表。

- 一行存什么：包之间的合并/继承关系
- 实际需求：跨包合并、继承停用政策属于旧能力查漏，尚未定为新库基础范围
- 独立或合并理由：目录加载和当前启停不需要包祖先图；确认多父合并才独立存M:N边，普通版本延续无需此表
- 主键、外键、关系：若纳入PK(owner_id,child_skill_id,parent_skill_id)；两端包FK；防环
- 取舍与前提：若保留祖先政策，不能省边导致通过合并绕过停用；未纳入前不默认开放合并
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:113。

## skill_scope_policy

**状态：条件范围／需补必要性。** 去向：基础工作清单同名表。

- 一行存什么：对包或方法在多个联系人/场景的细粒度停用规则
- 实际需求：Q41需保留可证启停，但不等于批准联系人/场景/方法三级政策
- 独立或合并理由：整包当前启停放reply_skill足够；同一包对多个范围有独立规则，才有0:N政策事实
- 主键、外键、关系：若纳入PK(owner_id,policy_id)；skill、contact、method真实FK；明确scope形状
- 取舍与前提：不允许把未知旧政策猜成允许；细粒度范围若保留，必须独立复验，不被全局enabled代替
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:119。

## skill_policy_operation

**状态：条件范围／需补必要性。** 去向：skill_operation（条件替代）。

- 一行存什么：一次政策启停的幂等决定
- 实际需求：仅在细粒度政策纳入且需保留可重试控制动作时需要
- 独立或合并理由：同Skill领域的安装/政策/学习许可动作可以共用有限kind操作账本；政策本身与操作历史仍分开。只有当前CAS启停时，不为一对一状态新建动作表
- 主键、外键、关系：若纳入PK(owner_id,operation_key)；按kind有真实policy/skill/contact FK与请求摘要
- 取舍与前提：共享仅限同领域明确操作合同，不建立任意entity_type/id总日志；旧启用动作不得覆盖新停用
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:120。

## skill_use

**状态：建议合并。** 去向：assistant_context_item（若用于审核则相应审核输入）。

- 一行存什么：某次实际上下文使用的Skill具体版本及政策视图
- 实际需求：回复依据需要可回看、可清理；这不要求第二份相同Skill-输入关系
- 独立或合并理由：当事实就是某次实际模型输入采用哪一个Skill版本，已有typed输入项可表达，不应再复制一份相同关联；准备、读取、模型自报需明确role和时点
- 主键、外键、关系：context item FK准确skill/version；实际call指最终冻结上下文；role有约束
- 取舍与前提：DSH中途读取必须记录实际后续输入/读取事件，初始selected清单不能冒充实际使用，也不证明发送或效果
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:121。

## skill_use_method

**状态：条件范围／需补必要性。** 去向：基础工作清单同名表。

- 一行存什么：一次实际Skill使用中的具体方法成员
- 实际需求：仅方法级实际使用追踪纳入后需要，普通Skill版本引用不要求
- 独立或合并理由：若需要列出真正使用的多个方法，是使用与版本成员的0:N关系；若模型只自报方法名，不应当作已验证调用事实落表
- 主键、外键、关系：若纳入FK实际输入项/使用事件与version_method；PK(use,method)
- 取舍与前提：精确区分允许、读取、模型报告；没有方法级需求就不建
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:121。

## skill_learning_scope

**状态：条件范围／需补必要性。** 去向：contact中的独立学习授权字段（如需历史再用授权记录）。

- 一行存什么：联系人经验学习的独立开关与代次
- 实际需求：学习是独立授权，不能由同步/记忆处理授权推得；本次是否接回学习能力未确认
- 独立或合并理由：若只是每联系人唯一一份当前enabled/revision，可并contact；授权语义独立不等于必须独立表。若需多份许可/不可变历史才再拆
- 主键、外键、关系：contact现有PK；learning_enabled/revision与其他代次分别检查
- 取舍与前提：不纳入学习时没有隐式授权；纳入后开关默认关闭，撤销立即失效
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:128。

## skill_learning_operation

**状态：条件范围／需补必要性。** 去向：skill_operation（条件替代）。

- 一行存什么：一次学习授权改变及幂等结果
- 实际需求：仅学习能力与可重试授权控制纳入后需要
- 独立或合并理由：与政策/目录操作同领域控制回执可共有限类型表，无须每种按钮一张表；当前许可仍在独立语义字段
- 主键、外键、关系：PK(owner_id,operation_key)；真实contact FK；expected/result learning_revision
- 取舍与前提：必须保留旧启用重放拒绝；不是把同步许可转成学习许可
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:129。

## skill_learning_batch

**状态：条件范围／需补必要性。** 去向：background_task_step的skill_learning类型；学习结果指向真实草稿版本。

- 一行存什么：一个有限学习工作单元的状态、实际执行和结果
- 实际需求：仅已授权经验学习纳入后需要
- 独立或合并理由：若一个batch恰是一项固定输入step，重复batch身份/状态没有新事实；只有业务batch需跨多step独立归属时才另建batch头
- 主键、外键、关系：真实task/step/attempt FK与输出draft/version；步骤kind约束
- 取舍与前提：不能给学习伪造记忆round或assistant_turn；统一执行需正式支持该kind
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:130。

## skill_learning_input

**状态：条件范围／需补必要性。** 去向：用途专用输入表；共享材料方案待Q43。

- 一行存什么：学习批次实际消费的组合材料和版本
- 实际需求：仅学习能力纳入后必须有真实材料关系；本次Q43不作选择
- 独立或合并理由：一个工作单元可有多种多份真实材料，是0:N输入关系；不能从当前候选/联系人重算历史。是否结构共用另议
- 主键、外键、关系：学习执行FK；assistant/selection/message/memory/preference/Skill具体版本typed FK
- 取舍与前提：不按内容hash跨范围共权限；可靠后续聊天不能由复制候选推断发送
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:131。

## skill_learning_receipt

**状态：条件范围／需补必要性。** 去向：基础工作清单同名表。

- 一行存什么：一个有限材料单元的预约/成功/no_change消费结果
- 实际需求：仅学习纳入且要求跨启动不重复消费时需要
- 独立或合并理由：学习组合材料与单message消费粒度不同，不能未定义单位就并processing_receipt；确认组合消费合同才独立建或正式扩展公共receipt
- 主键、外键、关系：PK真实范围+稳定unit key；指向本次batch及完整实际输入集合
- 取舍与前提：组合材料ID不可只是无FK字符串；若只有幂等step重试，可复用执行结果，不必额外全局receipt
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:132。

## skill_draft

**状态：条件范围／需补必要性。** 去向：基础工作清单同名表。

- 一行存什么：待审核策略的稳定草稿身份和当前修订
- 实际需求：仅纳入经验学习/人工草稿审核流程后需要
- 独立或合并理由：同草稿会被反复编辑并多次审核，身份与0:N内容修订分离有意义；Q41保留目录不要求重建草稿流程
- 主键、外键、关系：PK(owner_id,draft_id)；真实Skill根FK；当前revision完整FK
- 取舍与前提：草稿不是可加载的已发布Skill，不能因复用版本表而提前启用
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:133。

## skill_draft_version

**状态：条件范围／需补必要性。** 去向：基础工作清单同名表。

- 一行存什么：一个草稿修订的策略正文、私人依据与产生位置
- 实际需求：仅草稿流程纳入后需要
- 独立或合并理由：多版草稿及审核冻结需要不可变版本；私人依据与发布文件的生命周期不同，不能并已发布版本伪造发布
- 主键、外键、关系：PK(owner_id,draft_id,revision)；draft与实际执行FK
- 取舍与前提：私人依据受来源删除；只有清洗策略可获批发布，不把原聊天塞Skill正文
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:134。

## skill_draft_target

**状态：条件范围／需补必要性。** 去向：基础工作清单同名表。

- 一行存什么：一个草稿修订拟更新/合并的目标Skill版本
- 实际需求：仅更新/多目标合并草稿纳入后需要
- 独立或合并理由：一个草稿可针对N个目标，目标是可复验关系；若只新建独立包，没有目标无需此表
- 主键、外键、关系：PK(draft,revision,target_skill,target_version)；两端完整FK
- 取舍与前提：不存target_versions JSON；后续审核可以沿不可变草稿关系读取，无需再复制
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:135。

## skill_review

**状态：条件范围／需补必要性。** 去向：基础工作清单同名表。

- 一行存什么：一次冻结草稿及同输入比较的审核身份和状态
- 实际需求：双侧审核/人工批准属于未确定纳入的扩展范围
- 独立或合并理由：一次审核可产生多侧结果和多次执行，业务审核不等于物理调用；若保留该产品能力有独立实体价值
- 主键、外键、关系：PK(owner_id,review_id)；draft/revision及确认操作FK；冻结集合修订
- 取舍与前提：目录已有文件不代表历史审核通过；新用户输入审核不能伪造assistant_turn
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:136。

## skill_review_input

**状态：条件范围／需补必要性。** 去向：用途专用审核输入表；可否共享材料待Q43。

- 一行存什么：一次审核两侧共用的真实输入版本和来源
- 实际需求：只有双侧审核纳入才需要；Q43仍未选
- 独立或合并理由：审核需要独立冻结的0:N材料，不可默认继承某次旧回复输入或读取当前内容
- 主键、外键、关系：review FK；同scope typed input FK；输入序号唯一
- 取舍与前提：共同上下文只冻结一次，两侧引用同份；精确来源删除仍穿透审核和文件
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:137。

## skill_review_target

**状态：建议不独立建。** 去向：从skill_review.draft_id/revision → skill_draft_target派生。

- 一行存什么：审核重复保存的草稿目标版本集合
- 实际需求：当前没有独立审核目标选择需求；已有不可变draft revision目标集合
- 独立或合并理由：审核已固定草稿修订，目标集合相同，重复存储产生两份可不一致事实；无须独立成表
- 主键、外键、关系：review完整FK固定draft revision，查询该revision targets
- 取舍与前提：若未来允许审核另选目标集合，则出现新事实，必须重新建模；不默许扩大审核范围
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:138。

## skill_review_side

**状态：条件范围／需补必要性。** 去向：基础工作清单同名表。

- 一行存什么：同次审核的一侧策略、真实执行和输出
- 实际需求：仅双侧比较流程纳入后需要
- 独立或合并理由：同一review有before/after等多侧，是1:N，不能把结果列无限加在review或用数组藏执行引用
- 主键、外键、关系：PK(owner_id,review_id,side)；具体strategy版本及result_attempt真实FK
- 取舍与前提：before无Skill与published/draft分支严格区分；失败/unknown不能当可批准比较
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:139。

## skill_review_result_call

**状态：建议不独立建。** 去向：沿skill_review_side.result_attempt → model_call的执行FK派生。

- 一行存什么：审核侧重复列出所属执行的物理调用
- 实际需求：没有独立挑选调用子集的确认需求
- 独立或合并理由：call已有唯一真实执行归属，若侧就是执行结果，重复列一份调用链无新事实；调用的实际输入/输出仍在call和完整事件中
- 主键、外键、关系：side有result_attempt完整FK；call反向producer索引
- 取舍与前提：若业务需要表达“只消费其中几次调用”的独立选择，再建立精确结果依赖边，不能直接把所有attempt调用等同采纳证据
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:140。

## skill_catalog_operation

**状态：条件范围／需补必要性。** 去向：skill_operation（条件替代）。

- 一行存什么：一次安装/发布/合并/回滚等受管目录操作的幂等结果
- 实际需求：Q41当前要求保留目录和最小接回；完整受管写目录流程是否纳入待定
- 独立或合并理由：纯目录核验/映射只需稳定包身份、版本锚点和CAS；若App执行跨文件发布/回滚，则需要可恢复操作账本，可与同领域政策/授权动作共有限kind
- 主键、外键、关系：若纳入PK(owner_id,operation_key)；真实Skill/version/review FK和文件预期身份
- 取舍与前提：不把数据库事务当文件原子事务；保留原目录不授权自动改写文件
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:146。

## skill_worktree_projection

**状态：条件范围／需补必要性。** 去向：background_task_step（file_projection）与deletion_file_target等文件账目。

- 一行存什么：受管目录一次非权威回写的恢复进度
- 实际需求：只有确认需要App回写目录/崩溃恢复才存在，本次Q41不要求
- 独立或合并理由：一次投影若就是一个恢复步骤，不另造相同任务状态头；有多个文件时用已有typed文件目标明细；用户目录不能变成App可随意覆盖的投影
- 主键、外键、关系：真实operation/Skill version FK；预期原文件digest；步骤唯一键
- 取舍与前提：必须发现并发用户修改并停止覆盖；不能以减少表替代所需文件身份及恢复信息
- 根据：.scratch/sqlite-database-rebuild/issues/07-preference-document-skill-model.md:150。

