# 从业务事实推导：身份、读取范围、来源与消息

本文是独立建模建议，不是已认可的表结构或实施指令。不以表数为目标；没有读取旧 PG、旧迁移或任何旧候选结构。事实依据仅为两份当前规格及本轮任务给出的已确认要求。所有表名、键和拆分均为建议。

依据简写：`DB:n` 指 [数据库规格](spec.md) 第 n 行；`SYNC:n` 指[同步与记忆行为规格](../sync-memory-behavior/spec.md)第 n 行。本文不制定新产品入口，不实现 DDL，不操作真实资料、App 或 Skill 目录。

## 一、先列业务事实卡

| 事实 | 唯一身份与函数依赖 | 基数 | 可变性与历史 | 授权、删除生命周期 | 依据／性质 |
|---|---|---|---|---|---|
| 本机用户 | `owner_id → 本机用户身份`；不是显示名称决定用户 | 一个 owner 有多个联系人和已核验微信账号 | 身份稳定；名称可改 | 本人资料与联系人资料分别归属，但共用一库 | 已确认，DB:31、75；具体 owner 实体为建议 |
| 联系人 | `(owner_id,contact_id) → 联系人展示资料`；昵称、备注不决定身份 | 一个 owner 有多位联系人；重名允许 | 改名不换 contact_id；清空聊天不删联系人 | 清空范围是该联系人全部聊天，不因来源不同缩小范围 | 已确认，DB:31–32，SYNC:60 |
| 微信本人账号 | `(owner_id,已证明的渠道账号自然键) → account_id` | 一个 owner 可保存历次核验账号；一次读取须核对实际账号 | 显示名变化不换身份；账号切换不能串用游标 | 未核验账号不能读取正文 | 账号必须重新核验已确认，SYNC:63；账号自然键及基数是待查证／建模建议 |
| 微信私聊 | `(owner_id,account_id,已证明的私聊自然键) → conversation_id` | 一个账号有多条私聊；群聊不在本轮范围 | 会话名称是展示属性；稳定渠道键不可随改名改变 | 未选中、新出现私聊不自动读取 | 已确认，SYNC:18–25、97；精确自然键待 CLI 查证 |
| 联系人绑定 | `(owner_id,account_id,conversation_id) → binding_id,contact_id` | 一个私聊最多有一个当前已确认归属；联系人可有历次绑定 | 同账号同一仍核验私聊取消／重选沿用 binding_id；不自动改绑或合并 | 身份冲突需重核验；取消授权不删除绑定身份 | 已确认 Q34，DB:78；允许联系人保存多条历次绑定是建议，不等于新增多渠道产品能力 |
| 选择授权 | `selection_grant_id → 联系人、绑定、选择代次、核验依据、起止时间` | 一个联系人可有多次授权；同一时刻至多一次有效选择 | 每次重选新建授权；旧授权不可复活 | 取消立即阻止该联系人的旧读取和处理结果提交；已保存资料不因此自动删除 | 已确认，SYNC:23–24、68、74–75；授权实体为建议 |
| 总读取开关 | `owner_id → enabled,read_epoch` | 每个 owner 一份当前读取控制 | off/on 推进读取代次；新捕获记录新代次 | 只管微信读取；不撤销合法已保存资料的手动记忆处理资格 | 已确认 Q27/Q28，SYNC:68、50–51；代次按 capture 核验为建议 |
| 联系人聊天清空代次 | `(owner_id,contact_id,chat_epoch) → 该代次起因` | 联系人有多个顺序代次；一次清空推进一次 | 代次单调，旧在途页不能提交到新代次 | 清空不取消选择；旧来源和派生内容实际清理；须覆盖未捕获历史 | 已确认，SYNC:60–61、DB:86；独立代次记录为建议 |
| 清空后的渠道边界 | `(owner_id,account_id,conversation_id,barrier_epoch) → 精确边界证明` | 一次联系人清空可涉及多条渠道私聊；每条私聊各有渠道边界 | 边界不可用时状态必须显式受阻；最小渠道边界跨联系人删除／重建继续有效 | 逐条已知消息排除不足以拦截从未读入历史；秒时间和 local_id 不能冒充边界 | 已确认 Q24，SYNC:61、85；稳定渠道锚点为建模建议，边界协议待证明 |
| 明确恢复历史许可 | `restore_permit_id → 明确确认、固定账号/绑定/授权/聊天代次` | 一个许可只属于一个联系人；可有多次恢复操作 | 明确操作产生新许可，不修改旧删除历史 | 允许恢复该联系人当前本机可读全部历史；普通重启、重选、重试不产生此许可 | 已确认 Q26，SYNC:63、49；固定许可结构为建议 |
| 一次有限读取目标 | `read_goal_id → 固定范围、许可、目标描述、可靠续读状态` | 一个授权可有多个首次历史、补缺、增量分段目标；目标有多个捕获批次 | 目标固定；重试继续同一目标，不能悄悄改用最新许可 | 恢复读流不得凭动态“当前恢复许可”无限放行；清空／取消使旧目标失效 | SYNC:57、61、63 为已确认行为；有限读流结构为建议 |
| 捕获批次／来源 | `capture_id → 一次 CLI 响应及其读取资格快照` | 一个读取目标有多个 capture；一个 capture 只属于一个联系人 | 捕获事实不可冒充消息身份；重叠捕获可再次观察同一消息 | 取消后捕获无效，不等于撤销此前已合法保存来源 | 已确认，SYNC:58、62；批次边界及键为建议 |
| 原始记录 | `(capture_id,item_ordinal) → 本次观察到的一条原始记录` | 一个 capture 有多条原始记录 | 原始观察与规范消息分层；身份未明保留隔离记录 | 隔离记录也必须随来源删除，不可进入正常聊天／生成 | 已确认 Q32，DB:76 |
| 规范消息 | `(owner,contact,binding,已证明的消息自然键) → message_id` | 同一消息可以被多个 capture 重复捕获；一个 capture 包含多条消息 | 消息身份与渠道排序是不同事实；排序未知仍可存正常消息 | 身份未知隔离；不能按正文相同合并 | 已确认 Q32/Q35，DB:76、79；精确自然键待证明 |
| 非文字占位 | `message_id → 可靠类型、发送方、可用时间/位置` | 文字与非文字同属一条规范消息 | 图片、语音、视频、文件、表情及未知非文字类型都先占位 | 本轮不保存媒体资源、不提取非文字；未知类型不能当文字 | 已确认 Q33，DB:77、SYNC:58、72 |
| 来源支持 | `record_id → 至多一个 message_id`；`消息 ↔ 捕获批次` 为多对多 | 一个消息多条观察；一个捕获有多条观察，各自指向一条消息 | 规范去重不合并或抹掉来源；批次层 M:N 不等于记录层 M:N | 删一个来源不能无条件删除仍有有效来源的消息；联系人清空删除其全部消息／引用 | 已确认，SYNC:60、62、118（规格中的合同摘要；未读所链接旧实现）；单条CLI记录至多一条规范消息为本轮建模边界 |

