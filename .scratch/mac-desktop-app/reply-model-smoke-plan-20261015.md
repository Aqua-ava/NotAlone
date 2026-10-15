# 生产回复链路的官方 DeepSeek 合成冒烟准备

日期：2026-10-15，准备跨至10月16日。状态：离线实现及两轴审查完成，真实入口尚未执行。2026-10-16已核对协调会话的原始用户消息：要求三个会话设置目标并在完整授权下持续完成；本场必要DeepSeek合成验证沿该授权执行，不再逐批索要额度，仍须先记录具体新批次合同。本文不修改任务20状态或记忆评测冻结资料。

## 目标与最小范围

最终真实入口限定为当前签名App：新隔离userData连接本场受限后端，选择唯一合成联系人并点击“确认本次联系人”，只点击一次“生成候选”。单次草稿改写经App公开生成桥、当前认证HTTP、生产回复服务／运行时及隔离 PostgreSQL保存候选与依据。草稿固定为“明天我有空，晚点见。”，要求固定为“更自然一点，保留原意，不添加新事实。”；`include_relationship_context=false`。库中不放真实聊天、历史消息、关系记忆、待确认候选或Skill；记忆默认放行表保持空，不启动记忆Worker、同步、原生探针或CLI，不操作微信，不复制或发送。当前准备阶段不启动App。

本场事先限定 **最多1次实际供应商 HTTP**，零重试、失败也占额；生产运行时20秒保持，整场App调度最多5分钟、最多1次启动。一个正确的 `ReplyRuntimeOutput` 工具输出可以在这一轮完成；模型若先调用其他只读工具而需要下一轮，第二次出站必须在传输前拒绝，保留本场失败，不续额、不换模型、不自动开新 run。本场没有记忆提取 E／核验 V 两阶段，也不另用模型评价候选。失败后先本机诊断和实质修复，后继必要批次独立预登记，不能以连续新建run绕过停止条件。

最终实跑成功才认证**当前签名App的一次显式草稿改写→生产HTTP／PG／runtime→真实模型候选显示与保存**，模型装配为验收专用。本轮Mock只能证明HTTP／SDK／PG接缝，不能单独代签任务20的App模型链路。两者均不认证默认App模型配置、关系上下文检索、多轮助手讨论、生成质量总体、真实联系人身份、微信、TCC、自动采纳或发送。任务20其余条件分别保留。

## 现有接缝与前置缺口

源码读取基点为 `d6767ceb7bff9b243f273486ba4c8648fe545c7d`，另有其他 Agent 的工作区修改；执行前须重新冻结实际相关源码摘要。

