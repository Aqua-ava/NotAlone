# 归因并抑制 `read_goal` 突发增长

Triage: ready-for-agent（批准范围已全交付；遗留项属另立任务候选，见 Comments）
State: resolved
Type: task（分两阶段：A 研究，B 实现）

Blocked by: none

先读 [spec.md](../spec.md) 的"全局规则"和"与 14:18 诊断文档的差异"，再开始。

## Goal

查明 `read_goal` 行数为什么会成批增长，只对**已证实**的来源做最小改动，让"空闲、无新消息、无后台重启"时每联系人不再新增行，并让"后台重启后"每联系人新增行数有明确上界；同时让 `/api/sync/status` 与联系人删除的耗时随之下降。不得改变同步语义、删除证明和授权边界。

## 背景证据

- 11-06 23:28 的只读计数：`read_goal` 共 40,497 行；最近 14 小时每小时新增在 18 点 15,688 行、19 点 11,624 行，其余多数小时在 200–2,300 行之间，21 点之后降到 18–399 行。
- 18、19 点突发的失败码主要是 `history_runtime_revalidated`（history／incremental 目标被置失效）和 `history_snapshot_replaced`，涉及 237 位联系人，单人 2 小时内最多 127 行。
- 已有清理：`backend-ts/src/history/sqlite/goal-retention.ts` 的 `purgeStaleGoals`，在 `history.begin` 创建新目标的事务里每次最多清 50 个（`goalRetentionBatch`），已作废目标宽限 24 小时，"被新快照取代且无进展"的目标宽限 1 小时。相关提交：`0f9d15fab`（11-04）、`bbe43446a`（11-06 14:25）、`63cd07410`（11-06 15:09）。测试：`backend-ts/test/sqlite-goal-retention.test.mjs`。
- 三个**产生**目标的代码点（先读懂再下结论）：
  1. `backend-ts/src/history/sqlite/incremental-coordinator.ts:35`：`emptyTargetProbeIntervalMs=300_000`，空目标每 5 分钟探测一次（`:205,:229,:234`）；协调器默认 30 秒扫描一次（`:73`，`intervalMs ?? 30_000`）；正式宿主以 `firstHistoryManagedExternally:true` 创建（`backend-ts/src/sqlite-host-plugin.ts:209`）。
  2. `backend-ts/src/history/sqlite/actions.ts:190-197` 的 `history.begin`：每次创建新的 history 目标，同时把该联系人仍在 `running/incomplete` 的 incremental 目标置为 `invalidated / history_snapshot_replaced`（`:194`）。
  3. `backend-ts/src/history/sqlite/continuity.ts:175-200`：当联系人守卫租约的 `runtime_id` 与当前运行时不同（即后台重启过）且此前是正常使用，就把该联系人 `running/incomplete` 的 history／incremental 目标置为 `invalidated / history_runtime_revalidated`（`:197`）。
- 诊断文档（`docs/verification/deletion-and-sync-status-perf-20261106.md`）里"固定三行一轮、约 4 分钟一轮"的现象：`history running → history complete → incremental invalidated(history_snapshot_replaced)`，均为 0 页。其与"共用读取器轮转"（提交 `d6241977a`"支持大聊天记录分片轮转与持久恢复"）的关系**未被证实**。

## 必读

- `architecture/current/wechat-sync.md`：先 `rg -n "历史|增量|目标|读取器|恢复|检查点|空" architecture/current/wechat-sync.md` 定位，再读命中的章节。
- `architecture/current/privacy-deletion.md` 中关于 `read_goal` 作为删除目标和审计依据的部分（`rg -n "read_goal|目标|审计" ...`）。该文件超过 20 KB，**不要整读**。
- `docs/verification/deletion-and-sync-status-perf-20261106.md`（上文引用的诊断），尤其"可选优化"表中方案 A、B。
- `backend-ts/src/history/sqlite/README.md`。

## 阶段 A：归因（只读，不改代码）

目标产出：一份 `docs/verification/read-goal-churn-attribution-20261106.md`（新建，中文，不含联系人名称与消息内容，联系人只写 ID 前 8 位），回答下面每一问。