## 二、从事实得到的具体结构

以下是逻辑结构说明，不是 SQL。`!` 为 NOT NULL，`?` 为允许 NULL；未标 `?` 的字段均必填。ID 使用不承载业务顺序的本地稳定身份，具体编码待技术设计。时间表示待运行时查证；记录时间不充当渠道顺序。所有联系人子表都携带 `owner_id,contact_id`，使用完整复合 FK 防止串人；这是范围约束需要的冗余，不允许只检查单列 id。长期自动重读抑制不是联系人子资料，改锚定 owner+已核验账号/私聊身份，不依赖可删除的联系人壳或 binding。

### 1. `local_owner`：本机用户

- 字段：`owner_id!`、`created_at!`、`display_name?`。
- PK：`owner_id`。不以名称建 UNIQUE；本轮不新增登录或云端用户体系。
- 独立理由：本人资料、联系人和账号都依赖用户身份；将用户重复写在每位联系人中会丢失无联系人时的本人归属。

### 2. `contact`：联系人身份及其选择控制代次

- 字段：`owner_id!`、`contact_id!`、`display_name?`、`remark?`、`selection_epoch!`、`lifecycle_state!`、`created_at!`、`updated_at!`。
- PK：`(owner_id,contact_id)`；FK：`owner_id → local_owner`；名称、备注不唯一。
- `selection_epoch` 在授权、取消等选择变更时单调推进。`lifecycle_state` 至少区分正常与删除中；联系人物理删除、最小身份保留与统一删除模块整合，本文不决定联系人删除后重建策略。
- 独立理由：联系人不是微信账号，也不是某一次会话授权。聊天清空不删除此行。

