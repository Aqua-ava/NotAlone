# 图片同步查询线性化

Triage: ready-for-agent
State: claimed

Blocked by: none

## Goal

把 `image-sync-actions.ts` 中逐行执行的相关 legacy cutoff 子查询提升为一次性 `legacy` CTE，保持图片同步结果、分页顺序、空 cutoff、已有 legacy cutoff 和退避语义不变。

## Acceptance

- [x] 大联系人合成数据不再出现按消息数 × 尝试数增长的相关扫描。
- [x] 空 legacy cutoff、多个 legacy attempt 和既有当前版本 attempt 的结果与原实现一致。
- [x] `media.imageSyncTargets` 与 `media.imageRefreshPending` 的查询参数顺序正确。
- [x] 同一数据集上记录修复前后耗时和查询计划。
- [x] 相关图片同步、历史同步和类型检查通过。

## Test seam

公开 `media.imageSyncTargets`／`media.imageRefreshPending` 存储动作及 `SqliteImageSyncCoordinator` 行为；不只断言 SQL 字符串。

## Answer

实现已完成并自测通过；State 保持 claimed，等待 Lead 安排的独立 Standards／Spec 审查。

### 实现摘要

- `backend-ts/src/media/sqlite/image-sync-actions.ts`：把 `preparation` 中逐行执行的 legacy cutoff 相关子查询提升为顶层一次性 `legacy` CTE（`coalesce(max(s.rowid),0)`），`preparation` 用 `CROSS JOIN legacy l` 及 `p.rowid>l.cutoff` 比较；`scope()` 参数顺序跟随 `legacy→attempts→preparation→work` 由 3 组 owner/contact 扩为 4 组。语义保持：空 cutoff 归零、已有 legacy cutoff、多个 legacy 尝试、当前版本尝试、`attempts` 重试计数与退避分支均未改。导出 `imageSyncWorkSql` 仅供回归测试与基准脚本读取实际查询计划，不参与产品装配。
- `backend-ts/test/fixtures/sqlite-image-sync/scenarios.mjs`：确定性合成夹具（固定联系人/消息/尝试/请求键/时间，走真实表约束与触发器），提供边界场景（分页、排除路径、空 cutoff、已有 cutoff、多 legacy、准备退避阶梯、单图重试阶梯）和大联系人场景（1,200 图片消息、6,936 次提取尝试，其中 legacy 5,764、当前版本 1,172）。
- `backend-ts/test/fixtures/sqlite-image-sync/legacy-work-sql.mjs`：修改前 `workSql` 冻结快照，只供基准脚本在同一数据集上复现修改前耗时/计划。
- `backend-ts/test/fixtures/sqlite-image-sync/golden.json`：修改前实现通过公开存储动作采集的 27 个边界用例 + 6 个大联系人用例结果（messageId 归一为 `<message>`）。
- `backend-ts/test/sqlite-image-sync-linearization.test.mjs`：公开 seam 回归（结果黄金样例等价、目标顺序、刷新/退避语义、查询计划、P95 耗时）。
- `backend-ts/scripts/perf/image-sync-query-baseline.mjs`：可重复基线/对照脚本（`--emit-golden` 采集黄金样例；默认测量当前动作与冻结旧 SQL 的耗时、计划、结果与等价性）。

### 修改前基线（同一合成夹具，Node v24.21.0）

夹具：`synthetic-contact-large`；图片消息 1,200，提取尝试 6,936（legacy 5,764、当前版本 1,172），媒体头 1,148，媒体文件 139，规范化捕获 1,200。查询参数 `now=1800000000000`，`after='0'`。

| 指标 | 修改前 |
| --- | ---: |
| `media.imageSyncTargets` 动作 P50 / P95 / max | 1077.874 / 1095.173 / 1095.173 ms |
| `media.imageRefreshPending` 动作 P50 / P95 / max | 1070.282 / 1080.123 / 1080.123 ms |
| 直接执行修改前 SQL P50 / P95 / max | 1084.485 / 1092.672 / 1092.672 ms |
| 结果数量 | 首页 64 条；到期遍历 931 条；pending=true |

修改前查询计划（`EXPLAIN QUERY PLAN` 关键行，完整计划见脚本输出）：`MATERIALIZE preparation` 下命中 `CORRELATED SCALAR SUBQUERY 2` → `SEARCH s USING INDEX media_attempt_record (owner_id=? AND contact_id=?)`，即按 `preparation` 每一行重算 legacy cutoff；同一联系人的 `owner_id/contact_id` 对每个当前版本尝试行重复扫描尝试表。

### 修改后同一数据集

