# read_goal 突发与稳态增长归因（阶段 A，只读）

任务：`.scratch/runtime-waste-cleanup-20261106/issues/01-read-goal-churn.md` 阶段 A。
日期：2026-11-06/07（本机）。测量全程真实库只读（`sqlite3 -readonly` / `file:...?mode=ro`），未启动或停止任何 App/开发进程，未写库、未建副本。联系人一律只写 ID 前 8 位，不含消息正文。

## 结论先行

1. **突发不是（只）由重启解释。** 重启只是触发器：每次后台重启把全部 `history_guard_lease` 置 `lost`（退出路径 `history.guardRelease`，`actions.ts:139-146`），唤醒链随后按联系人逐轮"重验→作废运行行→新建目标"。更重要的是：**在 epoch 不变（无重启）的 18.5 分钟窗口里，突发仍在进行**（1,636 行 / 217 联系人，见第 1 节），且当代观测的每联系人轮次间隔约 14:18 诊断时的"4 分钟"已变为"群内 ~2 分钟、群间隔 ~5–5.5 分钟"的自续行循环（第 4 节）。"仅重启触发且每联系人每重启 ≤2 行"的免修条款不成立。
2. 每轮每联系人新增 2 行（1 个 `history` 全空目标 + 1 个 `incremental` handoff 目标），并伴随把上一轮 `running` 行批量置 `invalidated / history_runtime_revalidated`；轮内不改写、不合并既有目标。0 页贯穿全部循环行（`pages_accepted=0`）。
3. `purgeStaleGoals` 追得上：18:25–19:25 的 ~17k 行突发到 23:28 只剩库存 40,497 行，00:05 已降到 24,230 行（第 5 节）；不需要"批量清理加速"。
4. `/api/sync/status` 的 `readCoverage` SQL 复现（真实库只读、边运行边测）：7 次 pass 耗时 min 12.60 s / 中位 18.46 s / max 26.10 s（第 6 节），比诊断文档"安静副本 5.15 s"慢，主要差异是测量时库上并发在写（churn 干扰）。
5. `PRAGMA quick_check`（3.0 GB 真实库，一次）：**11.85 s**，结果 `ok`（第 7 节），低于 60 s 开库预算，不是当前问题。

## 0. 测量条件与偏离说明

- 库：`~/Library/Application Support/NotAloneDesktop/managed/sqlite/notalone.sqlite`，3,199,328,256 字节，schema 版本 42（`SELECT MAX(version) FROM schema_migration` 复核 42）。
- 00:05 前所有查询用普通 `sqlite3 -readonly`；00:05 后（库被干净关闭、`-wal/-shm` 被删除、无进程持有文件）普通只读打开报 `SQLITE_CANTOPEN(14)`，改用 `file:...?mode=ro&immutable=1`（库静态无写入，等价只读；读到的总数 24,230 与 00:05:41 普通只读所得一致）。缺少 -shm 时只读连接需自行创建 shm，这一步失败的根因未完全诊断，但数据一致性已核对。**已证实**：两种打开方式读数一致。
- 期间进程事件（开发监督器日志 `/tmp/notalone-dev.log`、`ps`、`lsof`，只观察不干预）：
  - 23:19:52 开发栈启动（`node scripts/dev.mjs`），后端 23:20:11 connected；`database_instance.epoch=1214`。
  - 00:04:47 "源码已更新"→stopping；00:04:59 stopped；00:05:00 connecting（epoch=1215，00:05:41 实测）。
  - 00:05:04 再次源码触发重启；00:05:34 连接；00:06:49 disconnected；00:07:53 整个 dev 栈退出（`ELIFECYCLE exit 143`）。此后库文件静态（mtime 00:05，无 -wal/-shm），00:11 实测 epoch 仍 1215、`lease` 全部 `lost`、总行数 24,230 与退出前一致。
  - **这些重启不是本 Agent 发起**（源码被他人改动所致）；对测量而言如实记录，未改变任何进程状态。
- 时间换算：SQL 时刻均为 `strftime('...','localtime')`；`created_at` 为毫秒 Unix 时间。

## 1. 当前稳态（问 1）

