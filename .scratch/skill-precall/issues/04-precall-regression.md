# 04 — 单次调用、失效与预算回归

Type: task
State: resolved
Triage: ready-for-agent
Blocked by: 01, 02, 03

按 [spec](../spec.md) 完成 Skill 预加载的行为回归、正式 profile 验证和修改前后性能对照。

## What to build

- 覆盖正常路径一个 Skill、多 Skill、无 Skill，全部断言物理模型调用次数。
- 覆盖 `skill` 目录工具不可见、`skill_resource` 可用且最多两次。
- 覆盖禁用、未核验、缺失、revision 变化、删除和来源失效。
- 覆盖 Skill 正文导致输入预算超限时的整体无 Skill 降级。
- 覆盖显式 `selectedPackageId` 兼容路径。
- 覆盖 Agent 取消、超时、释放和迟到结果。
- 使用正式 DSH profile 和实际安装制品验证插件接线，不用修改核心的测试替身冒充通过。
- 记录修改前后的物理调用次数、首次请求大小和本地准备耗时；不把模型网络耗时算成业务准备耗时。
- 完成后执行相关 Standards/Spec 两轴审查，并处理范围内问题。

## Acceptance Criteria

- [x] 正常路径 Skill 不再产生第二次模型调用。
- [x] 所有 Skill 读取与来源失效路径均 fail closed 或整体无 Skill 降级。
- [x] 预算超限不截断 Skill 正文。
- [x] 资源工具只能访问已预加载 Skill 的允许资源。
- [x] 正式 profile 装配与 DSH 官方插件行为有可定位验证。
- [x] 相关后端测试、桌面测试和 typecheck 通过，剩余失败有归属。
- [x] 修改前后对照数据写入 ticket Answer。

## Tests

- 运行 `sqlite-reply-skill-loop`、`sqlite-skills`、`sqlite-reply-candidates-profile` 和候选集成回归。
- 运行正式 profile 的合成模型测试，输出实际 `model_call` 数量。
- 运行桌面相关页面测试和 typecheck。
- 不调用真实外部模型、不读取真实微信、不发送消息。

## Out of Scope

- 真实模型语义质量评测。
- 实际 App 桌面验收。
- 后台 SQLite 队列优化。
- 旧讨论清理。

## Answer

