# 20：默认切换 SQLite 与旧业务清理

Triage: ready-for-agent
State: claimed
Type: task
Parent: [SQLite 数据库重建规格](../../sqlite-database-rebuild/spec.md)
Blocked by: [06 清空聊天与明确重读历史](06-clear-and-resync-history.md)；[10 记忆处理控制与恢复](10-memory-processing-controls.md)；[14 官方 Skill 加载接回](14-official-skill-loading.md)；[16 单条媒体保存与清除](16-single-message-media-lifecycle.md)

> 2026-10-29已批准发布，未开始实现。[任务索引与共同约定](../planning.md)。

> 2026-10-29范围修订：13、15、18、19均用户暂缓，不构成本票硬依赖，不通过本票补做。偏好／纠错诊断不启用、不回退旧PG；语音保存转换最小停用；真实媒体关联未认证的入口关闭。已有用户资料不因暂缓删除，原切换清理仅沿已确认授权；必要隔离、删除与活动引用安全检查保留。08记忆修正和12候选回复继续。

## 交付行为

在隔离结构、存储和已承接业务通过验证后，将默认业务入口切换为同一新空SQLite；精确停止旧写入，清理已确认旧业务及应用副本，同时保留模型密钥、原Skill和外部原件。

## 验收条件

- [ ] 切换前完整核对原77表/778字段/215基础FK逻辑目录及115个旧名称事实映射，逐项标明本轮实现、已确认退役或用户暂缓且入口关闭；对本轮实际DDL、索引、CHECK、范围触发器和必要事务验证。数量只是原始查漏基线，不为凑数建暂缓功能空表，不把骨架当完成。
- [ ] 所有仍活跃的PG存储消费者均已改接或按已确认范围退役，覆盖本轮同步、记忆、追踪、文档、回复和Skill；13偏好与15纠错／诊断入口须停用且无旧PG回退，不实施其功能来解除依赖。不得用漏接活跃消费者换取启动成功。
- [ ] 16提供的媒体结构、文件登记、发布/替换、统一删除注册及活动引用复核先通过；17未认证的真实资源入口继续关闭；18和19本轮暂缓，不启用新增语音保存／转换或真实关联能力。通用媒体存储和删除闭包仍需完整，不以文字流程通过就切不完整新库。
- [ ] 先在隔离合成环境完整演练目标识别、停机、清理、失败重试和配置切换；只有精确归属及已确认范围的真实对象才可进入实际清理，未知实例或不可连接不视为可随意drop。
- [ ] 进入维护态，撤销并核验旧App后台、任务、DSH及其他旧writer/活动引用停止；不强杀或接管未知进程，不在未确认停写时启动新旧双写。
- [ ] 新建独立database_id、owner及SQLite账本，不迁旧PG业务/授权/排除/迁移记录，不为本次重置保留旧PG业务备份；切换重试不得再造另一个空库。
- [ ] 切换控制与旧目标清理进度位于不会随目标删除的控制面；不得把唯一恢复凭据留在待drop旧PG或待删SQLite文件内。
- [ ] 按已确认归属清理旧业务库、含内容助手会话、缓存、派生文件和应用持有的旧业务副本，并复核旧媒体和活动句柄；保留模型密钥、原Skill目录及用户/微信外部原件。
- [ ] 空库无Skill业务行不触发孤儿误删或默认全停用；可证启停与未知分别接回官方加载，不能伪造旧审核或授权。
- [ ] 全部必要面核验完成才原子切换配置；目标不完整或旧清理失败继续维护态和原操作，不恢复旧writer，不以异常自动空库掩盖失败。
- [ ] 按本轮范围退役残留手动聊天文件导入/导入新建及旧PG启动路径，不扩大取消未确认功能；相关ADR-101/102、ADR-089/100、ADR-107/108替代条款和保留边界在实施中显式修订，不能由文档发布声称当前已切。
- [ ] 通过正常开发入口复核默认数据库身份、关键业务和关停；记录实际对象归属、清理状态和重要限制但不保存私人数据、凭据或可恢复定位。

## 验证与证据

先完成实际目标DDL/消费者/媒体存储闭包检查及隔离切换故障注入，再验证当前开发入口；结构完整性必须在本票切换前通过，不能推迟到21。真实清理对象的归属与授权不明时保持受阻。

依据[统一数据库设计](../../sqlite-database-rebuild/greenfield-design.md)和父规格实施；历史研究票、骨架或已知合成探针不能标为本票已完成。真实门槛见[定稿验证记录](../../../research/wechat-spec-finalization-validation.md)。

## 范围与执行门禁