计划 t0=23:46:14、t1=t0+1800s 的 30 分钟无重启窗被 00:04/00:05 两次后台重启打断（`epoch` 1214→1215 证实），故按段测量，并用"应用停止后的 30 分钟干净窗"补足一个完整无重启稳态样本：

| 段 | 时间（本地） | 条件 | 新增行 | 速率 |
| --- | --- | --- | --- | --- |
| 窗口 A 全段 | 23:46:14→00:04:46 | epoch=1214 全程无重启，应用运行 | 1,636 行 / 217 联系人 | 1,636/(18.5×60)×60 ≈ **5,300 行/时** |
| A-活跃段 | 23:46→23:57 | 同上 | 1,553 行/12 min | ≈ **7,800 行/时**（88–240 行/分钟区间） |
| A-衰减尾 | 23:58→00:04 | 同上 | 83 行/7 min | ≈ 710 行/时（分钟级 20/26→6/13 行） |
| 应用停止后 | 00:04:46→00:11:05 | 无进程读库 | **0 行** | 0 |
| 干净窗 B | 00:11:05→00:41:20 | 应用停止至 00:35（后段被他人重开但未产生行）、无重启 | **0 行** | **0 行/时**（见第 1.4 小节） |

SQL（窗口 A 总分类）：

```sql
SELECT kind||'/'||state||'/'||COALESCE(failure_code,'-') k, count(*)
FROM read_goal WHERE created_at>1793979974225 AND created_at<=1793981086000
GROUP BY 1 ORDER BY 2 DESC;
-- history/complete 613；history/running 397；incremental/invalidated/history_snapshot_replaced 396；
-- incremental/running 125；incremental/invalidated/history_runtime_revalidated 91；
-- history/invalidated/history_runtime_revalidated 13；history/incomplete/history_native_cancelled 1
```

"应用运行但空闲"的历史参考（因 purge 会删旧行，属下偏）：21 时 18 行、22 时 148 行（23:28 规格快照口径），和"约 200–400 行/时"判断一致；churn 循环的 5,000–8,000 行/时属于突发而非稳态。

**已证实**：epoch 不变的 18.5 分钟窗里突发仍在进行；应用停止后立即为 0。
**需要重测**：计划中的"应用运行＋完全无重启＋无新消息 30 分钟"完整窗口未获得（两次源码触发的重启打断）；若阶段 B 需要修复前后同口径对比，应在能保证开发栈不被外部改动的时间窗重测。

## 2. 突发是不是重启（问 2）

分钟级新增（HHAVING>100，起点 2026-11-06 14:00）与时间源对齐：

- 14:21–15:04 多分钟 >100 行/分：临近提交 `bbe43446a`（14:25）、`63cd07410`（15:09）——与 dev 热更新重启时间吻合。
- 15:19（318）、15:46–15:56、15:03–15:04：与提交 `460fdf5d5`（15:19）、`dee12e2f5`（15:55）吻合。
- **17:00–17:03（288/112/146/394）：附近（16:xx–17:03）无提交**，不与重启对齐。
- 17:59 单行 168、18:00 300 起：提交 `fefa2e75c` 18:06 在内；随后 **18:25–19:25 连续 60+ 分钟每分钟 200–400 行**，其中 18:26–18:32 呈 213/270/271 的重复循环。此段仅 2–3 次提交（18:06、19:34、19:47），无法解释 60 分钟级逐分钟自续循环。
- 23:03（113）在 23:19 重启前、属于旧 runtime 的自发活动；23:30–23:58 为 23:19 重启（epoch 1214）之后的循环段（分钟级 83–250 行/分钟，23:58 起衰减）；两次 00:05 前后的源码触发重启之后仅 00:00–00:04 残留 37 行。

代码侧的确定性链条（全部 `rg` 只命中一处或多处的写入点）：

