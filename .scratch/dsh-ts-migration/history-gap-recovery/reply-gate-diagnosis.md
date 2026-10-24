# 历史覆盖未知时回复门禁缺口

## 现象

实际 TS 历史运行态在总开关关闭时公开 `cli_history_coverages=[]`，`ran` 页面显示
“消息历史覆盖尚未确认”，但输入小窗仍允许发起生成。现有证据见
[verification.md](verification.md) 的“根级实际 App 验收”。

## 根因

- Python 基线 `PostgresReplyHistoryCoverage` 在 active 绑定没有历史任务时，还会检查
  账号级 `wechat_history_sync_authorization` 的版本 1 accepted，并合成
  `not_started` 阻止生成。
- TS `requireReplyScope` 移植时只保留历史任务行和逐绑定授权；两者都不存在时，SQL
  WHERE 把这行过滤掉，最终 phases 为空并静默放行。
- Desktop `historyReplyEligibility` 在账号 accepted、但当前联系人没有覆盖行或数组为空
  时返回 `undefined`，因此按钮没有 `not_started` 禁用状态。

## 最小修复候选

- `reply-scope` 恢复账号级 version 1 accepted 兜底，同时保留逐绑定授权；declined/
  required/未知版本仍走原增量路径。缺任务时视为 `not_started`。
- Desktop 在 accepted 下缺失当前联系人覆盖（空数组、字段缺失或只有其他联系人）
  均返回 `not_started`；完整覆盖和明确 incomplete 原合同不变。

## 合成验证

- 红测分别复现后端 MISSING rejection 和桌面 `undefined !== not_started`。
- 后端门禁、HTTP、准备与历史组合 20/20。
- Desktop unified workspace 与系统 Chrome 无头警告页 10/10。
- Backend TS 与 Desktop `tsc --noEmit` 通过。
- 同联系人一个 complete、另一个 active 绑定未开始时仍阻止，不能由任一完整绑定绕过。

## 未覆盖

未重新启动 App/微信，未发送消息，未调用真实模型；实际 App 门禁需根集成后单独复验。
票 20 保持 claimed。