### 3. `wechat_account`：已核验的本人渠道身份

- 字段：`owner_id!`、`account_id!`、`identity_namespace!`、`external_account_key!`、`display_name?`、`identity_state!`、`created_at!`。
- PK：`(owner_id,account_id)`；FK：owner；UNIQUE：`(owner_id,identity_namespace,external_account_key)`。
- 自然键只接受已查证、可稳定识别本人账号的协议值。未知身份不以名字或本机目录建立“已核验账号”。`identity_state` 可因冲突受阻，外部自然键不得原地改成另一个账号。
- 渠道最小自然身份因有效排除／截断仍需要时保留；联系人删除不级联删除此身份。无关 display_name 等展示属性仍按删除范围清除，不能以防重读为由保留敏感联系人资料。
- 独立理由：一个账号下多条私聊共享本人渠道身份；把账号复制入每位联系人会造成账号切换及核验状态不一致。

### 4. `wechat_conversation`：已核验的私聊渠道身份

- 字段：`owner_id!`、`account_id!`、`conversation_id!`、`identity_namespace!`、`external_conversation_key!`、`read_barrier_epoch!`、`display_name?`、`created_at!`。
- PK：`(owner_id,account_id,conversation_id)`；FK：完整账号键；UNIQUE：`(owner_id,account_id,identity_namespace,external_conversation_key)`。
- 当前只接纳已确认私聊。不存在已证明自然键时，不建立可读正文的规范会话；会话选择界面的临时展示条目不必持久化为可用会话。
- `read_barrier_epoch` 是该渠道私聊的单调抑制代次；清空、删除或新增排除推进它。有效抑制所需最小自然键及代次跨联系人删除继续保留；展示名按范围删除。新联系人再次绑定同一私聊时仍查询同一渠道抑制，不通过新 contact_id/binding_id 绕过。
- 独立理由：私聊渠道身份在取消／重选之间存在，且不同于用户确认的联系人归属。

### 5. `contact_binding`：私聊到联系人的稳定绑定

- 字段：`owner_id!`、`contact_id!`、`binding_id!`、`account_id!`、`conversation_id!`、`identity_epoch!`、`identity_state!`、`created_at!`。
- PK：`(owner_id,contact_id,binding_id)`；FK：完整联系人键、完整会话键；UNIQUE：`(owner_id,account_id,conversation_id)`。
- 同账号同一仍已核验私聊取消／重选不新建行。`identity_epoch` 在核验资格失效时推进；重核验生成新证明。不得通过 UPDATE contact_id 静默改绑。
- 独立理由：这是用户确认的关系事实；与账号、私聊分别拆开，避免将渠道存在误当作已确认联系人，也避免每次授权重建身份。

### 6. `binding_verification`：不可变的核验依据

- 字段：`owner_id!`、`contact_id!`、`verification_id!`、`binding_id!`、`identity_epoch!`、`verified_at!`、`method!`、`proof_format!`、`proof_payload!`。
- PK：`(owner_id,contact_id,verification_id)`；FK：完整绑定键。增加候选唯一键 `(owner_id,contact_id,binding_id,verification_id,identity_epoch)`，供授权复合 FK 验证归属。
- 只保存一次成功核验的最小无正文证明；`proof_payload` 只装外部协议证明，不能把联系人、授权或消息列表藏入 JSON。未知证明不写成成功记录。
- 独立理由：核验发生时间和方法是历史事实；后续再核验不能覆盖旧授权当时依据。

### 7. `contact_selection_grant`：一次联系人选择授权

