# read_goal 空目标复用（阶段 B，20261107）验证报告

任务：`.scratch/runtime-waste-cleanup-20261106/issues/01-read-goal-churn.md` 阶段 B（用户 2026-11-07 批准的执行条件 1–9 为准）。
 predecessor：`docs/verification/read-goal-churn-attribution-20261106.md`（阶段 A）。本文联系人一律只写 ID 前 8 位，不含消息正文。

## 1. 改动点（四个已证实调用点 + 一处据实判定）

| 调用点 | 改动 |
| --- | --- |
| `actions.ts history.begin`（service.ts:393/:477 共用的作废＋INSERT 点） | 事务内先按"同联系人可复用空目标"判据筛选；无可复用行时保持原"整体作废 running/incomplete 增量 + INSERT 新历史目标"；存在可复用行时只作废判据不满足的增量行，并直接返回最新的可复用 `history/running`（无则照旧 INSERT），不再重复作废。`i.recertifyId`（重新认证）始终禁用复用，保持逐目标审计关联。 |
| `continuity.ts:197`（重启后把 running 行置 `history_runtime_revalidated` 的作废点） | 同一判据判定：与本次重验完全同范围、0 页、无记录的 running/incomplete 行不作废、保持原值；其余行仍照旧作废（作废行是审计记录，从未把 `invalidated` 改回 `running`）。 |
| `service.ts:487`（beginIncremental handoff） | 未改语句：复用的前提是"上一个 running 增量不再被作废"，由上两处保证；`history.incrementalPending`/`currentIncremental` 随即命中未作废行，`beginIncremental` 不再 INSERT。其内部 `history_eligibility_changed` 作废路径（判据不成立时）原样保留。 |
| `purgeStaleGoals`（goal-retention.ts） | 未改动（条件 4：保留条件一个不放宽）。 |
| `cursor.ts` / 并发守卫 | 未改动；`historyCursorScopeDigest` 只作为判据使用。 |

新模块 `backend-ts/src/history/sqlite/goal-reuse.ts`：`reusableEmptyGoals(tx, token, report, target)` + `serializeSupport`（从 actions.ts 移入并以 re-export 保持既有导入点）。判据为逐行"全部成立才复用"：

1. `binding_id`、`grant_id`、`accepted_data_generation`、`accepted_barrier_generation` 与当前许可一致；
2. `pages_accepted=0` 且名下没有任何 capture_record（嵌套 EXISTS 比照 purgeStaleGoals 的同形态谓词）；
3. 行内 `cursor_scope_digest` 等于用当前许可＋当前报告＋本轮新目标重算的摘要（cursor.ts）；
4. 行内 `support_json`、`eligibility_json` 与当前值序列化后一致（后续 acceptPage/pending 均按此严校验）；
5. 行内 `target_json` 与本轮新目标 JSON 一致（比摘要更强的结构判别，防摘要未覆盖字段漂移）；
6. kind 前提：incremental 必须有 cursor；history 不得是 cursor 为 null 的 incomplete（与 `history.pending` 终页保护一致）。

**为什么语义等价（逐条）**：判据 3 的摘要覆盖 descriptor/协议/来源代次/分区集合/表实例/支持档制品与能力全集，与系统既有 `acceptIncrementalPage` 的"`cursor_scope_digest` 失配即 `history_cursor_scope_changed`"同一证据口径——摘要相等即"原生读取器打开的仍是同一固定快照"；判据 4/5 保证复用行就是当前代次的 pending 形态，后续每个接受页动作（`assertReadEligibility`、`assertHistoryReadBoundary`、`assertSourceContinuity`、`currentGoal`）照旧全量执行，没有省略任何一次许可/边界/代次核验；`prepareNormalUseTarget` 的租约重建、跨代次握手与 `history_runtime_revalidated` 语义在判据之外仍完整执行，即"重启后第一轮仍重验一次"没有被省略；197 点跳过的只是"对与本轮证据完全同行的作废写入"，因为该行本来就是本轮要重建的那一行。`history_guard_lease` 置 `lost` 的释放路径未触碰（条件 7）。

## 2. 合成夹具与基线 X→Y（任务要求的验收 1、2）

夹具：`backend-ts/test/sqlite-history-goal-reuse.test.mjs`（8 用例全绿，修改后与修复前各跑一次同负载）。

