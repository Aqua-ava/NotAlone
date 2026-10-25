# 根迁移持续目标

本会话持续目标为 active；当前目标工具不能改写既有正文。最新执行范围先读[验收范围更新](acceptance-scope-update.md)：用户已暂豁免费用门槛，停止费用专属优化／重跑；记忆真实验收改用本轮指定且唯一核验的联系人，身份映射仅保存在仓库外私有资料。无依赖任务使用全新可见 Codex 会话，不是 sub-agent；会话互通，根统一集成并独占桌面。仍不 push、不打包、不创建 PR、不发送外部聊天消息。

最后产品源码锚为 `030d3e1c9b2d3bf1841cd4d34f84e2ffc909da75`；接手续验提交 `70518615`。旧会话已收尾，不再等待；当前已按用户约定新建可见会话做双轴审查、v2 runner、非回复矩阵及宿主性能准备，均禁止自行调用真实模型或操作桌面。

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

接手 `npm run dev:status` 及 Computer Use 清单证实开发 App 已 stopped；桌面验收时按原资料目录与 TS 运行责任重新启动，不运行打包版。
接手最小 2/2、最终回复全集 456/456、后端 typecheck 通过；新真实模型调用 0。独立实测发现业务 JSON 正文被 alias 改写，待根修复；费用豁免不解除语义与来源门禁。

下一步：

1. 修复独立审查复现的业务 JSON 原文回归，完成实际 v2 采集接线及最终独立复审；`b3966784` 是上轮交接。
2. 优先以本轮用户指定联系人完成记忆真实覆盖，补齐冻结非回复矩阵和宿主性能；模型验证仍需足额有界预算、全分母、来源与独立语义审阅。
   费用仅记用户暂豁免，不为其单独重跑；质量、失败率、调用、token、延迟和其他未豁免门禁保持。
3. 最终代码后实际复验 App／微信范围闭环；Ticket 25 的未豁免条件通过后才推进 Ticket 26。
4. 收尾时正常退出开发 App，清理合成来源、测试库和自有进程，保留证据；不 push、不打包、不创建 PR。

绝不暂存：`desktop/tests/fixtures/expression-preference-backend.py`、`desktop/tests/fixtures/expression-preferences-page.py`、`desktop/tests/memory-correction/retirement-react.test.mjs`。