- 字段：`owner_id!`、`contact_id!`、`selection_grant_id!`、`binding_id!`、`selection_epoch!`、`identity_epoch!`、`verification_id!`、`granted_at!`、`revoked_at?`、`revocation_reason?`。
- PK：`(owner_id,contact_id,selection_grant_id)`；FK：联系人、绑定及含绑定/代次的核验候选键；UNIQUE：`(owner_id,contact_id,selection_epoch)`；部分 UNIQUE：每联系人至多一个 `revoked_at IS NULL` 的授权。
- `revoked_at/revocation_reason` 同为 NULL 或同有值；不可撤销后清 NULL 重开。新授权使用新 grant_id 和新代次，旧请求不得在重选后恢复有效。
- 当前已选从未撤销且与 contact.selection_epoch 匹配的授权推导，不再维护第二个 `selected` 布尔。切换本人账号不使旧绑定自动获得新账号资格。
- 独立理由：同一绑定有多次授权；将授权起止写入 binding 会覆盖历史并错误复活在途请求。

### 8. `wechat_read_control`：仅控制读取的总开关

- 字段：`owner_id!`、`enabled!`、`read_epoch!`、`updated_at!`。
- PK/FK：`owner_id → local_owner`。没有 contact_id，没有记忆暂停字段。
- off/on 以及宿主读取实例更换推进代次；实际 App 存活、进程互斥/租约、当前 CLI 账号另在执行边界核验，不把数据库中的一个“running=true”当作活进程证明。
- 独立理由：总读取开关依赖 owner；放进每位联系人会产生多份冲突值，放进处理任务会错误停止已保存资料处理。

### 9. `contact_chat_epoch`：清空造成的不可逆分代

- 字段：`owner_id!`、`contact_id!`、`chat_epoch!`、`started_at!`、`reason!`（`initial/clear`）、`deletion_operation_id?`。
- PK：`(owner_id,contact_id,chat_epoch)`；FK：联系人；`deletion_operation_id` 对统一 `deletion_operation` 作明确类型的 FK／范围校验（跨领域接口待整合）。`reason=clear` 时必填，initial 时为空。
- 每联系人初始代次为 0；最新代次通过索引读取最大值，避免另存一份 current_chat_epoch。新清空在短写事务中分配下一代次并撤销旧提交资格；来源都引用其创建时的确切代次。
- 独立理由：清空事件既不等于选择授权，也不等于渠道边界；需要保留清空起因，而不是全局重置一个删除标记。

### 10. `conversation_history_cutoff`：跨联系人生命周期的精确历史截断

- 字段：`owner_id!`、`account_id!`、`conversation_id!`、`barrier_epoch!`、`deletion_operation_id!`、`state!`（`establishing/verified/blocked`）、`boundary_protocol?`、`boundary_token?`、`established_at?`、`blocked_reason?`。
- PK：`(owner_id,account_id,conversation_id,barrier_epoch)`；FK：完整稳定渠道私聊键及统一删除操作。没有 contact_id、binding_id 或 contact_chat_epoch FK。`state=verified` 时协议、令牌和核验时间必填；其他状态不得伪造有效令牌。
- 一次联系人清空可建立多条渠道边界，删除操作记录起因与清理范围。边界是最小无正文证明；不是秒时间、local_id 或已读消息集合。受清空影响但尚无可靠边界时，自动历史读取受阻；不能因联系人重建、新绑定或重选绕过。
- 旧边界不因恢复许可出现而删除；许可仅对固定目标生效。未来是否可安全压缩冗余旧边界须由渠道协议证明，本稿不假定最新时间戳可替代所有旧边界。
- 独立理由：联系人级清空与账号／私聊级渠道位置基数和生命周期不同；联系人可实际删除，最小渠道抑制仍须保留。

### 11. `history_restore_permit`：用户明确恢复该人历史的固定许可

- 字段：`owner_id!`、`contact_id!`、`restore_permit_id!`、`binding_id!`、`selection_grant_id!`、`selection_epoch!`、`identity_epoch!`、`chat_epoch!`、`channel_barrier_epoch!`、`verification_id!`、`confirmed_at!`。
- PK：`(owner_id,contact_id,restore_permit_id)`；FK：完整绑定、选择授权、聊天代次、核验依据；复合候选键约束这些记录确属同一绑定和代次。
- 此记录只由明确恢复操作产生，既不删除旧 cutoff，也不全局解除逐条排除。读取目标固定引用此 permit_id；重新选择或新清空后此许可不可复活。
- `channel_barrier_epoch` 是固定绑定所指私聊当时抑制代次的快照；与私聊当前值比较，避免新的渠道删除／排除发生后旧许可继续放行。
- 独立理由：当前已选只允许普通读取；明确放行已删除历史是额外用户决定，不能从选中状态或“最新恢复许可”推导。