| 证据 | 可复用内容及限制 |
| --- | --- |
| [`desktop/src/main/reply/client.ts`](../../desktop/src/main/reply/client.ts)，`generateReply` 第50行起 | 当前 App 先取默认助手会话，再用相同正文调用 `/replies/prepare` 和 `/replies`。本场复用此 HTTP 协议；不用旧 `/api/reply/generate` 冒充当前助手会话保存链路。 |
| [`server/app.py`](../../backend/src/notalone/server/app.py)，第1206行起 | `POST /api/contacts/{contact}/assistant-session/default`；`POST /api/contacts/{contact}/assistant-sessions/{sid}/replies/prepare`；同路径 `/replies`；最后认证 GET 复读保存结果与依据。prepare不应调用供应商。 |
| [`server/reply_wiring.py`](../../backend/src/notalone/server/reply_wiring.py)，第53–110行 | `build_reply_service` 已允许显式注入 `input_budget_profile`／`input_token_counter`，内部仍组装真实 Postgres 上下文、Skill、Store、出站台账和 `LangChainReplyRuntime`。只在新验收后端的模型工厂接缝返回真实受限 `ChatDeepSeek`，不替换 runtime、prompt、输出 schema 或持久化。 |
| [`deepseek_provider.py`](../../backend/src/notalone/reply/adapters/deepseek_provider.py)，第13、65行起 | 生产默认 `deepseek-chat`、`max_retries=2`，只公开同步 `http_client` 参数。本场不能直接照跑默认构造；验收专用构造须从一开始设置零重试并同时提供同步／异步客户端。生产默认保持不变。 |
| [`langchain_runtime.py`](../../backend/src/notalone/reply/adapters/langchain_runtime.py)，第607–621、700–757行 | 未注入已核实输入预算时保持 unknown；官方地址不会自动套用 ECNU profile。运行使用 `graph.ainvoke`，故只拦同步 transport 不足。`ToolStrategy(..., handle_errors=False)` 和仍存在的 `read_file` 意味着一次逻辑生成不保证只用一个 HTTP。原20秒 runtime时限保持。 |
| [`input_budget_middleware.py`](../../backend/src/notalone/reply/adapters/input_budget_middleware.py)，第218–277行 | 对真实 SDK 最终消息、工具和输出 schema完整编码；目前拒绝 `extra_body` 合并。不得用假计量、跳过middleware或删除结构化工具绕过。 |
| [`evaluation_http_budget.py`](../../backend/src/notalone/memory_extraction/evaluation_http_budget.py)，第74、249、344、476行起 | 已有持久 `EvaluationBudget` 及同步／异步 transport，可用于独立验收run；同一预算先持久预约再出站、并发拒绝、失败不退款、关闭不可恢复。只复用此机制，不改冻结文件，不复用记忆评测run或其记录语义。 |

旧 [`test_deepseek_smoke.py`](../../backend/tests/integration/reply/test_deepseek_smoke.py) 仅以凭据是否存在启用，含内存Store／Context、固定测试身份及默认库，没有本场持久硬预算。因此不直接执行，也不以其通过认证上述范围。

## 官方协议与本机 SDK 核验

本次只读核对本机版本：`langchain-deepseek 1.1.0`、`langchain-openai 1.5.1`、`langchain 1.3.15`、`openai 3.3.1`、`httpx 0.28.1`。DeepSeek SDK实际构造将 `max_retries` 与同步／异步 `http_client` 分别传给两个 OpenAI root client；不依赖构造后改字段。升级后重新核验并运行离线契约测试。

