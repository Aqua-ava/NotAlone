# 数据库迁移

NotAlone 使用 PostgreSQL 作为权威业务库。迁移文件按文件名顺序执行，不允许只在图形客户端中手工修改正式表结构。

本地开发数据库：

```text
数据库：notalone_dev
所有者：wy
schema：public
```

应用首个迁移：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/001_initial_ingest.sql
```

已应用首个迁移的数据库继续执行：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/002_reject_overlapping_messages.sql
```

联系人、来源和消息表为空时，继续执行联系人身份分离迁移：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/003_separate_contact_identity.sql
```

第三个迁移会在旧联系人、来源或消息存在时拒绝执行，不会把旧微信标识静默转换为
NotAlone 内部联系人。执行前必须确认数据范围和备份；本地空开发库可按全部迁移重建。

迁移仅建立数据结构，不读取 `chat_exports/`，也不导入真实聊天记录。

首个迁移建立旧版 `owner`、`contact`、`source_document` 和 `message`，第三个迁移在空业务
表上把 `contact.id` 改为 NotAlone 内部 UUID，并新增 `channel_identity` 和
`import_confirmation`。微信 `sender_wxid` 保存在渠道身份中，不再充当 `contact.id`；
`message` 同时保留规范化字段和原始单行 JSON 的 `raw_payload`。
第二个迁移保证同一用户与联系人下，一个 `external_local_id` 只能归属一个来源；不同
SHA 文件若包含重叠消息，正式导入会整批回滚，避免同一消息出现两个权威来源。

表和字段均通过 PostgreSQL `COMMENT ON` 保存中文说明。注释只描述通用数据契约，
不得包含真实姓名、微信 ID、聊天正文或凭据。