1. **当前稳态**：在**没有重启**的 30 分钟窗口里，每小时新增多少行？按 `kind/state/failure_code` 分类。
2. **突发是不是重启**：把分钟级新增量与后台重启时间对齐。可用的时间来源：
   - 分钟级新增：`SELECT strftime('%m-%d %H:%M',created_at/1000,'unixepoch','localtime') m, count(*) FROM read_goal WHERE created_at>? GROUP BY 1 HAVING count(*)>100 ORDER BY 1;`
   - 重启次数：`database_instance.epoch`（每次存储打开 +1，见 `worker.ts:120`）、`history_guard_lease` 里不同 `runtime_id` 的数量、开发监督器日志（如 `/tmp/notalone-dev.log` 若仍在）、`git log --format='%h %ad %s' --date=format:'%m-%d %H:%M'` 的提交时间（开发热更新会因源码变化重启后台）。
   - 判据：若突发时间与重启／提交时间吻合，且失败码以 `history_runtime_revalidated` 为主，结论为"重启触发"；不吻合则继续查轮转。
3. **每次重启每联系人产生几行**：用最近一次已确认的重启，统计每联系人新增行数的分布（最小、中位、最大）。
4. **"4 分钟三行一轮"是否仍在**：在无重启窗口里，抽 5 位联系人（只用 ID 前 8 位）查最近 30 分钟的 `read_goal` 时间线；若存在，找出是谁调用了 `history.begin`（读 `backend-ts/src/history/sqlite/coordinator.ts`、`service.ts` 的调用链，不要猜）。
5. **清理是否追得上**：对比"每小时新增"和 `purgeStaleGoals` 的实际删除速度（它只在 `history.begin` 里跑，每次最多 50 个）。突发后多久回落到稳态？
6. **`/api/sync/status` 现状**：在隔离副本上复现诊断文档的测法（`history.coverages` 每批 4 位联系人），报告现在的耗时与诊断时 5.15 秒的对比。
7. **（附带）** spec 末尾"附带待测"的 `quick_check` 耗时。

阶段 A 完成条件：上述 1–6 有数据回答；给出"哪些来源是已证实的、哪些仍是推测"的清单；并在文件底部的 `## Comments` 提出阶段 B 的建议方案。

**阶段 A 结束后把 `Triage:` 改为 `ready-for-human` 并停下，等用户确认阶段 B 方案再继续。** 例外：若归因结论是"仅重启触发、且每次重启每联系人新增 ≤ 2 行"，可以直接报告"无需阶段 B"并把 `State:` 改为 `resolved`。

## 阶段 B：最小修复（用户确认后）

只处理阶段 A 证实的来源。可选方向（**不是预设答案**，按证据挑选）：

- **复用而不是新建**：重启后的 `history_runtime_revalidated` 流程里，若上一个已完成的 history 目标与新目标的 `cursor_scope_digest`、`binding_id`、`grant_id`、`accepted_*_generation` 完全相同且 0 页，复用旧目标，不再 `INSERT` 新行。
- **不为 0 页空探测置失效**：`actions.ts:194` 只在新快照确实替换了增量读取器目标时才失效 incremental 目标。
- **批量清理加速**：突发后清理追不上时，让 `purgeStaleGoals` 在一次事务里按预算清得更多，或在后台空闲时分批清（仍保持有界，不阻塞同步）。
- **按联系人错峰**：重启后 237 位联系人不要同一时刻各建一轮目标。

硬约束：

- 不改变 `read_goal` 作为删除目标和审计依据的语义；`purgeStaleGoals` 保留的条件（最新目标、被 `history_source_recertification`／`history_restore`／`handoff_from_goal_id` 引用的目标、名下有 `capture_record` 的目标）一个都不能放宽。
- 不修改既有迁移；若确需新增索引或列，使用版本 **44**（43 归任务 02），并更新写死版本数的测试。
- 不得让"全部私聊"范围外的会话被读取；不得因复用目标而跳过授权／代次检查（`assertReadEligibility`、`assertHistoryReadBoundary`）。
- 涉及改变"重启后是否必须重新证明连续性"的语义，属于产品范围决策：停下问用户。