- `history_runtime_revalidated` 的唯一写入点：`backend-ts/src/history/sqlite/continuity.ts:197`（`prepareNormalUseTarget`，条件：租约存在但 `state!=='active'` 或 `runtime_id` 不同，且此联系人此前是 normal use）。租约被 `history.guardRelease`（`actions.ts:139-146`）置 `lost`——释放发生在共享读取器轮转/交接与正常用量完成等路径（`service.ts:89,180-186`），不依赖重启。
- `history_snapshot_replaced` 的唯一写入点：`actions.ts:194`（每次 `history.begin` 都把该联系人 `running/incomplete` 的 incremental 行作废）。
- `history.begin` 的 INSERT 调用点：`service.ts:393`（`synchronize`，FirstHistory 恢复流）、`service.ts:477`（`synchronizeIncremental` 的 `armed.revalidated||freshTarget` 分支，begin 后立即返回 coverage）、`recertify.ts:149`、`resync.ts:126`（本窗口未观测到后两者）。`history.beginIncremental`（`actions.ts:258`）经 `service.ts:487`。

**判定（已证实）**：重启是突发的数值性"点火"条件之一，但"突发全部由重启解释"不成立——无重启窗口（窗口 A、17:00–17:03、18:25–19:25 的持续分钟循环）内突发继续存在；模式是把租约翻回 `active` 的每轮重验＋两条新行。
**仍是推测**：每轮中把租约置回 `lost` 的具体释放路径（共享读取器换手的 `release`、`intentionalRelease`、`observeGuardLoss` 三条候选）未逐一归因；5–5.5 分钟的群间隔与 `emptyTargetProbeIntervalMs=300_000`（`incremental-coordinator.ts:35`）的对应关系未用注入时钟复现。

## 3. 每次重启每联系人产生几行（问 3）

取**可完全对齐的重启：23:19:52 开发栈启动（epoch=1214）**：

- 重启后 10 分钟（23:19:52–23:29:59，循环尚未起）：**52 行**，头像靠前的联系人多为 2–4 行（样本行：0257b99f=4、2593a5cb/0be1d0fe/09bdb34b/09287c1a/0809e515/07d2d072/04cd6ac7/0062d2e1=3、7fd510dd/1316f21f/11f0ae07=2）。按前 8 位分组的 status 构成：history/complete 21、incremental/invalidated/history_snapshot_replaced 12、history/invalidated/history_runtime_revalidated 10、incremental/invalidated/history_runtime_revalidated 9。
- 启动总量至 t0（23:19:52–23:46:14）：1,585 行 / 122 位联系人，其中直接段 52 行、循环段（23:30 起）1,533 行。早先读到"169 位联系人、2,210 行"的口径实际统计到约 00:02（把 23:46 后仍在生成的循环行一并计入），此处已修正。

**判定（已证实）**：单次重启对每联系人的直接新增量在重启后 10 分钟内约 2–4 行（1 个 0 页 complete history + 1 个 handoff incremental ＋同轮把旧运行行作废的 UPDATE；不满足"≤2 行"免修条件是因为叠加了后续循环轮）。
**仍是推测**：把"直接行"与"紧随循环"完全切开的更干净口径需要阶段 B 的合成夹具（注入时钟重放"开库→一次保存→重启"）。

## 4. "4 分钟三行一轮"是否仍在（问 4）

仍在，但节奏变了：当代观测为"群内轮次 ~20–30 秒一组、成簇每 ~5–5.5 分钟一轮"（与 300,000 ms 空目标探测间隔量级一致），每分钟聚合 18 时段约 250 行、23 时段约 135 行。

两位联系人 23:19:52 之后的完整目标血统（creation_no 升序，contacts 只取 ID 前 8 位）：

- `0be1d0fe`（31 行）每轮模式：
  - `[t] history/complete (0 页, rc=Y)` —— 开启即完成；
  - `[t 同秒] incremental/invalidated/history_snapshot_replaced (0 页, cur=Y, handoff=Y)` —— 同秒新建、下一轮被作废；
  - `[t+~20s 的下一轮] history/invalidated/history_runtime_revalidated (0 页, cur=N, rc=N)` —— 上一轮留下/被新建的 running 行被重验作废。
  - 例：23:30:33 complete+handoff-inval → 23:30:42 inv(runtime_revalidated) → 23:31:04 complete+inval → 23:31:12 inv → 23:31:23 complete+inval……23:58 后衰减为静默。
