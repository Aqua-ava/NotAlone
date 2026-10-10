# 12：模型预算提醒与超限拒绝

State: claimed
Triage: ready-for-agent
Blocked by: [assistant-session-context/07 默认会话的一次生成与可靠保存](07-default-session-persistence.md)

拆分标识：C11（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧05；Q2、Q17预算。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)。依赖是完整交付的前置，不代表这些前置已完成；本票尚未实现。

## What to build

用户提交讨论时看到接近上限提醒，硬上限时不调用模型但可继续查看历史。

## Acceptance criteria

- [ ] 预算计算包含系统指令、讨论、检索/Skill/工具及输出预留，按配置模型能力验证；初次和后续有界调用都经过检查。
- [ ] 可控配置下接近阈值显示提醒，硬上限拒绝模型调用但可查看历史；不以自动摘要或静默截断规避上限。
- [ ] 验证阈值前后及工具补入后预算，保持已有检索材料预算；计量能力未知时不假装精确或允许超限。
- [ ] 交付可复用的同一预算守卫供C06/C07/C08使用；全新会话入口在C04可用后接入，携候选由C12完成。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

覆盖系统、讨论、检索/工具和输出预留；配置临界值可验证，不静默截断或压缩。先提供已有全新会话能力的入口（可用时），携候选由C12完成。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

## Answer

2026-10-11 阶段 3a：完整调用预算守卫、实际运行时接线与显式合成计量配置完成当前自动切片，整票仍为 claimed。累计助手讨论、可信预算回执的持久化、公开 HTTP／页面提醒及探索运行时的同一守卫仍在实施；本切片通过不代表 12 整票完成。

- 新增 `InputBudgetProfile/InputBudgetRequest/InputTokenCounter/InputBudgetGuard`。仅允许已核实的精确计量或保守上界，必须覆盖 system、messages、tools、response schema、model settings、provider framing 六部分并对应同一模型与计量配置。未知能力或输出预留、错误覆盖、计量失败均在实际模型调用前拒绝，不用字符比例猜真实供应商 token。
- `LangChainReplyRuntime` 接受 `input_budget_profile/input_token_counter/on_input_budget`。最内层中间件在 Skills 动态 system 生效后逐轮计量最终请求，结构化输出工具也计入，并绑定计入预算的实际输出上限；原工具调用、查询行数、返回正文及超时限制保持。
- `build_reply_service` 只透传明确配置。真实 DeepSeek 的完整计量和能力尚未核实，默认未知并阻断，没有调用供应商。合成协议独立声明 JSON 计量方式与 framing，计量器绑定同一模型对象，纳入实际 defaults、model kwargs 和最终工具／设置，不能外推成真实供应商的精确 token。
- Core、Fidelity、保存／删除测试、PostgreSQL 回复流程、原运行时单元及 rewrite／import 夹具统一显式合成配置，只补预算配置和保留 `bind_tools` 实参，不删业务断言或绕过权限。按真实启动 cwd／PYTHONPATH 导入两个页面脚本并实例化模型及配置成功，没有启动 App。

实际命令在 Conda `NotAlone`、关闭 dotenv／追踪的环境运行：

```bash
NOTALONE_DISABLE_DOTENV=1 LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false PYTHONPATH=src python -m unittest tests.unit.reply.test_input_budget tests.unit.reply.test_input_budget_middleware tests.unit.reply.test_input_budget_runtime tests.unit.reply.test_input_budget_runtime_limits tests.unit.reply.test_langchain_vertical_slice tests.unit.reply.test_skill_runtime_resources tests.unit.reply.test_runtime_limits tests.unit.reply.test_history_tools tests.unit.reply.test_fidelity_input -q
PGPORT=55441 python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-a-session tests.integration.server.test_reply_message_groups tests.integration.persistence.test_reply_exploration tests.integration.server.test_assistant_session_deletion tests.integration.server.test_core_business_flow
```

