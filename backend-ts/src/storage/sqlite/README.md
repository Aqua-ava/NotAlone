# SQLite 存储扩展合同

产品合同以[数据与身份](../../../../architecture/current/domain-data.md)、[清理完成条件](../../../../architecture/current/privacy-deletion.md)为准；本页只保留本模块的接口、装配和故障处理。

SQLite 是当前默认业务存储。正式装配使用 `sqlite-host-plugin.ts`，迁移与具名动作由 `registry.ts` 聚合；切换、重置和旧资料清理由独立控制面负责，见[切换验证记录](../../../../docs/verification/20-sqlite-cutover-and-legacy-cleanup.md)。本文说明底层存储合同，不代表所有业务能力均已开放。

## 实例与连接

`client.ts` 导出 `SqliteStorage.open({userData,intent,role,expectedDatabaseId?})`。`userData` 必须为配置提供的真实绝对目录；所有数据库文件固定在 `managed/sqlite/notalone.sqlite`，不接受独立 SQL 路径。`create` 排他创建；`open` 必须带预期 `databaseId`，文件缺失或身份、权限、版本、完整性不符均保留现场并失败，不新建。`reset` 明确返回 `reset_requires_cutover`，不承担 20 的重置授权及清理流程。数据库角色 `business/test` 不授权破坏操作。

`status` 包含 `databaseId,runtimeId,epoch:bigint,schemaVersion,sqliteVersion,role`。每次成功打开推进持久 `epoch` 并更换 `runtimeId`；`StorageLease` 为前三个字段。重开撤销旧运行租约；业务自己的读取、联系人、来源、任务代次仍须在具名动作内分别复验，不可用该租约代替业务资格。

`verifyIdentity()` 同步检查句柄可用性及受控文件元数据，供连接状态快速拒绝文件被替换、关闭或 Worker 故障；不执行 SQL、不重复全库扫描，也不替代正式打开与业务动作中的实例租约、本人及范围复验。

每个句柄仅拥有一个 Worker、一条连接。`execute(name,input,lease=status)` 通过消息串行调用；`check()` 分别执行 `integrity_check` 和 `foreign_key_check`；`close()` 排空此前请求并关闭连接。Worker 退出、错误或超时后全部未决请求失败，不自动重开、不自动重放，业务须核对幂等记录再人工继续。

按 [ADR-159](../../../../architecture/adr/159-foreground-read-channel-isolation.md)，`openReader(actionNames)` 创建独立 Worker 的只读附属句柄，只接受可信装配声明且注册为 `read` 的具名动作。它沿用主句柄租约，不执行初始化、迁移或运行身份更新；每次短读结束后在事务外复验租约。主句柄故障、关闭或重开撤销旧读者。前台只声明 `identity.foregroundSnapshot`，由联系人元数据持有者负责删除排空及关闭，不与后台长查询共享执行队列。按 [ADR-160](../../../../architecture/adr/160-assistant-read-and-skill-worker-isolation.md)，助手目录、正文及候选回看使用另一附属读者，短读前后复核业务范围并参与删除排空；生成及最终提交继续使用主写者。

宿主另用 `background-reads.ts` 装配一个生命周期内只读通道，仅允许 `media.imageSyncTargets`、`media.imageRefreshPending`、`memory.read`、`memory.history`；图片同步目录查询和记忆管理列表读取经该通道执行，时间线准备、决定写入及其他写动作仍走主 worker。该通道由宿主关闭流程与助手读者同批排空，关闭失败保留共享存储供同一关闭重试；页面、Tool 和测试替身不能传入 SQL、动作名、连接或任意 reader。每次读取先取得 `owner.read_epoch` 或 `contact.data_generation` 删除边界，再以宿主共享 `ActiveHolders` 登记联系人/账号范围副本；“我”视图按 `displayContactId` 使用该联系人的来源边界，未提供显示联系人的全局本人后台读取直接拒绝；删除 fence 会撤销在途读取并等待读者实际关闭，迟到结果不得返回。主写者完成删除维护且 `VACUUM` 推进 schema 版本时，边界或业务读取触发的旧读者结果会被拒绝并退役，整次读取重建一次后继续；同一退役窗口内被撤销的并发在途读取也自动重试一次，只有通道显式关闭或删除撤销才以 `background_read_cancelled` 拒绝。

`timingDiagnostic` 提供未决／排队数量、当前动作及最近 60 秒最慢的至多 3 项摘要；内部至多保留 64 项。排队时间取主线程投递至 Worker 实际开始，执行时间取 Worker 开始至完成，保持原执行超时预算。摘要仅含具名动作、毫秒和成功状态，不记录输入或 SQL；通过现有运行状态接口返回，不增设读取资料或执行动作的入口。