本轮只发布任务，绝不执行真实切库、drop、清理、打包或远端操作。App首次使用继续搁置，不承接向导、组件安装、新模型设置、干净机器或发布；本票保留数据库自身必要切换职责。

本轮仅发布，尚未开始实现。`ready-for-agent`表示任务描述可供后续安排，不能据此自动领取、改代码、建业务库、读取微信或发起模型调用；须在用户后续明确要求实现时才开始并将State改为claimed。

后续开发及桌面验收只用`pnpm run dev`，先`dev:status`核验并复用热更新实例；不得自行打包、运行打包版、改发布门禁、push或创建PR。只处理必要的合成或已获准资料，不提交私人聊天、身份、凭据、截图或真实媒体。App首次使用继续搁置，迁移／恢复实验不纳入本轮。

## Comments

2026-10-30 t20-cutover 定稿记录（State/Triage 由 Lead 维护，未改动）

- 分支/工作树：`sqlite-rebuild-20`（独立工作树）；先 from `5fbe770c`，后合入 Lead 指定基线 `15ac355a`（merge f1692624）。提交：6c8c184f（cutover 控制面与演练）、52ab1a6f（旧 PG 启动路径与手动导入退役）、8efbabfd（审计文档与 ADR 修订）、4f782e12（审查阻断修复）、ad44bafa（run-current 对照）、本 Comments 提交。
- 验证入口：`docs/verification/20-sqlite-cutover-and-legacy-cleanup.md`（77/778/215/115 逐项、82 表实际 DDL 与 252 CHECK／92 触发器 body／FK action／索引／视图、37 组 FK 差异、消费者映射、11 项隔离演练、真实归属受阻、12 条验收判定、审查修复复核）。
- 结构：迁移 1..15 未改；`cutover.snapshot` 只读动作；实际 82 表/814 字段；77 表分类 67 实现／9 暂缓入口关闭／1 由 06 来源级排除替代；115 旧名称 0 未分类。
- 消费者：产品三入口运行时 0 个 pg 值导入；4 个遗留文件值导入（含 1 动态）不可达；13/15/18/19 ownership unavailable 并含旧路由 503 行为回归；手动导入与旧 PG 启动路径已退役，managed-postgres/schema-prepare 源文件按裁决保留不可达、发布清单未改。
- 安全/切换：控制面在 `database-cutover/manifest.json`；synthetic 授权仅隔离根允许，真实根必须 confirmed_local；清理完成→建目标→检查→二次停写→原子写配置；失败保持维护态、不恢复旧 writer、不建第二个空库。真实清理对象归属不明，实际清理受阻未执行。
- 验证：锁定 TypeScript 7.0.2 两端 typecheck 0；cutover 相关 24/24；相关后端模块 113/113；桌面启动 16/16；正常开发入口实测默认 SQLite（8 检查 passed、5 页 UI、关停 pids[]、重开同 database_id/owner，隔离根已清理）；run-current 本树 1559 项 vs 15ac355a 基线 1506 项，失败文件集合无新增（非 PG 失败仅 memory-profile 2 项且基线同样存在）；公开检查 0 问题。

2026-10-30 真实清理重评（只读复核，未读 .env/配置内容、未删除任何文件、未执行真实清理）

- 本机独立复核：无 postgres 进程/`/tmp/.s.PGSQL.5432` socket，`/opt/homebrew/var/postgres*`、`/usr/local/var/postgres*`、`~/Library/Application Support/Postgres` 均不存在；`~/.notalone` 仅 270 个用户 Skill 原目录（5.2M），无 backend.info 或其他业务文件；默认 Electron userData 仅 Chromium 级缓存（Cache 598M 等）、wechat-tool 17M、wechat-tool-dev-20261023 12M、desktop-settings.json、backend-launch.json（447B/0600，字段级由 Lead 只读盘点，指向当前开发仓库）、Preferences/Local State，maxdepth 3 无 managed/、state.json、NotAlone 业务 SQLite、assistant-runtime、updates/、runtime-copies/、sqlite-development.json、database-cutover/；`~/Library/Application Support/NotAlone` 为空目录。
- 结论：本机不存在真实旧业务库、含内容助手会话、旧媒体/派生业务副本；仅存 Chromium 缓存与开发工具/开发配置制品，归属本机开发 App，非旧业务数据，按保留边界不删除、不属旧业务清理对象。
- 重评：第 8 条 **N/A（本机无清理对象）+只读证据**；第 12 条保持通过（正常开发入口已复核默认库身份/关键业务/关停，归属与清理状态已记录）。最终 **12/12（11 通过 + 第 8 条 N/A）**，证据见 docs/verification/20-sqlite-cutover-and-legacy-cleanup.md §7/§10。建议 State=resolved。