- 实现上下文取得 73 项单元 GREEN，含旧控制契约、B 隐藏依赖、阈值、完整样本及工具后检查；30 项真实 HTTP／隔离 PG GREEN，22.566 秒。生产 runner 安装正式 001–052，自有随机库残留 0。
- 未知模型放行及缺少构造参数先取得两条真实 RED，接线后 GREEN。临界提醒允许一次调用；初始硬超限零次；历史 Tool 补入后第二轮阻断，只有一次实际调用、两次完整计量，原消息仍完整。完整样本参考可使请求超限，零次调用。初版样本夹具未明确启用关系背景而被权限守卫拒绝，只修复合成授权，没有放宽产品规则。
- 默认沙箱首次拒绝本地 PG socket，不作功能 RED；仅对已授权自有 55441 隔离库升级后取得实际结果。失效租约负例有无正文的既有异常类别日志，未打印计量请求、讨论、凭据或私人资料。
- `py_compile`、真实夹具导入探针、`git diff --check` 通过。09 首个公开页面生成前置随后到达缺删除按钮的真实 RED，证明合成装配可运行；不代表 12 的公开预算闭环或真实模型计量已完成。

剩余自主工作：权威完整讨论读取与删除依赖、可信预算元数据同候选保存和重读、公开错误及温和提醒、增长和超限历史仍可查看与新开，以及 B 独立探索 SDK 入口。两轴审查及本地提交按切片推进。本轮自动部分尚在实施，人工部分未执行；不运行真实 App、微信、OCR、外部模型或 19，不 push、发布或部署。

阶段 3a 提交前双轴审查已执行：Standards 硬规范 1、判断性气味 0；Spec 2。重叠模型身份问题合并后共有三处实际缺口：嵌套 `extra_body` 可以改写计入预算的输出上限，顶层 `model_settings.model` 可以绕过 profile 身份，通用消息转换丢弃无效工具调用并改变系统文本块结构。离线 SDK 合成探针显示后续轮实际请求可能超过已计量总量，未调用供应商。当前不交付正式守卫，正在新增真实 RED 并修复；先前 73／30 GREEN 保留为执行事实，不作为这些边界已解决的证据。

阶段 3a 修复记录：上述三处发现已用真实图与离线 SDK 载荷对照修复。计量器新增 `is_bound_to(actual_model) is True` 装配约定；SDK 路径复用实际 `bind_tools` 和原消息序列的 `_get_request_payload`，保留系统内容块、无效工具调用、schema 及有效默认参数，并核对最终模型路由和所有输出上限。未核实的 SDK transport 附加正文、Responses API 和通用转换扩展保持明确拒绝，不以同名模型代替真实对象绑定。

- 新增供应商边界测试先取得 5 条实际 FAIL，修复后扩为 7 项；与原 73 项合计 80 项 GREEN，主 Agent 复跑 1.517 秒。离线合成 JSON 协议的计量与实际 SDK 载荷逐项一致，两轮完整总量为 10,384／12,859；容量 10,984 时仅调用一次模型，第二轮检查拒绝。嵌套输出改写、模型改写及错误计量器对象均零次模型调用。该合成单位不是供应商 token，不能证明真实 DeepSeek 能力。
- 主 Agent 对新合入的 B 生成领取测试补显式合成预算装配；原直接运行时构造因 unknown 正确拒绝而报错，只增加测试配置，未放宽产品。正式 001–053 迁移的真实随机 PG 组合：8 项 `test_explored_generation`、12 项 `test_assistant_session_deletion`、1 项 `test_reply_message_groups`、2 项 `test_core_business_flow`，共 23 项 GREEN／19.649 秒，自有测试库残留 0。新测试构造属于 12 预算夹具适配，B 原业务断言保留。
- 实际单元命令为上列单元命令再加入 `tests.unit.reply.test_input_budget_provider_boundary`。组合命令为 `PGPORT=55441 python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-a-session tests.integration.persistence.test_explored_generation tests.integration.server.test_assistant_session_deletion tests.integration.server.test_reply_message_groups tests.integration.server.test_core_business_flow`。单元与组合的首次包装命令在测试结束后因 zsh 只读变量 `status` 报错，读取真实 unittest 输出分别确认 80 项 OK 及缺配置错误；后续组合用独立变量 `test_exit` 正确返回 0，不把包装错误当功能 RED。
- 规范修复复审：原 P1 已关闭，硬要求 0、判断性气味 0；规格修复复审 0 条 actionable findings，规格审查者独立重跑 7 项离线边界回归 GREEN／0.408 秒。12 仍为 claimed，累计讨论、预算元数据持久化及公开提醒继续实施；自动部分尚在推进，人工部分未执行。

