# 确定消息、原始记录与占位的关系模型

Triage: ready-for-agent
State: resolved
Type: grilling
Map: [SQLite 数据库重建设计决策地图](../map.md)
Blocked by: 01, 02

## Question

如何设计 source_batch、source_record 与 message，使原始出现、待核验隔离、规范消息和多来源关系都准确表达？一批／一行的粒度、消息唯一键、时间与顺序、占位以及检查点原子提交应如何约束？

## 已有输入

- [message-storage-draft.md](../message-storage-draft.md)
- [schema-plan.md](../schema-plan.md)
- [021_message_source_ref.sql](../../../backend-ts/database/migrations/021_message_source_ref.sql)
- [088_cli_opaque_cursor_order.sql](../../../backend-ts/database/migrations/088_cli_opaque_cursor_order.sql)

## 完成条件

形成可审阅的字段和键、关系基数、状态与 NULL 语义、去重与隔离合同、来源删除规则和写入事务；落实非文字只占位不进记忆，未证明的渠道能力不能写成已支持。

## Proposal：三种不同事实

本节记录本轮形成的逻辑结构基线，未执行 SQL。用户本轮明确确认的是 Q35 的排序不确定性处理，不把全部工程字段逐项冒充用户决定。延续内部 UUID/TEXT、UTC Unix 毫秒/INTEGER 及 owner/contact 范围约束；具体驱动、身份键真实组成、物理类型与索引性能仍需后续合同及验证。

### 行语义与关系

- `source_batch`：一次已接收的、有界、单绑定 CLI 返回页。一次真正重新读取是新批次；同一份已捕获结果重试提交沿用 batch_id。
- `source_record`：该页中一次原始消息事件出现。它先属于批次，可隔离待核验，核验后关联至多一条规范消息。
- `message`：一条身份及必要事实已可靠核验的规范消息；它可以被多批次、多条原始出现共同支持。非文字占位同样是一条规范消息。

```text
conversation_binding 1 ── N source_batch 1 ── N source_record
conversation_binding 1 ── N message      1 ── N source_record
```

第二条关系中的每个 source_record 可以暂时没有 message；不存在的消息不会为了凑外键而先建空壳。message 的有效来源反向要求需由写入和删除事务复验，普通子表外键不能保证父消息至少有一个活动来源。

### source_batch：字段、键与状态

| 字段 | 类型／可空性 | 含义 |
| --- | --- | --- |
| `owner_id`、`contact_id` | TEXT，非空 | 此页唯一归属的用户和联系人。 |
| `batch_id` | TEXT，非空 | 本次已捕获页的内部身份；落库重试沿用，不是 cursor 或内容哈希。 |
| `binding_id` | TEXT，非空 | 已核验私聊绑定；不再重复存其 account_id、channel 或当前昵称。 |
| `capture_mode` | TEXT，非空 | 历史、增量、补齐或明确历史恢复等来源来历，最终枚举与入口核对。 |
| `adapter_version` | TEXT，非空 | 本地读取协议／适配规则版本，不等于微信消息身份命名方案。 |
| `cli_version` | TEXT，可空 | 实际可核验的 CLI 版本；无法确认时明确未知，不伪填锁定版本。 |
| `cursor_before`、`cursor_returned` | TEXT，可空 | 此次请求使用和此页返回的不透明位置。返回值不是已获准推进的可靠检查点。 |
| `has_more` | INTEGER，可空 | 0／1 表示源协议已知结果；未知留空，不能默认当作历史完成。 |
| `reported_record_count` | INTEGER，可空 | CLI 明确声明的原始条数，作为不可变输入事实；不是已规范化数量。 |
| `captured_at` | INTEGER，非空 | 收到这一页的系统时点，不是消息发送时间。 |
| `source_state` | TEXT，非空 | `active`／`delete_requested`；描述来源可用性，删除失败不重新启用。 |
| 资格快照 | 待相关任务确定正式列与引用 | 必须回指当时的授权，并保存绑定核验版本、清空代次等必要资格；不能仅靠当前 active 或一个无约束 JSON 证明。 |