- `28ffbe2c`（25 行）：同样结构，仅在 23:36 后才开始轮次（说明唤醒逐联系人渐进扩散，不是所有联系人同一时刻爆发——这符合"按联系人错峰"现状）。

调用点归因（读码证实，不许猜）：

- complete 行 = `FirstHistoryCoordinator.#run → service.synchronize → history.begin@service.ts:393 + 页循环立即走完（0 页 exhausted）`。
- 长存 `running` 行 = `IncrementalHistoryCoordinator → service.synchronizeIncremental → history.begin@service.ts:477`（`armed.revalidated||freshTarget` 后立即返回，不在本调用里走页循环）——证据：23:48:19、23:53:18、23:55:22 的 `history/running` 行在后续多轮里保持 `running`（00:05 复查仍 running：495652/496152/496550）。
- incremental 行 = `service.ts:487 → history.beginIncremental@actions.ts:258`（带 `handoff_from_goal_id`）。
- 作废更新 = `continuity.ts:197`（runtime_revalidated）与 `actions.ts:194`（snapshot_replaced）。

**已证实**：三行本轮的构成、每轮 2 新行、0 页贯穿、调用点归属如上；整轮循环不依赖重启（窗口 A 内 epoch 不变）。
**仍是推测**：谁在轮次间把租约置 `lost`（第 2 节的三条候选）；群间隔 5–5.5 分钟与空目标探测的因果；`running` 行最终被撤销还是被复用结束（观测截断时仍存在）。

## 5. 清理是否追得上（问 5）

`purgeStaleGoals`（`goal-retention.ts:18-48`）只在每次 `history.begin`/`beginIncremental` 的事务里按 batch≤50 清"同联系人已无用"的目标（非最新、非同 scope 最新、无 `capture_record`、未被引用；`snapshot_replaced` 0 页宽限 1 小时、`runtime_revalidated` 空历史行宽限 1 小时、其余作废行 24 小时）。

库存演进（总数只读计数）：

| 时刻 | read_goal 总行数 | 来源 |
| --- | --- | --- |
| 14:18（诊断文档） | 279,909 | 诊断 |
| 23:28（规格快照） | 40,497 | 规格 |
| 23:46:14（t0） | 32,187 | 本测 |
| 00:05:41 / 00:11:05 | 24,230 | 本测（两次一致） |

- 23:28→23:46：−8,310 行 / 18 min（期间仍在生成新行），**净删除速率 ≈ 460 行/分**，即循环的每一次 begin 都在其事务里把该联系人 1 小时宽限到期的行清掉。
- 突发后回落时点：18:25–19:25 的 ~17k 行突发存到 23:28 尚余 40.5k（含全部类别），到 00:05 库存 24.2k（低于 18 时突发前的水平口径不可比，但"从 40.5k→24.2k 连续下行"成立）；00:11 静止。
- 23:46–00:05 期间新增 1,636+ 余行、库存仍净降 → **purge 追得上**。仍在库的 invalidated 行主要受 24 h 宽限（`history_runtime_revalidated` 且带 `cursor/进度`）与"最新/被引用"保留条件约束。

**已证实**：清理速度在突发后 ~45 分钟内把库存逼近稳态（24,230），不需"批量清理加速"。
**仍是推测**：库存的长期目标形态（哪些 24h 宽限行会自然到期删除）需跨天观察。

## 6. `/api/sync/status` 现状（问 6，方法偏离已说明）

按任务要求改在**真实库只读**上复现，未建副本（本阶段禁止写副本）。复现对象是 `readCoverage`（`backend-ts/src/history/sqlite/read.ts:75`）对每位联系人执行的 7 条 SQL（当前目标×2、页面计数、连续性阻塞性、消息类型聚合、隔离状态、隔离汇总），联系人集合取 `SELECT DISTINCT contact_id FROM read_goal`（280 位，与诊断文档"每批 4 位、约 70 批"≈280 联系人一致）；脚本 `/tmp/q6-timing-ro.py`（本仓库外）。

