# fenceContinuity 围栏写入点归因与并发窗口复现

Triage: ready-for-agent
State: resolved（2026-11-07：0/100 轮未复现，按用户口径结案；再现现场保留清单见报告）
Type: task（只读调查；不修改产品代码）

Blocked by: none

先读 [spec.md](../spec.md) 全文再开始。

## 阶段 1：调用点清单（产出见报告）

以 `rg "fenceContinuity" backend-ts/src/history/sqlite/` 实际枚举为准（不止 spec 预估的 8 处）。每处：调用方（动作/服务层）、触发条件的具体表达式、"arm 与释放事务间交错 / 注入 loss 抢在整备前后 / 换手与重验并发"窗口下是否可能成立及其事件序列叙述。

## 阶段 2：合成夹具复现

`backend-ts/test/sqlite-empty-probe-surface-stress.test.mjs`（新增重排放大文件）：无消息联系人夹具（同 sqlite-empty-probe-loop 夹具形态），每轮"手动重验＋loss 注入抢先 targets 打开"与"共享 stub 双联系人＋换手注入"两个变体，共 ≥20 轮连跑（t.diagnostic 打印每轮结果），整体有界（≤10 分钟）。判定/spec：围栏命中（`reason='history_source_continuity_unverified'`）计 hit。

## 停止与结案

- 未复现 → `State: resolved`；报告含 spec 所列"再现现场保留清单"（时间、联系人 ID 前 8 位、围栏 reason、epoch/runtime_id、±5 分钟 read_goal 时间线、当时是否在跑事件重验/共享换手与 dev.log 时间窗）。
- 复现 → `Triage: ready-for-human`，报告列最小复现序列＋候选写入点＋候选修复方向，停下等用户批准修复方案。

## Answer

调用点实枚举 20 处（guardAcquire 2、guardRelease 1、markContinuityLost 1、readPreflight→preflightGeneration 4、preflightTarget 3、prepareNormalUseTarget 7、启动重启链 1 外推）；走查结论：全部要求真实状态或身份变化，唯一与 transient 码同窗可成立的组合是"无 proof arm 的 entry 在并发窗口被释放"，但在观察到的空探针轮夹具形态里被排除。
复现：5 次独立运行每次 20 轮（变体A 独占通道手动重验×注入抢先 + 变体B 共享换手×注入）= 0/100，含 4 文件负载干扰联合跑仍 0/20 —— 按"未复现"结案；防重现现场保留清单（时间毫秒级、ID 前 8 位、围栏行全文、epoch/runtime_id、±5 分钟 read_goal 时间线与 sync_capture 计数、最近事件判断）已写入 docs/verification/fence-origin-attribution-20261107.md。
遗留：重演该观察需产品侧假设（例如"当时的 entry 实为无 proof arm"），若再现按现场清单采集后另立任务。

## Comments
