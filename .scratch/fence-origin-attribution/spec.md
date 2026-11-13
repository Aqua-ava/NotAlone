# history_source_continuity_unverified 围栏的"本源"只读调查

Triage: ready-for-agent
State: claimed

> 来源：2026-11-07 空探针轮任务的重载并发窗口观察到一次"瞬时码失守伴随防御性围栏"（报告 `docs/verification/read-goal-empty-probe-attribution-20261107.md` 遗留决策点 ②）；用户 2026-11-07 批准本任务："只读调查，不改产品代码"。

## Goal

回答一个问题：那次 `history_continuity_fence(reason='history_source_continuity_unverified')` 到底由哪个 `fenceContinuity` 调用点写出？在"共享读取器换手与重验并发的窗口"里它是否真实可复现。

## 阶段 1：调用点清单（纯代码走查，不改代码）

`backend-ts/src/history/sqlite/*.ts` 里 `fenceContinuity` 的全部调用点（现阶段已知 8 处，逐一核验后以此为准）：

- `actions.ts:122`（guardAcquire 士兵不匹配/状态非 active）、`actions.ts:125`（guardAcquire 对旧数据无可证明基线）、`actions.ts:143`（guardRelease 的 deferVerification!==true 且 normalUse!==true / sourceLost===true）、`actions.ts:148`（markContinuityLost 的 scope 匹配）；
- `continuity.ts:91`（preflightGeneration 对现存 lease 状态非 active/归属不匹配）、`continuity.ts:95,96,99`（preflightGeneration/preflightTarget 的 scope 与资料面检查）、`continuity.ts` 内 `preflightTarget` 末段与 `prepareNormalUseTarget` 内部多个 `return {ok:fenceContinuity(…),revalidated:false}` 分支。

产出表：调用点→调用方（哪个动作/服务层）→ 触发条件（具体布尔表达式）→ "重载并发窗口"（arm 与释放在事务间交错、注入 loss 抢在整备前后、换手与重验并发）里该条件是否可成立、成立的写入路径编号。若某点在该窗口"可成立"，给出一个具体的交错序列（叙述即可，不必夹具证明）。

注意：所有写围栏的路径都在写事务内；要关注的是**哪个动作先后被哪个调用方串起来**（guardRelease 由 `RetainedGuard.release` 的 holder close 触发、prepareNormalUseGuard 由 armGuard 触发、readPreflight/preflightGeneration 由 synchronize 入口触发、guardAcquire 由无 proof 的 armGuard 触发、markContinuityLost 由 `isSourceContinuityLost(error)` 的 catch 触发）。写成"序列 A→B 一事件级步骤"。

## 阶段 2：合成夹具复现（只加测试代码，不改 src/）

在 `backend-ts/test/sqlite-empty-probe-loop.test.mjs` 的复用式夹具上写一个**压力重现测试**（新测试文件或该文件内新增用例，选其一并说明理由）：

- 场景：共享读取器换手（按 `#releaseOwner` 合同的 stub）＋ 事件驱动重验并发，注入 `lossCode='history_snapshot_closed'`，时钟注入与既有夹具一致；
- 至少连跑 **20 次**（测试内循环或 `--test-repeat`；记录每次围栏命中与否、命中时输出的 fences 行、lease 行与错误码）；
- 判定"命中"标准：`history_continuity_fence` 出现 `reason='history_source_continuity_unverified'` 行，或测试输出里围栏行数变化事件；
- 结果写入 `docs/verification/fence-origin-attribution-20261107.md`：命中次数 / 20，未命中时的并发压力说明（尝试过的竞态窗口：触发点在 targets 打开前后、arm 前后、换手前后）。

## 停止与结案条件

- **未复现**：按用户口径结案：任务单 `State: resolved`，报告写明"若再次出现需要保留的现场清单"：发生时间（毫秒级）、联系人 contact_id 前 8 位、围栏 reason、当时的 `database_instance.epoch` 与 `runtime_id`、事发前后各 5 分钟内该联系人的 `read_goal` 时间线（kind/state/failure_code/created_at、同一 SELECT 口径即可）以及**那时是否在跑事件驱动重验或共享换手**（/tmp/notalone-dev.log 对应时间窗）。测试改动按"证据保留"标准决定是否保留提交（未复现的版本若只是负载探针，可保留但注明非回归锚点；提交说明里写清楚）。
- **复现**：`State: claimed` → `Triage: ready-for-human`，把最小复现序列、命中数据、候选写入点与候选修复方向写进报告，**停下等用户批准修复方案**；不写修复代码。

## 硬边界

- 不修改 `backend-ts/src/**`、`desktop/src/**` 的任何文件（产品代码）；只允许新增/修改 `backend-ts/test/**` 的测试与夹具、`docs/verification/**` 报告、本任务单文件。
- 真实库只读（`sqlite3 'file:...?immutable=1'`；本机普通 readonly CANTOPEN），本任务原则上不碰真实库；不启动 App、`pnpm run dev` 禁止、不联网、不装依赖。
- 工作树保护清单（5 个用户文件）不得触碰；每主题一个提交（若提交测试，标题中文、正文 1、2、3、4、无署名行、不 push）；`node scripts/check_public_history.mjs --ref HEAD --working-tree` issues=0。
- 夹具等待遵守等待纪律：有界等待，不 sleep 轮询；20 连跑整体有明确时间上界。

## 常用命令

```bash
cd backend-ts && node --test test/sqlite-empty-probe-loop.test.mjs
cd backend-ts && (set -o pipefail; perl -e 'alarm 600; exec @ARGV' -- node --test test/sqlite-empty-probe-loop.test.mjs test/sqlite-history-goal-reuse.test.mjs 2>&1 | tail -20)
```

## Answer

（执行 Agent 填写：调用点清单与窗口判定结论、复现结果、提交哈希、遗留风险。）

## Comments
