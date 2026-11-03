# SQLite 存储扩展合同

SQLite 是当前默认业务存储。正式装配使用 `sqlite-host-plugin.ts`，迁移与具名动作由 `registry.ts` 聚合；切换、重置和旧资料清理由独立控制面负责，见[切换验证记录](../../../../docs/verification/20-sqlite-cutover-and-legacy-cleanup.md)。本文说明底层存储合同，不代表所有业务能力均已开放。

## 实例与连接

`client.ts` 导出 `SqliteStorage.open({userData,intent,role,expectedDatabaseId?})`。`userData` 必须为配置提供的真实绝对目录；所有数据库文件固定在 `managed/sqlite/notalone.sqlite`，不接受独立 SQL 路径。`create` 排他创建；`open` 必须带预期 `databaseId`，文件缺失或身份、权限、版本、完整性不符均保留现场并失败，不新建。`reset` 明确返回 `reset_requires_cutover`，不承担 20 的重置授权及清理流程。数据库角色 `business/test` 不授权破坏操作。

`status` 包含 `databaseId,runtimeId,epoch:bigint,schemaVersion,sqliteVersion,role`。每次成功打开推进持久 `epoch` 并更换 `runtimeId`；`StorageLease` 为前三个字段。重开撤销旧运行租约；业务自己的读取、联系人、来源、任务代次仍须在具名动作内分别复验，不可用该租约代替业务资格。

每个句柄仅拥有一个 Worker、一条连接。`execute(name,input,lease=status)` 通过消息串行调用；`check()` 分别执行 `integrity_check` 和 `foreign_key_check`；`close()` 排空此前请求并关闭连接。Worker 退出、错误或超时后全部未决请求失败，不自动重开、不自动重放，业务须核对幂等记录再人工继续。

按 [ADR-159](../../../../architecture/adr/159-foreground-read-channel-isolation.md)，`openReader(actionNames)` 创建独立 Worker 的只读附属句柄，只接受可信装配声明且注册为 `read` 的具名动作。它沿用主句柄租约，不执行初始化、迁移或运行身份更新；每次短读结束后在事务外复验租约。主句柄故障、关闭或重开撤销旧读者。前台只声明 `identity.foregroundSnapshot`，由联系人元数据持有者负责删除排空及关闭，不与后台长查询共享执行队列。按 [ADR-160](../../../../architecture/adr/160-assistant-read-and-skill-worker-isolation.md)，助手目录、正文及候选回看使用另一附属读者，短读前后复核业务范围并参与删除排空；生成及最终提交继续使用主写者。

`timingDiagnostic` 提供未决／排队数量、当前动作及最近 60 秒最慢的至多 3 项摘要；内部至多保留 64 项。排队时间取主线程投递至 Worker 实际开始，执行时间取 Worker 开始至完成，保持原执行超时预算。摘要仅含具名动作、毫秒和成功状态，不记录输入或 SQL；通过现有运行状态接口返回，不增设读取资料或执行动作的入口。

## 02 / 05 / 14 的扩展位置

在 `registry.ts` 导入本票模块，并向 `registry.migrations` 追加连续 `{version,sql}`；已发布 SQL 不修改。`schema_migration(version,checksum,applied_at)` 使用 SHA-256，所有待升级 DDL、账本与 `user_version` 在同一事务提交。未知高版本、checksum 或结构摘要漂移拒绝打开。初始版本 1 建立 `database_instance`、`schema_migration`；后续领域 DDL 按 `registry.ts` 的连续迁移追加，当前版本以注册表为准。

向 `registry.actions` 注册 `{name,mode:'read'|'write'|'maintenance',retryBusy,execute(tx,input,lease)}`，名称例如 `capture.commitPage`、`deletion.plan`、`skills.registerPackage`。动作是受版本管理的代码，不接受 renderer、HTTP 或 Tool 提供 SQL、回调或模块地址。`registryModule` 只供受信任构建装配和隔离测试加载扩展注册模块，不是产品配置或 RPC 字段。

