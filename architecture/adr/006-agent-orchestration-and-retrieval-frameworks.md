# ADR-006：Agent 编排与检索框架边界

> 状态：已采纳
> 决策日期：2026-08-12

## 背景

候选回复正在从一次模型调用演进为包含联系人校验、检索计划、上下文组装、候选生成、风险检查、引用持久化，以及未来 Tool 授权暂停的工作流。同时，LangChain、LangGraph、Learn Claude Code 和 RAGFlow 的能力存在交叉：若不先划分职责，容易形成多个 Agent 编排器、多个 Memory 和无法级联删除的外部索引。

NotAlone 需要工作流能力，但不需要把领域模型交给通用 Agent 平台。联系人隔离、来源证据、权威数据和人工发送必须独立于框架。

## 决策

### 1. LangGraph 是唯一回复工作流编排器

首条回复图固定为：

```text
validate_scope
  -> assess_request_risk
  -> select_skill
  -> load_skill
  -> build_retrieval_plan
  -> retrieve_context
  -> assemble_context
  -> generate_candidates
  -> validate_candidates
  -> persist_trace
  -> return_candidates
```

LangGraph 只放在 `reply` 模块内部。领域对象和模块接口不得暴露 LangGraph State、checkpoint 或 message 类型。短文字回复走该有界图，不使用开放式自治循环。`select_skill` 只看到当前范围内 Skill 的精简目录；`load_skill` 经 `SkillPort` 加载已验证的不可变版本，v1 不作为模型 Tool。

### 2. LangChain 是薄适配层

LangChain 只用于模型接口、结构化输出、Tool schema 和必要的 streaming 适配。联系人选择、权限、风险、记忆写入、检索过滤和事务不由 LangChain Agent 或 Memory 管理。

### 3. PostgreSQL 是唯一业务事实库

`message`、`memory_candidate`、`confirmed_memory`、`reply_request` 和 `reply_candidate` 的权威状态保存在 PostgreSQL。LangGraph checkpoint 只保存可恢复执行的最小运行状态，不是长期关系记忆。

恢复工作流前必须重新校验 owner、contact、授权和删除状态。业务删除必须失效相关 checkpoint，防止旧运行状态重新引入已删除正文。

### 4. 检索通过 `RetrievalPort` 隔离

v1 的默认实现仍是 ADR-005 决定的 PostgreSQL 结构化/全文检索。RAGFlow 当前只作设计参考；只有出现量化的语义漏召回或复杂文档解析问题，并完成数据处理与删除评审后，才能作为 `RetrievalPort` 的候选实现做合成数据 POC。

即使启用 RAGFlow，检索结果也必须回到 PostgreSQL 校验 `owner_id + contact_id`、来源状态、有效期和删除状态。不得启用 RAGFlow Agent 编排回复，也不得把 RAGFlow Memory 当成 `confirmed_memory`。

### 5. Learn Claude Code 只作为 Harness 设计参考

借鉴 Permission、Hooks、Context Compact、Error Recovery 和 Task System；不引入其面向编程 Agent 的 Shell、文件系统、Worktree、自治 Agent Teams 或全局记忆模型。

### 6. Tool 采用确定性权限策略

Tool 分为 `allow / ask / deny`。模型只可以提出调用请求；应用层负责参数、范围、出站数据和批准状态。外部聊天发送属于 `deny`，不得注册为可执行 Tool。未来需要用户批准的读取操作可以通过 LangGraph interrupt 暂停，但批准后也只能继续生成候选，不能自动发送。

### 7. 回复 Skill 采用两级按需加载

Skill 目录只包含 `name`、`description` 和 `when_to_use`，供 `select_skill` 在低上下文成本下选择；完整目标、步骤、禁忌和示例只在选中后由 `load_skill` 加载。用户显式选择优先，自动选择最多一个且必须保存原因、置信度和版本。Skill 是策略而非关系事实，不进入 `confirmed_memory`，也不能因一次候选被采用而静默创建或更新。

## 被否决的方案

### 方案 A：全部使用 LangChain 高层 Agent

否决原因：回复链路含大量确定性步骤和严格状态边界，需要明确节点、恢复与审计；把所有步骤放入开放式 Tool loop 会降低可预测性。

### 方案 B：LangGraph 与 RAGFlow Agent 双重编排

否决原因：会产生双重路由、重试、checkpoint、Tool 权限和追踪，故障后无法确定责任边界。

### 方案 C：RAGFlow 作为关系记忆主库

否决原因：通用 knowledge/document/chunk 与 NotAlone 的联系人、证据、采纳和来源级删除语义不同；外部索引不能替代业务事实。

### 方案 D：自行实现完整 Agent Harness

否决原因：当前只需要一条有界回复工作流和少量 Tool，不需要复刻通用自治 Agent、团队协议或定时系统。

## 后果

- 产品代码开始前需要定义不依赖框架的 `ReplyWorkflowState`、`ModelPort`、`RetrievalPort`、Tool policy 和引用数据结构。
- `reply` 模块负责 LangGraph 图；`gateway` 负责 LangChain/供应商适配；`retrieval` 负责 Retriever 实现；`jobs` 负责后台任务，三类状态不可混存。
- 测试必须覆盖联系人隔离、图恢复幂等、Tool 权限、来源删除后 checkpoint 失效、检索降级和不存在发送节点。
- 引入 LangChain/LangGraph 仍需在新增产品代码时添加 Python 包配置、版本锁定和最小可运行命令；本 ADR 不代表依赖已经安装。

## 重新评估条件

- 若首条回复图始终保持单次模型调用且没有恢复、暂停或分支需求，可重新评估是否暂缓 LangGraph，保留同一应用层节点契约。
- 若 RAGFlow POC 在引用正确率、删除完成率、延迟或运维成本上不优于 PostgreSQL 基线，不进入生产。
- 若更换模型或编排框架，必须保持领域 port 和本 ADR 的联系人、证据、删除与人工发送边界。
