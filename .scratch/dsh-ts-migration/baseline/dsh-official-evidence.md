# DSH／TS 迁移 01：官方固定版本能力与风险基线

## 范围、版本与证据等级

查证日期：2026-10-23（Asia/Taipei）。NotAlone 代码基线：`3c168296`；本文件只完成 [01](../issues/01-behavior-data-baseline.md) 的官方证据子交付，不执行 02，不修改产品代码、任务状态、规格或 ADR。研究原稿保存在本机忽略的 `research/dsh-ts-baseline-official.md`，此处为纳入版本管理的证据副本。

候选源码为官方 `deepseek-ai/deepseek-harness` 提交 **`687f282e8625c6b8d11ff58211a90524be2e4317`**。通过 `git ls-remote ... HEAD refs/heads/master` 取得相同 SHA，再下载该 SHA 的源码归档并读取；下列外部链接均固定到该提交，不以可变 master 网页作验收。此为 01 候选，最终依赖闭包及发行制品由 02 固化；不声称已经锁定或安装产品依赖。GitHub commit 元数据 API 返回 403，因此未记录提交时间或推断 tag 与 SHA 的对应关系。

官方 [README](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/README.md) 标明 developer preview 和破坏性变更风险。本文“已查证”仅指固定源码、官方说明和示例交叉核对；**未启动 DSH、未执行其测试、未调用模型，所有运行合同仍待 02 验证**。官方测试仅作为可复用的案例证据。

本仓约束见 [ADR-102](../../../architecture/adr/102-dsh-typescript-backend-migration.md) 和 [隐私边界](../../../architecture/current/privacy-deletion.md)：普通 TS 业务与 DSH 共后台、官方 profile 装配；Electron 独立；PostgreSQL 仍为权威库；DSH 仅临时执行。当前 `backend/pyproject.toml:13–18` 和 `backend/src/notalone/reply/adapters/langchain_runtime.py:865–889` 仍使用旧框架及输出工具／ToolStrategy，不能把 DSH API 的存在写成迁移完成。

## 能力与适配结论

### 官方 profile 与 TS SDK

