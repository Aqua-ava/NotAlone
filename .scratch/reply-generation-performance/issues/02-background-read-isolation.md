# 后台图片与记忆读取隔离

Triage: ready-for-agent
State: claimed

Blocked by: none

## Goal

使用 `SqliteStorage.openReader()` 建立宿主生命周期内的后台只读通道，将图片同步目录查询和记忆管理读取从主 SQLite worker 移出；所有写入继续走主 worker。

## Acceptance

- [x] `SqliteImageSyncCoordinator` 只依赖 `Pick<StorageReader, 'execute'>`，宿主传入隔离 reader。
- [x] `SqliteMemoryManagement.read`／`readHistory` 使用隔离 reader，`prepareTimeline` 和决定写入仍走主存储。
- [x] `backgroundReads` 纳入宿主关闭、排空和错误传播。
- [x] 后台慢读期间前台写入不被串行阻塞。
- [x] 来源、lease、删除和迟到结果保护不回归。
- [x] 最小读写隔离测试和类型检查通过。

## Answer

实现完成（待独立审查）。提交：`39f98fbf3`（实现）、`5443871ad`（审查前风险补充）。

### 实现摘要

- 新增 `backend-ts/src/storage/sqlite/background-reads.ts`：`createBackgroundReads({storage,ownerId})` 复用 `SqliteStorage.openReader` 建立宿主生命周期内只读通道，固定允许 `media.imageSyncTargets`、`media.imageRefreshPending`、`memory.read`、`memory.history`。owner 不一致返回 `background_read_scope_invalid`，其他动作返回 `readonly_action_forbidden`；关闭/失效时在途读取以 `background_read_cancelled` 拒绝，不交付迟到结果；关闭等待在途读取结算，关闭失败保留重试；租约、存储身份或 worker 失效时退役旧读者；主写者删除维护 `VACUUM` 推进 schema 版本后退役旧连接并重建一次，同一退役窗口内被撤销的并发在途读取也自动重试一次，再次失败如实上报。
- `SqliteImageSyncCoordinator` 构造依赖收窄为 `Pick<StorageReader,'execute'>`，目录与 pending 查询经隔离读者；`SqliteMemoryManagement` 构造新增可选 `{reader}`，`read`／`readHistory` 走隔离读者，`prepareTimeline`、`decide`、`importRun`、`publishRun`、`automatic` 仍走主存储。
- 宿主在 owner 解析后创建 `backgroundReads` 并传入图片同步协调器与记忆管理服务；`closeSqliteHostResources` 增加 `backgroundReads`，与 `assistantReads` 同批并行关闭，失败抛 `AggregateError` 并保留共享存储供同一关闭重试。主 worker 仍是唯一写入口，不接受页面传入 SQL、动作名、连接或任意 reader。

### 变更文件

- 新增 `backend-ts/src/storage/sqlite/background-reads.ts`
- 新增 `backend-ts/test/sqlite-background-reads.test.mjs`
- `backend-ts/src/media/sqlite/image-sync.ts`
- `backend-ts/src/memory/sqlite/management/service.ts`
- `backend-ts/src/sqlite-host-plugin.ts`
- `backend-ts/src/storage/sqlite/README.md`
- 补充提交 `5443871ad` 修改 `background-reads.ts`、README 与新增回归
- `.scratch/reply-generation-performance/issues/02-background-read-isolation.md`（State: claimed）

### RED / GREEN 证据

- RED（实现前）：`node --test test/sqlite-background-reads.test.mjs` 失败，`ERR_MODULE_NOT_FOUND .../src/storage/sqlite/background-reads.ts`。
- 旧架构串行基线（一次性诊断，不进入仓库）：在 `test/fixtures/sqlite/readonly-registry.mjs` 合成的唯一主 worker 上先启动长读 `reader.slow`，再执行前台写 `reader.save`，实测写排队 1005.9ms、`slowSettledBeforeWrite:true`、`writeSettledBeforeSlow:false`，即旧实现下前台写被后台长读串行阻塞。
- GREEN：新增测试 9/9 通过，覆盖动作白名单与 owner 约束；可控慢读占住隔离读者期间主存储前台写先结算且主 worker 队列无 `media.imageSyncTargets`；图片同步目录查询与 pending 探测经隔离读者；记忆 `read`／`readHistory` 走隔离读者而 `prepareTimeline`／决定写入走主 worker；关闭排空、迟到结果拒绝与关闭失败重试；租约失效退役重建；维护后 schema 版本变化重建；维护退役窗口内并发读取重试恢复；删除排空读取与独立手录不误删。

### 实际命令与结果

