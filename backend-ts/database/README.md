# PostgreSQL 历史 SQL

本目录的 `migrations/` 保存旧 PostgreSQL 结构及升级脚本，仅用于核对历史设计。当前后台使用 SQLite；启动不加载这些 SQL，也不安装或连接 PostgreSQL。当前迁移由 [`src/storage/sqlite/registry.ts`](../src/storage/sqlite/registry.ts) 注册，连接与事务合同见 [SQLite 存储说明](../src/storage/sqlite/README.md)。

旧 schema 检查 CLI、PostgreSQL 宿主、安装器和相关测试已从当前工作树退役；最后保留它们的固定提交为 `a838de83c4825ae0c219cf6945ddc6cda4382273`。这些 SQL 不能作为当前 SQLite 的初始化、迁移或恢复入口。

历史调查需要在独立工作树恢复相应提交及其锁定依赖，按[历史测试说明](../test/HISTORICAL.md)核对范围。不要把旧命令指向用户现有资料，也不要将历史测试结果计作当前版本通过。旧库的来源、归属与删除仍受原有授权约束；源码退役不代表已删除本机数据库。
