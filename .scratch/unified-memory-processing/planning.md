# 统一记忆处理：实现任务索引

发布状态：用户已于 2026-10-27 确认粒度和依赖，六张正式任务均已完成。

规格：[统一记忆处理生命周期](spec.md)。[已确认拆分](ticket-proposal.md)。任务均为 Triage: ready-for-agent，01—06 已 resolved；依赖图已全部完成。

依赖：01 → 02 → 03 → {04、05} → 06。04、05 可在03完成后并行，06等待两者；六票均已实现并完成约定验收。

| 编号 | 任务 | Blocked by | State |
| --- | --- | --- | --- |
| 01 | [一个真实状态入口，联系人与本人分开](issues/01-unified-state-and-scope.md) | 无 | resolved |
| 02 | [一次暂停与继续控制整个范围](issues/02-persistent-pause-and-continue.md) | 01 | resolved |
| 03 | [固定一轮资料，完整处理到画像](issues/03-fixed-round-complete-pipeline.md) | 02 | resolved |
| 04 | [新资料自动接续，受阻只阻止当前联系人](issues/04-automatic-next-round-and-blocking.md) | 03 | resolved |
| 05 | [重启后安全恢复未完成工作](issues/05-safe-startup-recovery.md) | 03 | resolved |
| 06 | [存量任务安全接入并完成旧入口收口](issues/06-legacy-adoption-and-delivery.md) | 04、05 | resolved |

## 执行约定

- 领取前核对依赖都已 resolved，再将当前票改为 claimed；不要把 ready-for-agent 当作忽略阻塞边的许可。
- 每票在独立上下文中读取规格、对应任务和必要决策，复用用户已确认的三层验收入口。
- 01先固定最小轮次／归属／控制合同；02同时覆盖旧执行门禁；03形成稳定单轮执行合同，避免02与03隐性互相依赖。
- 04与05共用03合同；重启后衔接后续轮次的交叉场景在06验收。
- 只有真实验收完成后写入 Answer 和验证结果并置 resolved；不能因仅有代码、类型或合成通过而宣称全部集成可用。
- 使用实现流程时只做本地分支与提交；保持热更新开发和发布门禁，未经用户明确授权不推送或创建PR。
