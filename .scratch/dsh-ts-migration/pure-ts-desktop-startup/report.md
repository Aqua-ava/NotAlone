# 纯 TS 桌面启动与数据库准备交付

基点：`a61a21407c9395c462e4e68bfeee4628e7e9b15c`。源码已冻结；精确15个文件及逐项SHA见 [source-manifest.json](source-manifest.json)。根会话统一审查、暂存和提交；本会话未操作 Git index、提交、远端或发布入口。

## 实现范围

- 显式 `NOTALONE_HOST_RUNTIME=typescript` 的 DSH 配置允许缺省 Python；开发项目核验改查 `backend-ts/src/launch.ts` 与正式 profile。旧 runtime 保留原 Python／`command.py` 核验。
- `OwnedBackendProcess` 的合成 OS 子进程已实际读回 HOST 选择与受管寿命路径；不只核对保存配置。受管环境仍限制继承项，资料、本人及模型授权路径保持。
- 普通 DSH 诊断继续只读；纯 TS 待更新及首次受管准备改为 Node CLI，不装配模型、任务或 DSH 遥测。115份应用记录输出按准备操作有界接收，普通诊断仍限4096字节。
- 迁移复用原115份 SQL／checksum、035独立审计基线与实际账本、103旧Skill内容／资源／方法清单转换。迁移 SQL 与本版本账本共事务，动态执行拒绝 SQL 中途提交；不创建替代库、不复制资料、不补写历史成功记录。
- 更新前复用原连接解析、TLS及pgpass（`host-storage.ts`仅导出三个既有帮助函数），检查本机非系统目标、同一迁移锁与其它客户端连接；账本、基线、原始字节损坏时停写。
- 受管 PG 以新窄 TS 监督入口启动同一 postmaster／资料目录。父管道 EOF／父 PID 丢失发起收尾；共享消费者锁未释放时不关闭 PG，取得独占锁后 fast shutdown。本次仅对已核验 Darwin 启用原文件的内核锁，其他平台明确拒绝。
- 寿命文件归属或锁无法核验时保留资料服务，等待其真实退出，不越过未知消费者强停。此情形仍需根会话决定后续恢复；不能宣称已确认退出。

## 稳定接口

```ts
prepareDatabaseSchema({ databaseUrl, migrationsDirectory, environment? })
  // Promise<{ code: string; applied: string[] }>
acquireManagedDatabaseLease(path)
  // Promise<() => Promise<void>>，重复释放安全
```

schema API不创建数据库；调用者须关闭自身业务连接后调用。`ready` 时只读返回；仅 `migration_pending` 进入更新。CLI：`node --experimental-strip-types backend-ts/src/schema-prepare-cli.ts --migrations <原迁移目录>`，加 `--prepare` 才写入。只输出固定 code／迁移文件名，不输出连接串、模型凭据或正文。后台协作者已复用同一 API 准备合成启动库并负责接入 host 的共享锁。

## 验证与真实范围

- TDD 最小片：配置、空库、103内容转换、CLI、桌面诊断、共享锁、PG监督及首次受管装配均先失败再通过；错误命令路径与测试夹具失误不冒充业务 RED。
- 后端相关组：26/26通过，0失败、0跳过；包括新增schema／寿命／PG用例和既有HostStorage回归。
- 桌面相关组：26/26通过，0失败、0跳过；包括新增配置／诊断／空受管库与既有启动保护、受管退出、设置回归。两端 `tsc --noEmit` 通过。实际命令及结果见 [verification-summary.json](verification-summary.json)。未跑全后端或全桌面。
- schema 验证涵盖空库115迁移、114原库增量保留身份、035基线从036记账、锁与其它连接拒绝、未知／改变账本、PGOPTIONS拒绝、SQL事务逃逸回滚、损坏103正文完整保留；102旧Skill正文、资源、方法及原警告迁移后可读。
- 隔离 Python 比较器与 TS 新库的全部公开列、约束、索引及函数定义一致；Python 仅用于隔离比较器与旧回归夹具，不进入纯 TS 产品子进程。
- 真实隔离 PG16 的寿命测试验证父管道关闭后共享锁仍保护消费者，释放后 PG正常退出；Node锁与旧Python flock互操作、缺失／不可写／宽权限／链接拒绝均通过。
- 首次受管装配从空隔离集群实际建库、执行115迁移并读回就绪／无本人，`PATH=/usr/bin:/bin`；Python组件为一调用即失败的标记程序，未被触发。合成组件包装安装于本机的PG16；没有制作发布组件或App包。
- 一次新增 OS 环境用例遗漏独立握手路径，触及默认握手后被 `backend_already_running` 拒绝，未启动／重启／修改真实后台、未输出握手内容。已改为显式测试 info／env 路径，最小及相关组通过；不声称全程零默认路径读取。原失败保留在本记录及会话工具记录。
- 未读取业务库或真实 `.env`，未调用供应商、启动／操作真实 App／微信、发送消息或改变授权。根原先已有三个用户文件未修改。

## 数据、清理与剩余边界

只创建随机合成数据库及私有临时集群／目录。清理检查为自有测试库0、相关自有进程0、工作临时目录0；最终原始日志在仓库外0700目录／0600文件，摘要与日志SHA可核验。旧Skill转换失败可能像原Python路径一样保留已验证的不可变文件，旧表及正文仍在，可安全重试；没有清理未知或真实资料。

旧源码与兼容分支完整保留，25／26状态未改。受管组件完整性清单、准备／发布脚本仍包含旧Python文件库存要求，本轮未修改；取消该库存／构建依赖归26，不能用本次合成装配证明独立机器发布可用。纯TS模式只证明本报告覆盖的启动／准备边界；整产品纯TS、实际App／微信、模型质量和最终性能仍由根验收。

## 给根的启动错误记录

现有显示文案未改，见 `desktop/src/renderer/StartupSettings.tsx:170`、`:178`、`:188`、`:190`、`:192`–`:195`。固定code和恢复含义：`runtime_components_unavailable`＝组件缺失或校验失败／补齐完整组件；`baseline_missing`＝先核验接管方案；`migration_history_mismatch`＝核对原SQL与账本、不补假成功记录；`database_writers_present`＝正常退出同库程序后重查；`database_update_requires_local`＝核对原本机连接；`migration_busy`＝等待另一次更新结束；`migration_failed`＝核对权限和迁移文件后重试，保留已完成版本。用户可见的macOS错误记录由根统一补写。

## 官方依据

DSH锁定 `0.2.1-rc.2`／`687f282e8625c6b8d11ff58211a90524be2e4317`；[profile源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/profile.ts)说明正式profile组成；现有launcher继续使用它，本切片无新增DSH私有接口。[pg事务](https://node-postgres.com/features/transactions)要求同一client显式BEGIN/COMMIT/ROLLBACK；锁定pg8.16.3。[Apple open(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/open.2.html)确认O_SHLOCK/O_EXLOCK具flock语义；本机Darwin SDK `sys/fcntl.h:119–120`核验0x10/0x20；[Node24.19 fs](https://nodejs.org/download/release/v24.19.0/docs/api/fs.html)支持数值flags。官方约定与上述合成运行证据分别记录。