- 回归实现：补齐正常单／双／无 Skill、显式单包、两份资源、读取失败、完整预算超限、停用、来源资格失效、发送前修订变化、取消、超时和运行关闭；所有失败路径不保留部分正文，预算或读取失败降级后不自动重试 Skill。
- 发送前复验修正：Skill 在持久发送授权写入前失效时，本轮按无 Skill 清理；未取得发送授权的本地失败不计为物理请求，避免把尚未出网的尝试当成第二次工具步骤。超时发生在实际请求开始后时保留 `unknown`，不能宣称未发送。
- 正式 profile：新增 `sqlite-reply-skill-precall-profile.test.mjs`，使用正式 `sqlite.patch.yml`、实际安装的 `@deepseek-ai/dsh`／`dsh-skill`／`dsh-tool-skill@0.2.1-rc.2`、真实 SQLite 候选链和合成 SSE 传输。结果为 1 次真实物理 `model_call`，首请求包含 `gentle` 正文、不含 `available_skills`，工具仅为 `skill_resource`。
- RED→GREEN：新增“预加载后发送前修订变化”用例先以 `discussion_generation_failed` 失败，暴露失败未沿运行对象识别；修复后该用例只做 1 次无 Skill 物理调用并通过。候选 loop 最终 15/15；正式 profile 1/1。
- 真实调用次数：单 Skill 1、双 Skill 1、无 Skill 1、显式单包 1、预算降级 1、读取失败降级 1、发送前修订失效 1、资源读取 2（首请求＋一次资源往返）、资源读取后失效 2、超时 1（已发出，状态 `unknown`）。
- 对照数据（同一合成输入、同一 Skill、同一进程内 SSE，比较 `HEAD` 旧按需路径与本分支）：修改前 2 次物理调用、首请求 3,365 bytes、首次请求前本地准备 92.8 ms；修改后 1 次、2,588 bytes、首次请求前本地准备 89.1 ms（后续复跑 103.8 ms，单次样本不足以宣称延迟改善）。正式 profile 另行测得 1 次、2,577 bytes、首次请求前本地准备 84.8–110.1 ms；准备耗时不包含模型网络耗时，数字只作本机合成对照。
- DSH 依据：依赖声明、锁文件和实际解析均为 `@deepseek-ai/dsh`／`dsh-skill`／`dsh-tool-skill@0.2.1-rc.2`，官方源码基线 `687f282e8625c6b8d11ff58211a90524be2e4317`。安装制品 `dsh-tool-skill` 的 `Config`／`apply` 注册 `skill` 工具并由 `ctx.tools.get(skillTool.name, agent) === skillTool` 决定是否发布 catalog；`dsh-skill` 公开 `renderSkillContent`、`SkillProvider`、`registerProvider`、`snapshot`／`get`。本实现只使用这些公开扩展点，未修改安装制品或 DSH 核心。
- 其他命令与结果：`sqlite-skill-precall.test.mjs`＋`sqlite-skills.test.mjs` 34/34；候选 bridge 8/8；后端与桌面 typecheck 通过。`sqlite-reply-candidates.test.mjs` 12/15，3 个失败均为沙箱禁止本机 HTTP `listen EPERM`；`sqlite-reply-candidates-profile.test.mjs` 同因 `listen EPERM` 无法启动，未记作产品失败。
- 桌面页面：Playwright 用例已完成 bundle 编译，但沙箱无法启动或终止 headless Chrome（`SIGABRT`／`kill EPERM`），未获得 UI 通过证据。实际 `pnpm run dev` App 验收仍在 ticket 05。
- 文档收敛：同步 `architecture/current/skill-library.md`、`architecture/current/reply-generation.md`、隐私数据流、SQLite Skill README，并在 ADR-136 顶部记录后续修订范围；原 ADR 的多 Skill、单修订、资源和预算约束保留。
- 数据影响：仅使用合成联系人、消息、Skill 和 SSE；未读取真实微信、未调用外部模型、未发送消息、未启动或重启 App、未打包。
- 剩余风险：当前沙箱不能执行 HTTP host、真实 App 和 Playwright 验收；资源工具仍可能带来一次额外模型往返，不能表述为所有路径绝对一次。

## Comments

- 2026-11-04：按规格创建，依赖 01、02、03。
- 2026-11-04：单次调用、失效、预算、正式 profile 与性能对照完成；HTTP/Playwright 受沙箱限制的项已明确留待可运行环境与 ticket 05。当时保持 `claimed`，后由最终验收改为 `resolved`。

- 2026-11-04 上限补齐：新增 `skill_resource` 第三次调用真实集成回归。前两次读取成功，第三次在下一次模型请求前被硬拒绝，随后只发起一次无 Skill 降级请求；最终候选保留，`skillWarning` 为“回复策略暂不可用”，`loadedSkills/preloadedSkills` 清空，没有残留第三次资源正文。候选 Skill loop 16/16。

- 2026-11-04 规模化实际 App 缺口修复：92 个默认启用 Skill 时，旧实现每个 Skill 的 `record()` 前后都执行整套 `run.validate()`，导致 17,296 次 `assertAnchor` 和约 24 秒本地准备。现增加 `skills.assertRevisions`／`library.assertAnchors` 批量复验、`discussion.skillPreload` 单事务选择与输入记录，并移除预加载入口的重复验证；正式候选保护一次记录全部 selection/input。同一合成 92 Skill 链路 3 样本为 593/573/585ms，P95=max=593ms；Skill/候选/profile 相关回归 34+17+15+9 全部通过。

- 2026-11-04 上限边界：批量事件与上下文保留单轮最多 256 个 eligible Skill 的硬上限；257 个时抛 `skill_preload_limit`，整体无 Skill 降级而不是加载部分集合。新增 257 Skill 真实候选回归：仅 1 次无工具模型调用，`skillWarning=回复策略暂不可用`，loaded/preloaded 均清空。

- 2026-11-04 Standards P3 收口：92 Skill 性能门禁改为 2 次预热 + 20 个有效样本，nearest-rank P95 不再退化为最大值，同时保留 P95≤1000ms、max≤2000ms。项目测试入口定向运行 22/22；并发负载下 P95 743.3ms、max 906.8ms，独立运行 P95 677.4ms、max 683.1ms。