- 主键：`(owner_id, contact_id, batch_id)`；内部 batch_id 一次分配用于同一次捕获的幂等提交。
- 外键：`(owner_id, contact_id, binding_id) → conversation_binding` 的同范围唯一超键。
- 范围引用唯一超键：`(owner_id, contact_id, binding_id, batch_id)`，供原始记录同时校验所属绑定。
- 不对 cursor_before/returned、capture_mode 或内容哈希建立“同页唯一”假设。两次独立读取即使参数相同，也可能收到不同内容；相同内容也不说明是同一次捕获。
- 整页原始记录与头部原子落盘。已链接／待核验／拒绝数量优先从原始记录查询，不另存一组容易漂移的计数。reported_record_count 若有值，是源协议事实，与数据库当前记录数含义不同。
- 授权引用与清空代次是本组与后续控制／删除设计之间的必需接口，正式外键在相关任务确定后才能完成可执行 DDL；此处不发明已存在的授权表或接口。

### source_record：字段、键与状态

| 字段 | 类型／可空性 | 含义 |
| --- | --- | --- |
| `owner_id`、`contact_id` | TEXT，非空 | 联系人数据隔离范围。 |
| `record_id` | TEXT，非空 | 一次原始出现的内部 ID，便于证据和追踪引用；不代表微信消息 ID。 |
| `batch_id` | TEXT，非空 | 所属捕获批次。 |
| `binding_id` | TEXT，非空 | 同绑定范围校验字段，通过复合外键受约束，不是可独立改动的第二份归属。 |
| `record_no` | INTEGER，非空 | 此页中实际出现位置，从 0 开始；不是 local_id，也不是跨页消息顺序。 |
| `raw_kind` | TEXT，可空 | 实际返回的原始渠道类型；未知或不可解析留空并记录原因，不能猜为文字。 |
| `raw_payload` | TEXT，非空 | 本次允许保留的原始事件 JSON 表示，精确保留必要标识；作为当时输入，不与规范消息竞争更新。JSON 有效性、精确大整数编码和字段最小化须核验；无法安全归属的失败输出不伪造为合法原始事件。 |
| `resolution_state` | TEXT，非空 | `linked`、`pending_identity`、`identity_conflict`、`rejected` 等明确结果；最终枚举需要与解析阶段核对。 |
| `message_id` | TEXT，可空 | 可靠核验成功后的规范消息引用；未核验或冲突记录为空。 |
| `resolution_rule_version` | TEXT，可空 | 已采用的解析／身份核验规则版本；尚未处理时为空。 |
| `resolution_code` | TEXT，可空 | 有界的非正文原因码，不存任意敏感错误字符串。 |
| `resolved_at` | INTEGER，可空 | 实际处理时点，未处理时为空；不与批次捕获时间混同。 |

- 主键：`(owner_id, contact_id, record_id)`。
- 原始出现的业务位置唯一键：`(owner_id, contact_id, batch_id, record_no)`。增加 record_id 是缩短后续引用，不能取代这个位置约束。
- 批次外键：`(owner_id, contact_id, binding_id, batch_id) → source_batch` 对应唯一超键，所有字段非空。
- 消息外键：`(owner_id, contact_id, binding_id, message_id) → message` 对应唯一超键；只允许 message_id 暂缺。两条外键共用 binding_id，使原始记录不能关联到同联系人另一个会话的消息。
- CHECK：record_no 非负；linked 必须有 message_id，其余未建立关联的状态必须为空。resolution_state 非空，不能以一个 NULL 同时表示待核验、拒绝和删除。
- 已链接的消息引用不静默改挂。修复既有错误需要重新核验并撤销受影响证据／追踪，后续任务设计实际恢复合同；原始载荷本身保持当时输入。
- Q32 的隔离仅适用于已核验联系人且仍通过读取与删除资格检查的输入。它不允许保存其他联系人内容，也不能把已清空内容改标 pending 后重新存回；无法证明新旧边界时不得借隔离绕过删除。

### message：字段、键与非文字约束

