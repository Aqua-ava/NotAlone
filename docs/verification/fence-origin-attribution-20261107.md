# fenceContinuity 围栏写入点归因与并发窗口复现（2026-11-07，只读调查·结案）

任务：`.scratch/fence-origin-attribution/issues/01-fence-origin.md`（阶段 1 调用点走查＋阶段 2 合成夹具复现）。未复现按口径结案；不改产品代码；真实库零触碰。

## 阶段 1：`fenceContinuity` 全部调用点（实际 20 处）

以 `rg -n "fenceContinuity" backend-ts/src/history/sqlite/` 枚举；按写入动作分组。所有写入者使用同一 reason 常量 `history_source_continuity_unverified`，写入前都先查重（同联系人已有围栏行则不重复）。

| # | 动作 / 路径 | 条件（具体表达式） | 重载并发窗口是否可成立 |
| --- | --- | --- | --- |
| 1 | `history.guardAcquire`（无 proof arm；`actions.ts:122`） | 既有租约存在且（state≠active 或 runtime/bind/conversation/source 任一不匹配） | 换手/重验并发下，若 arm 走无 proof 分支（normalUse=false 或 retainedTarget 存在）且租约陈旧 → 可成立 |
| 2 | `history.guardAcquire`（`actions.ts:125`） | 无租约但名下已有 read_goal（且 rearmEmptyContinuity 未适用） | 空闲窗内基本不成立（空联系人已有前轮租约行） |
| 3 | `history.guardRelease`（`actions.ts:143`） | `deferVerification!==true && (normalUse!==true \|\| sourceLost===true)` | **最可能的候选**：向观察到的 transient 场景里，只有"entry.normalUse=false"（无 proof 的 arm，比如报告非 normal-use 或 retainedTarget 路径）或"sourceLost=true"（lostCodes 错误码）成立；本夹具注入的 `history_snapshot_closed` 不在 lostCodes → 该次观察可成立的前提是"当时的活动 entry 是无 proof arm" |
| 4 | `history.markContinuityLost`（`actions.ts:148`） | scope 行匹配（conversation/source 同值）且错误码∈lostCodes | transient 码不成立；`history_source_changed/...` 等真失证码成立 |
| 5 | `history.readPreflight → preflightGeneration`（`continuity.ts:91`） | 租约行存在且 `state!=='active'` 或归属/代次任一不匹配；只在 metadataRevalidation=**false** 时执行 | 窗口内若有"leased state 从 lost 变 active 却结果未重验"的竞态可成立；normal-use 判定通过时被短路，不可成立 |
| 6 | 同上（`continuity.ts:95`） | scope 行 conversation/source 不匹配 | 来源真实变化才成立 |
| 7 | 同上（`continuity.ts:96`） | `scope.tables_json==='' && hasHistoryOrSuppression` | 只在"scope 空表但有时效资产"初态可成立 |
| 8 | 同上（`continuity.ts:99`） | 无 scope 且 `hasHistoryOrSuppression`（首次进入前已有历史/删除抑制） | 与并发窗口无关（生命周期首次） |
| 9–11 | `history.prepareNormalUseGuard → preflightTarget`（`continuity.ts:109/127/129`） | scope 未登记但已有历史/抑制（109）；tables 已读而目标 identity 过渡非 same/legacy-exact（127）；无 scope 兜底（129） | 目标 identity/过渡竞态可成立（探测到目标变化时防御性围栏，属设计） |
| 12–19 | `prepareNormalUseTarget`（`continuity.ts:170/171/174/176/179/187/191`） | 租约归属不匹配；scope 归属不匹配；storedTarget/accountKey 失配；storedTransition=null；scope 未登记但已有历史；非 prior normal-use 或 transition 无序；无租约但历史行存在 | 同上，全部进入条件与"目标/支持档真变化"绑定；transient 码注入不改变这些输入 |
| 20 | （夹具外推）重开/重启时的整链 | 重启语义本来围栏 | 与本观察无关（阶段 A 已归因为重验入口） |

结论（走查）：**全部写入路径都要求"真实的状态/身份/来源变化"或"entry 为无 proof arm 后被释放"**，与"transient 码失守"同窗成立的组合只剩 #3 的"无 proof arm 的 entry 在并发窗口被释放"。该组合在观察到的空探针轮夹具形态（normal-use 恒真、恒有 proof arm）里被走查排除为不可成立——与下面阶段 2 的 0 命中一致。

## 阶段 2：合成夹具复现（0/100 轮）

`backend-ts/test/sqlite-empty-probe-surface-stress.test.mjs`（只加测试代码，未动 src）：

- 变体 A（独占通道，10 轮/次）：settle 后每轮手动重验，注入 `lossCode='history_snapshot_closed'` 抢在目标打开前后（txn 与 inject 竞态最尖锐的窗口），每轮收口三次短推钟给探针释放机会；围栏行计数增量>0 记 1 次 hit。
- 变体 B（共享 stub 双联系人，10 轮/次）：按 `SharedWechatClient` 真实 `#releaseOwner` 合同写法，换手与重验并发、同窗注入 displacement loss。
- 结果：**5 次独立运行、每次 0/20，共 0/100**；其中第 4 次 4 个文件联合加负载运行（goal-reuse＋empty-probe-loop＋incremental-controls 同跑）仍 0/20。测试每次输出 `FENCE-HITS=0/20`（t.diagnostic）。
- 未采用的变体（如实记录）：把注入点挪到"arm 已完成后的页循环中段"（此时 entry 已绑定，release 不围栏），以及多联系人交错换手——按走查结论不可能命中 writers 的条件，未加测。

## 现场保留清单（再次出现时）

- **时间**：毫秒级（Wall clock 与 `/tmp/notalone-dev.log` 对应时间窗）。
- **联系人**：contact_id 前 8 位。
- **围栏行**：`SELECT * FROM history_continuity_fence WHERE owner_id=… AND contact_id=…`（reason 与 operation 无关字段全取）。
- **租约与运行现场**：`database_instance.epoch`、`runtime_id`；`history_guard_lease` 该联系人行全文（guard_id/state/runtime_id）。
- **目标时间线**：事发前后各 5 分钟该联系人 `read_goal`（`kind,state,failure_code,creation_no,created_at` 原值顺序）；同一窗口的 `sync_capture` 计数（空抓取页节奏）。
- **最近动作判断**：事发前 1 分钟内是否发生：开发热更新重启（dev.log "源码已更新"/"phase"行）、共享读取器换手（多联系人活动）、手动/前台触发重验、或任何 Agent 的真实库访问。

## 数据处理影响

无：未改产品代码、未触碰真实库、未删除/改写任何用户数据；新增测试与报告。围栏计数只读。

## 交付

- 测试：`backend-ts/test/sqlite-empty-probe-surface-stress.test.mjs`（迭代放大器，非回归锚点；单独提交注明其角色）
- 报告：本文件
- 提交哈希与任务单 State 见 git log / 任务单。
