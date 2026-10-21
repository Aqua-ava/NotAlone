# 联系人身份与导入契约整改

> 2026-10-21 后继决定：[ADR-087](../../architecture/adr/087-wechat-confirmed-contact-onboarding.md)规定新联系人仅从微信会话确认加入，导入只补充已有联系人，旧独立创建与导入新建接口待退役。本文无需微信即可空目录首用或导入新建的要求不再有效；历史状态、签收与验收记录保持，不证明当前首用已交付。

## 背景

ADR-008 已确定 `contact_id` 是 NotAlone 创建的稳定内部身份，微信 `sender_wxid` 只作为渠道身份或来源元数据。现有 Python 模型和数据库仍把两者视为同一个值，规范消息也被微信 JSONL 字段绑定，来源删除尚未实现“删除后不可检索”。

## 已采纳约束

- v1 只服务一个用户和一个微信账号，不实现跨账号或跨渠道联系人合并。
- 首次导入由用户创建或选择联系人；导入文件不能提供 `owner_id`。
- 微信专属字段保留为来源证据，但不是所有规范消息的必填字段。
- `deleted` 只表示来源及派生资料已经清除并通过不可检索验证。
- 代码和数据库迁移必须使用合成数据验证，不接触真实聊天资料。

## 范围

本规格拆成三个独立任务：内部联系人身份迁移、规范消息与微信字段解耦、来源级删除。后台 Worker、前端界面、多账号和多渠道合并不在本轮范围。

本轮先实现内部联系人身份迁移。它只使用合成资料和隔离测试库，不读取或导入
`chat_exports/` 中的真实聊天资料。

## 统一数据关系

```text
owner
  -> contact（NotAlone 内部 UUID）
      -> channel_identity（wechat + sender_wxid）
      -> source_document
          -> import_confirmation
          -> message
```

- `contact.id` 使用 NotAlone 生成的 UUID；`display_name` 可修改，不参与身份匹配。
- `channel_identity.external_id` 保存微信 `sender_wxid`；`observed_name` 保存来源中最近识别到的展示名称，仅供核对。
- `import_confirmation` 一对一关联 `source_document`，记录用户把该来源分配给哪个联系人、采用何种人工确认方式以及确认时间。
- `source_document` 和 `message` 继续显式保存 `owner_id + contact_id`；所有外键必须证明关联对象属于同一 owner 和 contact。

### `channel_identity` 最小字段与约束

```text
id, owner_id, contact_id, channel, external_id,
observed_name, status, verified_at, created_at
```

- v1 的 `channel` 只允许 `wechat`，`status` 只允许 `active` 或 `revoked`。
- 同一 owner 下，一个 active `(channel, external_id)` 只能属于一个联系人。
- 同一联系人当前最多拥有一个 active 微信身份。
- 已有 active 微信身份与本次来源识别结果不一致时，整次导入失败；不得自动改绑、覆盖或创建第二个 active 身份。

### `import_confirmation` 最小字段与约束

```text
id, owner_id, contact_id, source_document_id,
channel_identity_id, method, confirmed_at
```

- `method` 只允许 `manual_create` 或 `manual_select`。
- 微信 JSONL 来源必须关联同一 contact 下的 active `channel_identity`；不含渠道身份的普通手工资料将来可令该字段为空。
- 一个 `source_document` 只允许一条确认记录。导错联系人时删除原来源并重新导入，不修改确认记录或来源的 `contact_id`。

## 模块与 seam

### 预览 seam

保留 `build_preview(path) -> ImportPreview` 作为调用方和测试共同使用的 Interface。预览只读取、解析和校验文件，返回一个微信渠道身份候选：

```text
ChannelIdentityCandidate(
    channel="wechat",
    external_id=<sender_wxid>,
    observed_name=<sender>,
    observed_name_variant_count=<count>,
)
```

预览不得生成 `contact_id`、猜测已有联系人或写数据库。

### 确认与导入 seam

保留一个应用层入口 `import_file(...) -> ImportResult`，但把当前含义模糊的
`confirmed_contact_id: str` 替换为显式选择：

```text
ContactSelection =
    ExistingContactSelection(contact_id: UUID)
    | NewContactSelection(display_name: str)

ImportConfirmationRequest(
    selection: ContactSelection,
)
```