| 字段 | 类型／可空性 | 含义 |
| --- | --- | --- |
| `owner_id`、`contact_id` | TEXT，非空 | 消息的用户和联系人范围。 |
| `message_id` | TEXT，非空 | 规范消息内部 ID，与来源出现的 record_id 分开。 |
| `binding_id` | TEXT，非空 | 当前范围中此条渠道消息所属的稳定绑定命名空间。 |
| `identity_scheme` | TEXT，非空 | 已获证明的渠道身份定义／编码方案，不是每次部署的 normalizer 版本。 |
| `identity_key` | TEXT，非空 | 按该方案可靠取得的消息身份值；组成当前尚不能从旧 CLI 键直接定稿。 |
| `speaker` | TEXT，非空 | 可靠解析的我方／对方方向；其他合法角色是否适用须遵守协议，不猜测。 |
| `message_type` | TEXT，非空 | `text`、图片、语音、视频、文件、表情或明确未知类型等规范种类；完整映射须核验，原始渠道类型仍在来源记录。 |
| `text_content` | TEXT，可空 | 真实文字正文；非文字占位为 NULL。 |
| `occurred_at` | INTEGER，可空 | 可可靠解释的原始发送时间；缺失或无法确定时区时保持未知。 |
| `time_precision` | TEXT，非空 | 例如 second／millisecond／unknown；秒级时间乘 1000 并不产生毫秒精度。 |
| `order_scheme`、`order_key` | TEXT，均可空 | 仅在适配器有可证明的排序合同后填写；两者同时有值或同时为空，不把 cursor 复制成排序键。编码和 SQL 比较方式仍待证明。 |
| `created_at` | INTEGER，非空 | 系统首次建立本条规范消息的时点；不是发送时间，也不是所有来源中最早的捕获时间。 |

- 主键：`(owner_id, contact_id, message_id)`。
- 外键：`(owner_id, contact_id, binding_id) → conversation_binding`，使账号与会话范围可由绑定追溯。
- 范围引用唯一超键：`(owner_id, contact_id, binding_id, message_id)`，供 source_record 同绑定引用。
- 去重业务唯一键提案：`(owner_id, contact_id, binding_id, identity_scheme, identity_key)`。这是唯一性合同的结构，不是当前已经取得其真实值的声明。
- 只有已证明的身份可进入 message；无法取得可靠身份的记录先留 source_record，不填伪 identity_key。当前 local_id + create_time 的哨兵方案没有完成唯一性证明，不能直接采用；server_id 也不能只凭名称认定全局唯一。
- identity_scheme 表达稳定身份定义；普通适配器升级不得随意换 scheme 造成重复消息。若身份命名方案真实改变，须迁移／对账原消息或保留待核验，不以一个新 scheme 生成第二份相同聊天。
- CHECK：text 类型必须有非空真实正文；本轮非文字类型的 text_content 为 NULL。时间未知时 occurred_at 为空，时间精度相应为 unknown；排序方案和键成对存在。
- 原图路径、语音路径、占位标签、联系人当前名、账号名称、重试次数或当前授权代次不放进 message。固定占位由 message_type 映射生成，记忆目标按合法文字与有效来源筛选。

### 三层去重与冲突处理

1. **同批次落库重试**：相同 batch_id 和 record_no 表示同一次捕获的同一次出现；重放必须验证对应载荷一致。载荷矛盾时报告冲突，不以 UPSERT 覆盖原记录。
2. **跨批次重复捕获**：新 batch、新 record；经同绑定下相同可靠身份键命中现有 message 后复用 message_id。保留来源不等于重复保存规范聊天。
3. **只有相似文本或时间**：两个人都说“好的”，或同一人连续发两次“好的”，都不能按正文哈希合并。身份不充分时保持隔离。
4. **相同身份键但规范事实矛盾**：不静默改写旧消息，不强行将新记录认作其有效来源；新原始出现保留为 identity_conflict，留给明确的核验／修复流程。

去重命名空间不包括 batch_id、读取授权代次、普通绑定复验 revision 或捕获时间。Q34 已确认同一关系取消／重选沿用 binding_id，授权变化不会因此把同一条渠道消息变成新消息。

### 占位与顺序的例子

```text
第一批：R1 → M1（文字“收到”）
        R2 → M2（image，text_content=NULL，展示为[图片]）
第二批：R3 → M2（同一可靠渠道身份，复用，不新建图片消息）
        R4 → 无 message_id（身份待核验，原始记录隔离）
```

source_record.record_no 只保存每页内部的原始出现顺序。若没有可靠的跨页渠道排序信息，同秒或缺时的消息不能用 local_id、UUID、捕获时间或提交顺序冒充真实先后。Q35 已确认：身份、发送方、内容或类型可靠时可以先建立规范消息，未知的 order_scheme/order_key 成对留空；稳定展示兜底不能作为真实聊天先后或因果的证据。

### 原子提交、检查点和删除

