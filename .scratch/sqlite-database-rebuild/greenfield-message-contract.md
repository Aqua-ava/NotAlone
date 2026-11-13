# 消息与来源：第一项收敛提案

状态：2026-10-29用户已确认原聊天正文不直接编辑、关系资料通过记忆修正、当前不建聊天正文版本表；其余字段和物理约束仍是结构提案，未批准最终DDL。依据Q32/Q33/Q34/Q35及已确认的来源删除、固定输入和完整追踪要求，从事实推导；旧表名不构成约束。

## 1. 三种事实

| 事实 | 唯一身份 | 函数依赖和基数 |
| --- | --- | --- |
| 一次确实发生的读取响应 | capture_id | capture_id决定当时读取目标、适配器、时间、读取代次；一响应含0:N条原始出现 |
| 响应里第几条原始出现 | capture_id＋item_no | 这对键决定原始必要载荷及核验结果；一出现至多解释为一消息，隔离时不指向消息 |
| 渠道中一条已核验消息 | 已核验账号/会话命名空间＋可靠消息键 | 决定消息身份及已核验正文/发送方/类型；同一消息可有0:N次历史捕获，有效消息须有至少一个有效来源支持 |

因此推导三个存储主体：sync_capture、capture_record、message。它们分开是因为事实粒度和基数不同，不是因为旧库有三个同名表。capture_record直接持有message外键，不另造只有两列的来源关联表。

## 2. 消息身份的两种键

内部键用于其他业务引用：`(owner_id,contact_id,message_id)`，由本机生成且不携带时间/顺序含义。

业务候选键用于判重：`(owner_id,contact_id,binding_id,identity_scheme,external_message_key)`。绑定固定对应已核验账号与会话，取消重选不换绑定身份；读取批次、许可代次、普通复验修订均不属于消息判重键。

identity_scheme是已证明的渠道键定义，不是适配器发布版本。升级解析器不能随意改变scheme制造重复消息。昵称、正文哈希、读取时间、分页cursor都不是消息身份。现CLI的local_id、秒级时间或名为server_id的字段尚不能直接宣布符合唯一性要求；这仍是适配器实施门槛。

联系人/绑定删除后，防止自动读回旧消息的排除以稳定渠道账号/会话身份为准；不依赖这里将被删除的message或contact行。明确恢复后保存新来源，不复活旧提取证明。

## 3. 字段与关系

下面TEXT/INTEGER为SQLite类型建议；内部ID用TEXT，系统时间用UTC毫秒INTEGER，外部不安全大整数身份按精确TEXT保存。所有列默认NOT NULL，标“可空”例外。具体外键父键以全库统一命名为准。

### sync_capture：一次真实读取响应

| 字段 | 类型 | 含义/约束 |
| --- | --- | --- |
| owner_id, contact_id, capture_id | TEXT | 联合主键；联系人范围 |
| read_goal_id | TEXT | 完整范围FK到固定读取目标，不另存一份可变许可 |
| read_epoch | INTEGER | 发起该次读取时的总开关代次；非负 |
| runtime_instance_token | TEXT | 实际发起者身份，防止旧进程提交 |
| captured_at | INTEGER | 本机捕获时点，不当渠道消息顺序 |
| adapter_version | TEXT | 解释该响应格式的适配器版本 |
| cursor_in, cursor_out | TEXT，可空 | 协议游标，不是消息键；不得夹带聊天正文 |
| result_state | TEXT | received/failed等受限状态；未知响应不能记成功 |
| error_code | TEXT，可空 | 有界无正文错误标识 |

一页响应已收到、仅数据库事务重试：沿用同一capture_id。重新调用CLI得到另一次响应：新capture_id，即便请求cursor相同。失败响应可零条记录。只有实际接纳记录与检查点同事务提交后，才能推进读取位置。

### capture_record：一次原始出现

| 字段 | 类型 | 含义/约束 |
| --- | --- | --- |
| owner_id, contact_id, record_id | TEXT | 联合主键 |
| capture_id | TEXT | 同范围capture真实FK |
| item_no | INTEGER | 页内位置；非负；UNIQUE(owner_id,contact_id,capture_id,item_no) |
| state | TEXT | normalized/quarantined/suppressed/erased等有限状态，不能把删除写成待核验 |
| message_id | TEXT，可空 | 同范围message FK；normalized必填，其余为空 |
| raw_payload | TEXT，可空 | 必要原始文字/元数据，敏感；删除和抑制后必须为空 |
| observed_identity_scheme, observed_message_key | TEXT，可空 | 本次实际取得的身份候选，不是已核验声明 |
| normalizer_version | TEXT | 本次核验/规范化解释版本 |
| reason_code | TEXT，可空 | 隔离、冲突或抑制的明确原因 |
| created_at | INTEGER | 本次原始出现入库时点 |

同capture/item重放须逐项核对既存载荷及身份，不以UPSERT覆盖原记录。normalized关联须核验同绑定和可靠身份，owner/contact一致本身不够。

状态变化可以记录核验结果，原始观察内容不改写；合法删除可以擦除。非文字仅保存占位所需原始类型和身份/位置元数据，不下载资源，不从占位造正文。隔离只允许在来源、联系人和删除资格均有效时保存；未知删除资格不是隔离留存理由。