| 指标 | 修改后 | 变化 |
| --- | ---: | ---: |
| `media.imageSyncTargets` 动作 P50 / P95 / max | 8.423 / 8.797 / 8.797 ms | P50 约 128× 降低 |
| `media.imageRefreshPending` 动作 P50 / P95 / max | 5.065 / 5.260 / 5.260 ms | — |
| 直接执行新 SQL P50 / P95 / max | 8.217 / 8.443 / 8.443 ms | — |
| 结果数量 | 首页 64 条；到期遍历 931 条（sha256 与修改前一致）；pending=true | 无变化 |

修改后查询计划：`MATERIALIZE preparation` 下为一次性 `MATERIALIZE legacy` → `SEARCH s USING INDEX media_attempt_record (owner_id=? AND contact_id=?)`，随后 `SEARCH p`、`SEARCH h`、`SCAN l`；不再存在相关子查询内扫描 `media_extraction_attempt` 的节点。冻结旧 SQL 在同一数据上仍为 1095.006 / 1113.476 / 1113.476 ms，证明差异来自 SQL 结构而非数据或环境。

### 等价性证据

- 大联系人（6 个用例）：首页、第二页、刷新窗口首页、刷新窗口续页、到期遍历（计数 + 顺序 + 请求键 sha256）、pending；与修改前黄金样例完全一致。
- 边界（27 个用例）：空 cutoff（当前版本尝试次数决定联系人级退避 1/5/30/60 分钟/1 天阶梯）、已有 legacy cutoff（cutoff 前当前版本尝试不计入 preparation，全部立即到期）、多个 legacy 尝试（单图重试 1 分钟/5 分钟/30 分钟/6 小时/1 天阶梯）、缩略图刷新窗口、原图/清除/隔离/主图分类/缺规范化捕获/运行中尝试/无媒体头等排除路径、两联系人参数隔离。
- 计划断言：全查询计划中不存在“相关子查询 → `media_attempt_record`/`media_extraction_attempt` 扫描”，并包含一次性 `legacy` CTE。

### 实际命令与结果

```text
export PATH=/tmp/notalone-node/bin:$PATH
node backend-ts/scripts/perf/image-sync-query-baseline.mjs --runs=10 --label=before --emit-golden  # exit 0，采集基线+黄金样例
node backend-ts/scripts/perf/image-sync-query-baseline.mjs --runs=10 --label=after                 # exit 0，修改后对照
cd backend-ts && node --test test/sqlite-image-sync-linearization.test.mjs  # RED（修改前）：tests 3 / pass 2 / fail 1；P95 1099.32ms > 100ms
cd backend-ts && node --test test/sqlite-image-sync-linearization.test.mjs  # GREEN（修改后）：tests 3 / pass 3 / fail 0
cd backend-ts && node --test test/sqlite-image-sync.test.mjs                 # pass 27 / fail 0
cd backend-ts && node --test test/sqlite-original-image.test.mjs             # pass 8
cd backend-ts && node --test test/sqlite-image-memory.test.mjs               # pass 5
cd backend-ts && node --test test/sqlite-image-quality-evidence.test.mjs     # pass 26
cd backend-ts && node --test test/sqlite-media.test.mjs                      # pass 21
cd backend-ts && node --test test/sqlite-media-host.test.mjs                 # pass 2
cd backend-ts && node --test test/sqlite-incremental-sync.test.mjs           # pass 10
cd backend-ts && node --test test/sqlite-clear-resync.test.mjs               # pass 17
cd backend-ts && node --test test/sqlite-history-sync-status.test.mjs        # pass 7
cd backend-ts && node --test test/sqlite-history-recertify-async.test.mjs    # pass 16
cd backend-ts && node node_modules/typescript/bin/tsc --noEmit              # exit 0
```

RED 阶段黄金样例由修改前实现生成，因此“结果等价”在旧实现上通过、仅性能断言失败，符合先失败后通过的 TDD 记录；修改后回放全部黄金样例通过。

### 未覆盖项与风险

- 仅本机 macOS + Node v24.21.0 + 合成数据；未做真实 App／桌面验收（由 Lead 独占），未接触真实聊天资料。
- 未在 Lead 的 `/tmp/notalone-baseline` worktree 重跑全量基线；本 ticket 的修改前数据在修改前同一工作树上由同一脚本采集，脚本内置修改前 SQL 冻结快照，可在同一命令下重复对照。
- 计划断言依赖当前 Node 内嵌 SQLite 的计划文本表述；升级 Node/SQLite 后需复核断言。
- 未覆盖 P02 后台只读通道下的端到端行为（并行 Agent 负责）；本 ticket 只改图片同步动作 SQL 与参数顺序。
- `imageSyncWorkSql` 为测试/基准新增公开导出；若审查要求收窄，可移到独立诊断模块，行为不变。
