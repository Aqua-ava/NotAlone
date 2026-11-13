# 确定用户、账号与联系人绑定的关系模型

Triage: ready-for-agent
State: resolved
Type: grilling
Map: [SQLite 数据库重建设计决策地图](../map.md)
Blocked by: none

## Question

用户、微信账号、联系人、渠道身份与会话绑定分别是什么实体，哪些是一对一或一对多？如何定义主键、候选键、范围外键、活动唯一性、撤销及重绑的生命周期，避免昵称承担身份？

## 已有输入

- [spec.md](../spec.md)
- [schema-plan.md](../schema-plan.md)
- [message-storage-draft.md](../message-storage-draft.md)
- [003_separate_contact_identity.sql](../../../backend-ts/database/migrations/003_separate_contact_identity.sql)
- [015_owner_channel_identity.sql](../../../backend-ts/database/migrations/015_owner_channel_identity.sql)

## 完成条件

逐表给出一行含义、字段及类型、函数依赖、主键／候选键、基数、NULL、约束、索引访问依据和删除／变更合同；已确认边界不重复提问，新的真实取舍通过用户讨论确定。

## Proposal：四张身份核心表

本节记录本轮讨论的逻辑结构基线，尚未执行建表；字段类型及物理实现仍需后续验证。用户本轮明确确认的是 Q34 的绑定身份与授权分离，不把全部工程字段逐项冒充用户决定。当前仅微信私聊、单个当前微信账号、空库重建；不新增跨账号联系人合并或多渠道功能。

### 类型与键的共同约定

- 内部 ID 初步采用应用生成的 UUID，以非空 TEXT 保存；外部账号／会话标识是独立的非空 TEXT，不假定它们是 UUID，不以昵称、大小写折叠或正文推断身份。
- 时间初步采用 UTC Unix 毫秒 INTEGER；本组字段记录系统创建、修改和核验时点，不用于伪造聊天的原始时间。物理类型、STRICT 选项和运行时适配仍由后续物理设计验证。
- 除明确写可空的字段外，其余均 NOT NULL。组合主键每列显式非空；关系用同范围复合外键约束。
- 所有范围字段均来自受控运行身份与核验结果，不能允许原始资料自行指定 owner_id。必要的范围唯一超键是为了保证同 owner/contact 的真实引用，不能误称每个 UNIQUE 都是最小候选键。

### owner：资料所有者

一行表示一位 NotAlone 资料所有者；当前本机产品只有一位实际用户，保留 owner 范围是既有私密资料隔离要求，不新增登录或多租户功能。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `owner_id` | TEXT | 内部用户身份，主键。 |
| `created_at` | INTEGER | 本库中资料所有者建立的时间。 |

主键：`owner_id`。这里不存微信昵称、微信账号和同步开关；若之后确有应用级用户显示名需求，再作为用户自己的属性讨论，不能拿微信昵称替代用户身份。旧表 owner.display_name 的使用者须在完整旧结构映射时复核，不能只因旧列存在就照搬。

### channel_account：用户已核验的微信账号

一行表示某位 owner 名下的一份外部账号身份；同一账号重新核验沿用本行。允许保留被撤销账号的真实历史记录，不等于本次已经支持多账号并行或无感切换。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `owner_id` | TEXT | 所属用户；外键到 owner。 |
| `account_id` | TEXT | 本库内部账号 ID。 |
| `channel` | TEXT | 当前只允许 `wechat`，用于外部身份命名空间。 |
| `external_account_id` | TEXT | CLI 已核验的本人账号标识，不是显示名。 |
| `state` | TEXT | `active`／`revoked`；描述当前认可的账号身份，不表示 App 是否运行或同步开关是否开启。 |
| `last_verified_at` | INTEGER | 最近一次真实账号核验时点。 |
| `created_at`、`updated_at` | INTEGER | 建立和最近修改时点。 |
| `revoked_at` | INTEGER，可空 | active 为空，revoked 必须有撤销时点。 |

- 主键：`(owner_id, account_id)`。
- 全表业务候选键：`(owner_id, channel, external_account_id)`，避免同一用户重复建立同一账号记录。
- 外键：`owner_id → owner.owner_id`。
- 条件唯一：每个 `(owner_id, channel)` 只允许一条 active 身份，沿用当前仅一个活动账号的合同。
- 沿用既有保护：同一 `(channel, external_account_id)` 不同时作为两个 owner 的 active 身份。此条件唯一不是全表候选键，不阻止同一身份的合法撤销历史。
- CHECK：合法 state、非空账号字符串、state 与 revoked_at 一致。外部身份变更不是把本行的 external_account_id 改成另一个账号，而是重新核验其他账号及其独立资料范围。

