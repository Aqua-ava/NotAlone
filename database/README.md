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

联系人身份迁移完成后，继续把微信专属消息字段移出通用消息表：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/004_separate_wechat_message_metadata.sql
```

第四个迁移会保留已有消息，把微信 local/server id、talker、来源时间和原始 JSON 搬到
`wechat_message_metadata`，再从 `message` 删除这些微信专属列。整个搬迁位于一个事务中；
任一步失败都会回滚到迁移前结构和数据。

继续增加来源删除状态和最小删除凭证约束：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/005_source_deletion_state.sql
```

第五个迁移区分 `delete_requested`、`deleting`、`delete_failed` 和 `deleted`。只有文件名、
SHA 和消息数量已经清空且写入删除时间时，数据库才允许状态为 `deleted`；只改状态会被约束拒绝。

继续建立已确认桌面会话的持久化绑定：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/006_conversation_binding.sql
```

第六个迁移保存稳定绑定 UUID、`owner_id + contact_id`、渠道账号范围、会话定位线索、状态和
最近验证时间。定位线索不能使用昵称或聊天正文替代；绑定撤销后，验证适配器不会再返回
`Ready`。迁移只建立表和约束，不读取桌面会话。

迁移仅建立数据结构，不读取 `chat_exports/`，也不导入真实聊天记录。

首个迁移建立旧版 `owner`、`contact`、`source_document` 和 `message`，第三个迁移在空业务
表上把 `contact.id` 改为 NotAlone 内部 UUID，并新增 `channel_identity` 和
`import_confirmation`。微信 `sender_wxid` 保存在渠道身份中，不再充当 `contact.id`；
第四个迁移让 `message` 只保留通用规范字段，原始单行 JSON 和微信 ID 保存在可随消息级联
删除的 `wechat_message_metadata`。同一用户与联系人下，一个微信 `external_local_id` 仍只能
归属一个来源；不同 SHA 文件若包含重叠消息，正式导入会整批回滚，避免同一消息出现两个
权威来源。

来源删除完成后，`source_document` 只保留隔离键、内部来源 ID、来源类型、状态和删除时间。
同一文件再次导入会创建新的来源与确认记录，不恢复旧来源内容。

表和字段均通过 PostgreSQL `COMMENT ON` 保存中文说明。注释只描述通用数据契约，
不得包含真实姓名、微信 ID、聊天正文或凭据。
