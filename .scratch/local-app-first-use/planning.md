# 本机首用实施票据索引

> 2026-10-23：用户已批准方案并要求发布实施票据，先不写代码。全部新票 open，发布不等于启动实现。规格见[spec](spec.md)。

## 粒度与阻塞关系

| 票据 | 依赖 | Triage | State |
| --- | --- | --- | --- |
| [01 核实无开发环境的微信准备路线](issues/01-wechat-preparation-feasibility.md) | 无 | ready-for-agent | open |
| [02 补齐自动建库与原库生命周期](issues/02-database-lifecycle.md) | 无 | ready-for-agent | open |
| [03 接入可恢复的微信组件准备](issues/03-wechat-component-preparation.md) | 01 | ready-for-agent | open |
| [04 补齐首用范围选择与主界面衔接](issues/04-first-connection-scope.md) | 03 | ready-for-agent | open |
| [05 补齐模型设置与用途提示](issues/05-model-setup.md) | 无 | ready-for-agent | open |
| [06 补齐恢复诊断与删除确认](issues/06-recovery-and-deletion-ui.md) | 02 | ready-for-agent | open |
| [07 验证开发态完整首用与恢复](issues/07-integrated-development-acceptance.md) | 02, 04, 05, 06 | ready-for-agent | open |
| [08 整理独立交付验收前置清单](issues/08-release-readiness.md) | 07 | ready-for-agent | open |
| [09 完成同版安装产物与干净机器验收](issues/09-clean-machine-release-acceptance.md) | 08 | ready-for-human | open |

01 → 03 → 04；02 → 06；02、04、05、06 → 07 → 08 → 09。07另依赖原历史同步票08的真实验收；09另依赖用户明确发布授权、干净目标机器及必要凭据／测试范围。01若证实路线不可交付，03及其后续保持阻塞并回到决策，不把调研完成视为可行。

首次可执行前沿为01、02、05，仅在用户后续要求实现时开始。票02与06串行；票03与04串行；票05若与首用控制器共享文件须协调单一写入者。当前CLI另有会话改动，开始前先核对并接续，不覆盖。

## 与既有任务的归属

- [独立交付01](../standalone-app-delivery/issues/01-managed-first-run.md)：已实现部分复用，剩余生命周期归02，干净机器归09。
- [独立交付02](../standalone-app-delivery/issues/02-wechat-onboarding.md)：未解决的接入路线由01、03承接，不重复被中止路线。
- [独立交付03](../standalone-app-delivery/issues/03-confirmed-sync-and-reply.md)：完整流程缺口由04、07承接。
- [独立交付05](../standalone-app-delivery/issues/05-release-acceptance.md)：新的整体验收入口为08、09，旧证据保留。
- [原库启动](../in-place-database-startup/spec.md)及[104修复](../authorized-private-history-sync/repair-104-migration.md)：复用完成结果，02只补回归和缺口，不重做迁移修复。
- [首次账号连接](../wechat-first-connection/spec.md)：复用已有全部私聊分支，04补默认单会话和组合路径。
- [历史同步票08](../authorized-private-history-sync/issues/08-real-wechat-acceptance.md)：保持原负责人及真实验收归属，07引用并验证组合行为，不另建同步实现票。

旧票状态不因新规划自动关闭。后续负责人在对应新票完成时把证据回填旧票，按其剩余验收条件决定状态；旧票历史“手动首版／备份搬库”等要求按 ADR-065 后续修订、ADR-066、ADR-087、ADR-101 的现行范围判断，不能恢复已退役目标。

票06另承接 ADR-094 的调用台账删除缺口，验证单来源保留、整体清除、隔离及晚到调用不能回填；现有删除服务不能作为完整实现证据。

## 本轮验证

仅文档结构、依赖、链接、一致性及公开历史检查；不运行产品、测试库或模型，不读取聊天。实际结果由本轮提交与最终回报记录，票据保持open。