阶段 3b 前置：A 完整讨论数据源切片已实现并独立验证。`read_assistant_discussion_in_transaction(connection, scope, request_key)` 按实际 A051 当前 generation 读取同范围完整有效历史，排除本次 generation 正文；`require_assistant_discussion_current(connection, scope, snapshot)` 在调用方同连接、同 owner 事务中复验当前 UUID、已使用对象及内容、原始来源和样本状态，不提交或另开锁连接。不可变 `DiscussionContext`／`DiscussionSnapshot` 区分低权重旧讨论、完整候选消息组版本、默认展示与实际选择；正文只在内存，快照仅实际 ID 与指纹，来源 ID 和样本 ID 分别返回，含无 raw 根的手动样本。新版本若未被旧请求使用，不据此失效旧快照。

- 独立新上下文 TDD 共 20 项 PG 反馈，覆盖范围、实际 owner_memory 跨联系人来源证明、删除前后复验、manual 样本、旧候选、绑定、当前 UUID、内容指纹、无隐式提交、不可变容器及长讨论无截断。发现并修复历史数据数组污染的范围验证、已删候选错误分类等边界，没有改变 C 的来源权威。
- 主 Agent 最近真实命令：`PGPORT=55441 python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-a-session tests.integration.persistence.test_assistant_discussion_context tests.integration.persistence.test_assistant_candidate_versions.AssistantCandidateVersionsStoreTest`，共 34 项 GREEN／2.988 秒，正式 001–053、自有随机库残留 0。有限 mypy 两源码、三个文件语法与差异检查通过。只读限定双轴审查 Standards 硬要求／气味 0、Spec 0。
- 该数据源依赖已正式交付的 11 存储切片与 053；其删除组合回归依赖 09 后端。C 仍唯一负责实际读取来源的捕获、保存前复验及删除传递清理；A 没有混写 `reply_style_sample_use` 或复制当前样本正文。本切片不意味着新派生已清除、模型已接完整历史或整票完成。
- 公开预算回执首条 NEW HTTP TDD 已取得真实 RED：临界请求守卫为 warning，HTTP 200 且确实调用模型，但公开响应缺少 `input_budget`。1 项／2.018 秒 FAIL，自有库残留 0；持久回执和新硬上限配置下重读旧历史断言尚未执行到。后续接局部计量回执、可信持久化和页面提示，不用模型输出或 runtime 全局 lastDecision 伪造预算。


阶段 3b 薄协议交付：新增严格 `discussion_snapshot_to_payload`／`discussion_snapshot_from_payload`（固定 version 1，仅真实范围／对象 UUID 与 SHA 指纹），拒绝正文、未知字段、非规范 UUID、非 HEX 指纹、重复身份及本次输入／turn 自引用。新增 `require_assistant_discussion_available(connection, scope, snapshot)` 区分历史来源可用性与当前输入 CAS：已完成甲在乙的新输入或绑定撤销后仍可查看，复验原锚点及所用历史，不能推进或回退当前指针；`require_assistant_discussion_current` 继续用于运行／保存的同事务当前版本检查。自锚点不重新进入自己的 C 请求守卫。

- 本阶段实际 `PGPORT=55441 python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-a-session tests.integration.persistence.test_assistant_discussion_context tests.integration.persistence.test_assistant_candidate_versions.AssistantCandidateVersionsStoreTest`：23 历史＋14 候选版本，共 37 项 GREEN／4.317 秒，正式生产 001–053 随机库残留 0；新增纯协议 10 项 GREEN／0.005 秒，有限 mypy 两源码与差异检查通过。各新增纯反馈有真实 RED→GREEN；三条新 PG 中首项 API 缺失 RED→GREEN，其余两项是已有守卫的回归，不虚构 RED。合入期间中止一轮 exit130 且已清理，不计成功或业务失败。
- 独立两轴限定审查：Standards 硬要求 0、低风险判断性 Duplicated Code 1（两个政策入口的身份四元组比较保持显式；无事务或范围行为重复），Spec 0。审查者各自重跑 10 纯协议 GREEN。只交薄契约，不宣称 C 中央捕获、派生擦除或累计模型输入已完成。
- 先前阶段的工作树测试确有未正式交付 A10 夹具导入。正式测试修复 `55adc98ca69f3555a48468356f9b9cd91ec4e19d` 移除此导入，以正式 048 表中的合成行准备独立会话，原范围、来源和正文断言全部保留；`git archive` 正式树加精确补丁的隔离副本 36 项历史／版本／迁移 GREEN／3.941 秒，库残留 0，两轴 0。此前 34 项执行事实保留，本次才补足独立正式消费的前置证明。
- 当前历史 generation 用户正文仍按旧规则要求完成状态；自审已确认该规则会误丢失败、预算阻断或被替换但来源仍有效的用户要求，与规格累计讨论不符。已告知总协调，下一独立真实 TDD 将区分有效用户输入与完成 AI 候选，并用实际总预算回归防止绕过；不将旧过滤当最终契约。12 保持 claimed，自动部分继续实施，人工部分未执行；无真实 App、OCR、微信、外部模型或 19，无 push／发布／部署。