### contact：用户的一位联系人

一行表示稳定的内部联系人；一位真人是否可跨账号合并不由昵称或数据相似度决定，本次继续不做跨账号或跨渠道合并。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `owner_id` | TEXT | 联系人所属用户。 |
| `contact_id` | TEXT | 稳定内部联系人 ID。 |
| `display_name` | TEXT | App 当前展示名称，非空但不唯一。 |
| `created_at`、`updated_at` | INTEGER | 建立和修改时点。 |

- 主键：`(owner_id, contact_id)`；外键：`owner_id → owner.owner_id`。
- 名称不设唯一约束；同名联系人分别存在。contact 不重复存 account_id、微信 locator 或“当前绑定状态”，这些由绑定关系表达。
- 昵称变化不更换 contact_id，不移动聊天或记忆。是否专门保存名称历史仍未决，不把本节提案误记为用户已放弃历史名称。

### conversation_binding：账号内会话到联系人的核验映射

一行表示一次明确的会话身份对应关系，供来源、消息读取与回复资格引用。提议在同一有效关系的读取取消／重选之间保持 binding_id；读取授权的代次与范围另存，不覆盖身份本身。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `owner_id` | TEXT | 同时约束账号和联系人属于同一 owner。 |
| `binding_id` | TEXT | 内部绑定身份。 |
| `account_id` | TEXT | 属于本 owner 的已核验账号。 |
| `contact_id` | TEXT | 属于本 owner 的联系人。 |
| `conversation_locator` | TEXT | 已核验的微信私聊定位标识；不直接当 contact_id。 |
| `identity_state` | TEXT | `verified`／`invalidated`，表示身份映射资格；不是同步选择开关。 |
| `binding_revision` | INTEGER | 映射复验或失效所用的单调版本，初步从 1 开始；不能替代独立授权代次。 |
| `verified_display_name` | TEXT | 绑定核验时的渠道名称快照，供现行前台核验合同使用；不是联系人当前名或名称历史列表。 |
| `last_verified_at` | INTEGER | 最近一次身份映射核验时点。 |
| `created_at`、`updated_at` | INTEGER | 建立与修改时点。 |
| `invalidated_at` | INTEGER，可空 | verified 为空，invalidated 必须有失效时点。 |

- 主键：`(owner_id, binding_id)`。
- 账号外键：`(owner_id, account_id) → channel_account(owner_id, account_id)`。
- 联系人外键：`(owner_id, contact_id) → contact(owner_id, contact_id)`。同一个 owner_id 同时参与两个外键，可拒绝将用户 A 的账号连到用户 B 的联系人。
- 范围引用用唯一超键：`(owner_id, contact_id, binding_id)`，供后续来源等表作同联系人复合引用；不是另一套独立业务身份。
- 当前有效映射条件唯一：`(owner_id, account_id, conversation_locator)`，防止一个有效微信会话同时指向两位联系人。
- 当前范围内还建议每位联系人至多一条 verified 映射：对 `(owner_id, contact_id)` 建条件唯一。历史失效映射仍可保留；这不预建跨账号合并。
- CHECK：合法 identity_state、非空定位与名称快照、revision 正整数、state 与 invalidated_at 一致。若拿不到现行前台合同所需的名称快照，应保持待核验或明确缺口，不以填假名字通过约束。
- owner、account、contact、locator 建立后不在原行改挂；错误归属需先使相关工作失效，按来源删除合同处理，再重新确认。不能移动绑定的外键来移动旧聊天的归属。

### 关系与范式检查

```text
owner 1 ── N channel_account 1 ── N conversation_binding
  └── 1 ── N contact        1 ── N conversation_binding（包含历史失效映射）
```

- 每个绑定恰有一个账号和联系人；每个账号可有多个私聊绑定；联系人历史可有多个绑定，但当前提案至多一个有效映射。新联系人创建与有效绑定建立应在同一事务完成，避免把任意空记录当成已确认联系人。
- owner、账号身份、联系人名称、会话对应关系分别依赖各自的键。channel 只放账号表，不再在绑定中复制 channel 或 external_account_id；绑定通过 account_id 找到它们。
- `contact.display_name` 是 App 当前展示名，`verified_display_name` 是核验时快照；二者时间语义不同，不能当作两份可随意同步修改的同一事实。它不授权自动绕过现行改名确认规则。
- 读取总开关、逐人选择、历史授权版本、授权代次和同步游标不在本节重复定义；它们由后续授权／同步模型引用 binding，读写时同时复验账号、映射和有效授权。映射 verified 本身不等于可读取正文，也不自动扩大前台识别资格。
- 名称、时间和状态等非键字段的函数依赖需要按最终约束复核；上述条件唯一仅对有效记录成立，不能据此简单宣称所有历史行已经具有同一自然键或整套模型已严格满足第三范式。