### 12. `sync_read_goal`：有限、不可换范围的读取目标及其检查点

- 字段：`owner_id!`、`contact_id!`、`read_goal_id!`、`binding_id!`、`selection_grant_id!`、`selection_epoch!`、`identity_epoch!`、`chat_epoch!`、`channel_barrier_epoch!`、`kind!`（`initial_history/catchup/incremental_segment/explicit_restore`）、`restore_permit_id?`、`target_state!`、`target_protocol?`、`target_descriptor?`、`committed_cursor?`、`state!`、`coverage_state!`、`status_reason?`、`created_at!`、`completed_at?`。
- PK：`(owner_id,contact_id,read_goal_id)`；FK：绑定、授权、聊天代次、可选恢复许可，均为完整范围键。`explicit_restore` 才且必须有 restore_permit_id，其他类型为空。
- `target_state=ready` 时协议及目标描述必填；目标描述是 CLI 能证明的有限快照/上界，不是日期字符串代替证明。初始、补缺和恢复的“全部本机可读”以当次可证明范围为准；不可读或缺口显式记录，不能承诺微信完整历史。增量也分成有限读取段，完成后再创建后续目标。
- 目标首次成立后范围、许可、账号绑定、各业务代次不可更换；channel_barrier_epoch 须与所指私聊当前值一致。暂停/断开继续原目标与合法检查点；取消/清空后旧目标失效，新目标另建。读开关 off/on 不改目标固定许可，新 capture 带新 read_epoch。
- `committed_cursor` 只在该协议及目标范围内解释；游标不是消息身份。消息、来源引用、隔离记录及检查点在同一事务原子写入。如何选择普通增量的后继检查点、历史与增量交接，由 CLI 能力证明后补充，本文不假定 local_id 单调。
- 独立理由：授权不是执行进度，一次授权可有多个目标；有限目标也不同于一次分页响应。目标与当前检查点先合在同一行，因为当前只存在每目标一条推进流，未证明需要单独检查点实体。

### 13. `sync_capture`：一次捕获及其来源身份

- 字段：`owner_id!`、`contact_id!`、`capture_id!`、`read_goal_id!`、`read_epoch!`、`runtime_instance_token!`、`captured_at!`、`cursor_in?`、`cursor_out?`、`adapter_version!`、`result_state!`、`error_code?`。
- PK：`(owner_id,contact_id,capture_id)`；FK：完整读取目标。cursor 只保存协议允许的无正文值；捕获级元数据不得装整页正文副本。
- 此 capture 即聊天来源批次身份，不另建一个同身份的 `source` 壳。重新调用CLI取得响应是新 capture；仅同一已收到响应的数据库重放沿用原capture，重复消息由消息自然键去重；失败捕获可以没有原始记录。捕获完成并不自动意味着检查点已提交。
- 领取、CLI 发出前和提交前都检查实际账号、固定目标许可、选择代次、identity_epoch、chat_epoch、当前读取开关及 capture.read_epoch。off/on 后旧 capture 返回也被拒绝；新 capture 可在仍有效的同一目标继续。
- 独立理由：一次目标有多次外部观察，每次观察的读取资格、来源与响应位置不同。不能把批次 id 当消息 id。

### 14. `capture_record`：原始观察、隔离状态与来源位置