拟固定官方 `https://api.deepseek.com`、实际唯一端点 `https://api.deepseek.com/chat/completions`、`model=deepseek-flash`。这与生产默认模型别名不同，结果必须明确记录。模型名来自当前[官方能力表](https://api-docs.deepseek.com/quick_start/pricing/)；文档不是本场实测或最大上下文认证。

当前官方 Chat Completions 文档明确：默认启用thinking，thinking不支持 `tool_choice=required`；`reasoning_effort=none` 可关闭thinking。因此验收构造使用顶层 `reasoning_effort="none"`，保留生产ToolStrategy映射出的`required`；不用当前预算编码器尚未核实的`extra_body`、beta strict或其他端点。`temperature=0`、`stream=false`，输出上限由同一个预算profile写入。上述协议须在请求出站前逐字段复验，不能仅相信构造参数。[官方请求协议](https://api-docs.deepseek.com/api/create-chat-completion/)、[thinking说明](https://api-docs.deepseek.com/guides/thinking_mode/)。

离线收紧实际prompt时发现：生产图的SkillsMiddleware产生两个纯text system blocks，而本机ChatDeepSeek仅对assistant／tool作转换，system仍为list；官方协议要求system.content为string。经主Agent明确接受，本场新增唯一的验收provider序列化适配：只接收生产实际两个纯text块，第二块必须带原有`\n\n`边界，以同一分隔符确定性拼回string，保留全部原文字节；其他块数、类型或未知字段均拒绝。计量器与transport逐次核对同一完整最终payload摘要，system string必须字节一致。实际base／discussion／空Skill提示、两份完整工具schema、适配源码和SDK版本一同冻结；漂移须在出站前拒绝。**这不是修复或认证生产默认DeepSeek适配器**，最终报告必须继续写明非默认验收模型装配。

## 验收专用输入预算

不改生产默认、不冒用 `EcnuInputTokenCounter` 或 `synthetic_budget_kwargs`。新harness只为本场实现绑定真实模型对象、两个实际SDK root client、官方地址、零重试配置和最终请求字段的完整JSON估算器。覆盖system、messages、tools、response schema、model settings和供应商framing；任何未知字段、路由变化或对象错配均拒绝。

拟用 `APPROXIMATE`：完整规范JSON的UTF-8字节数加4096 framing估算，另保留16384安全余量与2048输出预留；本场有效输入策略窗口上限65536，完整出站JSON另限32768字节。这是明确收窄的短草稿验收策略，须核对其不超过官方已公布能力；字节估算不宣称真实tokenizer、数学上界或最大context。完整请求／工具schema若不能落在这个小范围，直接拒绝，不扩大上限。当前ADR-045的ECNU生产放行不扩展到其他生产配置；本场显式注入及上述估算局限单独记录。

## 准备实现与离线验证

本轮只拥有下列新增文件，不编辑已有dirty夹具、业务源、冻结71源、sealed reviews或任务票：

- `desktop/tests/reply-model-smoke-app-acceptance.spec.ts`：默认skip；即使环境存在key也不能自动运行。未来仅用当前签名包经真实生成按钮完成本场，失败不重试，正常菜单退出；当前只列举、默认skip和类型检查。
- `desktop/tests/reply-model-smoke-fixture.ts`：复用独立app-fixture／isolatedenv／有限test:app门禁，先核绝对包路径、ASAR摘要及严格签名，再启动专用后端；App不持有key或key文件位置。新隔离userData和PG，失败后保留精确清理线索。
- `desktop/tests/fixtures/reply-model-smoke-backend.py`：随机隔离PG、生产服务装配、合成单草稿、共用持久预算的两种transport、元数据收据和精确清理。
- `desktop/tests/fixtures/test_reply_model_smoke_backend.py`：离线Mock。模拟key且替换完整环境，DNS／socket真实出站硬拒；预算注册只落临时home，不创建真实用户registry或领取真实预算。

离线必须证明：生产HTTPprepare预约供应商0；正确结构化Mock响应完整保存并可GET复读；最终SDK序列化的model／endpoint／reasoning_effort／工具schema／输出限额吻合；同步／异步共用1份余额；503、超时、无效结构、错误模型及工具循环均保留失败；失败后无重试；第二轮未进入底层transport；路由、scope、key、schema或计量错配拒绝；缺任一显式启用条件时在读key／建真实预算／启动PG前退出。两个SDK client必须都是受限HTTPX client，`trust_env=false`、`follow_redirects=false`，禁止隐式代理和其他出站路径。记录写失败也须停，不能继续出站。

实现完成后先运行新增离线Mock、TypeScript检查、Playwright列举和默认skip，并做Standards／Spec两轴独立审查。此时交主Agent审查具体代码、冻结配置、命令与未决项；**不能只凭这份计划就向用户请求新模型额度**。不修改既有dirty rewrite／lifecycle夹具。

## 已授权范围内的单次执行合同

1. 先固定实际源码、prompt／schema、输入和配置摘要，确认离线及两轴已过。主Agent记录并告知本场合同：官方DeepSeek、合成草稿、最多1次实际HTTP、零重试、失败占额、结果范围和估算局限；准备与冻结完成前不读key、不创建／领取真实run。
2. 依上述持续授权新建独立随机run。只允许唯一官方POST端点；允许的实际请求数为1，串行、无重定向、无预热、无模型列表／试连接、无外部语义评审。旧42次记忆run已closed，17未用额永久关闭，不读旧registry或将旧余额带入。
3. 凭据只由本轮明确来源在成功领取后于子进程内部加载，不出现在命令行、stdout、日志、配置摘要或子进程诊断。禁用隐式dotenv／遥测；不复用用户业务库、默认App userData或导入真实资料。允许显式使用已有根`.env`，只解析官方端点、模型与key三项，不写入环境、不插值或回退；其余配置不用作本场服务连接。不得为准备本场提前读取或复制密钥。
4. 新隔离库只建立本场随机owner、contact、已确认合成绑定和空Skill库。App内手动选联系人及确认资格，填写固定草稿和要求，再经公开生成按钮触发默认会话、POST `/replies/prepare`及相同正文的`/replies`。所有本地请求使用新随机Bearer token；prepare供应商预约0已由离线HTTP回归验证，不能用测试端直接POST代替最终App按钮。
5. 持久预算`.batch()`包住整场。唯一供应商HTTP在底层发送前预约；HTTP错误、连接／读取失败、格式错、模型错、取消和超时都占额，不退款。预约失败或第二次请求触发不可恢复关闭。预约数是保守计费上限，不能把“已预约但未确认到达供应商”写成成功HTTP。
6. 保留生产20秒运行时及取消合同，不改成记忆评测的300秒。外层本地HTTP等待应覆盖原运行时收尾但有限；不得以超时自动重试。成功时断言同scope／session／turn／input／request的completed候选、草稿依据、无使用Skill，认证GET复读与PG／出站台账一致。模型可返回1–3条候选，不能把候选条数当HTTP次数。
7. 成功或失败均终结预算并取得`closed=true`、`request_limit=1`、`reserved_requests<=1`的持久回执；关闭无法核实时保留unknown，不另开run重做。保留原失败。成功场只编辑本地候选，不复制／发送，然后使用公开菜单正常退出并核exit0。关闭后台服务、客户端与自有连接，精确删除本场测试库和自有临时资源；保留私有预算／脱敏结果证据，核自有PID及库gone。App故障兜底关闭不计正常退出通过。

执行参数已具体化；准备完成、当前包核验及新冻结之后才能启动，不能把此处参数示例当作已执行证据：

- `NOTALONE_REPLY_MODEL_SMOKE_APP_ACCEPTANCE=1`。
- `NOTALONE_TEST_APP_EXECUTABLE`为本轮当前签名`.app/Contents/MacOS/...`绝对路径；`NOTALONE_REPLY_MODEL_SMOKE_APP_ASAR_SHA256`为该包ASAR实际摘要。
- `NOTALONE_REPLY_MODEL_SMOKE_AUTHORIZED_RUN_ID`为本场独立新run；`NOTALONE_REPLY_MODEL_SMOKE_OUTPUT`为本机私有0700输出目录，不能与临时夹具目录相同。
- `NOTALONE_REPLY_MODEL_SMOKE_KEY_FILE`为获批后显式指定的本机私有凭据来源。本机已有根`.env`可直接复用：仅该准确路径允许最多16KiB，读取后核验`NOTALONE_DEEPSEEK_BASE_URL`为官方地址、`NOTALONE_DEEPSEEK_MODEL=deepseek-flash`及唯一API key；重复、缺失、插值、其他端点／模型拒绝。也支持最多1KiB的单行key文件，其他`.env*`路径在打开前拒绝。所有来源须普通文件、本人0600，打开采用NOFOLLOW／NONBLOCK并复验；不在参数中放key内容。准备阶段只查本机根`.env`的文件类型／权限／大小，未读内容。
- `NOTALONE_REPLY_MODEL_SMOKE_CONFIG_SHA256`须匹配当前实际源码／SDK／schema／输入／ASAR冻结摘要。可在**不含key和预算的准备阶段**用已激活Conda的`python -B desktop/tests/fixtures/reply-model-smoke-backend.py --configuration <ASAR摘要>`输出公开配置与摘要；此命令不读key、不创建预算或连接服务。
- 主Agent在`desktop/`沿现有有限`npm run test:app -- --interactive --coordinator <本轮ID> --from <当前开始> --until <有限截止> --max-launches 1 --file tests/reply-model-smoke-app-acceptance.spec.ts --output artifacts/<本轮目录>`执行；`test:app`的dist构建由主Agent串行协调，不能在当前准备中执行。

## 输出与拒绝条件

公开摘要只含runId、实际model／端点／模式、源码与输入摘要、预算及HTTP实际计数、固定错误类别、候选数／依据匹配等布尔计数、运行耗时和清理结果。只在本机私有证据保留必要的合成输入／输出；headers、key、环境、数据库连接串和内部思维链不记录。生产出站台账按既有流程写入隔离PG，不能用其1条逻辑记录推导实际HTTP只有1次。

以下任一发生即拒绝真实启用：仅有旧记忆预算；缺本场具体新台账或冻结配置；依赖真实联系人／聊天／默认库；使用ECNU或其他端点／模型回退；无法核实真实异步transport；只有常量假计量；默认thinking与required冲突；出现未知extra_body、未核实schema或超出小策略上限；缺离线、类型、默认skip或任一审查；原失败被覆盖；退出／清理归属不明。被拒绝不自动扩大本场额度，也不改任务20为通过。

## 本轮实际状态

已完成代码、版本与官方文档核验，以及新增有界后端／App入口；当前离线Mock **24／24，4.527秒**，包括认证公开HTTP→生产装配→真实SDK序列化→Mock→PG保存复读，以及显式项目凭据源与其他来源打开前拒绝。只为离线测试在临时home建立合成预算，拒绝外部DNS／socket，仅公开HTTP回归临时允许自有127.0.0.1服务；用户真实registry未读取或创建。原missing入口、HTTP装配、spy过宽、wire／提示／schema／system协议及凭据源红灯和中间测试错误均保留，不覆盖为一次全绿。

最小离线验证（仓库根目录，先激活Conda）：`PYTHONPATH=backend/src:backend NOTALONE_DISABLE_DOTENV=1 python -B -m unittest discover -s desktop/tests/fixtures -p test_reply_model_smoke_backend.py -v`。当前最终日志为`desktop/artifacts/reply-model-smoke-final-mock-20261016-v3.log`，前22项结果独立保留。类型为`desktop/`下`npm run typecheck`；列举与默认skip使用忽略目录内独立Playwright config，只匹配本片spec、没有globalSetup，不调用全局App／headless lease。它们只验证注册及默认关闭，不能证明App集成已运行。

原22项阶段最终类型检查exit0；独立配置列举1项exit0、默认skip1项exit0；`git diff --check`通过。日志分别为`desktop/artifacts/reply-model-smoke-final-types-20261015.log`、`reply-model-smoke-final-list-20261015.log`和`reply-model-smoke-final-skip-20261015.log`。该阶段Standards硬违规0／smell0，初审两项清理P2已修正；Spec0，原提示／完整schema冻结P2已修正，获批的恰好两个纯text system blocks无损适配已复核。根Agent的显式凭据源增量与24项结果已获两轴增量复核，均0发现。两轴均只读，未执行真实入口。

准备阶段已对当前v5包实际ASAR核摘要`a888634004538e3bc441204a8018238c38a6435720825e2a37afafba98f4ef0c`，并用上述无key／无预算`--configuration`命令冻结实际10个源码、完整prompt／工具schema、输入及已安装SDK版本；加入显式项目凭据源后，当前配置摘要为`6787cb10f0778a9fa7b4692c18116bbad0e1a6d9a5b69851486895f8c9bb676c`，完整公开配置保存在忽略产物`desktop/artifacts/reply-model-smoke-final-configuration-20261016.json`。旧22项阶段配置和产物保留，不用于本次启动。配置按实际文件内容和ASAR核验，不把此前Git历史读点当当前源码。文件、包或依赖变动后须重新核摘要，不能沿用本值。

本轮真实凭据读取0、真实预算创建／领取0、模型HTTP0、App／CLI／微信／build／发送0。仅完成验收专用非默认装配的准备；不能把准备通过写成真实App／模型或生产默认DeepSeek链路已经通过。