官方支持 named profile、bundle 和有序 patch；插件为共享 Context 装配单元。沿此入口挂载薄业务插件，普通模块由插件导入；不另造直接 `new Context()` 的产品启动器。home 和 invocation patch 也会参与配置，02 必须验证最终有效树与隔离的 home，不能只审查一份 YAML。依据：[架构启动合同](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md#L15-L45)、[profile 源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/profile.ts#L1-L20)、[启动配置说明](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/README.md#L39-L67)。

`DeepSeekHarness`／`HarnessClient` 是外部调用者通过 stdio JSON-RPC 驱动子进程，不等于同进程插件。目标后台内业务应使用公开 `ctx.agents`／`ctx.llm` 等服务。SDK 可作隔离测试驱动，不能以“TS SDK”冒充共后台设计。依据：[SDK 用法与示例](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/client/README.md#L12-L60)、[实际 spawn](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/client/src/client.ts#L214-L225)。

### Agent 创建、取消与释放

`ctx.agents.create({sessionId, agentOptions, setup})` 返回拥有释放能力的 handle；setup 在发布前完成 scoped tool／listener。创建 signal 仅用于创建，返回后不能依赖它取消运行；setup 只装配，不驱动 Agent。依据：[Agent 创建与驱动例子](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/README.md#L26-L66)、[setup 合同](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/index.ts#L95-L119)、[官方生命周期测试例子](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/tests/scope-lifecycle.spec.ts#L339-L359)。

`cancel(cause)` 默认清 inbox 并发出 abort，返回 void，不等于清理已完成。`handle.dispose()` 取消、等 idle、释放 scope、关闭持久化 handle（若有）、移除注册，失败会汇总抛出。依据：[取消实现](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/agent.ts#L175-L181)、[释放实现](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/index.ts#L550-L590)。业务仍须独立截止时间、删除世代与迟到写入复验；不能把 abort 当作远端停止或费用为零。不合作的工具／模型是否会阻塞退出，02 须实测。

### Session 内存与持久化

核心 Session 默认保存在内存；模型可见内容必须可从事件记录重建，并不要求写磁盘。持久化由附加插件承担。依据：[Session 说明](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/README.md#L12-L28)、[内存 Store](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/index.ts#L1049-L1055)、[移除条目](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/index.ts#L1253-L1254)。

默认 [sdk-minimal 配置](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/sdk-minimal/cordis.patch.yml) 明确启用 JSONL sessions，不能原样使用。移除内存注册不证明清空所有外部引用或 provider 缓存，也不删除已经写出的历史文件。产品讨论仍由业务 PG 保存，DSH 不恢复额外长期副本；取消、删除、正常退出与失败退出后均须核对残留。

### Tool 与 Skill 作用域

可在 Agent scoped Context 注册工具；`restrict` 限制继承的全局工具，scoped 注册不自动被其过滤。`guard` 提供单调拒绝点。scope 是运行时路由，不是 owner/contact 授权，业务工具必须闭包绑定已验证身份并在执行、提交前复验；不能允许模型传参改换联系人。禁止注册聊天发送工具。依据：[注册例子和权限合同](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/README.md#L30-L89)、[register/restrict/guard 源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L1071-L1148)。

Skill registry、filesystem provider、模型 tool 是分开的；支持 scope 分层及 provider invalidation。可评估用受控 provider 映射业务已核验的不可变 Skill 版本，不直接暴露任意文件目录。官方目录变更会追加替代目录，旧正文仍可能在当前 Session 历史；删除／禁用须取消并销毁旧运行，不能把空目录消息当物理删除。provider 失败会保留 last-good view，必须验证业务资格检查不因此失效。依据：[Skill 注册／provider 及缓存合同](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill/README.md#L51-L102)、[registry 实现](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill/src/index.ts#L390-L481)、[模型目录 consumer](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/tool-skill/README.md#L28-L85)。

### 结构化输出与单次模型调用

已查的通用 LLM options 与 DeepSeek wire 类型没有根级 response schema 字段，不能臆造 `response_format`。官方存在子 Agent activation 的 `structured_output` 工具、schema 校验与完成 guard，但不等于根 Agent／单次语义调用具有相同公开合同。不为输出格式引入产品不需要的子 Agent。02 应验证公开工具机制能否实现既有 schema、终止、错误与预算语义；直接模型结果仍须业务严格解析校验，失败不能算成功。此结论不排除其他适配器或扩展提供能力。依据：[GenerateOptions](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/types.ts#L528-L570)、[DeepSeek wire 类型](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-deepseek/src/wire-types.ts#L23-L41)、[子 Agent 输出合同](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subagent/subagent/README.md#L111-L113)、[输出工具校验源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subagent/subagent/src/structured.ts#L56-L103)。

`ctx.llm.stream` 是单 provider attempt；`prepareCall` 固定 adapter generation、默认值与控制项。可承接确定性单次语义调用，不强迫使用 Agent loop。调用者负责输入不可变、取消、完整 terminal 判定及最小台账。官方强调输入可重建不代表授权额外永久正文日志，追踪仍按原业务保存和删除规则。依据：[官方一次 stream 例子](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/README.md#L47-L63)、[prepareCall 源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/index.ts#L956-L1012)、[服务测试例子](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/tests/service.spec.ts#L193-L210)。

## 默认配置冲突与适配风险

`sdk-minimal` 是官方独立 bundle，不叠加 base，但并非 NotAlone 所需的最小权限配置。[完整配置](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/sdk-minimal/cordis.patch.yml) 包含会话上传、插件清单、压缩、终端与 persistent Shell、JSONL persistence、`llm-retry`。这与 ADR-102 的目标存在默认配置冲突；须通过官方 profile 和公开配置消解，不是绕过启动机制或改核心的理由。

| 风险 | 固定官方证据与事实 | 02 应核对的边界 |
| --- | --- | --- |
| 重试放大物理调用 | [policy](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/retry-policy.ts#L14-L53) 的 normal 默认首次之后最多重试 5 次，初始 500ms、上限 10s、jitter 0.1，另有无限 always；[执行器](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-retry/src/index.ts#L194-L225) 按 provider policy 执行。 | 业务上限不能被框架重试绕过；policy 在 provider 上配置，不猜成 llm-retry 插件字段。对照 maxRetries:0 与受控重试，计每次实际请求及取消。 |
| 计量不等于预算 | [LLM 文档](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/README.md#L176) 明确服务没有 rate limiting；[goal 限制](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/goal/goal/README.md#L155-L158) 不计 tokens、金额、墙钟或 quota。 | 不加载 goal 来代替现有业务预算，也不将 token-meter 当硬拦截。输入预算、输出 cap、步数、并发、deadline、前台优先及取消需业务统一仲裁。 |
| 额外会话日志上传 | [插件说明](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-log-deepseek/README.md#L30-L51) 与 [源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-log-deepseek/src/index.ts#L184-L203)：有 live sessionId 可将 canonical events 写入 `dsh_session_log`；enabled 默认 true（同文件 38–54 行）；重新开启可补发关闭期间后缀。 | 内存 Session 仍可能上传。禁用该插件／能力并检查每条模型请求；只关 JSONL 或 OTEL 均不充分。 |
| 插件清单上传 | [源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/plugin-package-inventory-deepseek/src/index.ts#L153-L213) 默认 enabled，字段 `dsh_plugin_packages` 含活动 Loader host 与 requesting Agent standing preset 的包名／版本。 | 非依赖全集，但仍是额外包身份披露；禁用并检查请求体，不以“无聊天正文”忽略。 |
| 独立 OTEL 通道 | [base 配置](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/base/cordis.patch.yml#L205-L232) 默认 FEEDBACK_ONLY、collector 为 `https://dsh-otel-collector.deepseeksvc.com/v1/logs`；非空 DSH_TELEMETRY_DISABLED 禁用。 | FEEDBACK_ONLY 不是完全关闭。与前两插件分别核验；测试反馈、退出、重启均无 exporter 出站，不能只检查正常生成。 |
| 额外模型调用 | [base](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/base/cordis.patch.yml#L60-L77) 挂载标题 LLM，cap 4096、timeout 60s；[标题实现](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-title-llm/src/index.ts#L233-L267) 独立 prepareCall 并带 sessionId。 | base 与 minimal 不混为一谈；检查最终树中所有标题／compaction 等模型调用者，删除非业务路径并精确计数。 |

取消和 scope 服务不提供 PostgreSQL 事务、owner/contact 访问控制、业务删除世代、幂等与恢复资格。新旧过渡期也不能各自限流后声称全局预算等价。上述是源码显示的适配责任，不是已发生的产品故障。

## 依赖与发行制品

候选源码根版本为 `0.2.1-rc.2`、包管理器 `pnpm@11.28.5`、Node 要求 `^22.19.0 || >=24.0.0`，见 [根 package.json](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/package.json#L1-L10)。[CLI package.json](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/package.json) 声明 `@deepseek-ai/dsh`、`lib/bin.js` 及广泛 workspace 依赖；[锁文件](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/pnpm-lock.yaml) 是源码依赖证据，不等于产品安装闭包已经验证。

只读查询 [npm 精确版本元数据](https://registry.npmjs.org/@deepseek-ai%2fdsh/0.2.1-rc.2) 确认版本存在：

- tarball：`https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.1-rc.2.tgz`
- shasum：`a502d1551aabc881020e3cb7961c38901565731a`
- integrity：`sha512-tvY+yhfKRifthbqPe/OK0AYxM5ZkvqfYq/jMYgJcEUxiRRL1Vwra3Ti5TB6AXgSWQdiPHYh/Vp6SJa9yHwMNuw==`

registry 元数据未提供 gitHead 和 engines；GitHub releases API 返回 403。**尚未证明 npm tarball 对应候选 commit，未验证 release tag、tarball 内容、完整安装闭包或正式 exports 可用性**。02 须固定每个插件／CLI 的准确版本、制品摘要及可复现依赖图；不能以源码 workspace 可导入推断发行包可导入。此次没有下载 npm tarball、安装依赖或运行 postinstall。

## 02 最小实验建议（本次未执行）

1. **官方启动与装配**：隔离临时 home，经官方 profile 启动真实发行制品；薄插件加载普通 TS 模块并提供合成健康入口。记录最终插件树、进程树、Node／包版本与锁摘要；证明业务与 DSH 同进程、Electron 不承担业务运行。所有非业务 Shell、文件写入、子 Agent、标题、压缩、持久化、上传能力均不进入有效树。
2. **单次请求与结构化结果**：本机假 provider 捕获请求，正常单次语义调用恰好一个物理请求。验证有效 JSON／输出工具、非法字段、错误类型、缺字段、工具缺失、未提交结果、max-tokens、流中断；每种失败均不提交业务结果。根 Agent 的输出 schema／终止合同不足时给最小复现，再讨论适配，不静默启用子 Agent 或改核心。
3. **取消与释放**：在创建、模型等待、工具执行、重试退避和完成前分别取消；await dispose 后 Agent／Session 注册消失，旧工具不可调用。测试不合作假 provider／工具，记录退出边界和失败；迟到结果与取消后重试不得写库，已发请求照实计账。
4. **作用域与删除**：两个 owner、每个两个合成 contact 并发运行，工具及 Skill 只见各自允许内容。运行中禁用／删除 Skill 或来源，重建运行后不可恢复旧目录／正文；provider 失败不能借 last-good view 绕过业务资格。保持业务讨论 PG 持久化，DSH 无隐式 resume。
5. **出站与文件证据**：拦截所有网络请求和临时目录变化；断言无 `dsh_session_log`、`dsh_plugin_packages`、OTEL 请求或 JSONL 正文副本。覆盖正常、错误、取消、反馈、关闭和重启；临时 Session 与关闭上传分别断言，不能互相替代。
6. **预算与制品闭包**：注入 429／5xx／超时及重试取消，统计 attempt、tokens 和截止时间；无标题／压缩隐式调用。核验准确 npm 制品与官方源码关系、exports、全部依赖、退出资源和打包前所需资源清单；不因源码可用直接认证发行集成。

## 本次验证与数据处理

- 实际执行：官方仓库 `git ls-remote`；固定 SHA 归档 HTTP 下载／解压；`rg`、`sed` 阅读文档、源码、配置和测试例子；`git show 3c168296:...` 核对既有回复输出适配；官方 npm registry 只读元数据查询。源码放在任务专用 `/tmp/notalone-dsh-official-687f282`，未放进产品依赖目录。
- 文档验证：45 个链接通过检查（固定 commit 链接对应的源码文件及行号存在、本地文档链接存在）；另检查正文尾随空白。`git diff --check -- research/dsh-ts-baseline-official.md` 无输出，但此文件被忽略，不能把该命令当作覆盖了新增正文的证据。这些检查不运行 DSH，也不代表 API 集成验收。
- 数据影响：仅读取公开 DSH 资料和本仓源码；未读取私人聊天、真实业务库、凭据或 `.env`，未调用真实模型，未启动 App、安装依赖、打包或发送消息。
- 未完成：02 的运行、网络、文件、取消、结构化输出、依赖闭包与真实供应商合同均未验证。当前仍是 Python 产品实现；本文不签收 01 的其他子交付，也不解锁下游任务。
- 清理：本次没有构建产物、运行进程或依赖安装；任务专用公开源码与原归档约 200 MiB，保留供主会话复核固定行号，不作为产品运行资源。
- 协作边界：研究原稿受 `.gitignore:22` 的 `/research/` 忽略，未强制加入 Git；主会话追加授权保存此证据副本并统一本地提交，子会话没有单独 add／commit。