- 字段：`owner_id!`、`contact_id!`、`record_id!`、`capture_id!`、`item_ordinal!`、`normalization_state!`（`quarantined/normalized/suppressed`）、`message_id?`、`raw_payload?`、`observed_identity_namespace?`、`observed_external_message_key?`、`quarantine_reason?`、`normalizer_version!`、`created_at!`。
- PK：`(owner_id,contact_id,record_id)`；FK：完整 capture、可空的完整 message 键；UNIQUE：`(owner_id,contact_id,capture_id,item_ordinal)`。`item_ordinal` 仅定位这一响应，不证明聊天先后。
- normalized 必须有可靠消息身份、非空 raw_payload 和非空 message_id；quarantined 必须保留任务需要的原始记录与原因且 message_id 为空，禁止检索、正常聊天展示和生成引用。suppressed 的 raw_payload、message_id 均为空，只保留必要无正文回执；清空时 raw_payload 不能作为“隔离数据”逃逸删除。
- 同一稳定身份与现有正文/发送方/类型冲突时，观察进入隔离，不能按后到覆盖。身份后来得到证明可在重新核验全部资格后转 normalized；新增映射是显式动作，原观察来源身份不换。
- 每条记录至多指向一条规范消息，禁止关联不同 binding 或不同自然消息身份。经 record 推导 capture↔message 的 M:N，不额外建立 record↔message 关联表。删一条 record 不无条件删 message；先检查其他有效 record 支持。删除消息前撤下受影响引用并按依赖处理，不能用 ON DELETE SET NULL 把已规范记录悄悄留成可检索孤儿。
- 独立理由：隔离的是尚不能成为规范消息的一次观察，不应在正常消息表中填伪身份；不再仅为一个隔离状态增加同字段表。状态与引用互斥须由约束/触发器及事务接口共同保证。

### 15. `message`：统一规范消息及占位

- 字段：`owner_id!`、`contact_id!`、`message_id!`、`binding_id!`、`identity_namespace!`、`external_message_key!`、`revision!`、`sender_role!`、`kind!`、`text_body?`、`original_type_code?`、`sent_at?`、`sent_at_precision?`、`order_state!`、`order_protocol?`、`order_token?`、`created_at!`。
- PK：`(owner_id,contact_id,message_id)`；FK：完整 binding；UNIQUE：`(owner_id,contact_id,binding_id,identity_namespace,external_message_key)`。该自然键只在 CLI 证明其唯一范围后生效，不能先认定 local_id 可用。
- `sender_role` 只接受可证明的本人/联系人；若协议证明系统事件可另列 system，不能以 unknown 伪装已知发送方。发送方或有效内容/类型不可靠的观察先隔离。
- `kind=text` 时 text_body 必填，空字符串是否有效由渠道合同判定；其他类型 text_body 必须为空。`kind` 覆盖 image/audio/video/file/sticker/other_nontext，原始未知类型保留 original_type_code，不当作文字。占位文案由类型生成，不存一份可误用于提取的假正文。
- `sent_at` 与精度同时有值或同时为空，不伪造高精度；渠道排序与发送时间独立。`order_state=verified` 时协议及位置令牌必填；unknown 时均为空，正常保存该消息。稳定展示兜底使用 message_id 等本地键，必须标明不代表真实顺序，不能提供因果证据。
- `revision` 是规范解释变动的提交版本，不是新的消息身份；固定处理目标引用 message_id+revision。冲突未经明确核验不改 revision；排序补全若影响实际输入解释同样更新版本。旧实际输入由提取追踪保存，不额外发明一套本轮未要求的完整聊天编辑历史。
- 独立理由：来源、消息、授权身份各不相同；同一消息可以有多个观察。文字与所有占位共享唯一身份和位置事实，不按媒体种类拆重复消息表，也不建立当前不存储的媒体资源表。

### 16. `message_read_exclusion`：跨联系人生命周期的已知身份自动重读排除

- 字段：`owner_id!`、`account_id!`、`conversation_id!`、`identity_namespace!`、`external_message_key!`、`blocked_barrier_epoch!`、`deletion_operation_id!`、`created_at!`。
- PK：`(owner_id,account_id,conversation_id,identity_namespace,external_message_key)`；FK：完整稳定渠道私聊键；删除操作 FK 与范围校验待统一删除接口整合。没有 contact/binding FK，不依赖已删除 message。只保留必要无正文身份与排除来历，无正文、摘要、占位或联系人展示副本。
- 联系人或 binding 删除不级联清此排除；重建联系人并绑定同一自然账号/私聊时仍生效。新增排除推进渠道 read_barrier_epoch，与 blocked_barrier_epoch 原子记录，撤销旧在途放行资格。
- 普通读取检查排除；明确恢复只允许固定目标在其 permit 下放行，不删除整批排除决定。恢复后保存的是新来源；旧来源、证明、助手讨论和旧记忆不复活。以后再清空仍推进代次并阻止旧恢复任务。
- 独立理由：规范消息及联系人物理删除后仍需要必要渠道身份防止自动读回；该结构不能代替覆盖尚未读入历史的 conversation_history_cutoff。

