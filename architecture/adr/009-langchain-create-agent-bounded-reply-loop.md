# ADR-009：使用 LangChain create_agent 实现有界候选回复循环

> 后续决定：[ADR-091](091-retire-runtime-todos-and-auto-summary.md)取消第 4 节的 Todo／自动过程摘要强制要求及相关 UI／测试要求；下文保留历史设计，不再作为待补功能。[ADR-092](092-defer-time-calendar-web-tools.md)已将时间／日历／网络工具改为未来可选方向，取消当前版本强制接入及相应验收要求。持续讨论不压缩按 ADR-042／045 保持。

> 状态：已采纳
> 日期：2026-08-16
> 修订：ADR-006 第 1、2、7 节及方案 A
> 后续修订：第 3 节的 `load_skill` 实现和第 6 节的 Deep Agents 边界由 ADR-010 修订

## 背景

ADR-006 采用固定的 LangGraph 线性回复图，并把 `select_skill -> load_skill` 和单次检索写成显式节点。后续讨论确认，候选回复需要让模型根据当前消息和已返回证据，自主决定是否加载回复 Skill、先查哪类联系人资料、是否继续换一个查询，以及信息不足时是否请求澄清。继续把这些选择拆成固定节点，会在应用层重复实现 LangChain 已提供的标准模型-Tool 循环。

NotAlone 仍不需要通用自治 Agent。联系人范围、权限、数据状态、运行预算、引用校验、持久化和外部发送边界必须独立于模型和框架。

## 决策

### 1. 使用 create_agent，接受 LangGraph 作为底层 runtime

候选回复的内部模型-Tool 循环使用 LangChain `create_agent`。`create_agent` 底层运行在 LangGraph 上；v1 不直接手写自定义 `StateGraph`，也不自行实现通用 Agent Loop。

只有出现复杂的确定性/模型分支、跨进程暂停恢复、durable checkpoint 或 Human-in-the-loop interrupt 等已证明需求时，才下沉到直接 LangGraph 编排；届时可以把整个 `create_agent` 作为自定义图中的一个节点。框架类型不得进入领域对象或公开 port。

### 2. 确定性外壳包围有界 Agent Loop

```text
validate_scope
  -> assess_request_risk
  -> assemble_initial_context
  -> create_agent bounded Tool loop
  -> validate_agent_output
  -> persist_trace
  -> return_result
```

确定性代码拥有联系人与授权校验、当前消息和近期对话装配、Tool 注册与参数校验、运行预算、引用和候选校验、事务持久化及最终返回。模型只能在这个外壳内部选择已注册的只读 Tool，并返回结构化候选或澄清需求。

### 3. 核心只读 Tool 与授权外部 Tool

> 当前 Skill 加载实现见 ADR-010；以下 `load_skill` 方案保留为本次决策的历史背景。

- `load_skill(skill_id)`：读取当前可用目录中的一个不可变回复 Skill 版本；它是 Tool，被读取的 Skill 是策略内容，不是 Tool。
- `search_contact_messages(query, ...)`：按需检索当前联系人的历史规范消息。
- `search_confirmed_memories(query, ...)`：按需检索当前联系人的已采纳关系资料。
- `get_current_time(timezone)`：通过确定性代码返回当前时间，不调用模型猜测。
- `search_calendar(...)`：只读查询用户已授权的日历范围，不创建、修改或删除日程。
- `web_search(query)`：查询模型不知道或可能变化的公开信息，不携带无关聊天正文、联系人身份或关系资料。

前三个 Tool 是候选回复核心能力；时间、日历和网络搜索通过独立 adapter 接入，其中日历与网络连接器必须先完成用户授权和出站范围配置。`owner_id + contact_id` 由已验证的 runtime context 注入，不是模型参数。Tool handler 分别调用框架无关的 port 或 adapter，并在执行层强制范围、状态、数量、时间和出站字段限制。当前待回复消息和近期对话由应用层预装，不通过 Tool 重新获取。

模型自动选择 Skill 时调用 `load_skill`；用户明确指定 Skill 时，应用层通过同一个 `SkillPort` 校验并预加载。两条入口不得形成两套 Skill 存储、版本或权限规则。每次最多使用一个 Skill 版本，并记录实际版本和选择原因。

### 4. Todo 与上下文压缩使用 LangChain middleware

