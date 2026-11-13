# read_goal 空探测轮与租约 lost 释放路径的归因与修正

Triage: ready-for-agent
State: open

> 来源：用户 2026-11-07 批准："另开一个任务处理'空探测轮 + 租约 lost 路径'：先在合成夹具复现归因，再修。"
> 前置阅读（只整读一次）：
> - `docs/verification/read-goal-churn-attribution-20261106.md`（阶段 A：轮次结构、§4 血统、§8 推测清单）
> - `docs/verification/read-goal-reuse-phaseb-20261107.md`（阶段 B：复用判据、§6 遗留——"空探测轮对无消息联系人每重验轮仍 +1 complete 行；`pages_accepted≥1` 的运行行按用户条件字面不复用；租约置 lost 的释放路径仍未归因"）
> - `.scratch/runtime-waste-cleanup-20261106/issues/01-read-goal-churn.md` 的 Comments（本任务的承接边界）
> - `backend-ts/src/history/sqlite/goal-reuse.ts`（现判据）、`service.ts:393/:477/:487`、`actions.ts:139-146,194`、`continuity.ts:175-200`、`incremental-coordinator.ts`（30s 扫描与 300s 空目标探针）

## Goal

1. **归因阶段（只读代码＋合成夹具，不改产品代码）**：用可注入 `now`／`intervalMs` 的合成夹具复现"无消息联系人每重验轮 +1 行"的现象与"租约被置 lost"的具体释放路径（阶段 A 列出 4 条候选：共享读取器换手的 `release`、`intentionalRelease`、`observeGuardLoss`、共享读取器轮转/交接等）。产出 `docs/verification/read-goal-empty-probe-attribution-20261107.md`：每个来源给出"谁调用、什么条件、几行/轮"的证据（行号＋夹具断言），与阶段 A 的时钟推断（群间隔≈300s 探针量级）对上或推翻。
2. **修正阶段（归因证实后，最小改动）**：让"空闲、无新消息、无后台重启"时无消息联系人不因空探测/重验轮新增 `read_goal` 行——复用阶段 B 判据（同 binding/grant/两代次/`cursor_scope_digest`、0 页、无 capture_record、读取器目标未替换）扩展到该路径；已知候选方向（不是预设答案）：
   - 空目标探针（300 s）与重验轮命中复用判据时不再 INSERT/不再作废（当前此轮仍 +1，说明某调用点绕过 `reusableEmptyGoals`，按归因定位）；
   - `pages_accepted≥1` 的运行行不在本任务随意复用（那是阶段 B 条件 2 的字面边界）；如确有必要，属语义扩展，另经用户批准。
3. **循环的读侧语义保持不变（用户已决策 2026-11-07）**：每轮 0 页读库**不消除**——这些读取是无消息联系人发现新消息的方式，去掉会改变同步语义。本任务只做"行数不再每轮 +1"，读取频率与语义原样保留。若归因发现必须改读侧行为才能止住行数增长，停下问用户，不擅自改读取路径。

## 硬边界（承任务 01 的合同，继续适用）

- "重启后第一轮仍重验一次"不省；已 invalidated 行绝不改回 running；`purgeStaleGoals` 保留条件不放宽；不动"把租约置 lost"的判定本身，只允许归因其调用来源（改【谁在什么条件下调用释放】属产品语义，需用户逐点确认）。
- 真实库只读（`file:...?immutable=1` 聚合；本机普通 readonly 打开会 CANTOPEN）；不启动 App、不 `pnpm run dev`；验证只允许合成夹具与隔离副本（副本无写入需求）。
- 不做清理加速/错峰；若归因落定后需要新增迁移，版本 44 且先报用户批准。
- 工作树保护清单文件不得触碰；每主题一个提交；署名行禁止；不 push；`check_public_history` issues=0。

## 验收

- [ ] 归因报告：现象在夹具中 100% 可复现（注入时钟）；4 条候选逐条给出"命中/排除"证据。
- [ ] 修正后的夹具：无消息联系人空闲 1 小时（注入时钟、探针间隔 300 s）新增 0 行；有消息联系人的行为与阶段 B 后一致（其验收不受回归）。
- [ ] 负向测试：判据任一条件不成立时保持现有行为（沿阶段 B 的 12 例扩充到新路径）。
- [ ] 相关测试：`sqlite-history-goal-reuse`、`sqlite-goal-retention`、`sqlite-incremental-sync/-handoff/-controls`、`sqlite-history-parked-sync-handoff`、`sqlite-history-goal-order`、`sqlite-history-recertify*`、`sqlite-deletion` 全过。
- [ ] 数据处理影响：只减少新行创建，不改写历史；无迁移（或经批准的 44）。
- [ ] 任务单 `## Answer` 写验证命令与剩余风险（尤其 `pages_accepted≥1` 与"空读是否继续"两项的用户决策点）。

## Test seam

公开存储动作 `history.begin`／`history.beginIncremental`／`history.normalUseRevalidationCandidate` 与 `IncrementalHistoryCoordinator`／`FirstHistoryCoordinator`（构造可注入 `now`、`intervalMs`）；夹具参照 `backend-ts/test/sqlite-history-goal-reuse.test.mjs` 与 `sqlite-goal-retention.test.mjs`（其夹具写法直接延伸）。

## 停止条件

- 修正需要改变"重启后是否重验"或"空探针是否读库"的产品语义。
- 需要对真实库写入或应用迁移未经用户批准。
- 夹具无法复现现象：报告并停下，不按样子改。

## Answer

（执行 Agent 填写：归因结论、改动与验证命令、数据影响、剩余风险与决策点。）

## Comments