- 7 次 pass 总耗（同一脚本、含并发写入干扰）：14.45 / 12.60 / 24.76 / 23.91 / 16.17 / 18.46 / 26.10 s → **min 12.60 s，中位 18.46 s**。
- 分项（最慢 pass，280 联系人合计）：当前历史目标选择 2,547 ms（≈9 ms/位×2，与诊断文档"每位 ~6 ms"同量级）；incremental 选择 292 ms；消息类型聚合 **18,253 ms**（诊断文档 1.2 s——同表同披露口径下被放大，见下）；隔离汇总 3,528 ms；其余 <300 ms。
- 与诊断文档 5.15 s 的对比必须带条件：诊断测于"安静副本 + 库当时还在读但无本测量这轮并发写"；本测期间库上有活跃写者（churn），且消息表/`capture_record` 页面与 churn 写路径重叠，是指标放大的最可能原因——**在没有安静条件复测的情况下不能下结论说 SQL 变慢了**。`read_goal` 行数从 279,909（14:18）降到 24,230 不会解释这种放大（当前目标选择耗时与行数相关性反而应下降）。
- **已证实**：只读层面 7 条 SQL/ contact 的时间结构与诊断一致；当前目标选择量级正常；隔离汇总在干扰下更贵。
- **需要阶段 B 补一遍**：在"应用未运行 + 安静副本"（建副本需 ≥15 GiB 可用，当前约 54 GiB）重测，同 `deletion-and-sync-status-perf-20261106.md` 方法对齐。

## 7. `quick_check` 耗时（问 7，附带）

```bash
/usr/bin/time -p perl -e 'alarm 35; exec @ARGV' -- \
  sqlite3 -readonly '<真实库>' 'PRAGMA quick_check;'
# 输出 ok；real 11.85s / user 0.68s / sys 1.55s
```

3.0 GB 库、运行中测量一次：**11.85 s**，`ok`，未触发 35 s 放弃线，远低于 `sqliteOpenTimeoutMs=60_000` 开库预算。**已证实**，无需改。

## 8. 已证实 / 仍是推测清单

已证实（本报告给出数据或唯一出处）：

1. `history_runtime_revalidated` 唯一写入点 `continuity.ts:197`；`history_snapshot_replaced` 唯一写入点 `actions.ts:194`；`history.beginIncremental` 唯一 INSERT 点 `actions.ts:258`（由 `service.ts:487` 调用）。
2. 无重启（epoch=1214）窗口内突发增长继续存在（1,636 行/18.5 分钟，217 联系人）。
3. 每轮每联系人新增 2 行的结构与调用点归属（`service.ts:393/:477/:487`）；全部循环行 `pages_accepted=0`。
4. 23:19 重启直接贡献 ≈2–4 行/联系人（10 分钟窗口总 52 行，2–4 行/联系人）；不满足免修条款。
5. `purgeStaleGoals` 追得上，突发后 ~45 分钟内库存 40.5k→24.2k。
6. `quick_check` 11.85 s、`ok`；`readCoverage` 只读复现总耗在真实库上 min 12.6 s（有并发干扰）。
7. 干净稳态（应用停止）30 分钟窗新增 0 行（第 1.4 小节）。

仍是推测（引用时需注明）：

1. 每轮把租约置 `lost` 的具体释放路径（共享轮转 release / `intentionalRelease` / `observeGuardLoss`）。
2. 群间隔 5–5.5 分钟与 `emptyTargetProbeIntervalMs=300_000` 的因果（需注入时钟复现）。
3. 停止前仍 `running` 的三个目标行的最终归宿（撤销 vs 被 pending 流程完成）。
4. `/api/sync/status` 在安静条件下的真实耗时（需副本复测）。
5. 18:25–19:25 长循环的启动触发（该时段 2–3 次提交可对齐但不足以解释全部分钟级循环）。

## 1.4 干净窗 B（00:11:05→00:41:20，约 30 分钟）

