# 01：SQLite 基础与生命周期

Triage: ready-for-agent
State: resolved
Type: task
Parent: [SQLite 数据库重建规格](../../sqlite-database-rebuild/spec.md)
Blocked by: none（没有前置任务）

> 2026-10-29已批准发布，未开始实现。[任务索引与共同约定](../planning.md)。

## 交付行为

通过既有开发入口在隔离目录使用受控SQLite：创建可信初始实例、显示真实就绪或故障状态，并在重开和升级后保留同一实例。提供业务逐票加入结构和具名短事务的底座；本票不切换默认业务库，也不把开库成功当作完整产品可用。

## 验收条件

- [x] 首次创建、普通打开与明确重置分别判断；新库生成独立实例身份和SQLite版本账本，不复制旧PG业务、授权、排除或迁移账本。
- [x] 业务路径来自受控配置根并核验文件/目录身份、权限、符号链接与预期database_id；目录0700、文件0600；不从工作目录猜业务库。
- [x] 采用已核验的node:sqlite与专用存储Worker，具名短事务串行执行；所有连接启用外键，WAL、同步和清理策略按统一设计设置，不伪造pg兼容池或开放任意SQL工具。
- [x] 结构变化与迁移记录同事务提交，重复打开不重放已成功版本；中断可核验后继续，迁移漂移、未知高版本、损坏或实例不符时保留现场并停止业务写入，不另造空库。
- [x] 精确整数、空值分支、唯一性和复合外键分别验证；integrity_check与foreign_key_check分别通过，不能以其中一项代替另一项。
- [x] 短写事务不等待CLI、模型或文件I/O；有界busy处置只重试可幂等数据库动作，不重发外部请求；Worker失败和旧租约迟到写入明确拒绝。
- [x] 通过正常启动/诊断边界和可见状态验收创建、重开、升级中断及拒绝损坏库；使用独立临时根和合成资料，不触碰用户业务库。
- [x] 为后续业务票提供同一实例的增量结构与事务接入合同，尚未完成的业务能力保持不可用；全部目标结构和消费者完整性由20切换前复核，不在本票冒称77表产品验收完成。
- [x] 实施时明确修订ADR-101/102中本票涉及的PG底座条款并更新相关入口，保留DSH官方机制、用户模型凭据、原Skill目录和外部原文件。

## 验证与证据

先验证临时库单一开库/事务失败用例，再扩大到升级、Worker和两连接WAL等相关检查；观察实际热更新入口的就绪与故障状态。已有SQLite合成探针可作为机制先例，不能代替本票实际代码和DDL验证。

依据[统一数据库设计](../../sqlite-database-rebuild/greenfield-design.md)和父规格实施；历史研究票、骨架或已知合成探针不能标为本票已完成。真实门槛见[定稿验证记录](../../../research/wechat-spec-finalization-validation.md)。

## 范围与执行门禁

不实现首用向导、组件准备、模型设置或独立安装流程。正式切换与旧库清理由20执行；当前原PG不可连接不是创建、接管或清理未知PG实例的理由。

本轮仅发布，尚未开始实现。`ready-for-agent`表示任务描述可供后续安排，不能据此自动领取、改代码、建业务库、读取微信或发起模型调用；须在用户后续明确要求实现时才开始并将State改为claimed。

后续开发及桌面验收只用`pnpm run dev`，先`dev:status`核验并复用热更新实例；不得自行打包、运行打包版、改发布门禁、push或创建PR。只处理必要的合成或已获准资料，不提交私人聊天、身份、凭据、截图或真实媒体。App首次使用继续搁置，迁移／恢复实验不纳入本轮。


## Answer

2026-10-29 完成实施 01；默认 PG 业务未切换，未处理其他实施票。

