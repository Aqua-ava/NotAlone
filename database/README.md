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
