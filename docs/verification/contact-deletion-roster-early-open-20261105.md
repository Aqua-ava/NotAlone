# 联系人删除名单服务提前重开（2026-11-05）

## 背景与目标

桌面端删除联系人时会闪出「联系人目录读取失败」「联系人同步状态读取失败…当前不能确认授权范围」。第一步已在桌面端停掉无关读取并保留旧状态；本步处理后端：原实现只在 owner 仍 active 且该 owner 全部删除操作 completed 后，才允许重建名单服务，导致联系人删除的「封禁→清理→压缩→核验」全过程中目录、持久绑定与同步状态都返回 `identity_closed` 或存储排队失败。

目标是把名单服务关闭窗口从整个删除任务缩短到压缩阶段，同时保持身份写入关闭与删除闭包不变。

## 本机实测依据

在真实库的隔离副本上测量（原库只读，副本测完删除；未在真实 App 删除真实联系人）：

- 库 1,790,943,232 字节，page_size 4096、437,242 页，active 联系人 281/288；
- 最近三次真实联系人删除总耗时 43.0 / 74.7 / 121.1 秒；其中 plan→seal（封禁、排空读者、逐目标清理）约 21.4 / 45.9 / 90.9 秒，compact+verify（checkpoint、VACUUM、全库校验）约 21.6 / 28.8 / 30.3 秒；
- 副本上 checkpoint 前 0.0ms、VACUUM 13.4s、VACUUM 后 checkpoint 109ms、`integrity_check` 5.4s、`foreign_key_check` 0.74s，compact 合计约 19.7s；
- VACUUM 期间独立的只读连接可正常执行只读查询（约 2ms，无 SQLITE_BUSY）；但联系人服务走主存储 Worker，压缩动作在执行期间独占 Worker，HTTP 读取会排在压缩之后，桌面默认 8s 超时仍会失败。

结论：提前重开可以覆盖封禁、清理与排空读者阶段（21–91 秒），不能消除 compact 的 20–30 秒排队；桌面端仍需在压缩窗口静默失败并重试。

## 本次改动

- `deletion.metadataAvailable` 保持严格语义：owner active 且没有任何未完成 contact/account 删除。仅保留给仍要求完全结束的调用方与兼容测试。
- 新增 `deletion.metadataAdmission`（只读）：
  - `available`：owner active、无未完成 account 删除，且每个未完成 contact 删除对应的 contact 已处于 `deleting`/`deleted`（plan 事务已封禁、目录/绑定/资格/前台快照都按 active 截断）；尚未封禁或缺失联系人的手写任务仍关闭；
  - `writable`：严格条件，任何未完成 contact/account 删除期间为 false；
  - `admittedOperations`：已隐藏联系人的未完成 contact 删除操作 ID，供名单读者登记准入。
- `ActiveHolders`：新增 `admittedDeletionIds`。只有可信的 `ContactMetadataLifetime` 登记；匹配跳过“对这些操作已准入的 `coversAllContacts` 读者”，显式 key、scopeKeys、账户、来源与 contact_history 闭包保持不变，未声明准入的旧读者仍被 drain 关闭。
- `ContactMetadataLifetime`：
  - 初始化与重建使用 admission；联系人删除封禁后可只读重建，读者只查询活跃联系人，不进入该删除操作的 drain/verify/sealTargets 闭包；
  - early-open 期间拒绝身份写入（非 GET）与 `GET /api/sync/cli-sessions`（可能把已删联系人重新列为候选的名单预览），返回既有 409 `identity_closed`；普通 GET（目录、已保存绑定、同步状态、头像等）可读；
  - 账户删除、缺失联系人或尚未封禁的任务继续关闭；普通读取在名单已打开时不再逐次访问主 Worker，保持前台专用读者不被后台 SQL 阻塞；
  - 释放改为“实际 close 完成后才标记可重建”，close 失败保留状态让 holder drain 重试；
  - 早开服务跨过 compact 后若前台 reader 因 schema 版本推进失效，重置并重试一次。
- 隐私规格与模块说明同步更新：`architecture/current/privacy-deletion.md` 的「删除范围与完成条件」「最小验证清单」、`backend-ts/src/storage/sqlite/deletion/README.md`、`backend-ts/src/contacts/sqlite/README.md`。

## 验证

- `cd backend-ts && npm run typecheck`：通过。
- `node --test --test-timeout=180000 test/sqlite-deletion-metadata.test.mjs test/sqlite-deletion-metadata-restart.test.mjs`：9 项通过，覆盖：
  - 名单准入在封禁前/账户删除时关闭、联系人封禁后只读提前放行、完成后写入门禁恢复；
  - 清理被挡住时名单服务重建并返回兄弟联系人，删除联系人及其绑定不可见，身份写入与名单预览 409；
  - 早开读者登记后删除继续完成（不阻塞闭包），完成后写入恢复；
  - 跨重启：联系人已封禁的未完成删除名单只读可读、被删对象不可见；缺失联系人的手写任务和未完成账户删除仍 409 `identity_closed`。
- 后端全部 16 个 `test/*deletion*.test.mjs`：仅 `sqlite-memory-unknown-deletion.test.mjs` 失败，且在未包含本次改动的 HEAD 基线工作树中同样失败（`message.sourceRecordIds.length` 1 vs 2），属既有失败，与本改动无关。
- `node --test --test-timeout=180000 test/sqlite-deletion-metadata.test.mjs test/sqlite-deletion-metadata-restart.test.mjs test/sqlite-foreground-isolation.test.mjs test/sqlite-deletion.test.mjs test/sqlite-deletion-compaction.test.mjs test/sqlite-background-reads.test.mjs test/sqlite-contact-close.test.mjs`：49 项全部通过，覆盖前台专用读者不被后台 SQL 阻塞，以及压缩推进 schema 版本后早开名单的前台 reader 重建一次后继续读取。
- 未运行后端全量测试；未在真实 App 删除真实联系人验证。桌面端收窄读取暂停与失败静默重试在另一个提交，需与后端改动一起验收。

## 已知限制与剩余风险

- compact（VACUUM 与全库校验）仍在存储 Worker 内同步执行，期间所有名单读取会排队并可能超过客户端超时；本步只把关闭窗口从 43–121 秒缩短到 compact 的 21–30 秒，没有解决压缩可用性。
- early-open 只开只读；身份写入、名单预览与账户删除保持关闭。若后续要开放 early-open 写入，需要单独评审 holder 闭包、新 deletion_target 与 verify 的重新收集。
- plan 提交到 advance drain 之间仍可读取旧服务实例；该实例按 DB 状态只返回活跃联系人，但名单预览（cli-sessions）在同一请求内若已完成准入检查可能短暂可用，属于既有窗口。
- 已封禁联系人删除在跨重启后提前可读，但 blocked 任务不会自动完成，删除进度仍由删除面板/自动续跑推进。
- 需要真实 App 与至少一次真实联系人删除的桌面验收后，才能宣称端到端消除该错误提示。