### message：一条规范消息

| 字段 | 类型 | 含义/约束 |
| --- | --- | --- |
| owner_id, contact_id, message_id | TEXT | 联合主键 |
| binding_id | TEXT | 同范围已核验绑定FK |
| identity_scheme, external_message_key | TEXT | 与范围/绑定组成业务唯一键；仅可靠身份可填 |
| sender_role | TEXT | self/contact；system仅协议能证明时允许，不能填伪unknown |
| kind | TEXT | text/image/audio/video/file/sticker/other_nontext |
| text_body | TEXT，可空 | text必填；所有非文字必须NULL；占位文案由界面生成 |
| original_type_code | TEXT，可空 | 必要渠道类型，保留未知非文字类别 |
| sent_at, sent_at_precision | INTEGER/TEXT，可空 | 同时有值或同时空；不伪造时间精度 |
| order_scheme, order_key | TEXT，可空 | 同时有值或同时空；只有可靠跨页顺序合同才填写 |
| interpretation_revision | INTEGER | 当前解释/排序资格的CAS修订号，正整数；不是消息正文版本ID |
| availability | TEXT | active/disputed/invalidated等有限状态；有冲突时不得仅凭行存在生成 |
| created_at | INTEGER | 内部创建时点，不充当渠道顺序 |

正文、发送方、非文字类型及业务身份在接纳后原则上不可原地编辑。排序/时间若从未知补为经核验值，必须保留实际依据、增加interpretation_revision，并使依赖旧解释的未提交处理重新核验。此修订计数器只表示当前状态发生变化，不支持“读取任意旧revision正文”。

## 4. 是否需要消息版本表

**当前建议不建立聊天正文版本历史表，也不开放直接编辑原聊天正文。** 已确认的用户纠错对象是关系资料/记忆；完整提取追踪保存当时真实输入和输出。此项于2026-10-29经用户确认；不扩大解释为用户批准全部字段或DDL。

必须区分三个概念：

- 原始观察内容：capture_record保持当时输入，合法删除除外。
- 当前规范解释：message保留稳定正文及可核验的排序/资格，CAS修订用于过期检查。
- 某次处理实际看到的内容：完整追踪保存当时载荷，并用真实message与capture_record FK保留来源。

没有message_version实体时，不能创建外键指向不存在的历史`message_id+revision`。固定输入记录保存真实message FK＋accepted_interpretation_revision快照，提交时比较当前修订；实际历史输入从追踪读取，不从当前message倒推。

若以后确认“用户编辑聊天原文”“可靠渠道原地编辑历史”或“修复解析错误后仍需独立浏览全部旧解释”，就出现新的版本事实，届时需专门设计版本和替代关系。当前检测到解析错误或身份冲突先隔离/暂停使用，不以无限覆盖代替修复协议。

## 5. 重复、冲突和非文字示例

| 输入情况 | 结果 |
| --- | --- |
| 同一已收到响应因DB失败重放 | 同capture/item核对后幂等，不新增原始出现 |
| 新一次读取再次读到可靠键K、同一正文和类型 | 新capture/record指向既有message；消息仍一条 |
| 可靠键K对应新正文或发送方与既存事实矛盾 | 新观察隔离；若冲突动摇既存身份/内容可靠性，message置disputed并停止新引用；不按先到或后到选择真相 |
| 没有可靠消息身份 | 有效授权和删除资格下保存隔离record，不造假message |
| 身份和内容可靠、顺序未知 | 保存message，排序字段NULL；本地展示顺序不能作因果证据 |
| 图片/语音/文件等 | 同一message结构，text_body=NULL，只占位置/类型，不进入记忆提取 |

raw格式差异不自动等于消息内容矛盾；仅在相同语义身份合同下比较明确规范事实，不用正文近似度猜合并。

## 6. 删除和事务合同

删一个来源：撤销该来源资格、擦除对应record及包含该来源的完整追踪/副本；仅在message仍有其他合法来源支持且无身份争议时保留规范事实。其他来源不能为旧追踪换出处或洗掉原删除依赖。

删一条消息或清空联系人：覆盖全部相关捕获支持、正文、占位与派生依赖，登记必要渠道排除/精确历史边界；不能因存在第二次捕获而保留目标消息。原始来源、规范消息和追踪副本都在清理范围内。

接纳响应的事务：复核账号/绑定/固定许可/数据代次/读取开关代次 → 检查渠道排除与清空边界 → 接纳原始出现及去重/隔离 → 关联消息 → 原子推进合法检查点。外部CLI调用在事务外。

同步开关关闭仅阻止新读取和过期capture提交，不撤销已合法保存资料的记忆处理资格；联系人取消/清空的硬撤销另行判断。

## 本次收敛与剩余决定

已明确提议：三种事实粒度、直接来源外键、三层去重、统一非文字占位、正文不静默覆盖、当前修订计数与历史版本分开。

用户已确认：“原聊天正文保持原样，修正关系资料走记忆；当前不建聊天编辑版本表”（2026-10-29，回复“接收”）。CLI真实消息唯一键与精确历史边界属于技术证明工作，不能让用户选择代替证明。

尚未实施SQL或操作真实数据。本文件优先于greenfield首稿中含糊的“一页重试新capture”及“message_id+revision历史引用”表述。