## 验收

- [x] 阶段 A 报告已写入 `docs/verification/read-goal-churn-attribution-20261106.md`，1–6 各有数据；推测与已证实分开标注。
- [x] 用户已确认阶段 B 方案（2026-11-07，仅第 1 项复用方案；执行条件见 Comments）。
- [x] 合成夹具复现"N 位联系人、一次后台重启"：修复前每联系人新增 X=2 行，修复后 Y=1 行（见 `docs/verification/read-goal-reuse-phaseb-20261107.md` 第 2 节）。
- [x] 合成夹具"空闲多轮无新消息、无重启"：新增行数为 0（3 轮验证）。
- [x] `sqlite-goal-retention`、`sqlite-incremental-sync`、`sqlite-incremental-handoff`、`sqlite-incremental-controls`、`sqlite-history-goal-order`、`sqlite-history-recertify-*`、`sqlite-deletion` 全部通过（另含 `sqlite-history-quote-store` 回归与更广 46 文件代理集）。
- [x] 在隔离的真实库副本上，修复前后各重放"打开→一次重启"：两副本行为一致（0 新增、0 作废，静态围栏态正确拒绝重验）；`/api/sync/status` 安静副本 1.42/1.43/1.44 s 已与诊断 5.15 s 配对记录。
- [x] 数据处理影响已写明：没有删除或改写既有用户数据；无清理加速；判据外行为保持现状。

## Test seam

公开存储动作 `history.begin`／`history.coverages` 及 `IncrementalHistoryCoordinator`（构造参数有可注入的 `now`、`intervalMs`）；不要只断言 SQL 字符串。参照 `backend-ts/test/sqlite-goal-retention.test.mjs` 的夹具写法。

## 常用命令

```bash
cd backend-ts && node --test --test-name-pattern="<名称>" test/sqlite-goal-retention.test.mjs
cd backend-ts && node --test test/sqlite-goal-retention.test.mjs test/sqlite-incremental-sync.test.mjs test/sqlite-incremental-handoff.test.mjs
```

## 停止条件

- 归因结论需要改变同步语义、授权范围或删除证明。
- 发现要对真实库写入（任何 `UPDATE/DELETE/INSERT`、迁移）才能验证。
- 阶段 A 数据显示问题已自愈（稳态为 0，突发完全由重启解释且每次 ≤ 2 行）：报告后结案，不做阶段 B。

## Answer

**阶段 B（复用 0 页单空目标，2026-11-07 完成执行条件 1–9）**：报告 `docs/verification/read-goal-reuse-phaseb-20261107.md`。

**改动摘要**（语义等价理由见该报告第 1 节逐条）：

1. 新增 `backend-ts/src/history/sqlite/goal-reuse.ts`：`reusableEmptyGoals` 判据（binding/grant/两代次/`cursor_scope_digest` 相同 + `pages_accepted=0` + 名下无 capture_record + 行内 support/eligibility/target 与当前序列化一致 + kind 前提）＋ `serializeSupport`（移自 actions.ts，re-export 保持既有导入）。判据 3 用 cursor.ts 的摘要把"新快照的 descriptor/协议/分区集合/表实例列集"对照到行内证据，负向测试证明摘要失配即不复用。
2. `actions.ts history.begin`：有可复用空目标时不 INSERT、不触发 snapshot_replaced 全量作废，只在判据不满足的增量行上作废；`history.beginIncremental`（:487）不改语句、经 pending 命中未作废行。`i.recertifyId` 禁用复用。
3. `continuity.ts:197`：同判据的 running/incomplete 行保持原值不置 `history_runtime_revalidated`；已作废行绝不改回 running；判据外保持现有行为。重验（租约重建/跨代次握手）本身不省（条件 1）。
4. `purgeStaleGoals` 未改动（条件 4）；"租约置 lost"释放路径未触碰（条件 7）；未新增迁移（条件 9；43/44 均未动用本任务版本号）。

