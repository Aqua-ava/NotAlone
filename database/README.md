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

迁移仅建立数据结构，不读取 `chat_exports/`，也不导入真实聊天记录。

首个迁移建立 `owner`、`contact`、`source_document` 和 `message`。微信 JSONL
导入时，`contact.id` 取对方的 `sender_wxid`，`contact.display_name` 取对方的
`sender`。`message` 同时保留规范化字段和原始单行 JSON 的 `raw_payload`。

表和字段均通过 PostgreSQL `COMMENT ON` 保存中文说明。注释只描述通用数据契约，
不得包含真实姓名、微信 ID、聊天正文或凭据。