## 三、关键事务与授权结论

1. **选择／取消**：短事务推进 contact.selection_epoch，结束旧授权；重选建立新授权，保持同一已核验 binding_id。所有旧读取目标和手动处理结果按其捕获的旧 grant/epoch 拒绝提交。已合法保存来源继续保存。
2. **读取与持久化**：同步读取资格包含总开关及 capture.read_epoch；提交前重核验实际账号、绑定、选择授权、聊天代次、渠道抑制代次、目标与删除边界。来源/消息/隔离及该页可靠检查点同事务提交，事务不等待 CLI。
3. **关闭读取开关**：推进 read_epoch，停发新 CLI 请求；旧代次 capture 不提交。合法已保存资料仍可用于用户已启动或新启动的手动记忆处理；记忆任务只检查其固定联系人选择、资料及独立处理控制，不读取总开关当处理门禁。
4. **清空／联系人删除**：先建立统一删除操作，推进联系人 chat_epoch 和受影响私聊 read_barrier_epoch，登记稳定渠道排除／截断，失效旧目标与在途写入，再清本联系人所有来源正文、规范消息和依赖。清空保留选择授权；删除联系人允许移除联系人与 binding，渠道最小抑制独立保留。可靠 cutoff 成立后，普通增量只接纳清空后的有效新消息；无法证明精确分界必须显示受阻，不能宣称已满足“新消息继续”。库外副本清理与复核归统一删除模块。
5. **明确恢复**：重新核验本人账号及联系人 → 建固定 restore_permit → CLI 证明有限历史目标 → 分页写新 capture/source → 去重规范消息。许可仅限该人该绑定该目标，不扫描其他联系人，不恢复旧记忆；文字等待用户手动处理。
6. **未知与乱序**：消息身份未知隔离；身份、发送方、内容或类型可靠但排序未知时正常保存并标 unknown。没有可靠消息键时不得生成“正文哈希身份”；没有精确渠道边界时不得以本机时钟补位。

## 四、明确不建、合并与待整合接口

- 不建手动文件导入任务或导入文件来源；当前产品没有该入口。capture 已是 CLI 来源批次，不为相同身份另建通用 source 壳。未来出现不同来源事实再重新判断共享结构。
- 不为图片/语音/视频/文件/表情各建一套消息表，不建原媒体下载与资源生命周期表；本轮统一占位。
- 不建昵称身份映射键，不存正文哈希作为消息唯一键，不以 display_order/local_id/时间戳生成渠道顺序。
- 不建第二份 selected 状态，当前授权可推导；不把总读取开关复制到每个任务；不把恢复历史建成长期全局布尔。
- 不建独立 message_source_ref：当前已证明的是每条 CLI record 至多对应一条 message，直接可空 FK 足够；批次与消息的多对多从 record 推导。若未来证实单条来源材料可规范化成多条消息，再判断不同关联事实。
- 本文没有规定 SQLite 类型、索引执行计划或触发器语法。复合 FK/状态互斥/候选键必须在全库设计中落实，不能以应用注释替代数据库约束。
- **跨领域接口待整合**：统一 deletion_operation 的精确复合候选键及目标范围；记忆固定输入的 message_id+revision 和 source 支持；完整参与窗口对 capture/record 的依赖；账号/进程读取租约；来源级删除仍有其他支持时的重核验；规范消息 revision 变动的处理失效规则。它们不构成继续增表的自动理由。
- **技术前置条件**：CLI 本人账号、私聊和消息自然键；不透明续读位置与失效规则；有限历史快照目标；清空精确边界与清空期间新消息归属；历史到增量交接。本稿未验证这些能力；字段表示需要证明的合同，不宣称现有 CLI 已提供。

核对结果：本稿只形成事实到结构的讨论材料；没有读旧候选、执行测试、运行 App、读取真实聊天或修改业务数据库。

消息字段及revision含义以[消息收敛提案](greenfield-message-contract.md)为最新讨论依据；未建立历史版本实体时不把message_id+revision声明为历史FK。