- `backend-ts/src/storage/sqlite/` 提供 `SqliteStorage.open/execute/check/close`、受控目录/文件身份核验、独立 Worker、实例运行身份和持久 epoch。create 排他创建；open 必须核预期 database_id；reset 明确拒绝并由 20 承接切换及清理，不自动清库。
- 初始版本只含 database_instance 与 schema_migration 两张工程元数据表；DDL、SHA-256 账本、user_version、结构摘要和运行代次同事务提交。开库在写锁内再次核验实例/结构/版本。未知高版本、损坏、漂移与旧租约明确拒绝。
- 具名 read/write 动作同步执行，整数精确读取为 bigint，拒绝不安全整数 Number；NULL、唯一性及跨 owner/contact 复合 FK 以合成扩展验证。每次 busy 等待 100ms，显式可幂等的纯数据库动作最多再试两次，Worker 故障不自动重放外部请求。
- `maintenance` 仅提供 checkpoint/vacuum/check，事务外同步执行、逐步核验身份与租约、不自动重试、无整体回滚保证。05 仍须排空领域写者并核验每一清理面，不能用此结果冒称删除完成。
- 正常开发启动通过显式隔离配置显示 SQLite 就绪或固定故障状态，并阻止 PG/DSH/未完成业务启动。创建成功固化 open+预期实例；普通产品启动不启用此开发诊断。dev:status 支持核验相同独立 userData。
- 新增 ADR-109，明确局部替代 ADR-101/102 的 PG 底座目标并补回链、现行入口；保留 DSH 官方机制、用户凭据、Skill 原目录及外部原文件。

实际验证命令与结果：

1. `cd backend-ts && node --test test/sqlite-storage.test.mjs`：10/10；`pnpm typecheck`：通过。运行时 Node 24.19.0 / SQLite 3.53.3。首个 red 为模块缺失，精度反例 red 后增加绑定校验，最终全部 green。
2. `cd backend-ts && ELECTRON_RUN_AS_NODE=1 ../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test test/sqlite-storage.test.mjs`：10/10。实际 Electron 44.7.0 / Node 24.21.0 / SQLite 3.53.4。
3. `cd desktop && node --test tests/sqlite-development.test.mjs tests/startup-schema-guard.test.mjs tests/diagnostic-export.test.mjs tests/development-policy.test.mjs`：25/25；`pnpm typecheck`：通过。`node --check desktop/scripts/development-status.mjs` 与 `git diff --check`：通过。
4. 正常 `pnpm run dev --user-data-dir <独立合成根>`，使用 Computer Use 操作实际 App；dev:status 带相同根核验了 --notalone-dev 宿主及存活监督器。创建后显示“SQLite 底座已就绪，业务功能尚未切换”，结构版本1、SQLite3.53.4；界面重新检查和监督器安全热重启保持同一实例。人工损坏合成库后显示 storage_invalid，字节保留未替换；升级写入产生超过500KB WAL后终止自有合成升级进程，正常界面重新检查恢复同一实例版本1。独立单测同时核对无成功升级账本、integrity与FK通过。创建中断后再次create显示storage_already_exists，未误造空库。
5. 两连接 WAL 读取、busy 有界与主线程心跳、原子回滚、异步事务拒绝、Worker 异常、旧租约、文件换身份/权限/符号链接、迁移失败/重复打开/checksum/高版本/结构漂移均由上述10项覆盖；另注入外键孤儿，明确验证 integrity_check 仍ok而 foreign_key_check 导致打开失败。
6. code-review：Standards 无明确问题（桌面作者参与该轴，未参与存储实现）；Spec 独立审查发现的事务外维护合同和写锁复核两项均修复，最终增量及桌面独立复核无剩余问题。仅跑本票及受影响模块，未机械执行全量或连接未知PG。

数据影响与限制：仅创建、破坏及恢复本轮独立临时根中的合成 SQLite，不读取用户业务库/微信、不调用模型、不外发消息、不改私人配置。没有77表/领域消费者、真实微信、实际删除闭包或默认切换的验收结论；这些由后续票及20/21负责。所有维护步骤的领域排空和删除完成证明留给05；本票没有自动备份、加密或SSD法证擦除保证。

下游合同以 `backend-ts/src/storage/sqlite/README.md` 为准；02/05/14各加独立迁移与动作模块，registry聚合与连续版本由集成负责人串行确认，已发布SQL及编号不可重写，独立测试库不带入集成。实例租约只防旧运行写入，不替代联系人、授权、来源和任务代次。桌面使用结束后通过菜单正常退出，未重启主仓旧实例；端侧进程、临时目录和清理结果在本会话回报，票内不存可恢复定位。

本地提交及提交后公开历史检查结果见本会话最终回报；无push、远端分支或PR。
