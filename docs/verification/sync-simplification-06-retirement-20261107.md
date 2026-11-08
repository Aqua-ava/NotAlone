# 同步减负 06 退役旧同步流程

正常同步在每轮共享读取租约内重新核对来源。守卫随读者释放，持久的来源证明和检查点用于下次接续。删去单人／批量重新认证、开发调试面板、旧副本清理请求和处理器，保留清空、显式重读、来源变化停读和删除抑制。已验证的历史等价只用于删除闭包，按账号、联系人、会话及物理出现范围保留。决定及旧 ADR 回链见 [ADR-177](../../architecture/adr/177-retire-source-recertification-and-cleanup.md)。

## 数据与迁移

清理后的真实库保持46版。离线清理已按确认名单完成，见 [05 清单及结果](sync-simplification-05-inventory-20261107.md)。另用 APFS 克隆制作46版备份和独立迁移副本，由正式 `SqliteStorage.open` 使用默认时限升级。副本打开耗时13.192秒，完整性和外键检查通过，再次打开保持业务资料与等价事实一致。真实库及备份文件身份、大小和时间戳均一致。

| 副本项目 | 46 | 47 |
| --- | ---: | ---: |
| 业务表 | 94 | 92 |
| 历史领域表（含来源证明） | 13 | 11 |
| 已完成旧副本清理账本 | 28 | 0 |
| 消息 | 43,550 | 43,550 |
| 来源证明 | 16 | 16 |
| 受管媒体账本 | 823 | 823 |
| 历史终态抑制 | 938 | 938 |

保留的消息、绑定、授权、来源证明、捕获、排除、清空、终态抑制和受管媒体，以及九类引用与模型台账通过端侧逐表全行摘要比较。前46份迁移校验和逐项相同。迁移生成11条逐键和2条表范围删除等价事实。合成反例覆盖损坏证明、错范围、旧清理未结案、旧删除目标完整回滚及未完成旧换绑的正文资格隔离。

<!-- METRICS -->
## 指标

| 口径 | 06 前基线 | 冻结点官方测量（`06-final-metrics.json`） | 保留语义恢复后最终（本会话） |
| --- | ---: | ---: | ---: |
| `backend-ts/src/history/sqlite` 文件 | 62 | 36 | 36 |
| `backend-ts/src/history/sqlite` 行 | 6,560 | 4,587（净删 1,973，30.08%） | 4,907（净删 1,653，25.20%） |
| 去冻结历史 DDL 运行时 | 6,048 | 4,587（净减 1,461，24.16%） | — |
| `backend-ts/src` 全量 | 31,369（318 文件） | 37,427（310 文件） | 37,754（310 文件） |

冻结点官方口径达 30.08%；但为恢复「成功租约保留通道与守卫」语义并修复失联归因（用户决定，优先行为正确），`synchronize`/`synchronizeIncremental` 主干、`prepareSource`/`synchronizeQuotes` 复用与 `guardRelease` 归因向基线逐字回移，净增约 320 行。按指示未为凑 30% 压行，最终口径以本行为准（25.20%，较前一会话记录的 29.82% 差少 12 行目标证实不可达且非追求）。旧 SQL 历史迁移以冻结文件归档留存，分列统计，不计净删。

## 验证

迁移合成组14/14通过。桌面相关公共合同20/20、合成 Chromium 视图17/17、分类用例4/4通过。现行桌面登记原先漏掉已有的 `runtime-cache.test.mjs`，桌面基线和本次比较都补齐同一登记，运行同一默认命令。此用例在临时目录构建及签名仓库探针，并注入签名检查结果。

桌面默认全量对照使用 `pnpm test`，600秒外限。基线1,394项（1,368通过、25失败、1跳过），当前1,342项（1,317通过、24失败、1跳过），均退出1。逐文件及标题比较新增失败0，退役的一个认证用例缺席不算修复。

正式原生读取器对47版副本跑两轮生产协调器。每轮16/16都有新接纳时间，无失败码。最后复验2.998秒、2.888秒。消息43,550、全库绑定832（活跃范围50、有效16）、引用计数和围栏0均一致。曾单独计量一次双轮回放，仍生成32个历史目标和32个增量目标，旧无正文目标按既有保留策略回收。本次验证两轮接续，未覆盖长期目标量和长期性能。