`execute` 必须同步返回，read/write 只使用 `StorageTransaction.run/get/all(sql,values?)`；maintenance 只获得 `StorageMaintenance.checkpoint/vacuum/check`，没有领域 SQL 能力。不等待 CLI、模型、DSH、网络或文件 I/O；外部步骤先在事务外执行，再用固定输入与幂等键提交并复验全部资格。事务接口退出即失效，Promise 返回在 read/write 中会回滚并拒绝。读动作由 SQLite `query_only` 禁写。主键、复合 FK、CHECK、NULL 分支、唯一性及资格必须由对应业务模块共同验证；本票不代替 77 表验收。

所有 INTEGER 读取为 `bigint`，跨 JSON 边界显式转十进制字符串或经范围检查的安全整数；不能直接转 Number 截断；绑定时拒绝超安全范围的整数 Number 及非有限数值，防止写入已失真的身份或计数。UTC 时间用毫秒，未知值保持 NULL。参数使用 node:sqlite 的绑定值数组，不插值业务输入。具名写事务采用 `BEGIN IMMEDIATE`，busy 每次最多等 100ms；仅 `retryBusy:true` 的纯数据库幂等动作在整事务回滚后最多重试两次，不重发外部请求。结果在 COMMIT 前验证可克隆。

## 清理与故障

实施05新增[统一删除合同](deletion/README.md)。`deletionMigration(version)`与具名动作独立在`deletion/`；领域通过真实授权、来源闭包及文件清理回调注册。当前显式SQLite宿主注册身份及Skill元数据域的联系人/账号范围；未装来源、历史清空、讨论或媒体处理器时拒绝，不把空计划判成功。公共maintenance新增只读`inspect()`，回传空闲页、内存临时存储、secure_delete、WAL/SHM/journal大小及未知辅助文件数，不能替代领域排空证明。

所有连接启用 FK；WAL、FULL 同步、secure_delete、内存临时存储、1000页自动checkpoint及零 journal_size_limit。普通关闭不把 DELETE 宣称为存储面擦除。05 通过 `mode:maintenance` 注册具名维护动作；该模式不包事务、不自动重试，执行前后及每步复验实例租约；没有整体原子或回滚保证，Promise 拒绝不能撤销先前已完成维护，不得用于领域业务提交。调用者须先排空领域写者及长读者，独立核验 checkpoint、空闲页、必要 VACUUM、WAL/SHM 与受管文件及活动引用；失败不能 completed。01 不提供任意维护 SQL Tool，也不自动 VACUUM 或清库。维护结果不等于删除完成；05 必须核验checkpoint busy结果与全部清理面。

迁移聚合由集成负责人串行确认顺序和连续版本；02/05/14各写独立模块，不并发修改已发布版本，不根据导入排序动态重编号。独立工作树的合成库不带入集成验收；集成后始终从同一实例按已发布链追加升级。

固定故障以 `StorageFailure.code` 传递，不传异常原文或文件路径。约束失败或事务失败回滚；`storage_busy` 不证明外部动作未发送。进程崩溃时 SQLite 回滚未提交升级，重开先执行完整性及 FK 检查，再核验版本与身份并撤销旧运行租约。创建中断留下的未初始化文件须人工诊断，不自动删除。

## API 依据

实际安装锁定 `@types/node 26.6.4`，实现只使用 Node 24 已存在的 `DatabaseSync`、`prepare/run/all`、`setReadBigInts`、`isTransaction`、`close` 与 `timeout`。已读取官方 Node 24 SQLite 文档（https://nodejs.org/docs/latest-v24.x/api/sqlite.html），并以当前 Node v24.19.0 和实际开发 Electron 的 Node 分别验证；确切 Electron/SQLite 版本及验收结果写入任务 Answer。未修改 DSH、官方 profile 或模型接口。