**夹具指标**：一次后台重启每联系人新增 **X=2 → Y=1** 行、每轮作废 ≥2 → **0** 行；空闲 3 轮新增 **0** 行；纯粹作废监测、快照替换负向测试全部按旧行为回归。相关测试：新增 `backend-ts/test/sqlite-history-goal-reuse.test.mjs`（8 用例）；指定必测文件与更广 46 文件代理集通过（唯一失败为既有失败）。

**验证命令**：`cd backend-ts && node --test test/sqlite-history-goal-reuse.test.mjs`；必测 8 文件合跑；`node scripts/perf/read-goal-reuse-replay-20261107.mjs --user-data=<副本root> --passes=2 --status-passes=7`（/tmp 隔离副本）。

**副本重放数据**：修复前/后两个等价副本（sha256 与真实库一致）各 280 联系人 × 2 轮重验链，两态均为"0 新增、0 作废、0 复位"（当前静态库 278/280 位联系人带围栏，重验链被正确拒绝，说明两种代码在停读态行为一致、迁移无漂移）；适用面审计：1294 条 running/incomplete 行中 **274 条满足复用判据**、278/280 资格仍可核验——围栏解除并发生重启后，这些行正是该修复要消除的重复 INSERT/作废对象。`/api/sync/status`（70 批 × 7 轮安静副本）：修复前后均为 min 1.42 / 中位 1.43 / max 1.44 s（与诊断 5.15 s、阶段 A 12.6–26.1 s 的配对口径见报告第 4 节）。

**数据处理影响**：真实库全程只读；副本写入仅落在产品 named action 与修复代码路径；无删除或改写既有用户数据，不新增清理行为；只减少新行创建与作废写入。

**剩余风险**：空目标探测轮对无消息联系人仍可能每重验轮 +1 行（complete 行不在批准复用条件内）；pages_accepted≥1 的运行行按用户条件保持旧行为；"谁把租约置 lost"未归因（另立任务）。若真实 App 修复后仍见周期循环，按条件 7 记录、不收口。

—— 阶段 A 的答复保留如下。——

阶段 A（只读归因）完成。报告：`docs/verification/read-goal-churn-attribution-20261106.md`。

**结论摘要**：

1. **突发不是仅由重启解释（已证实）**。epoch=1214 全程无重启的 18.5 分钟窗口里新增 1,636 行 / 217 联系人（活跃段 ~7,800 行/时）；应用停止后的 30 分钟干净窗新增 0 行；另有 17:00–17:03 突发对不上任何提交（非重启时点）。"仅重启触发且每次重启每联系人 ≤2 行"的免修条款**未触发**。
2. **轮次结构已归因（已证实）**：每轮每联系人 2 个新行（`history.begin` 的 0 页 complete 目标 + `beginIncremental` 的 handoff incremental 目标，全部 `pages_accepted=0`），同时把上一轮 `running` 行置 `invalidated/history_runtime_revalidated`；当代节奏为群内 ~2 分钟、群间隔 ~5–5.5 分钟（对照 14:18 诊断的"4 分钟"）。调用点锁定：`service.ts:393/:477/:487`、`actions.ts:194`（snapshot_replaced）、`continuity.ts:197`（runtime_revalidated 唯一出处）。
3. **每次重启每联系人**：23:19:52 重启后 10 分钟直接段共 52 行 / 21 联系人（≈2–4 行/人），随后逐联系人接管成循环（23:30 起爆发）。
4. **purgeStaleGoals 追得上（已证实）**：库存 40,497（23:28）→32,187（23:46）→24,230（00:05 后静止）；突发后 ~45 分钟回到稳态库存；无需"批量清理加速"。
5. **/api/sync/status 只读复现（未建副本，方法偏离已记录）**：7 次 pass min 12.60 s / 中位 18.46 s / max 26.10 s（诊断文档安静副本 5.15 s）；差异主因是测量时库上有并发写者（churn 干扰），需在安静副本复测后定论。
6. **quick_check（附带）**：3.0 GB 真实库一次 **11.85 s**、结果 `ok`，远低于 60 s 开库预算。