隔离开发 App 由 Computer Use 操作。通过界面明确授权两位合成联系人，首轮各1条，历史2/2。正常退出，在私有合成读取器计划中为其中一位新增1条，重开自动显示2条和1条，绑定各1，来源均 `ok`，两人都有增量接纳，模型台账0。同步设置无关注项，开发者调试区保留，批量修复入口已撤下。隔离实例已正常退出。

```sh
pnpm --dir desktop run test:inventory
pnpm --dir desktop run dev:status --user-data-dir "$TASK_SYNTHETIC_DIR"
pnpm --dir desktop run dev --user-data-dir "$TASK_SYNTHETIC_DIR"
cd backend-ts
npm run typecheck
perl -e 'alarm 600; exec @ARGV' -- npm test -- --test-timeout=60000 --test-force-exit
```

`TASK_SYNTHETIC_DIR` 指向合成数据目录，`WECHAT_CLI_CONFIG` 指向同一验收的合成配置。真实迁移回放、原生读取器回放、媒体与引用摘要及原始测试日志保存在 `~/.local/state/notalone/diagnostics/sync-simplification-remaining-20261107/`。合成桌面模型配置留空，未验收真实模型生成。

<!-- BACKEND_FULL -->
## 本轮（2026-11-08）后端全量与收敛记录

`npm test -- --test-timeout=60000 --test-force-exit`（同基线口径）第三轮：2,104 项、通过 2,055、失败 48、取消 1。与前一轮基线逐例比较（`final-comparison-session3-final.json`）新增失败 0；3 条比较产物标记为解析器 unresolved 伪差（标题仍在基线 identities 中）。`startup-host` 的 manual 案例双基线命中，保持允许失败；同套件 1 例本轮缺席（基线有而本轮没有，不计新增）。

本轮新增收敛（前三轮每例先判真回归/断言过时，详见[按例判定](sync-simplification-06-retention-assertions-20261108.md)）：retention 语义一致后 `sqlite-private-history`（83/83）、`sqlite-history-target-handoff`（3/3）、`sqlite-history-source-ready-wake-controls`（7/7）、`sqlite-quote-sync`（12/12）、`sqlite-first-history-coordinator`（21/21，无守卫一次租约按租约关闭）、`sqlite-cutover-retirement`（8/8）、`sqlite-history-shared-process-loss`（9/9）等全部转绿；提交链 `9ade51885`（退役旧表断言）→ `b4a3014ee`（无守卫租约收盘）→ `7a7cfc20f`（断言按保留语义校准）→ `d18a1cb4b`（失联归因与引用复用对齐）。

### 外部核验（本轮）
- 47 版副本两轮回放本轮**未验证**：agent 只读上下文缺微信容器 TCC 授权，`bindAccountMetadata` 起守卫即 `history_source_unverified`（诊断固化 `session3-external-diagnosis.md`；新进程复现、读取器制品与账号配置一致、`startup` 门在干净环境通过；App 内长驻 CLI 持有 session/contact 句柄）。上轮 2026-11-07 20:56 六副本双轮回放成功证据（16/16、两轮 2,998/2,888ms、消息 43,550、绑定 832、全库引用不变、真实库不变）存 `six-copy-sync.json`；**代用户态复核的当前代码版脚本**为 `/tmp/six-copy-sync-current.mjs`（用户终端执行 `cd backend-ts && node /tmp/six-copy-sync-current.mjs`，只读真实库并再次断言不变）。
- 隔离开发 App（合成目录，`desktop-06-synthetic/user-data`）：`dev:status` 复用入 development（pid 94029），后端 979ms 就绪；`/api/sync/status` `sync_enabled=true`、`cli_bound_count=2`、`cli_backfill_phase=complete`、`cli_sync_phase=active`、`body_available=true`、两条 coverage complete 无失败码；schema 47、消息 3、绑定 verified 2、`source_proof` 双 `ok`（本启动后重验）。无打包、未发微信消息（证据 `session3-app-verification.md`）。
- 真实库只读核对：消息 43,628、最新 2026-11-07 23:36（+08），与维护方口径一致。

### 遗留冲突点
ADR-177「不再停车保留联系人守卫/不新增持久租约」与恢复后的保留语义（同一会话外的 ADR-176 判定与用户决定）相互不一致——保留语义为正确性行为基准，ADR-177 相关句段需在后续 ADR 文案更新中纠正；本票 Answer 中同步标注。

已核验持久增量的旧读取器在同一租约完整交接历史后继续增量，33页合成用例覆盖无持久历史检查点的情形。两项持久检查点能力齐备时允许有界交接。不同来源仍停读，界面的“检查微信来源”进入同步设置。
