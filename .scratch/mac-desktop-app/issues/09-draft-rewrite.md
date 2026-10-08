# 09：草稿改写与候选编辑

Type: task
State: claimed
Triage: ready-for-agent
Blocked by: 06
Spec: ../spec.md

## 交付行为

输入或粘贴草稿，选择本次语气/要求，经真实后端生成候选并编辑。

覆盖规格用户故事：22、23、24、25、27、28、29。

## 验收条件

- [ ] 默认 rewrite_draft 且关系语境关闭；用户可明确打开，只提交当前联系人和本次输入。
- [ ] 展示真实候选或澄清、处理中、核实提醒、超时和失败；保留原候选快照，编辑独立存于本次运行。
- [ ] 相同输入重试复用幂等键，改变输入或明确重新生成使用新键；可控模型捕获范围，测试不伪装为语义质量评测。

## 测试与范围

- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Comments

- 2026-10-09：主 Agent 已完成增量两轴：固定范围 `b72a93468cf5c2c79eb16aafe0798957cb897890..ef44e1794b78d5b397072c6ea50dda8d1014bf66` 的 Standards hard 0 / possible 0、Spec 0，原 P3 已修，merge 五处接线与共享 hook 等价核查无问题。合并及修复后各一次 `npm run typecheck`、`npm run build` 均 exit 0，差异与二十任务辅助检查通过；本次没有 App、后端或签名包运行，不把历史 UI 结果扩张为最新版通过。代码可先由主 Agent 安全合入供整体验收；任务保持 claimed，验收勾选和依赖不变，未写 Answer/resolved，不解除 10/11/12 阻塞，最新源码 App、合并接线与签名包继续待认可时段。
- 2026-10-09：主 Agent 已完成完整两轴，固定范围 `ef86567f1f9c7d5c780f2f03cac939eef3f05264..e025ec42ff93867adcb65bdcf363ecb326e6455a` 为 Spec 0、Standards 硬违规 0，只有订阅/revision 重复的 possible P3。采纳后先合入集成 `136a5bafc9d69e5208f6c9eaf45cc786469b1fe9`；五处真实冲突按 resolving-merge-conflicts 逐处保留 16 授权、09 改写、门禁及 04 记录，固定增量修复基点为 merge `b72a93468cf5c2c79eb16aafe0798957cb897890`。
- 2026-10-09：小型 `useRevisionedSession` 仅供 contacts/replies 两处共享订阅、卸载保护、单调 revision 与切换范围清除错误；各自初始状态、业务操作和具名桥接保留。Context7 不可用，核对 React 19.3 [useEffect](https://react.dev/reference/react/useEffect)、[useRef](https://react.dev/reference/react/useRef)、[useCallback](https://react.dev/reference/react/useCallback) 与实际安装 19.3.0；合并及修复后 types/build 均通过，不添加镜像 hook 测试或通用 store。历史实际验收保持下方记录，最新版 UI、合并接线及签名包继续待认可时段；任务 claimed，未写 Answer/resolved、不解除 10/11/12 阻塞，已完成增量双轴结论见上方记录。
- 2026-10-09：用户明确选择先继续不触桌面的工作，实机验收稍后安排。保留原实现并合入集成 `ef86567f1f9c7d5c780f2f03cac939eef3f05264` 的测试门禁；独立重启显式使用统一 `launchApp`，没有以 `npm start`、直接 Playwright 或旧命令绕过预约。当前只完成源码候选、类型/构建检查与只读启动路径审计；没有新 App 时段或启动额度，任务保持 claimed，等待主 Agent 两轴评审和后续预约验收。
- 2026-10-09：历史实际结果保留：默认改写的关系语境控件缺失、丢失生成响应后的错误分类各经历 red → green；新增 9 条实际 App 行为已分组通过，并在首轮完整回归通过。首轮完整结果为 95 passed / 1 failed，唯一失败是任务 06 尚把生成按钮当占位能力的禁用断言，已改为有草稿时启用。后续完整回归因用户要求优先解决桌面干扰而 Ctrl+C 中止，session 34837 exit 130，21 passed / 75 did not run；不能写成完整 96 条通过。中止后已确认 worker PID 67969 消失，本工作树自有 Electron/后端和改写夹具临时目录已回收。
- 2026-10-09：历史后端相关命令 `python -m unittest tests.integration.server.test_rewrite_history_permissions tests.integration.server.test_reply_api tests.integration.server.test_core_business_flow -v` 在当前工作树 `backend/src`、Conda NotAlone 与隔离配置下通过 15/15；只创建、迁移并回收本轮随机 `_test` 库，未访问业务库、外部模型、微信或剪贴板。合入门禁并适配重启后，`npm run typecheck`、`npm run build` 均 exit 0；文档与辅助校验继续用于候选收尾，不代替 UI 结果。
- 2026-10-09：递延项包括最新源码的受控 App 回归、修正后的任务 06 生成按钮断言、补充的候选单选断言、输入快照文案与要求标签布局、重启门禁的真实 App 适配，以及本任务最终签名包和相关 App 验收。当前模型为受控外部边界，候选结构/权限/幂等结果不证明真实模型中文质量；当前后端没有公开澄清对象，不能把空候选或本地等待冒充澄清或服务端进度。未写 Answer 或 resolved。
- 2026-10-08：任务 09 在独立工作树开始实现；按已批准的实际 App、HTTP 和隔离 PG 接缝逐片 red → green。当前后端仅返回真实候选与风险备注，不把本次 POST 等待伪装为服务端异步进度或澄清结果；评审由主 Agent 统一安排。
- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。