### 删除、变更与索引

- 身份主表之间初步使用 ON DELETE RESTRICT／ON UPDATE RESTRICT，避免在库外文件未清理时仅删父行就丢失归属。真正删除由删除任务完成受影响资料与文件后再移除身份记录；最终行为在删除合同中统一验证。
- 名称更新是属性更新；取消同步是授权变更；身份冲突是映射失效；清空聊天是资料删除。不能让一个 status 或删除动作同时代替这四件事。
- 主键和业务唯一约束先由语义决定。除其索引外，只有实际存在按 contact 查绑定、按 account 枚举有效绑定等查询时才加相应范围／状态索引；不预建所有字段索引。
- 当前只有两张新表的 owner 单列引用及绑定的两条复合引用，不用 JSON ID 数组或 entity_type/entity_id 来替代关系完整性。

### 为什么暂不单独建 contact_channel_identity

当前新库不再走历史文件导入，只有微信私聊。已有代码中旧 channel_identity 主要由历史导入写入，而普通微信绑定／历史纳入只直接创建 conversation_binding；旧身份表还缺少账号范围。可研究用带 account 范围的绑定映射表达当前所需的渠道身份，不复制一份相同映射。

这只是有条件的四表方案：如果核验显示“对方渠道身份”和“私聊会话 locator”不是一对一，或需要一个人多个会话／渠道身份，就必须保留独立身份表及明确外键，不能仅因某些值目前相同而合并。源码依据：[绑定](../../../backend-ts/src/contacts/binding-service.ts)、[历史导入写入](../../../backend-ts/src/imports/history-import-service.ts)、[导入协议](../../../backend-ts/src/imports/history-import-format.ts)、[历史纳入](../../../backend-ts/src/sync/wechat-history-enrollment.ts)。

## 本轮处理状态

- Q34 已确认选择 A：同一账号和已核验私聊关系未改变时，取消同步后重新选中沿用原 binding_id，重新授权由独立记录与代次表达。
- 旧 owner.display_name 的使用者交给完整旧结构映射复核；名称历史不影响本轮身份键设计，仍不擅自记为用户已放弃。独立渠道身份是否需要补表取决于适配器和后续关系模型的新证据，出现相反证据时重开相应设计，不以四张表为硬性目标。

## Answer

2026-10-28，本项已形成可供后续消息及来源设计使用的身份关系基线。

**用户明确决定**：Q34 选择 A。同一有效账号和已核验私聊关系在取消／重新选中之间保持 binding_id；取消同步只撤销相关读取和处理资格，不删除联系人身份映射。新授权使用独立授权记录／代次，旧请求不能借相同 binding_id 自动恢复写入资格。

**工程建模结论**：以 owner、channel_account、contact、conversation_binding 四类核心记录作为当前范围的建模基线。本任务已给出字段草图、主键／候选键／条件唯一、范围外键、历史与当前基数、NULL、变更与删除合同。姓名展示、渠道账号和会话映射不互相冒充；绑定中的核验版本与读取授权代次不混用。

**继续验证的边界**：只适用于账号及会话身份仍已核验、映射未变的情况；身份冲突、映射失效或真实删除后不得凭 Q34 自动重建。授权表、来源中的授权引用、检查点及清空边界由后续任务收敛，具体 SQLite 类型与约束还要执行合成验证；resolved 不表示已经建表或已完成产品集成。

**验证**：只读源码及现行领域约束，复核表的行含义、范围引用与生命周期，并检查文档链接与状态。未访问真实业务库、运行 App／微信、修改业务代码或执行 SQL。

## Comments

- 本任务只产生设计决定或事实查证；表数不是硬指标。沿用仓库隐私、手动发送和桌面热更新约束，不读取私人资料，不执行真实删库，不做远端操作。
- 用户对 Q34 回复 A；本轮只收敛这一项需要用户参与的决策，下一项为“确定消息、原始记录与占位的关系模型”。
