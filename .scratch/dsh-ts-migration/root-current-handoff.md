# 根迁移持续目标

用户要求的目标正文修正无法由当前目标工具改写，以下为持久执行约束：无依赖任务必须创建全新、用户可见的 Codex 会话，不是 sub-agent；会话直接通信，主会话统一集成并独占 App／微信验收。当前验收联系人使用 `cloudy`；此前 `ran` 的证据保留但不再使用。不得发送未明确指定的外部消息。用户已授权全部可用额度并确认后续可安全推进的步骤，禁止 push、打包或创建 PR。`get_goal` 仍返回旧 `ran` 正文和 `blocked` 状态，不得谎称目标正文已更新。

当前代码 HEAD 为 `030d3e1c9b2d3bf1841cd4d34f84e2ffc909da75`。用户已要求所有现有会话收尾，后续由新 agent 接管；不得继续等待旧会话或扩大验收。

- Ticket 01—24 均 `resolved`；Ticket 25 为 `claimed`，Ticket 26 为 `open`。
- `282f43af` 收紧未知/风险项候选并修正 SSE 终态；`d59ffd0a` 修复跨助手会话停止投影；`cca335e4` 补齐 Python 兼容中断路由的 `user_cancelled`。
- `5696cd91` 修复多消息边界空行后，全 96 次正式重跑为 96/96 成功、完整五阶段；新臂质量
  48/48、严重假事 0，旧臂 21/48；调用数、token、失败率和 p50/p95 通过，但费用比 1.271635
  （95% CI 1.22812–1.32237）仍超过 1.10，Ticket 25 保持 `claimed/not approved`。
- 费用独立审计确认 1.271635 是真实缓存命中结构差异，不是费用公式或分母错误。`56f8e3b8`
  只稳定 system/tools 的 8 次小样仍为 1.438；wire 分析定位到 user payload 在随机 evidence
  UUID 第 443 字符处分叉。
- `98ec114f`→`5c34f869`→`fb64f0ee`→`cf88db24` 逐步补齐请求局部 evidence/history/
  discussion/Skill alias、嵌套 JSON 与 v2 catalog/mapping 生产采集。`cf88db24` 的回复
  454/454、Skill 93/93、比较/来源/盲包 258/258、三轮 RED 11/11 和类型检查通过。
- `030d3e1c` 已补分层资料 system/read_scenario alias 与实际 DSH+PG 来源采集；定向回归
  58/58、TypeScript、`git diff --check`、公开扫描通过。仍需第五位可见审查并在最终切片后全量回归。
- 实际 App 停止验收已通过：按钮可见，补丁 `queued→generating→stopping→cancelled`，turn `88e65711-0d21-4cd6-934b-2e3de6909937` 为 `failed/user_cancelled`，候选 0，界面明确显示未保存候选。
- DBX 已无损保存 `notalone_restart_connectivity_20261025.sql` 后关闭；未丢弃未保存查询。

开发 App 当前仍由 `npm run dev` 运行，保留五项 TS 开关与 `NOTALONE_DEV_CDP=1`，使用原资料目录；
CDP 仅作脱敏事件观察。全程未发送微信消息，未保存或上传视觉帧。

下一步：

1. 从 `030d3e1c` 继续：先交第五位全新可见审查并重跑最终回复全量；`b3966784` 是 Ticket 25 交接。
2. 明确 `approve` 后建立足额新预算，跑固定 96 次、无重试、全分母、完整五阶段与新双盲/第三裁决；
   费用、质量、失败率、调用、token、延迟任一未通过均保持 `claimed / not approved`。
3. 最终代码变更后重新核验 App 生成、停止、联系人和同步范围闭环；Ticket 25 通过后才可推进 Ticket 26。
4. 收尾时正常退出开发 App，清理合成来源、测试库和自有进程，保留证据；不 push、不打包、不创建 PR。

绝不暂存：`desktop/tests/fixtures/expression-preference-backend.py`、`desktop/tests/fixtures/expression-preferences-page.py`、`desktop/tests/memory-correction/retirement-react.test.mjs`。