| 指标 | 修复前 | 修复后 | 断言原文 |
| --- | --- | --- | --- |
| 一次后台重启（storage 关闭重开一次）＋唤醒链稳定后，每联系人新增 `read_goal` 行 | **2**（1 个 0 页 complete 历史 + 1 个重建 handoff 增量） | **1**（仅重验轮的 0 页历史目标；2/3 名联系人夹具同样 ≤1） | 修复前失败输出 `每联系人新增 ≤1（b53907ac：2）`；修复后 `≤1` 断言通过 |
| 重验轮作废行（`history_runtime_revalidated`/`history_snapshot_replaced`） | 每轮 ≥2 行 | **0** | 两夹具均为 0 |
| 空闲多轮（无重启、无新消息，3 轮 wake） | 0 新行 | **0 新行**，且不作废 | 计数稳定 |
| 磁盘影响 | 每轮每联系人净增 2 行 | 净增 1 行/重启，空闲轮 0 | 行为对比，未测量字节（微字级） |

夹具结构：3 位合成联系人、正常使用连续性、稳定 descriptor/表实例（对应"同身份快照"）、`FirstHistoryCoordinator`＋`IncrementalHistoryCoordinator` 的宿主级唤醒链（`firstHistoryManagedExternally:true`），重启为真正的 SqliteStorage 关闭/重开（沿用 `sqlite-clear-support` 的 `restart` 语义）。基线 X 用 `git stash` 只暂存两处 src 改动后同类负载实测，测即恢复。

## 3. 复用判据负向测试（条件 5）

- 判据逐项单独破坏（12 例，`fixture.cloneGoal` 克隆行 + `fixture.reusePreview` 决策直取）：binding_id、grant_id、accepted_data_generation、accepted_barrier_generation、cursor_scope_digest、pages_accepted>0、support_json、eligibility_json（read_epoch 漂移）、target_json 字段漂移、无 cursor、名下有 capture_record、本轮目标已替换（descriptor＋表实例）。每例都证明：破坏的克隆行不可续用、未破坏的原始行仍可续用（判据无超宽化）。binding/grant 属 token 侧破坏，原始行同样不可续用（判据本身拒绝）。
- 端到端（真实服务链，非注入判据）：
  1. **快照真被替换**（descriptor 变化）：旧增量仍被作废（`history_runtime_revalidated`），新建目标持有本轮游标；`f.state.tails` 证明读取器拿到的是替换后快照的游标，不是被作废旧目标的游标（`tail-2`，且旧目标行不再参与读取）。另一层保险未动：`beginIncremental` 的 `resumable` 摘要复验（cursor.ts 口径）在判据不成立时显式停止。
  2. **pages_accepted>0**（接受过空"追平"页）：重启后重建＋作废旧目标（旧行为）。
  3. **名下有 capture_record**（增量页带记录）：同上旧行为。
  4. **read_epoch 回转**（读取开关关/开）：同上旧行为；重复唤醒链不复活旧资格。

## 4. 真实库隔离副本重放（验收 6、8）

- 副本：`/tmp/phaseb-copy-pre-20261107`、`/tmp/phaseb-copy-post-20261107` 两个等副本（`lsof` 无占用窗口内 `cp -c`，三者 sha256 均 `2380c481…e97b92be34` 一致；目录与文件权限按规则设置；两副本打开均在 60s 预算内完成 43→44 迁移）。真实库全程只读（`file:…?immutable=1` 聚合计数），未对真实库做任何写操作（条件 9）。
- 真实库现状（只读核计）：schema 版本 43、280 位活跃联系人、`read_goal` 24,230 行、`history_guard_lease` 全部 `lost`、**278/280 位联系人带 `history_continuity_fence` 围栏**（App 已停读 + 广泛围栏的静默态）。
- 重放（`backend-ts/scripts/perf/read-goal-reuse-replay-20261107.mjs`，两轮"打开→重验链（prepareNormalUseGuard→begin）"）：修复前、修复后各在其副本上跑 280 位联系人 ×2 轮。两次结果一致：重验实施 0 位（278 位被围栏正确拒绝、2 位 grant 已失效 `read_not_authorized`），每轮新增 0 行、作废 0 行——**两种代码状态下，现有静态副本都不会写行**（围栏语义正确保持），因此本副本重放证明的是"停读者上零写入等价 + 迁移无升级漂移"，行为收益由合成夹具承担。
- **适用面审计（copy 上只读＋identity.eligibility 读动作）**：1294 条 running/incomplete 行中 **274 条满足复用判据**（以各联系人自身最新行为当前轮证据；`latestDigestSelfMismatch=0`、`runningPagesPositive=0`、`runningWithCapture=0`）；278/280 位联系人当前资格仍可核验（仅 2 位 `read_not_authorized`）。即：一旦围栏解除、用户重新开启同步并发生"打开→重启"，这 274 条行正是修复要消掉的重复 INSERT/作废对象。
- `/api/sync/status`（`history.coverages` 每批 4 位、70 批 × 7 轮，安静副本）：**修复前副本 min 1.42 / 中位 1.43 / max 1.44 秒；修复后副本 min 1.42 / 中位 1.43 / max 1.44 秒**。与诊断文档原测配对：诊断当时 5.15 s（27.99 万行库、当时在读者）、阶段 A 12.6–26.1 s（有并发写者，不作结论依据）、现在安静副本 1.42 s（2.42 万行）——修复不改变 `readCoverage` 本身，行少的库文件本就更便宜；如需把 5.15 s 口径再复现需重建当时的库行量，另行测量。