**实际命令**：`sqlite3 -readonly`（00:05 库被安静关闭后普通只读打开报 CANTOPEN，改 `mode=ro&immutable=1`，读数与普通只读一致）做聚合计数/时间分布/mode/schema 查询与两位联系人血统查询；`lsof`、`ps`、`/tmp/notalone-dev.log`、`git log` 定位重启与提交时间；`/usr/bin/time perl alarm` 计时 quick_check。未启动/停止任何进程，未写库、未建副本、未提交 git。

**数据处理影响**：全程真实库只读；报告只含 `contact_id` 前 8 位，无消息正文、无联系人名称；`quick_check` 只扫描不写。没有删除或改写任何用户数据。

**剩余风险 / 待办**：
- "应用运行 + 无新消息 + 无重启 30 分钟"的完整口径未取全（00:04:47/00:05:04 两次源码触发的后台重启打断，非本 Agent 所为）；现有稳态证据 = 停止窗 0 行 + 21/22 时历史参考 18–148 行/时（purge 下偏）。
- 轮次间把租约置 `lost` 的具体释放路径、群间隔与空目标探针（300 s）的因果仍属推测（报告第 8 节"仍是推测"清单）。
- window B 后段他人重开开发栈（epoch→1219）；重开 6 分钟内未产生行，"重开已点火/未点火"待阶段 B 定夺。

## Comments

**等待用户确认阶段 B 方案，确认前不动代码。** 阶段 B 方向逐条分析见报告 `## Comments`；要点：

1. **建议先做（已证实来源的最小改动）**：把"重验后必然新开 history 目标并全量作废增量"改为"同 binding/grant/代次/`cursor_scope_digest` 且 0 页时复用既有目标"——收束 `service.ts:393`（synchronize 的 begin）、`service.ts:477`（synchronizeIncremental 的 begin 后立即返回）与 `actions.ts:194`/`continuity.ts:197` 的全量作废。预期夹具指标：一次重启每联系人新增 X≈2–4 → Y≤1（Y 定稿待用户确认）；无重启空闲轮从每轮 2 新行 → 0。
2. **语义确认点**：该修复保留"重启后每联系人第一次仍重验并建立一次目标"；若要求"重启后不再重新证明连续性"属于产品语义变更，按任务单停止条件需要另行决策。
3. **不建议投入**：批量清理加速（purge 已追得上，第 4/5 节）；按联系人错峰（`28ffbe2c` 血统证明已天然错峰）；"不为 0 页空探测置失效"（群隔与探针的因果未证实，先让夹具说）。
4. **仍需先复现再改**：轮次间置 `lost` 的具体释放路径（4 条候选，报告第 8 节）——只在合成夹具观测后对证实者加配套改动。
5. 红线重申：不改动 purgeStaleGoals 保留条件、不改删除证明/授权边界；确需新增迁移时版本只能用 44（43 归任务 02）。

**2026-11-07 用户批准阶段 B（仅第 1 项：复用 0 页目标，减少新建和全量作废），Triage 转 ready-for-agent，执行条件如下：**

