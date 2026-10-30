# 旧受管运行时记录（已退役）

> **已退役**：PG/Python 受管运行时链已移除。以下材料仅对应 Git 快照 `a838de83`；其中命令已失效，不适用于当前 SQLite 实现，也不要照此准备或验证运行时。

旧交付曾将 TypeScript 项目、锁定 Node 依赖与 PostgreSQL 16.15 放入受管运行时。当前桌面应用不再使用该运行时；CPython、Psycopg 及其构建／替换工具也已退役。

`component-sources.lock.json`与`attribution-sources.lock.json`保留PG固定官方源码摘要和原始版权通知。Node依赖的原始许可保存在项目的node_modules，Electron和前端通知沿用独立打包资源；微信工具LLDB的内嵌CPython属于独立原生组件，不由本退役删除。

`prepare-runtime.mjs`准备project/postgres布局并逐文件登记；`verify-runtime.mjs`以Node检查迁移、备份恢复和清理。构建／验证命令需显式运行，本次没有执行制品构建、打包、搬动或发行验证。日常只用npm run dev。

旧CPython／Psycopg通知和验证文档是对应旧产物的历史记录，不表示当前默认依赖或当前发行已认证。正式发布仍须单独验证完整DSH／Node及原生依赖通知、签名、公证与真实机器使用。
