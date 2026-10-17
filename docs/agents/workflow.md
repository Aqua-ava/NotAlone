# Agent 工作流

本文件是本仓库的完整工程工作流。根目录 `AGENTS.md` 只保留入口规则；涉及功能、Bug、架构或测试改动时，先读取本文件。

## 工作模式

### 讨论模式

用户在询问方案、解释、诊断、评审或状态时，进行只读探索和分析，不进入实现阶段。

### 实现模式

用户明确要求实现功能、修复 Bug 或指定一个 ticket 时，进入实现阶段。当前 ticket 或 spec 范围内的普通文件编辑、测试和重构按流程连续完成，不为每个文件或测试单独询问。

### 决策模式

以下情况需要暂停并询问用户：

- 功能范围或用户意图不明确
- Module 的 Interface 或 Seam 会影响整体架构，但尚未确定
- 方案涉及删除或迁移数据、外部发送、正式环境或 push
- 实际实现需要超出当前 spec 或 ticket
- 测试失败要求改变原定方案

用户作出决策后继续当前流程，不把一次决策解释成对其他范围的授权。

## 子 Agent 协作

本仓库开发任务允许主 Agent 主动委派。任务可独立拆分且能提高效率或核验质量时，直接使用子 Agent，无需用户逐次指定或确认；适用技能明确要求子 Agent 或并行工作时，按技能执行。

- **独立探索**：将互不依赖的代码或文档问题交给子 Agent，明确问题与证据范围；主 Agent 同时推进不依赖其结论的工作。
- **并行实现**：将无阻塞关系的任务交给不同子 Agent，明确各自负责的文件或模块，按需隔离工作树。告知执行者还有其他 Agent 在协作，应适配已有修改；主 Agent 负责集成与最终验证。使用 `implement-spec` 时，按其任务图调度已就绪的 tickets。
- **独立审查**：使用 `code-review` 时，按技能分别启动 Standards 和 Spec 审查子 Agent；缺少 spec 时按技能跳过 Spec 轴并说明。实现阶段结束后，按下方流程进入审查。

短文字回复、简单单点修改和紧密依赖的步骤由主 Agent 完成。委派时提供目标、来源指针、职责边界和完成条件；子 Agent 返回带来源的结构化证据，实现任务同时报告文件变更与验证结果。子 Agent 不得直接发送外部消息或改写用户确认事实；既有数据、桌面占用和 Git 授权边界继续适用。

工具不可用或并发槽不足时，使用可用的串行路径并说明实际限制，不把能力限制解释成缺少用户授权。

## 工具选型

简单需求使用最小本地工具；只有标准化、可替换的边界确有价值时才使用 MCP。当前工作流没有证明需要时，不预先实现自治 Agent Harness、定时自动化或聊天渠道自动化。

## 主流程

### 1. 明确问题

在工作目录中处理功能或架构工作时，先使用 `grill-with-docs` 明确问题、范围和决策。

完成条件：问题、目标、约束和主要取舍已经足够明确，可以判断下一条路径。

### 2. 处理设计不确定性

- 需要通过可运行答案确定状态、业务逻辑或界面时，使用 `handoff` -> `prototype` -> `handoff` 回到原工作流。
- Module、Interface 或 Seam 的设计不清楚时，使用 `codebase-design`。
- 这两个 skill 只在对应问题出现时进入，不是每个任务的固定阶段。

完成条件：关键 Interface、Seam 或可验证的行为已经确定；如果仍有重大未知，不进入实现。

### 3. 选择工作规模

- 多会话工作使用 `to-spec`，再使用 `to-tickets`。
- 单会话的小任务可以从 `grill-with-docs` 直接进入 `implement`。
- 目标过大且路径不清楚时，先使用 `wayfinder`；地图清晰后回到 `to-spec`，不要直接跳到 `implement`。

### 4. 形成 spec

`to-spec` 将已经讨论的内容整理成 spec。写入前确认测试所依赖的 Seam；spec 应记录用户问题、解决方案、Implementation Decisions、Testing Decisions 和 Out of Scope。

完成条件：spec 已发布到 `.scratch/`，并且测试 Seam、范围和排除项清楚。

### 5. 拆分 tickets

`to-tickets` 将 spec 拆成可独立验证的 tracer-bullet tickets。每个 ticket 说明交付的完整行为，并记录真实的 `Blocked by` 关系。

先展示 ticket 粒度和 blocking edges；用户认可拆分后再发布。已由 `to-spec` 产生的 tickets 不再经过 `triage`。

完成条件：每个 ticket 都能在一个新上下文中完成，阻塞关系正确，并已按依赖顺序发布。

### 6. 实现 ticket

`implement` 一次处理一个 ticket，并在独立上下文中工作：

1. 读取 ticket、spec、`CONTEXT.md`、相关领域文档和 ADR。
2. 在已约定的 Seam 上使用 `tdd`，以一个 red -> green 的垂直切片推进。
3. 定期运行类型检查和单文件测试，最后运行完整相关测试。
4. 完成后使用 `code-review`，分别检查 Standards 和 Spec。
5. 按 `docs/agents/engineering.md` 完成本地提交，并报告实际变更、验证结果、数据影响和剩余风险。

普通实现不重复发起权限确认；只有进入“决策模式”时才暂停询问。

## 其他入口

- 原始外部 Bug 或请求先使用 `triage`，生成 agent-ready ticket 后再进入 `implement`。
- 难以直接定位的故障使用 `diagnosing-bugs`，先建立会失败的反馈回路，再修复并补回归测试。
- `diagnosing-bugs` 发现没有可测试的 Seam 时，转入 `improve-codebase-architecture` 或 `codebase-design`。

## 阶段边界

在 grill、设计、spec、tickets 和实现之间，根据上下文是否仍然有用选择继续、`clear`、`handoff`、subagent 或 `compact`。完成一个 ticket 后使用新上下文处理下一个 ticket；在 `to-tickets` 之前保持同一条思考链，除非上下文接近 smart zone 上限。