## 领域扩展位置

在 `registry.ts` 导入领域模块，并向 `registry.migrations` 追加连续 `{version,sql}`；已发布 SQL 不修改。`schema_migration(version,checksum,applied_at)` 使用 SHA-256，所有待升级 DDL、账本与 `user_version` 在同一事务提交。未知高版本、checksum 或结构摘要漂移拒绝打开。初始版本 1 建立 `database_instance`、`schema_migration`；后续领域 DDL 按 `registry.ts` 的连续迁移追加，当前版本以注册表为准。

向 `registry.actions` 注册 `{name,mode:'read'|'write'|'maintenance',retryBusy,execute(tx,input,lease)}`，名称例如 `capture.commitPage`、`deletion.plan`、`skills.list`。动作是受版本管理的代码，不接受 renderer、HTTP 或 Tool 提供 SQL、回调或模块地址。`registryModule` 只供受信任构建装配和隔离测试加载扩展注册模块，不是产品配置或 RPC 字段。

`execute` 必须同步返回，read/write 只使用 `StorageTransaction.run/get/all(sql,values?)`；maintenance 只获得 `StorageMaintenance.checkpoint/vacuum/check`，没有领域 SQL 能力。不等待 CLI、模型、DSH、网络或文件 I/O；外部步骤先在事务外执行，再用固定输入与幂等键提交并复验全部资格。事务接口退出即失效，Promise 返回在 read/write 中会回滚并拒绝。读动作由 SQLite `query_only` 禁写。主键、复合 FK、CHECK、NULL 分支、唯一性及资格必须由对应业务模块共同验证。

所有 INTEGER 读取为 `bigint`，跨 JSON 边界显式转十进制字符串或经范围检查的安全整数；不能直接转 Number 截断；绑定时拒绝超安全范围的整数 Number 及非有限数值，防止写入已失真的身份或计数。UTC 时间用毫秒，未知值保持 NULL。参数使用 node:sqlite 的绑定值数组，不插值业务输入。具名写事务采用 `BEGIN IMMEDIATE`，busy 每次最多等 100ms；仅 `retryBusy:true` 的纯数据库幂等动作在整事务回滚后最多重试两次，不重发外部请求。结果在 COMMIT 前验证可克隆。

## 清理与故障

[统一删除模块](deletion/README.md)提供 `deletionMigration(version)` 与具名动作；领域注册真实授权、来源闭包及文件清理回调。正常 registry 已组合身份、历史、媒体、记忆、文档、回复和 Skill 元数据；任何 requiredDomain 缺失都拒绝，不把空计划判成功。`maintenance.inspect()` 回传空闲页、内存临时存储、secure_delete、WAL／SHM／journal 大小及未知辅助文件数，不能替代领域排空证明。

所有连接启用 FK；WAL、FULL 同步、secure_delete、内存临时存储、1000页自动checkpoint及零 journal_size_limit。普通关闭不把 DELETE 宣称为存储面擦除。统一删除通过 `mode:maintenance` 注册具名维护动作；该模式不包事务、不自动重试，执行前后及每步复验实例租约；没有整体原子或回滚保证，Promise 拒绝不能撤销先前已完成维护，不得用于领域业务提交。调用者须先排空领域写者及长读者，独立核验 checkpoint、空闲页、必要 VACUUM、WAL/SHM 与受管文件及活动引用；失败不能 completed。01 不提供任意维护 SQL Tool，也不自动 VACUUM 或清库。维护结果不等于删除完成；05 必须核验checkpoint busy结果与全部清理面。

领域迁移在公共 registry 串行确定连续版本。各模块只追加独立迁移，不并发改写已发布 SQL，不按导入排序动态重编号；升级始终从原实例沿已发布链追加。隔离合成库的结果不能替代用户实例迁移证据。

固定故障以 `StorageFailure.code` 传递，不传异常原文或文件路径。约束失败或事务失败回滚；`storage_busy` 不证明外部动作未发送。进程崩溃时 SQLite 回滚未提交升级，重开先核验身份、结构和迁移账本，再在同一写锁快照中完成完整性及 FK 检查后才升级或更新运行租约；实际升级保留前后完整性检查。创建中断留下的未初始化文件须人工诊断，不自动删除。

## API 依据

实现使用 Node 24 的 `DatabaseSync`、`prepare/run/all`、`setReadBigInts`、`isTransaction`、`close` 与 `timeout`。接口变更须核对实际 Node／Electron、锁定类型及安装制品；实现说明与历史运行结果分别记录，具体查证步骤见[工程工作流](../../../../docs/agents/engineering.md)。

阶段实现和旧验收记录已移至[开发历史](../../../../docs/history/backend-development-history.md)；历史数字不表示当前版本通过。
