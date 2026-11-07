# `read_goal` 空探测轮 +1 行与租约 lost 释放路径归因（2026-11-07，定稿）

任务：`.scratch/read-goal-empty-probe-loop/issues/01-empty-probe-loop.md`（阶段 A 归因＋阶段 B 最小修正）。
前置：`docs/verification/read-goal-churn-attribution-20261106.md`（阶段 A）、`docs/verification/read-goal-reuse-phaseb-20261107.md`（阶段 B）。
测量全程合成夹具与新开真实库只读无关；联系人只写 ID 前 8 位；不含消息正文。

## 结论先行

1. **certified-absent（无消息表）联系人的空闲探针循环本来就是 0 新增**（阶段 A 草稿的"+1/轮"猜测被推翻——见勘误节）。驱动链：`readCoverage` 的 `emptyTargetAwaitingMessages` 豁免使租约 lost 时覆盖仍投影 `phase='complete'`（`read.ts:107-108`、`:125`），协调器只走探测轮（`incremental-coordinator.ts:454-466`），从不进 `requestFirstHistoryRecovery`→FirstHistory 重验，因此不走 `history.begin`，不 INSERT、不读正文页（列表探测轮保持目标元数据频率：每轮 targets+1、inspects≥2）。
2. **事件驱动的重验轮（手动同步、前台触发、重启）对"同身份 complete 空目标"的经典 +1 已在本任务修正**：阶段 B 复用判据只收 `state IN ('running','incomplete')`，上一轮的 complete 空行在 SQL 层被过滤（`goal-reuse.ts` 原 `:33-34`），于是重验轮照旧 INSERT —— 唯一失败点即 state 子句（夹具克隆实验证明：同一行仅把 state 改为 running 即可命中其余全部判据）。
3. **"每轮把租约置 lost"的释放来源已归因（4 条候选逐一钉死）**：
   - (a) 共享读取器换手：生产 stub 合同（`shared-client.ts:36-41` 的 `#releaseOwner`）证明每次 owner 变更先释放上一持有者守卫；载体夹具断言"换手后上一联系人租约 lost 且不围栏"。微信原生通道无 `park`（`native-client.ts` 无该定义），故生产中每次换手都触发。
   - (b) 空探测成功后的正常释放：探针验证通过 → `releaseNormalUseGuard()`（`service.ts:464`）→ `withExclusiveChannel` finally 的 `intentionalRelease`（`:183-184`）→ `guardRelease`（`actions.ts:136-143`）置 lost（normalUse 且非 sourceLost → 不围栏）。夹具"settle"与循环断言钉死。
   - (c) `observeGuardLoss`（`service.ts:118-131`）：守卫会话 loss promise 驱动，事件级；瞬时码（recoverableGuardFailures 一类如 `history_snapshot_closed`，不在 `lostCodes`）→ 只置 lost 不围栏——夹具断言"行数零增长、租约 lost"。注意并发整备竞态的重载窗口观察到一次防御性围栏（见"遗留决策点 ②"）。
   - (d) 协调器 `#cancel`/stop（`incremental-coordinator.ts:252-261` → `service.ts:518`）与跨运行时重启（全部租约 lost）只在范围取消/停读/重启时发生，非周期机制；其中重启即"重启后第一轮重验"的合法入口（合同保留）。
4. **用户决策（2026-11-07）执行情况**：每轮的 0 页读库**不消除**——空闲探针的目标元数据/inspect 频率保持原样（夹具逐轮断言 targets/inspects 增量同修正前后一致）；重验轮的空页读取保持（复位后仍读一次空页，deltaPages=1）。修复只停止"行数不再每轮 +1"，读频率与同步语义原样。
5. **purgeStaleGoals 未动**（保留条款原样）；已 invalidated 的行**绝不复活**（判据与复位都只作用于 running/incomplete/complete 的空行，逐条测试锁定）。

## 修正内容（阶段 B 遗留的最小改动）

- `backend-ts/src/history/sqlite/goal-reuse.ts`：判据扩展第三形态——complete 且 0 页、名下没有 capture_record 的空 history 行也参与复用（其余既有判据逐条不变）；其返回 cursor 恒为 null（本轮重验与新目标同起点的读取）。
- `backend-ts/src/history/sqlite/actions.ts` `history.begin`：命中第三形态时在同事务把该行复位到本轮重验起点（`state='running',coverage_state='partial',completed_partitions='[]',cursor=NULL,resume_cursor=NULL,failure_code=NULL`），行数不变、`acceptPage` 随后按 running 收本轮空页并回到 complete；`purgeStaleGoals`、`history.interrupt`、失败/中断路径原样。`reusableEmptyGoals` 不返回已 invalidated 行（审计不动）。
- 语义等价性：该行的全部身份字段（binding/grant/两代次/cursor_scope_digest/support/eligibility/target_json）与"本轮将新建的目标"逐字段一致（判据证明），差异只在 id 与 creation_no——因此本轮重验读到的目标、页、覆盖率与新建路径完全相同；id 稳定性对 `sync_capture`（goal_id）与引用（`handoff_from_goal_id` 等）更友好。

## 夹具证据（`backend-ts/test/sqlite-empty-probe-loop.test.mjs`，6 用例）

1. 空探针成功释放：租约 lost、不围栏（(b) 源）；首行即 complete 空行。
2. 空闲探针循环 3 轮：0 行新增、0 正文页、目标元数据频率保持；随后手动重验轮：**同一行**重验复位→读 1 空页→回到 complete（行数 0 增长、pages_accepted 保持 0）。
3. 判据正向+负向：complete 空行被续用；`fixture.seedCaptureRecord` 加一个 capture_record 子记录后即被排除（新形态唯一新增负向条件）。
4. `observeGuardLoss` 事件级：租约 lost、行数零增长；注入与整备存在调度竞态（见遗留 ②）。
5. 协调器 stop/范围取消路径：仅事件级释放（(d) 源）。
6. 共享读取器换手（stub 按 `SharedWechatClient.acquire/#releaseOwner` 真实合同重写）：换手即释放上一联系人租约 lost 且不围栏（(a) 源）。

回归：`sqlite-history-goal-reuse.test.mjs`、`sqlite-goal-retention.test.mjs`、`sqlite-incremental-sync/-handoff/-controls`、`sqlite-history-parked-sync-handoff`、`sqlite-history-goal-order`、`sqlite-history-quote-store`、`sqlite-deletion`、`sqlite-history-empty-revalidation` 共 11 文件 104 用例，3 次连跑全部通过。

## 遗留决策点（均不在本任务批准范围内）

1. **带 tail 游标的增量 handoff 行**：`pages_accepted≥1`（每轮 sweep 的 caught-up 空页接受也算页）后不再满足"pages_accepted=0"判据 → 仍按原行为作废＋重建（+1）。将其扩展为"空页（无 capture_record）即可复用"属语义扩展，**需用户另行批准**。
2. **围栏本源未定**：重载并发窗口观察到一次"失守发生在整备中（arm 与释放竞态）"时出现防御性围栏（`history_source_continuity_unverified`）；单联系场景 4 连跑不出现。fences 全部写入点已审计（fenceContinuity 的 8 个调用方），未能复现定位写入者——如实标注未决。
3. 真库副本重放与 `sync/status` 安静副本复测已由阶段 B 交付（`read-goal-reuse-phaseb-20261107.md` §4）；本任务未再重复。

## 数据处理影响

只减少新行创建；不新增/改写任何既有行；无迁移；真实库未触碰（本任务全程合成夹具）。`sync_capture`（空抓取页记录）写入频率与修正前一致。