- `cd backend-ts && export PATH=/tmp/notalone-node/bin:$PATH && node --test test/sqlite-background-reads.test.mjs` → 10 pass / 0 fail（补充提交后）。
- `node --test test/sqlite-background-reads.test.mjs test/sqlite-memory-management.test.mjs test/sqlite-image-sync.test.mjs test/sqlite-host-close.test.mjs test/sqlite-readonly.test.mjs`（集成 HEAD `b4a885f01` 之上）→ 62 pass / 0 fail。
- `node --test test/sqlite-background-reads.test.mjs test/sqlite-memory-management.test.mjs test/sqlite-image-sync.test.mjs test/sqlite-host-close.test.mjs test/sqlite-assistant-read.test.mjs test/sqlite-memory-management-pagination.test.mjs test/sqlite-memory-management-http.test.mjs test/sqlite-memory-close.test.mjs test/sqlite-readonly.test.mjs` → 89 pass / 0 fail。
- `node --test test/sqlite-host-launch.test.mjs test/sqlite-shutdown.test.mjs test/sqlite-storage-timing.test.mjs test/sqlite-foreground-isolation.test.mjs test/sqlite-media-host.test.mjs` → 21 pass / 0 fail。
- `node node_modules/typescript/bin/tsc --noEmit` → exit 0。
- `node scripts/check_public_history.mjs --ref HEAD --working-tree` → issues 0。

### 风险与边界

- `backgroundReads` 未注册为删除持有者（本 ticket 的排空要求指宿主关闭）；已验证删除后的读取不复活已删范围、维护后自动重建，但删除 `deletion.compact` 时若恰有后台长读持有读事务，checkpoint 可能 busy 使删除进入既有 blocked／重试路径，而非像主 worker 串行时那样等待。属剩余风险，未扩大 ticket 范围处理。
- 维护后重建为首读一次透明重试；同一退役窗口内被撤销的并发在途读取已在 `5443871ad` 中改为自动重试一次，只有通道显式关闭（宿主退出）才以 `background_read_cancelled` 拒绝；图片同步另有既有事件唤醒重试，记忆页请求由页面重试。
- 新增测试文件由 `test/run-current.mjs` 自动发现（按 `*.test.mjs` 扫描），无需另登记。
- 未运行桌面 App 验收与性能采样，按分工归 Lead／P03；未触碰 `image-sync-actions.ts` 及用户既有桌面文件改动。


### 2026-11-04 删除排空补充

- 消除审查指出的时序缺口：后台通道此前未登记 `ActiveHolders`，读取已取得旧结果后若删除完成，旧结果仍可能最后返回。现新增 `background.readBoundary`，按联系人读取 `data_generation`、owner/self 读取 `read_epoch`，随后以共享 `ActiveHolders` 登记 `background-read:<uuid>`；联系人读取声明 `coversAllSources:true`，纳入来源删除闭包。
- 宿主把与 `DeletionService` 相同的 `deletionHolders` 传给后台通道。删除 fence 会撤销在途读取、退役并等待只读 Worker 关闭；迟到结果以 `background_read_cancelled` 拒绝。边界读取与业务读取共享同一恢复周期，删除后 `VACUUM` 即使先令边界动作触发 `schema_drift`，也只在未撤销时透明重建一次。
- RED：旧实现下新增“后台读取已取得旧结果后删除必须排空且迟到结果不能返回”失败，读取在删除 fence 后仍保持未决，未进入撤销/关闭路径；修复 holder 后该用例通过。随后发现删除完成后的边界 `schema_drift` 不在恢复路径，删除排空回归失败；把边界与业务读取合并到同一重试/释放生命周期后转绿。
- GREEN：`sqlite-background-reads.test.mjs` 11/11；后台读取、候选延迟、Skill loop、host launch、cutover structure 合计 40/40；backend typecheck 通过。删除排空测试确认旧读取被提前以 `background_read_cancelled` 拒绝，删除完成且独立手录不被来源删除误删；删除后读取仍可重建并返回仅剩的合法资料。
- 数据影响：仅增加内存 holder 与只读边界查询，不新增持久字段、不扩大资料范围、不缓存正文；读取仍按 `owner_id + contact_id` 隔离，迟到结果继续拒绝。


### 2026-11-04 self 显示范围删除排空

- Spec Review 发现“我”视图使用 `scopeKind=self`、`contactId=null`，另以 `displayContactId` 过滤当前联系人；旧实现只登记 `coversAllContacts`，来源删除无法匹配该 holder。合成复现可在来源删除完成后返回旧本人记忆正文。
- 修复：`memory.read`／`memory.history` 以 `displayContactId` 对应联系人读取 `data_generation` 并登记 `coversAllSources:true` holder；contact scope 的 contactId 与 displayContactId 不一致时拒绝。没有 `displayContactId` 的全局本人读取不再允许走共享后台通道，返回 `background_read_scope_invalid`。
- RED：新增“我视图按显示联系人排空来源删除并拒绝迟到正文”，旧实现 150ms 内未被删除 fence 撤销，测试失败。GREEN 后该读取提前以 `background_read_cancelled` 拒绝，删除 completed；后台读取 12/12。
- 数据影响：不扩大读取范围；本人视图仍只展示当前显示联系人来源，owner/contact 隔离与删除闭包保持。