## 5. 相关测试与数据边界声明

- 必测文件全部通过：`sqlite-goal-retention`、`sqlite-incremental-sync`、`sqlite-incremental-handoff`、`sqlite-incremental-controls`、`sqlite-history-goal-order`、`sqlite-history-recertify-async`、`sqlite-deletion`、`sqlite-history-quote-store`（经 history.begin 路径回归）。修复前基线 8 文件 97/97 一致基线。
- 更广影响：`sqlite-history-*`、`sqlite-goal-*`、`sqlite-incremental-*`、`sqlite-clear*`、`sqlite-deletion*`、`sqlite-quote-*` 共 46 文件 385 用例，修复后 384 通过、1 失败。该失败（`sqlite-history-startup-host.test.mjs` "manual 正式 profile…"）经 stash 对照确认在干净 HEAD 上同样失败，属既有失败，与本改动无关。
- **测试语义更新（有据）**：`sqlite-history-parked-sync-handoff.test.mjs` 4 处断言原先固化"共享切换/重启重验后必然把现有增量置 `history_snapshot_replaced`/`runtime_revalidated`"。这正是批准范围要取消的行为（调用点 service.ts:477 在四个点内）。已改为：同身份快照不再作废（复用续读）、快照真替换时仍作废、恢复入口不被查询瞬时失败吞掉（失败码由注入改为可重试的 `history_interrupted`，断言由"blocked 持有替换错误"改为"degraded 下一轮重试"）。6/6 通过。
- 数据处理影响：真实库零写入；隔离副本写入只发生在产品 named action 与本修复代码路径（无手改 SQL）；合成夹具只用合成数据。无删除或改写既有用户数据；新增行只减少、作废只少。
- 未触碰范围：`guardRelease` 释放语义、`purgeStaleGoals` 全部条件、`beginIncremental` 的判据不成立路径、错误清理加速、错峰、迁移（未新增索引/列，未使用版本 44/43）。

## 6. 剩余风险与照实记录（条件 7）

1. **空目标探测轮仍每轮可能 +1 行**：对"无消息的已认证空目标"联系人，`synchronizeIncremental` 的空探测验证通过后会释放守卫，下一轮重验走 FirstHistory 时仍会为 0 页 complete 目标 INSERT 一行（complete 行不在批准的复用条件内——只有 running/incomplete 行复用）。夹具相应场景未测出额外作废（无增量行可作废）；该 +1/重验轮模式与阶段 A "群间隔 ~5–5.5 分钟"的观测一致，合成夹具一次重启内每联系人 ≤1 行的指标不受影响。
2. **pages_accepted≥1 的运行行不再复用**（用户条件严格采用 `pages_accepted=0`）：真实宿主每 30 秒的协调器 tick 会对追平度联系人接受一次空"追平"页（pages_accepted 0→1），因此重启若发生在空页接受之后，该联系人的增量目标会回到旧行为（重建＋作废）。阶段 A 观测的 churn 行多为 pages_accepted=0 时被作废（重验先于首轮 tail 读取），本修复对这些行成立；长期稳态下行为是否全量收敛待真实 App 观察后定夺（见 3）。
3. **每轮"谁把租约置 lost"未归因**（阶段 A 推测项）：本修复不触碰释放路径。若真实 App 在修复后仍出现周期循环（每轮 0 页读取仍发生但行数已稳定），属另立任务范围（本任务不收口）。
4. `sqlite-history-startup-host.test.mjs` 的 "manual 正式 profile…" 失败为既有失败（干净 HEAD 复现），本文仅记录，不归属本任务。
5. 测试语义更新涉及 `sqlite-history-parked-sync-handoff.test.mjs`（见第 5 节），均为批准调用点黑盒的语义结果。