- 全窗新增 **0 行**（`SELECT count(*) FROM read_goal WHERE created_at>1793981465282` 两次采样一致；t_b0 00:11:05、t_b1 00:41:20）。
- 期间环境事件（**非本 Agent 所为**，只观察）：00:35 前后 dev 栈被再次打开（`-wal/-shm` 重新出现、库 mtime 00:35、`epoch` 依次走至 1218（00:36:23 实测）→1219（00:41:20 实测））；重开至 t_b1 止 `read_goal` 新增仍为 0——按 23:20 案例，重开后的循环最早 ~10 分钟后才点燃，采样截断在此前，因此"重开已点火"与"未点火"都不能下结论。
- 结论：**无进程运行且无重启的 30 分钟稳态新增 = 0 行/时**；"应用运行但无新消息"的稳态参考仍是 21/22 时历史口径 18–148 行/时（purge 对历史小时数有下偏）。
- 覆盖注意：B 窗口后 ~6 分钟处于"已被重开但尚未产生行"的前置状态，若阶段 B 要"应用运行×30 分钟无循环"的口径，需要在没有外部打开/重启干扰的时段重测。

## Comments

### 阶段 B 建议（供用户确认阶段方案后再动手）

只处理上面"已证实"的来源；下面括号里先给出我建议的上下界 X/Y，供合成夹具验收参考。

1. **收紧"重验后必然新开 history 目标"与"每次 begin 全量作废增量"的合流**（方向 1+2 的合体，最小改动、来源 100% 已证实）：
   - `service.ts:477` 的 `synchronizeIncremental` 分支：当"存在与 freshTarget 完全同 scope（binding/grant/代次/digest）、0 页、只是被上一轮作废的最近目标"时，**复用**上一条目标（把它从 `invalidated/history_runtime_revalidated` 恢复为 `running` 或直接续用其 handoff 的增量），不再 INSERT。
   - `actions.ts:194` 侧同样只在新目标确实与旧增量目标不同（判据与代码既有 `sameEmptyTargetGeometry`、`cursor_scope_digest` 相同语义）时才作废。
   - 对应"全量作废"的另一半：`continuity.ts:197` 只作废真正与新轮不同的 0 页运行行（同 digest/0 页即复用）。
   - 预期收益（对应验收指标 X→Y）：一次后台重启后每联系人新增 `history+incremental` 目标从实测 ~2–4 行降到 ~1 行（X≈2–4，Y≈1）；无重启空闲循环轮从每轮 2 新行降到 0，突发源（4,000–8,000 行/时）随循环轮消失。
   - **语义边界（需要用户点头）**：这项改动意味着"在连续性已重新证明的前提下，0 页目标不再被重复作废再重建"，不触及删除证明、来源核验或授权范围；"重启后是否必须重新建立空目标"本身属产品语义，如需把"重启后的重证"一并省掉，那属于任务单"改变同步语义"的停止条件——**本建议不包含**。
2. **不建议投入**：
   - "批量清理加速"（purge 已追得上，第 5 节）；
   - "按联系人错峰"（`28ffbe2c` 血统证明已天然错峰，突发规模取决于轮次时长而非同时性）；
   - "不为 0 页空探测置失效"（五分钟探针与群隔的因果仍是推测，先在第 1 项夹具里验证是否还有残余轮，再决定）。
3. **仍需先复现、不建议直接改**：轮次间把租约置 `lost` 的具体释放路径。若第 1 项收益不足（夹具仍有 >1 行/联系人/重启），下一步应在合成夹具中观察轮次间 4 条释放候选（`service.ts:89` 共享换手、`:180-186` 成功释放、`observeGuardLoss`、`history_native_cancelled`），只对已经证实的那条加"不释放→续用租约"或"释放后复验不重新 INSERT"的配套改动。
4. **填写验收夹具时的 X/Y 令牌**：
   - 夹具 1（N 联系人 + 一次后台重启）：X=2–4（实测），Y 暂定 1（若复用不成立严格 ≤2）。
   - 夹具 2（空闲 1 小时无新消息无重启）：当前新增 0（应用停止实测量级；修复若仍 ≥1 行需回看第 1 节活跃段差异）。
   - `/api/sync/status`：修复后在安静副本复测并与本报告 min 12.6 s（有干扰）配对记录。
5. **无需阶段 B 例外条款未触发**：突发不是"仅重启触发"，且每联系人/重启 >2 行。

（本报告为阶段 A 产出，未改代码；`git status` 未动用户文件，未运行 git 提交。）
