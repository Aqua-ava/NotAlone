# 03 — 预加载追踪与候选依据展示

Type: task
State: resolved
Triage: ready-for-agent
Blocked by: 01, 02

按 [spec](../spec.md) 记录多 Skill 自动预加载的真实来源和版本，并校正候选依据，避免把“预加载”误写成“模型实际采用”。

## What to build

- 为每个预加载 Skill 记录 `origin=auto_preload`、package id、revision、head revision、manifest/content digest 和目录快照。
- 保留显式选择来源，区分自动预加载与用户/兼容接口指定。
- 候选依据只展示实际进入模型请求的 Skill 正文和资源；目录摘要本身不冒充正文输入。
- 检查现有执行事件载荷能否承载多 anchor 和来源；不足时做最小迁移，不扩大数据范围。
- 桌面候选区可展示“本次预加载的 Skill”及版本，不宣称模型一定遵循了该 Skill。
- 降级时明确显示“回复策略暂不可用”或等价真实状态，不显示未加载 Skill。
- 保持名称、版本、路径和资源身份不串包。

## Acceptance Criteria

- [x] 自动预加载多 Skill 时每条选择都有独立、可追溯的事件记录。
- [x] 候选依据只引用真实进入请求的正文和资源。
- [x] UI 不新增逐次手选控件。
- [x] UI 区分“已预加载”和“实际输入”；不伪造模型采用证据。
- [x] Skill 降级后不残留旧名称、旧正文或旧资源。
- [x] 删除和来源失效仍能沿实际输入闭包处理。

## Tests

- 候选事件投影测试：多 Skill、多资源、自动来源、显式来源。
- 桌面页面测试：依据展示、降级提示、无手选控件。
- 现有删除闭包和迟到结果测试回归。
- 若修改数据结构，执行迁移和完整性测试。

## Out of Scope

- 不改 Skill 选择策略。
- 不增加 Skill 编辑、学习、审核或发布入口。
- 不改记忆与文档展示。
- 不改变旧讨论加载规则。

## Answer

- 追踪实现：每个 `skill_selection` 与 `skill_input` 事件现在记录冻结 Skill 名称及 `preload.origin`／`preload.catalogRevision`；原有 anchor 继续包含 package id、revision、head revision、目录身份、manifest digest 与 content digest。资源读取沿用对应预加载来源，来源、目录快照和名称不会串包。
- 候选投影：`reply.view` 只从真实 `skill_input` 事件生成 `loadedSkills`；`preloadedSkills` 再从成功的 `SKILL.md` 实际输入中投影，因此目录列出或选择事件不能冒充正文输入。自动来源保持 `auto_preload`，显式兼容入口保持 `explicit`。
- 桌面展示：候选区显示“本次预加载的 Skill：名称（第 N 版）”；实际正文和资源收在“实际进入模型输入的 Skill 内容”分组中，逐项显示名称、版本与相对路径。文案只陈述预加载事实，不宣称模型采用了策略；没有新增手选控件。降级时清空预加载身份和实际输入，仅显示“回复策略暂不可用”。
- RED：后端 3 个多 Skill／显式／资源用例先因缺少 `preloadedSkills` 和事件来源而失败。重放到最新消息排除工作区合同后，UI 测试保留“不出现 `excludedMessageIds`”断言，没有恢复旧勾选语义。
- GREEN：`sqlite-reply-skill-loop.test.mjs` 10/10；其中单／双 Skill 和显式单包均为 1 次物理调用，正文加两份资源为 2 次物理调用（一次资源往返）。
- 其他验证：`sqlite-skill-precall.test.mjs`＋`sqlite-skills.test.mjs` 34/34；候选 bridge 7/7，包含新增预加载字段的严格解码与既有失效撤下；后端及桌面 TypeScript typecheck 通过；候选集成 12/15，3 个失败均为沙箱禁止本机 HTTP `listen EPERM`。
- 桌面 UI 自动测试：测试 bundle 可编译，但 Playwright 启动 headless Chrome 被当前沙箱拒绝（进程 `SIGABRT`、清理 `kill EPERM`），因此未伪造页面通过证据。实际开发 App 的视觉与交互验收留给 ticket 05。
- 数据影响：仅合成 Skill、联系人和候选；未读取真实微信、未调用外部模型、未发送消息、未启动 App 或打包。
- 剩余风险：页面自动交互未在本沙箱执行；需要在 ticket 05 通过实际 `pnpm run dev` App 核对多 Skill 展示、降级清理和无手选控件。

## Comments

- 2026-11-04：按规格创建，依赖 01、02。
- 2026-11-04：多 Skill 来源、实际输入投影和候选展示完成；后端与类型检查通过，Playwright 因沙箱限制待 ticket 05/可运行环境复验。当时保持 `claimed`，后由 ticket 05 与最终验收改为 `resolved`。

- 2026-11-04 最终实际 App 验收：92 个内置 Skill 的名称、版本与正文只在用户展开“实际进入模型输入的 Skill 内容”时按页读取；展开前后 `model_call`、模型日志行数和 `skill_input` 均不变。页面没有逐次手选控件，降级时清空 Skill 身份并显示“回复策略暂不可用”。
