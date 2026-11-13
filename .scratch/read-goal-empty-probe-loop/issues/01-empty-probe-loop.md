# 空探测轮 +1 行与租约 lost 释放路径：归因并最小修正

Triage: ready-for-agent
State: resolved（2026-11-07：归因定稿与最小修正完成，遗留两点见 spec 遗留决策点）
Type: task（先归因后修，两阶段）

Blocked by: none（承接 `.scratch/runtime-waste-cleanup-20261106/` 任务 01 阶段 B 的遗留——先读其 spec 免答已决问题）

先读 [spec.md](../spec.md) 全文、阶段 A/B 两份验证报告、本任务承接口径，再开始。实现期间注意：`backend-ts/src/history/sqlite/*` 是本任务主战场，不要与其他改同域文件的工作并行。

## 阶段 A：归因（只读＋合成夹具，不改产品代码）

产出 `docs/verification/read-goal-empty-probe-attribution-20261107.md`，回答：

1. 无消息联系人的"每重验轮 +1 行"：哪个调用点、什么条件插入（夹具断言可复现）？`reusableEmptyGoals` 为什么没被这个路径命中（判据哪一项在无消息联系人身上失败——例如 `creation_no IS NULL`、`cursor_scope_digest` 口径差异、`eligibility_json` 自首次以来变化，或该路径根本没走 `reusableEmptyGoals`）？
2. 阶段 A 列出的"租约置 lost"4 条候选释放路径逐条命中/排除（共享读取器 release、intentionalRelease、observeGuardLoss、轮转交接），证据要定位到行号＋夹具。
3. 每轮的 0 页读取（读库动作）是哪个调用发出？是否随修正可消除？（消除与否最终问用户。）

阶段 A 完成后停下，在 `## Comments` 写结论并 `Triage:` 保持 `ready-for-agent`（用户已在总批准里授权"先归因再修"），直接进入阶段 B 的最小修正——除非触及停止条件。

## 阶段 B：最小修正

- 对证实来源只做"行数不滚大"的最小改动：复用判据扩展到对应路径；候选（不是预设）：该调用点在判据命中时不再 INSERT/作废。
- 承接任务 01 合同：重证不省、invalidated 不复活、purge 不放宽、真实库只读、无迁移（必需则版本 44 并先报告）。
- 夹具验收：无消息联系人空闲 1 小时（注入时钟、探针 300 s）0 新行；有消息联系人回归结果与阶段 B 后一致；判据负向测试扩展覆盖新路径。
- 若发现修复后仍存在"每轮空读库"或"页数 ≥1 的行永远新建"，照实记录为决策点。

## 验收 / 停止条件 / Test seam

见 [spec.md](../spec.md)。验证命令：

```bash
cd backend-ts && node --test --test-name-pattern="<名称>" test/sqlite-history-goal-reuse.test.mjs
cd backend-ts && node --test test/sqlite-history-goal-reuse.test.mjs test/sqlite-goal-retention.test.mjs test/sqlite-incremental-sync.test.mjs test/sqlite-history-parked-sync-handoff.test.mjs
```

## Answer

**归因定稿**：① certified-absent 空闲探针循环本来就是 0 新增（阶段 A 的"+1"猜测被勘误推翻，`readCoverage` 的 emptyTargetAwaiting 豁免使其不进重验）；② 真正 +1 的是事件驱动重验轮对同身份 complete 空目标（阶段 B 判据的 state 子句漏判——唯一点，克隆实验证明）；③ lost 释放 4 条候选全部钉死：(a) 共享读取器换手（stub 按真实 `#releaseOwner` 合同证实，微信原生通道无 park）、(b) 探测轮成功后的正常释放（settle 路径）、(c) observeGuardLoss（事件级）、(d) 停止/重启路径——全部事件级，不是周期自转的写入者。

**修正**：goal-reuse 判据新增第三形态（complete 0 页无记录空 history 行可续用），`history.begin` 命中时同事务同行复位（state running→读空页→complete），行数不增长、读取频率保持（用户决策：每轮 0 页读库不消除）。

**验证**：夹具 6 用例（空闲 3 轮 0 行 0 页、手动重验同行程、判据正负向含 capture_record 排除、observe 事件级、协调器 stop、共享换手）+ 指定回归 11 文件 104 用例 3 次全绿（`perl alarm 900 -- node --test …`）。

**数据处理影响**：只减少新行创建，无迁移，真实库未触碰（全程合成夹具）；sync_capture 写入频率不变。

**剩余风险/决策点（详见 spec.md"遗留决策点"）**：① pages_accepted≥1 的 handoff 行（空页接受也算页）按合同仍每轮重建（+1）——扩展到"空页即可复用"需用户另批；② 重载窗口观察过一次 arm/释放竞态下的防御性围栏（reason=history_source_continuity_unverified），fenceContinuity 写入点未复现定位——如实标注未决。

## Comments

## Comments