1. 保留"重启后第一轮仍重验一次"的语义，不省重证；重证语义不在批准范围内。
2. 只在以下**全部**成立时才复用／不作废：`binding`、`grant`、两个代次（`accepted_data_generation`、`accepted_barrier_generation`）、`cursor_scope_digest` 都相同，且 `pages_accepted=0`、名下没有 `capture_record`，且**原生读取器的目标可证明未被替换**（`actions.ts:193` 注释约束：新固定快照替换原生读取器目标后，旧目标的增量游标不能再交给该读取器）。`sameEmptyTargetGeometry`／`cursor_scope_digest` 是否足以证明"读取器目标未变"，要用负向测试证明；任一条件不成立就保持现有行为（新建＋作废）。
3. **不要把已 `invalidated` 的行改回 `running`**。作废行是审计记录。要么一开始就不作废、不新建；已经作废的行不碰，保持原值。
4. `purgeStaleGoals` 的保留条件（最新目标、被 `history_source_recertification`／`history_restore`／`handoff_from_goal_id` 引用的目标、名下有 `capture_record` 的目标）一个都不能放宽。
5. 负向测试必须覆盖：上述每个条件单独不成立时仍新建并作废；快照真被替换时旧增量游标不会交给读取器。
6. 验收沿任务单：合成夹具"N 位联系人＋一次后台重启"修复后每联系人新增 ≤1 行；合成夹具"空闲循环"新增 0 行；在真实库隔离副本上重放"打开→一次重启"对比修复前后；相关测试（`sqlite-goal-retention`、`sqlite-incremental-*`、`sqlite-history-goal-order`、`sqlite-history-recertify*`、`sqlite-deletion`）全部通过。
7. 不碰"租约被置 lost"的释放路径，不做清理加速和错峰。若修复后夹具仍显示循环在转（每轮 0 页读取仍在做），在 Comments 记录观测并另立任务，不在本次收口。
8. 在**没有并发写者的安静副本**上按诊断文档原法重测 `/api/sync/status`（`history.coverages` 每批 4 位联系人），与诊断文档 5.15 秒配对记录；12.6–26.1 s 那组数据测量时有并发写者，不作为结论依据。
9. 若确需迁移，用版本 **44**（43 已归任务 02，勿动）；**不得对真实库做任何写操作**（验证只允许合成夹具与隔离副本；副本上也不做迁移）。

背景：本次修复只让行数不再滚大，循环本身可能仍在转、每轮仍对全部联系人做 0 页读取——与"谁在轮次间把租约置 lost"（阶段 A 标注为推测）同属后续任务。

**2026-11-07 阶段 B 完成（State: resolved）**，执行条件 1–9 逐条核验，报告：`docs/verification/read-goal-reuse-phaseb-20261107.md`。验记录要点：

1. 条件 1：`prepareNormalUseTarget` 的重验与租约重建完整执行；仅跳过"与本轮证据同行的重复作废写入"。条件 2：判据为 5 组前提＋结构 target 相等，12 例判据级负向 + 端到端快照替换、空页、记录页、read_epoch 四例负向证明"任一不成立即旧行为"，快照替换的旧游标不交给读取器。条件 3：没有把任何 `invalidated` 行改回 `running`；达标行在作废动作之前保持原值。条件 4：`purgeStaleGoals` 无改动。条件 5：见上。
2. 条件 6：夹具 X=2 → Y=1、空闲 3 轮 0 行；真库隔离副本修复前后重放一致（静态围栏态两种代码都是 0 新增 0 作废）；适用面审计 274/1294 行满足判据；指定必测文件与 quote-store 回归通过，更广 46 文件 385 用例中 384 通过（唯一失败为干净 HEAD 同现的既有失败 `sqlite-history-startup-host` "manual 正式 profile…"，与本改动无关）。条件 7 的夹具观测如下。
3. **夹具后仍存在的循环观测（另立任务候选）**：(a) 空目标探测路径（无消息联系人）验证通过会释放守卫，下一轮重验仍为 complete 目标 INSERT 一行——complete 行不在批准复用条件内，与阶段 A"群间隔 ~5–5.5 分钟"口径吻合；(b) 协调器 tick 接受的空"追平"页会把 running 增量的 `pages_accepted` 推到 ≥1，此后该行不再满足 `pages_accepted=0` 判据（用户条件字面），若在其后再发生重启/重验轮则回到旧行为；阶段 A 观测的 churn 行在作废时 `pages_accepted=0`（重验先于首轮 tail 接受），修复对该主形态成立。两点的根因仍是"谁在轮次间把租约置 lost"（阶段 A 推测 1），不在本次收口。
4. 条件 8：安静副本 `/api/sync/status` 修复前/后均为 min 1.42 / 中位 1.43 / max 1.44 秒（70 批 × 7 轮），与诊断 5.15 s 配对记录（差异来自库行量与状态不同，readCoverage 未改）。条件 9：未加迁移（版本 43/44 均未占用），真实库全程只读（immutable 打开聚合计数），副本写入仅落在产品 named action 与修复代码路径。