- CLI 在事务外读取；入库时重新检查账号、绑定、有效读取授权、清空代次及当前来源资格。batch、record、经核验的 message／关联和本次获准推进的检查点在短事务中提交或回滚。
- cursor_returned 只记录源返回事实，可靠检查点在同步状态中另存。已捕获、已规范化和历史覆盖完成不是同一件事；存在隔离记录不允许被标为语义／规范化覆盖完整。
- 整页原始记录可靠落盘后能否继续推进捕获位置，须证明重启可恢复待处理记录且 cursor 合同无歧义；不能单凭“存了 raw_payload”放行。当前 CLI 的已知限制仍是前置缺口。
- 删除一批来源先使其失去使用资格，再清理相关原始记录、规范消息支持、证据和追踪；消息只有失去所有有效来源才按相应合同删除。清空联系人聊天按全部来源与隔离内容清理，真实删除不保留正文墓碑。
- batch／message 到 record 初步使用 RESTRICT，避免无声删除最后来源而遗漏跨领域或库外清理；最终删除语义由删除任务统一确定。正向 FK 不能替代反向有效来源复核。

### 规范化与索引

- 原始记录、捕获页和规范消息是不同事实；raw_payload 是当时输入，message 是经核验的解释，二者并存不构成两个可独立修改的当前事实源。
- binding_id 在原始记录中的保存是有意的范围冗余，用两端复合外键验证相同绑定；父表额外 UNIQUE 是范围引用超键，不误称最小候选键。严格范式与范围隔离之间的此项取舍明确记录，物理设计时复核成本。
- 原始 JSON 中可保留完整必要事件，内部关系、可查询状态和范围引用使用正式列，不将 message_ids 数组作为关系实现。重复的“已处理条数”等派生字段不默认落表。
- 候选索引：message 按联系人和时间读取；source_record 按 batch/record_no 枚举、按 message_id 查全部来源、按 resolution_state 查待核验；先用实际查询和删除反查证明需要，再定列顺序与覆盖范围。

## 本轮处理状态

- Q35 已确认选择 A：消息身份、发送方、内容或类型已经可靠核验，但无法确定精确先后时，先保存规范消息并明确顺序未知；不以稳定展示兜底冒充真实聊天顺序。
- 本轮不重问已确认的非文字占位、不进入记忆、原始记录隔离和稳定 binding_id。消息自然键的真实组成、排序编码、授权与清空引用仍需要后续合同与验证，不能用用户对结构的同意替代技术证明。

## Answer

2026-10-28，本项形成后续记忆、证据与任务设计所用的消息／来源逻辑基线。

**用户明确决定**：Q35 选择 A。身份、发送方及真实文字或非文字类型已经可靠核验时，不因精确排序未知而阻止规范消息保存；order_scheme/order_key 可成对为空，发送时间缺失或精度不足保持真实状态。展示兜底不成为真实先后或因果证据。消息身份不足仍遵守 Q32，留在隔离原始记录，不能由 Q35 绕过。

**工程建模结论**：三表分别表示有界捕获页、页中原始出现和经核验的规范消息。批次落库幂等、原始出现位置唯一和跨批次消息去重分别表达；原始记录的两组复合外键约束同用户、联系人及绑定。非文字在统一消息表保存类型，正文为 NULL，占位标签由类型派生，不进入记忆提取。

**必须继续闭合的合同**：identity_scheme/key 的真实保证、授权及清空资格的正式引用、排序键编码、可靠检查点和删除事务须在后续控制、删除及物理化任务中完成。当前研究已明确旧 CLI 键不足以直接作为已证明自然键；逻辑字段就绪不等于这些缺口已解决，也不等于可直接实施或已通过 SQL 验证。

**验证**：只读复核既有去重、来源与游标代码及前置研究，检查本任务字段、范围外键和状态含义、文档链接及任务依赖。未执行 SQL、运行 App／微信、读取真实资料或修改业务代码。

## Comments

- 本任务只产生设计决定或事实查证；表数不是硬指标。沿用仓库隐私、手动发送和桌面热更新约束，不读取私人资料，不执行真实删库，不做远端操作。
- [08删除一致性提案](08-deletion-consistency.md)已补source_batch的真实grant范围FK、开关／binding／data代次、history_restore授权，以及分generation/episode的检查点；Q32隔离不能存回无法通过删除资格的正文。实际可靠消息身份及精确清空adapter仍是10前置门禁，不把字段就绪当作协议已证实。
- 用户对 Q35 回复 A；本轮完成这一项需要用户参与的逻辑模型决策，下一项为“确定记忆、版本、证据和完整追踪的关系模型”。