阶段 3c 规格纠正交付：将有效用户历史输入与完成 AI 候选的可用性分开。失败、运行中、仅 reserve 及被替换但来源仍有效的 generation 用户正文完整进入累计讨论；候选必须同时证明 A turn 与 C request completed。A 尚未保存 reply 外键时，只按实际 owner/contact/binding/idempotency key 关联真实 C request 并核验其已捕获来源与样本，无 C request 时只核验真实 turn 依赖。`available` 同样接受来源有效的 failed 用户锚点，支持原失败键重试，不放松 CURRENT 指针／绑定 CAS，快照格式和已完成记录指纹构造不变。

- 新增 9 项真实 PG 回归。正文遗漏、真实 C 请求未匹配、实际 raw 依赖漏返回、failed 锚点误拒绝分别取得实际 RED→GREEN；其余来源／manual 样本／替换终态／内容变更／完成保存与 A 完成间隔／状态变更回归初跑即 GREEN。旧排除 USER 断言是对规格的错误解读，现明确更名并纠正为保留 USER／不纳入未完成 AI，不删减任何来源或删除断言；没有引用尚未提交的 14 helper。
- 实现上下文正式 001–053 隔离 PG：32 历史＋14 版本，共 46 项 GREEN／4.535 秒，纯协议 10 项 GREEN／0.005 秒、有限 mypy 两源码与差异检查通过，每轮自有库残留 0。主 Agent 再从正式 `cc9609c` 导出独立副本，只加入这两个已审文件，排除所有未提交 metadata／14／10／前端源码：46 项 GREEN／4.258 秒，正式生产迁移和库清理均核实。限定两轴 Standards 硬要求／气味 0，Spec 0。
- C 中央来源与样本删除仍须覆盖 prepared pending／failed、A reply FK 尚为空的实际同键 turn，并清除 fresh-read 用户正文；本阶段验证旧捕获拒绝，不将 fresh-read 派生擦除声称为通过。完整生产模型上下文与总预算增长／替换共用仍继续接线。12 保持 claimed，自动部分继续实施，人工部分未执行；没有实际 App、OCR、微信、外部模型或远端操作。

总协调主树集成阶段 3b／3c：按顺序消费正式 `fda3696ac85642bb8dd3bdc2c4d2129dbbde654f`、`55adc98ca69f3555a48468356f9b9cd91ec4e19d`、`2c0b02c13e65ebf4835f645cb40d7b224b3a680a`、`fa3aa385c189c5474cc26fbb636d39d6e203260f`，只集成本票五个文件，不取 A 未提交的运行时、回执、目录或替换功能。

- 在 Conda `NotAlone`、关闭 dotenv／追踪、`PYTHONPATH=src:.` 环境，运行 `python /private/tmp/notalone-coordinator-isolated-tests.py /Users/local-user/learn/NotAlone tests.integration.persistence.test_assistant_discussion_context tests.integration.persistence.test_assistant_candidate_versions`：48 项 GREEN／6.939 秒（32 历史、16 候选版本及迁移验证），真实正式 001–053、52→53 与 fresh／重复迁移均验证，自有根库和嵌套库残留 0。
- 同环境 `python -m unittest tests.unit.reply.test_assistant_discussion_serialization -q`：10 项 GREEN／0.010 秒；差异检查通过。最终限定双轴静态复审 Standards 硬要求 0／重要气味 0、Spec 0，不把静态复审冒充额外运行证据。
- 本次完成数据源与严格身份协议的独立主树集成。累计完整模型载荷、可信预算回执、公开提醒和 C 的中央捕获／派生硬擦除仍由原负责人继续；12 保持 claimed，原验收标准完整保留，人工部分未执行。