> 2026-10-11：适用范围由 [ADR-042](042-assistant-session-context-boundary.md)局部修订；本节不能用于压缩跨请求的持续助手讨论。单次运行消息机制继续有效。

`create_agent` 始终注册 `TodoListMiddleware`，让模型在步骤会随 Tool 结果变化的多步骤请求中调用 `write_todos`；普通回复不强制创建 Todo。有 Todo 时，UI 展示精简的步骤与进度。Todo 是本次运行计划，不是业务事实、关系资料或后台任务状态。

`SummarizationMiddleware` 在达到可配置 token 或消息阈值时压缩较早运行消息并保留最近原文。压缩摘要只属于可丢弃、可重建的 Agent runtime state；PostgreSQL 中的 `message`、`memory_candidate` 和 `confirmed_memory` 仍是权威事实。若使用 checkpointer 延续同一聊天线程，来源或联系人删除必须使相关摘要和 checkpoint 失效，恢复前仍要重新校验联系人、授权与删除状态。

### 5. 产品硬边界与运行预算分开

联系人隔离、删除状态、只读 Tool、来源证据和禁止外部发送是不可变产品硬边界，必须由代码强制执行。模型/Tool 调用次数、单次返回数量、token、超时和重试次数是可配置运行预算；具体数值在实现和合成评估时确定，不写死为领域规则。Prompt 和 Tool description 只能提供软指引，不能代替执行层校验。

### 6. 当前候选回复不采用 Deep Agents

> 本节由 ADR-010 修订：当前采用独立的 `SkillsMiddleware`，仍不采用完整 Deep Agents harness。

Deep Agents 面向长周期、多步骤任务，默认围绕文件系统、上下文 offloading、计划和子 Agent 组织能力。当前候选回复所需的 Todo 与上下文压缩已经由 LangChain middleware 提供，不需要文件系统、子 Agent 或跨进程长期任务；引入完整 harness 会增加数据副本、权限面和删除复杂度。

未来若增加关系分析任务，必须由用户从独立入口主动创建，并明确联系人、时间和资料范围；不能因打开聊天窗口或生成候选而自动分析长期历史。只有这类任务证明需要动态规划、大量中间材料、跨进程恢复或多个专业子 Agent 时，才单独比较普通 Worker、直接 LangGraph 与 Deep Agents。当前只借鉴 Deep Agents 的 progressive disclosure 和上下文管理思路。

## 保留的 ADR-006 边界

ADR-006 关于 PostgreSQL 业务事实、`RetrievalPort`、RAGFlow 隔离、Tool `allow / ask / deny`、来源删除、checkpoint 不作为关系记忆以及禁止外部发送的决定继续有效。ADR-009 只替代固定线性回复图、LangChain 仅作薄适配层、`load_skill` 非模型 Tool 和单次静态检索的部分。

## 官方依据

- LangChain `create_agent` 与模型-Tool 循环：<https://docs.langchain.com/oss/python/langchain/agents>
- LangChain Todo 与上下文压缩 middleware：<https://docs.langchain.com/oss/python/langchain/middleware/built-in>
- LangChain Tool adapter 与 runtime context：<https://docs.langchain.com/oss/python/langchain/tools>
- LangChain progressive Skill loading：<https://docs.langchain.com/oss/python/langchain/multi-agent/skills>
- LangGraph 低层 runtime 与直接使用条件：<https://docs.langchain.com/oss/python/langgraph/overview>
- Deep Agents 的长周期 harness 范围：<https://docs.langchain.com/oss/python/deepagents/overview>

## 后果

- `reply` 模块拥有确定性外壳、`create_agent` 配置和 Tool adapter；`skills`、`retrieval`、`gateway` 继续提供框架无关能力。
- 测试必须覆盖自动 Skill 加载、迭代检索、Todo 按需创建与进度输出、摘要触发与删除失效、授权外部 Tool 的范围、运行预算停止、引用完整性、跨联系人拒绝、已删除资料不可检索及不存在发送 Tool。
- 当前仓库尚未安装或锁定 LangChain/LangGraph；本 ADR 记录架构选择，不证明运行时已经可用。
- 实现前使用合成数据确定具体预算并核对锁定版本的官方 API；原型是验证手段，不是采纳本 ADR 的前置条件。