确认方式不由调用方重复传入：`NewContactSelection` 固定写入 `manual_create`，
`ExistingContactSelection` 固定写入 `manual_select`，因此 Interface 无法表达类型与方法
矛盾的请求。`owner_id` 来自受控运行身份；内部函数可以接收它，CLI 不再要求用户把 owner
UUID 作为联系人确认信息输入。

### 持久化 seam

`IngestRepository` 保持一个深 Interface：一次调用完成联系人解析或创建、渠道身份核验、
来源、确认记录和消息写入。调用方不负责安排 SQL 顺序。

```text
import_document(owner_id, document, confirmation) -> ImportResult
```

`ImportResult` 至少返回 `contact_id`、`channel_identity_id`、
`source_document_id`、`confirmation_id`、`outcome` 和 `message_count`，使调用方和测试能从
同一 Interface 观察结果。所有写入位于一个 PostgreSQL 事务；任一步失败都不得留下联系人、
渠道身份、来源、确认记录或部分消息。

## 行为规则

1. 新建联系人时，由 NotAlone 生成 UUID，并把预览识别出的微信身份作为首个 active 渠道身份。
2. 选择已有联系人时，没有微信身份则在用户本次确认后建立；已有相同身份则复用；已有不同 active 身份则拒绝。
3. 某个微信身份已绑定另一联系人时拒绝，不根据昵称、正文或模型判断自动改绑。
4. 同一 active `(owner_id, contact_id, content_sha256)` 重复导入返回原结果，不新增确认记录或消息。
5. 不同来源复用同一联系人下的微信 `external_local_id` 时继续整批拒绝，不自动合并。

## 数据库迁移与回滚

- 新迁移把 `contact.id`、`source_document.contact_id` 和 `message.contact_id` 统一为 UUID，并新增 `channel_identity`、`import_confirmation` 及复合外键和唯一约束。
- 当前没有真实数据入库，因此迁移必须先断言不存在已有 `contact`、`source_document` 或 `message`。发现旧数据时立即失败，不把旧 `sender_wxid` 静默认定为已由用户确认的内部联系人。
- 本地开发库和测试库在空库上按全部迁移顺序重建；迁移失败由 PostgreSQL 事务自动回滚。
- 迁移成功并开始新格式导入后，不提供有损的反向 SQL。需要回退时恢复迁移前备份；没有备份不得声称可回滚。

## TDD 测试 seam

实施前确认以下四个 seam，测试只从这些 Interface 观察行为：

1. `build_preview`：只返回渠道身份候选，不返回或创建联系人。
2. `import_file`：创建或选择联系人，并在联系人确认失败时不调用 repository adapter。
3. `IngestRepository.import_document`：通过 `ImportResult` 和领域错误验证事务、幂等与冲突行为。
4. PostgreSQL 迁移：使用直接 SQL 验证字段类型、复合外键、唯一约束和空库保护；这属于数据库 seam，不作为应用层行为测试的旁路。

第一个 TDD 纵向切片固定为：选择一个已存在的内部联系人导入合成 JSONL，得到独立的
`contact_id` 与微信 `channel_identity.external_id`，同时写入一条 `manual_select` 确认记录；
两者不得相等，也不得输出到普通 CLI 成功信息。

## 数据处理与真实资料验证

- unit、integration 和迁移测试只使用合成或匿名化夹具，任何真实正文、联系人标识、文件名或路径不得进入测试、Git 或错误快照。
- 自动测试稳定后，可以另行取得用户明确授权，对用户指定的单个 `chat_exports/` 文件执行本地只读结构验收；默认不显示正文和身份信息，也不写数据库。
- 真实资料验收用于发现导出格式差异，不能替代可重复的合成测试。发现的新结构先匿名化为合成夹具，再进入自动测试。

## 完成条件

三个任务分别实现并通过相关 unit/integration 测试；数据库迁移可重复执行；现有正常导入、损坏文件拒绝、联系人隔离、幂等和重叠来源行为不回退。

内部联系人身份任务还必须满足：上述四个测试 seam 已由用户确认；空库迁移保护通过；
同一微信身份不能绑定两位联系人；确认记录可从来源追溯且不会被标成模型判断；未执行经授权的
真实资料验收时，不得宣称真实导出格式已经兼容。
