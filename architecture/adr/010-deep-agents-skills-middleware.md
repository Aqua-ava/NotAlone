# ADR-010：使用 Deep Agents SkillsMiddleware 加载回复 Skill

> 状态：已采纳
> 日期：2026-08-16
> 修订：ADR-009 第 3 节的 `load_skill` 实现和第 6 节的 Deep Agents 边界
> 后续修订：ADR-019 修订 v1 supporting files 的范围；本 ADR 的单 Skill、只读读取、缓存和禁止扩权边界继续有效。

## 背景

ADR-009 采用 LangChain `create_agent`，并计划由 NotAlone 自行实现 `load_skill` Tool。后续领域讨论明确：Skill 库中存在多个独立回复 Skill，每个 Skill 代表一种回复策略；用户可以创建、删除或从网络明确安装 Skill，模型只在当前请求需要时读取一个完整版本。

LangChain 文档把这种 progressive disclosure 描述为一种可自行实现的 Skill 设计模式。Deep Agents 已把目录发现、元数据注入和按需读取约定实现为可组合的 `SkillsMiddleware`。继续自行实现同一套扫描和提示词装配没有产品价值，但引入完整 `create_deep_agent` 又会带入当前候选回复不需要的文件写入、Shell、子 Agent 和长任务能力。

## 决策

### 1. 在 create_agent 中组合 SkillsMiddleware

候选回复继续使用 LangChain `create_agent` 作为有界 Agent Loop，并在其 middleware 列表中组合 `deepagents.middleware.skills.SkillsMiddleware`。不改用完整 `create_deep_agent`，也不因采用该 middleware 自动启用 Deep Agents 的 Todo、通用文件系统、Shell、Subagent、Memory 或长任务能力。

Deep Agents 类型不得进入领域对象或公开 port。`skills` 模块继续通过框架无关的 `SkillPort` 管理目录、版本和状态；工作流适配层把当前已验证范围转换为 `SkillsMiddleware` 所需的 backend source，并实现锁定版本实际调用的 `BackendProtocol` 枚举与下载契约。middleware 的 discovery backend 只供框架扫描目录元数据，不等同于模型可见的 `read_file` Tool。

不使用 `SkillsMiddleware` 默认的通用 Agent 提示词。NotAlone 传入保留框架必需占位符的定制 `system_prompt`，只说明如何读取一个 `SKILL.md` 回复策略，不展示 `allowed-tools`，也不引导模型访问 supporting files 或执行脚本。

### 2. SkillsMiddleware 只负责运行时发现和渐进加载

每次候选回复运行只向 `SkillsMiddleware` 暴露当前 `owner_id + contact_id` 可用的已启用 Skill 版本。middleware 在模型调用前注入精简目录；模型需要完整策略时，使用受控只读 `read_file(file_path, offset=0, limit=1000)` Tool 读取目录中给出的 `SKILL.md` 虚拟路径。定制提示词与 Tool schema 必须使用同一组参数名。

`read_file` 不是通用文件系统能力：它只接受本次目录中已列出的 Skill 路径，经 `SkillPort` 校验 owner、contact、状态和不可变版本后返回正文，不允许路径遍历、任意文件读取、写入或执行。已验证范围从 runtime context 注入，不由模型提供。NotAlone 仍强制每次最多使用一个 Skill 版本，并记录版本和选择原因。

官方 middleware 会把 `skills_metadata` 缓存在 Agent state，同一线程后续轮次不会自动重扫。因此 NotAlone 必须把缓存绑定到 `owner_id + contact_id + skill_library_revision`：联系人变化时使用新的线程/checkpoint namespace；Skill 安装、更新、禁用或删除时递增目录修订号，并在下一轮前清除旧 metadata、旧 Skill `read_file` Tool 结果和包含旧 Skill 正文的摘要，或直接创建新的运行状态。恢复执行前再次校验这三个值，不能只信任 checkpoint 中的目录。

用户显式选择 Skill 时，应用层通过同一个 `SkillPort` 校验并预加载；自动选择时由 `SkillsMiddleware` 目录和受控读取接口完成。两条入口不得形成两套存储、版本或权限规则。

### 3. NotAlone 拥有 Skill 库生命周期

`SkillsMiddleware` 不负责产品内的创建、网络安装、更新、删除、用户隔离、版本历史或审核。NotAlone 的 Skill 库负责这些行为，并把产品内置、用户创建或用户明确安装的 Skill 固化为不可变版本，保存来源类型、来源定位、内容摘要和校验结果。

网络安装发生在独立的用户操作中，不发生在候选回复 Agent Loop 内。下载内容按不可信指令处理：v1 只持久化并暴露通过格式、大小和路径校验的 `SKILL.md` 文本，不下载或挂载 scripts、references、assets 等 supporting files；`allowed-tools` 等能力声明被忽略且不进入 middleware 目录。Skill 声明不能注册新 Tool、MCP、Shell、文件写入、网络权限或外部聊天发送能力，也不能扩大现有 Tool 的授权范围。

### 4. 版本风险由适配层隔离

当前仓库尚未安装或锁定 `deepagents`、LangChain 或 LangGraph。本 ADR 只记录目标组合，不证明运行时可用。实现时必须核对并锁定兼容版本，以合成 Skill 验证 `SkillsMiddleware`、backend adapter、定制提示词、受控 `read_file` schema、缓存失效和结构化输出的组合；若第三方接口变化，只替换工作流适配层，不改变 `SkillPort` 或领域对象。

## 保留边界

- ADR-009 的 LangChain `create_agent`、确定性外壳、运行预算、Todo、上下文压缩和 LangGraph 下沉条件继续有效。
- 完整 Deep Agents harness 仍不用于候选回复；未来关系分析任务是否采用它仍需独立评估。
- PostgreSQL 继续拥有 Skill 目录、版本、状态和来源记录；Deep Agents backend 只是当前运行的受控视图，不是第二个权威库。
- Skill 是回复策略而非 Tool；`read_file` 只负责把已批准的策略文本放入上下文。实际可执行能力只来自 NotAlone 注册并由应用层授权的 Tool。

## 官方依据

- LangChain 的 Skill progressive disclosure 设计模式：<https://docs.langchain.com/oss/python/langchain/multi-agent/skills>
- Deep Agents Skill 与 backend：<https://docs.langchain.com/oss/python/deepagents/skills>
- Deep Agents `SkillsMiddleware` API：<https://reference.langchain.com/python/deepagents/middleware/skills/SkillsMiddleware>
- Deep Agents middleware 架构：<https://reference.langchain.com/python/deepagents/middleware>

## 后果

- 不再自行维护 Skill 目录扫描，但仍需实现 `SkillPort`、Skill 库管理、scope-aware backend adapter、NotAlone 专用目录提示词和受控 `read_file`。
- 测试必须覆盖 owner/contact 目录隔离、scope 或目录修订变化后的缓存失效、禁用或删除 Skill 不可恢复、一次最多一个版本、`read_file` schema、网络 Skill 不能扩权、路径遍历拒绝、历史版本记录和不存在发送 Tool。
- 引入 `deepagents` 依赖前先做最小合成 POC；POC 通过后才能宣称该组合可运行。
