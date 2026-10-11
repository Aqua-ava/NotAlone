# 12：模型预算提醒与超限拒绝

State: claimed
Triage: ready-for-agent
Blocked by: [assistant-session-context/07 默认会话的一次生成与可靠保存](07-default-session-persistence.md)

拆分标识：C11（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧05；Q2、Q17预算。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)。依赖是完整交付的前置，不代表这些前置已完成；预算守卫及界面已部分实现，公开页面组合仍接续。

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

2026-10-11 上述单测试夹具与本票两文件最终独立审查：Standards硬要求0／重要Fowler可能气味0、Spec新增P0–P2为0；保持原断言与失败门禁，生命周期probe和真实十一HTTP结果分别记录，不借测试清理修复关闭预算UI或来源擦除。

2026-10-11 总协调主树消费B正式2d1f178的单测试夹具清理修复：原真实TestCase生命周期probe分别取得RED（部分setUp已分配资源不清理、doCleanups失败外层仍GREEN）；仅把cleanup登记移至setUp前，且失败向当前runner报告后，同probe两条GREEN：setUp仍有真实error但cleanup已执行，清理失败仍error且runner不成功。该probe只替换合成生命周期，不启动HTTP／PG／模型／页面；不冒作真实服务验收。原完整讨论预算HTTP十一项另在生产001–053随机库真实GREEN／18.806秒、skip0、repeat0、精确remaining0。产品和原断言未改，没有增模型／迁移；这修复避免测试错误冒充成功及残留自有资源。完整provider主树28c5证据保持，预算UI、大响应及pureDraft擦除仍接续，claimed不变。

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


阶段 3b 可信预算回执切片：每次实际运行调用使用局部 collector 收集守卫决策，最终成功决策经 `ReplyRuntimeResult → ValidatedReply → ReplyGenerated` 传递，并与候选在同一事务保存进既有 `context_snapshot.input_budget`。常驻 runtime 没有共享 `lastDecision`，模型输出 schema 没有预算字段；模型添加同名字段会被拒绝。成功回执只包含固定十项纯元数据，严格 codec 拒绝未知字段、正文、缺字段、非整数、bool、非有限数值及不一致总量；旧记录缺字段保留兼容，已存在但为 null／损坏的字段显式失败。重读与幂等回放使用已保存值，不按新 profile 重算。

- 首条公开 warning 反馈的真实 RED 保留：守卫已允许实际模型调用，HTTP 200 但响应缺预算字段。局部回执传递、实际候选事务保存和主 Agent 的公开 projection 接线后，主 Agent 独立复跑 1 项 GREEN／2.522 秒、正式 001–053 自有随机库残留 0。Assistant 端点未知计量与硬超限返回明确 409 状态及纯决策；旧全局生成端点原 502 契约保持。
- 新增严格 codec 5 项与真实运行时 4 项先取得模块缺失／字段缺失 RED，接线后合计 9 项 GREEN／0.138 秒。运行时测试保留真实 LangChain 图，覆盖末轮完整回执、工具补入后最终回执、同一 runtime 两次重叠调用各自归属，以及模型伪造预算字段的拒绝；只替换外部模型。新增实际内存 Store／Generator／Runtime 重放 1 项 GREEN／0.019 秒，新构造 runtime 的能力未知也不会在重放时调用模型。此项是保存契约回归，未虚构额外 RED。
- NEW `tests.integration.server.test_assistant_input_budget` 实际公开 HTTP 11 项 GREEN／19.723 秒，正式生产 001–053，自有随机库残留 0。覆盖临界 warning 同候选保存与低容量配置重读、未知计量／初始硬限零次模型、工具材料补入后只有一次模型并在第二轮拒绝、未知新配置下重放原回执、旧记录无字段、损坏字段 503 无正文／无模型、候选保存事务失败不发布部分结果并可重新生成、模型伪造拒绝、删除后 GET／旧键 POST 404。首轮新删除夹具漏传正式公开 `confirmed: true` 得到 400，补齐字段后单项 1.515 秒 GREEN，再跑全组 11 项 GREEN；没有放宽确认规则。
- 本轮实际命令：`PGPORT=55441 python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-a-session tests.integration.server.test_assistant_input_budget`；`NOTALONE_DISABLE_DOTENV=1 LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false PYTHONPATH=src python -m unittest tests.unit.reply.test_input_budget_receipt tests.unit.reply.test_input_budget_metadata_runtime -q`；同环境 `tests.unit.reply.test_input_budget_metadata_store -q`。`py_compile` 新 codec 与测试、`git diff --check` 通过。公开组日志在 `/private/tmp/notalone-assistant-input-budget-http-final.log`，未提交正文或日志产物。
- 页面采样清理后，只补 `snapshot: dict[str, Any]` 显式类型。正式 `fa3aa385c189c5474cc26fbb636d39d6e203260f` 的六源独立导出与当前七源分别运行有限 mypy，均为同一组 11 条既有错误；新增 codec 单独 mypy 通过。类型对照日志为 `/private/tmp/notalone-input-budget-mypy-baseline.log`／`/private/tmp/notalone-input-budget-mypy-current.log`，不将全七源称为类型检查通过。13 个源码／测试文件 `py_compile` 和差异检查通过。
- 最终 128 项单元 GREEN／2.050 秒，包含原 80、新增 metadata 10 及既有 Generator／Store 38。首次组合得到 13 个旧单元存储夹具不透传新回执的错误，严格持久化结果一致性检查正确拒绝；经主 Agent 授权，仅在 `test_langchain_vertical_slice`／`test_skill_runtime_resources` 的既有 Store 夹具各加一行 `input_budget=reply.input_budget`，原断言和守卫保持。组合日志为 `/private/tmp/notalone-input-budget-metadata-unit-final.log`。
- 扩展 PG 组合实际执行 43 项／35.860 秒，37 通过、6 失败，自有随机库残留 0；11 项 NEW 预算与 24 项原会话 API 均通过。6 项全部在旧 `test_postgres_reply_flow` 夹具的 C 原始来源捕获处、预算／模型前拒绝。正式 `fa3aa385` 完整 backend 独立导出、不包含任何本切片修改，再跑该 8 项，0.304 秒同样 2 通过／6 失败，正式 001–053 与库清理均已核对。未弱化 C 来源守卫，也未改该 PG 夹具；基线事实交由 C 来源负责人处理，不将 43 项写成全 GREEN。日志为 `/private/tmp/notalone-input-budget-metadata-pg-final.log`／`/private/tmp/notalone-input-budget-postgres-flow-baseline.log`。一次包装命令将 `reply` 拼为 `rely`，得到模块导入错误，11 HTTP 仍通过且数据库清理；随后用正确命令完成上述 43 项，不作功能 RED。
- 此切片尚未将权威完整讨论接入生产模型，也未交付预算公开页面提醒或临界大历史响应可读边界；已有全新会话入口和携候选按各自票处理。12 仍为 claimed，自动部分继续实施，人工部分未执行；没有真实 App、微信、OCR、外部模型、push、发布或部署。

最终单元与 PG 组合命令如下，均在 Conda `NotAlone` 执行，关闭 dotenv／追踪，PG 使用 runner 自有随机测试库：

```bash
NOTALONE_DISABLE_DOTENV=1 LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false PYTHONPATH=src python -m unittest tests.unit.reply.test_input_budget tests.unit.reply.test_input_budget_middleware tests.unit.reply.test_input_budget_runtime tests.unit.reply.test_input_budget_runtime_limits tests.unit.reply.test_langchain_vertical_slice tests.unit.reply.test_skill_runtime_resources tests.unit.reply.test_runtime_limits tests.unit.reply.test_history_tools tests.unit.reply.test_fidelity_input tests.unit.reply.test_input_budget_provider_boundary tests.unit.reply.test_input_budget_receipt tests.unit.reply.test_input_budget_metadata_runtime tests.unit.reply.test_input_budget_metadata_store tests.unit.reply.test_generator tests.unit.reply.test_store_lifecycle -q
PGPORT=55441 python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-a-session tests.integration.server.test_assistant_input_budget tests.integration.reply.test_postgres_reply_flow tests.integration.server.test_assistant_session_api
PYTHONPATH=src python -m mypy --follow-imports=silent src/notalone/reply/input_budget_receipt.py
PYTHONPATH=src python -m mypy --follow-imports=silent src/notalone/reply/input_budget_receipt.py src/notalone/reply/runtime.py src/notalone/reply/interface.py src/notalone/reply/store.py src/notalone/reply/generator.py src/notalone/persistence/reply_store.py src/notalone/reply/adapters/langchain_runtime.py
```

阶段3d提交前独立复核：仅正式 fa3aa385 导出加本回执切片（未包含10目录、11公开路由或14替换working依赖）实际11项HTTP再次全部GREEN／19.749秒，生产001–053、自有随机库剩余0。Standards硬规范0／判断性气味0，Spec0；审查独立运行新增10纯测试／0.374秒及48相关纯测试／0.116秒均通过。128单元与原43中37通过、6同基线来源夹具失败的事实保持，完整讨论生产接线、预算页面提醒仍待，本票继续claimed，自动部分继续实施、人工部分未执行。

总协调主树正式消费 `d4e00f8a9cc5cdf82e14aca028a21fb837443520` 的十五文件；唯一存储冲突将预算回执与已正式 C `reply_discussion_metadata` 一起同事务保存，不覆盖历史身份／样本依赖，也不取 A10／11／14 未提交源码。实际验证使用 Conda `NotAlone`、关闭 dotenv／追踪、`PYTHONPATH=src:.`：

- `python -m unittest discover -s tests/unit/reply -t . -q`：293 项 GREEN／3.152 秒，权限撤回负例保留既有无正文 Skill 日志。
- `python /private/tmp/notalone-coordinator-isolated-tests.py /Users/local-user/learn/NotAlone tests.integration.server.test_assistant_input_budget tests.integration.persistence.test_reply_discussion_dependencies tests.integration.server.test_authentic_expression_skill_exploration tests.integration.server.test_style_reference_budget_api`：26 项真实 HTTP／数据库 GREEN／30.381 秒（11 回执、10 中央依赖、2 Skill、3 工具预算），正式生产 001–053，自有随机库残留 0。
- 新 codec 单文件 mypy、相关十二源码／测试 py_compile 与差异检查通过；未把既有十一条类型基线称为全库通过。限定最终 Standards 硬要求 0／重要气味 0、Spec 0。

本次完成可信预算回执的主树集成，完整讨论模型载荷及预算增长、温和页面提醒和 C 已记录物理擦除缺口继续由原负责人推进；12 保持 claimed，原验收不修改，人工部分未执行。

阶段 3e 完整讨论生产消费者：在正式预算回执 `d4e00f8`、C 讨论来源消费 `3223a135c824ef0eb6ced1e71e4a282dd1f832b2` 基础上，新增 `PostgresAssistantDiscussionContext`，正式 `build_reply_service` 将其组合在 `ExploredReplyContext` 外层。基础上下文及其当前性验证先完成，再在单一 owner 锁／连接内调用正式 `read_assistant_discussion_in_transaction`／`require_assistant_discussion_current`，避免与基础样本适配器自有连接锁重入。无真实 A generation 锚点时保留旧全局回复的 `None`；真实 A 锚点不能静默绕过读取。

- A 历史依赖读取移除重复样本递归 SQL，只调用 C 唯一 `reply_style_sample_dependencies` 同连接端口；没有改动 C 中央来源／样本模块，也没有把历史样本混入当前五条直接参考。来源捕获、CURRENT 保存复验、HISTORY 重读和依赖删除仍由正式 C 接缝负责。
- 最终模型请求新增完整 `assistant_discussion`：保留正式 reader 顺序中的全部讨论输入、来源有效的 USER（含失败／阻断／被替换输入）、完成 AI 的每个消息组版本及父版本、默认展示／显式选择身份。正文逐项原样进入请求，不摘要、截断或另存历史正文副本；明确标为低权重讨论参考、不是联系人事实、未发送，当前明确意愿优先。系统提示增加同一边界说明；既有 fidelity、消息组、工具、Skill 和输出协议保持，最内层预算守卫逐轮计入新增完整正文与系统提示。
- 首条真正公开 HTTP 反馈在生产装配下取得 RED：1 项／0.558 秒，实际模型请求缺少 `assistant_discussion`；接线后同项 GREEN／0.536 秒，每次正式 001–053 随机库残留 0。日志为 `/private/tmp/notalone-assistant-discussion-consumer-red.log`／`/private/tmp/notalone-assistant-discussion-consumer-green.log`。后续新增项为公开契约回归，未虚构额外 RED；夹具曾将初始候选版本误写为 1（正式为 0）、将缺省意愿传为空字符串而触发公开 400，均只修正合成夹具，不放宽产品校验。一次测试编辑错误导致 NameError，修复后重新执行全组，不计为功能缺口。
- NEW `tests.integration.server.test_assistant_discussion_budget` 共 11 项实际公开 HTTP GREEN／17.785 秒，日志为 `/private/tmp/notalone-assistant-discussion-consumer-final-http.log`。覆盖完整 USER／AI 版本与选择、累计 warning 后硬限零次新增模型、被预算阻断的 USER 在下一次仍完整保留、两轮真实工具调用均保留全部原历史、同对象合成计量载荷与实际出站载荷一致、完成键在新输入／未知配置下重放且不回退 CURRENT、范围隔离、删除后旧键不可复活及新会话无旧历史。正式版本／样本 Store 构造两版候选及手动样本：当前五条参考不包含旧样本，删除旧样本后 C 清理三个实际依赖 turn，独立讨论仍可继续生成。
- 最终一次必要回归：回复纯单元 293 项 GREEN／1.882 秒；NEW 消费者 11、既有预算 HTTP 11、A 历史 32、C 讨论依赖 10、正式 C 版本 HTTP 2，组合共 66 项真实 PostgreSQL GREEN／58.686 秒。runner 实际安装正式生产 001–053，自有随机库剩余 0。日志为 `/private/tmp/notalone-assistant-discussion-consumer-unit-final.log`／`/private/tmp/notalone-assistant-discussion-consumer-pg-final.log`。这是当前工作树本切片的运行证据，独立正式导出、两轴复审与本地提交由主 Agent 后续执行。
- 两个 NEW 源文件有限 mypy 通过；五个生产源与两个测试文件共七文件 `py_compile`、`git diff --check` 通过。14 的独立夹具由该票 owner 接入真实消费者，本票未修改其文件或预填第八项结果。13 的连续指代薄字段尚未加入本次运行时补丁，后续由主 Agent 组合，不冒充本组已经验证其行为。

本切片精确文件范围为 `persistence/assistant_discussion_reply_context.py`、`reply/assistant_discussion_payload.py` 两个 NEW 源，`persistence/assistant_discussion_context.py`、`reply/adapters/langchain_runtime.py`、`server/reply_wiring.py` 三个现有源，NEW `tests/integration/server/test_assistant_discussion_budget.py`、既有 `tests/integration/server/test_assistant_input_budget.py` 的可选同对象计量观察构造，以及本票 Answer。没有修改 A Store／Service／App、B 探索、C 中央守卫、桌面或页面夹具。

实际命令在 Conda `NotAlone`、backend cwd 执行；PG runner 使用已授权本地 55441 自有随机库，模型只替换为显式合成协议适配器，没有真实供应商请求：

```bash
NOTALONE_DISABLE_DOTENV=1 LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false PYTHONPATH=src python -m unittest discover -s tests/unit/reply -t . -q
PGPORT=55441 python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-a-session tests.integration.server.test_assistant_discussion_budget tests.integration.server.test_assistant_input_budget tests.integration.persistence.test_assistant_discussion_context tests.integration.persistence.test_reply_discussion_dependencies tests.integration.server.test_authentic_expression_candidate_versions
PYTHONPATH=src python -m mypy --follow-imports=silent src/notalone/persistence/assistant_discussion_reply_context.py src/notalone/reply/assistant_discussion_payload.py
PYTHONPATH=src python -m py_compile src/notalone/persistence/assistant_discussion_reply_context.py src/notalone/reply/assistant_discussion_payload.py src/notalone/persistence/assistant_discussion_context.py src/notalone/reply/adapters/langchain_runtime.py src/notalone/server/reply_wiring.py tests/integration/server/test_assistant_discussion_budget.py tests/integration/server/test_assistant_input_budget.py
git diff --check
```

完整讨论现在已接入生产模型及同一预算守卫，旧完整历史在阻断和低容量重读时仍由公开 HTTP 读取。尚未执行预算公开页面提醒／新会话入口闭环，未验证桌面 JsonClient 1 MiB 响应边界下的大历史可读性；真实 DeepSeek 的能力／计量仍未核实，默认阻断规则保持。合成计量不是供应商 token，也不证明自然语言质量。12 保持 claimed，自动部分继续实施、人工部分未执行；未运行真实 App、微信、OCR、私人资料、外部模型、push、发布或部署，未自行暂存或提交。

阶段 3e 提交前主 Agent 独立验证：正式 `daa443deac6bafddfb6ad704a7ce80bc710aba94` 完整导出，只叠加以上七个源／测试文件，不包含任何尚未提交的 10 前端、11 选择读取、13 或 14 补丁。实际 `PGPORT=55441 python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-a12-discussion-cut-triek9ew/source tests.integration.server.test_assistant_discussion_budget tests.integration.server.test_assistant_input_budget` 共 22 项 HTTP GREEN／37.545 秒，生产 001–053、自有随机库剩余 0；日志 `/private/tmp/notalone-a12-discussion-fresh-http.log`。冻结源码的独立两轴审查：Standards 硬规范 0、Fowler 判断 0；Spec 错实现／范围扩张／actionable 各 0，并明确保留预算页面与大历史响应两项票级 partial。规格审查者另跑 21 项纯单元及三项合成载荷探针 GREEN，不作 PG 或页面证据。完整讨论只在当前生成内存和原权威资料中存在，没有新增长期副本。

总协调主树接续正式 `9e1a1d816c703e6434c7c6a75bb5e409edc0d4f2` 八文件：七源码／测试原样集成，任务记录冲突保留主树全部可信回执证据及本提交精确追加内容。在 Conda `NotAlone`、关闭 dotenv／追踪、`PYTHONPATH=src:.` 环境实际运行上文同五模块的主树隔离 runner：66 项 GREEN／47.426 秒（24 真实 HTTP、42 存储集成），生产 001–053、自有库精确剩余 0。回复单元 293 项 GREEN／2.287 秒；两个新源 mypy、七文件 py_compile 与差异检查通过。最终限定 Standards 硬要求／重要气味 0、Spec 0。完整有序消息组正文含实际消息 UUID 和本次要求的 JSON，原样进入模型并计量；未增加历史副本。预算 UI、1 MiB 大响应和 C 旧纯草稿历史依赖删除的物理擦除缺口仍由原负责人接续，本次不将其关闭，12 保持 claimed；人工／原生／外部模型未执行。

正式A 5ee4eac仅测试修正后缀净接；以下77项等结果归A，根最小独立复验另记。


### 来源删除后的 CURRENT 回归测试修正

2026-10-11：仅更正一个已过时的合成 HTTP 验收期待，生产预算、C 来源守卫、模型上下文和写入者均未修改。旧样本删除按正式路径清除三个依赖生成输入并将 CURRENT 置空；继续携带已被擦除的 expected_input_version_id 请求新模型本来必须失败。纯正式 c0844 无任何此补丁取得真 RED：1 项／1.557 秒／exit1，旧用例错误地要求200；与11分页切片无关。

新断言先证明 CURRENT为空、三条实际generation输入均redacted且正文NULL；旧expected身份返回409 assistant_session_input_conflict、模型增量0、公开GET讨论逐字未改变。再由合成用户以新UUID键提交独立新草稿、不携已删除expected，返回200且仅新增一次可控模型调用，实际新input UUID不属于已删除集合、CURRENT指向新输入。原独立讨论、当前五次与旧历史样本分离及模型完整历史断言全部保留，没有抹去失败或恢复旧身份。

TDD：同项1 / 1 GREEN／2.013秒；完整相关讨论预算模块11 / 11 GREEN／17.733秒，均真实生产001–054迁移、账本匹配、repeat0及两层自有库剩余0。旧RED/新GREEN/完整模块原始日志保留于 /private/tmp/notalone-a12-deleted-current-compat-r8h5tfht；本阶段只提交这一测试与本票追加。全票仍claimed，预算页面与有界大历史读取等剩余自动范围继续；人工、Page/App/native、19、微信/OCR与私人资料未执行。

主 Agent 新鲜限定两轴：Standards 硬性0／Fowler判断0；Spec actionable0、越界0，确认旧expect200已过时且未削弱删除。最终正式11分页＋实际C启动＋本测试的相关完整组合77 / 77 GREEN／46.440秒，正式54迁移账本、repeat0及自有库0；原76G1F与purebaseline RED继续保留，不作预算公开页面完成证据。

2026-10-11 总协调仅净接正式A `5ee4eac` 原测试的22行修正及本票后缀，未修改预算、CURRENT或删除生产代码。主树实际认证HTTP→隔离PG整个原模块 **11 GREEN／17.853s／skip0／actualexit0**；001–054账本／repeat0、自有库剩余0。旧身份409及零模型、完整历史不变、新键独立输入一次模型和新CURRENT的加强断言全部通过，原样本、讨论与删除标准保留。新鲜Standards硬要求0／重要Fowler possible0、Spec新增P0–P3为0；两轴只读未代测试。此提交不代表累计预算公开UI完成，12仍claimed，公开提醒与新开路径由A继续正式交付，人工未执行。


### 预算界面与归属守卫的主树集成（2026-10-11）

只净A正式328f985c56e4c3fcadb0b5df46a748bde004cbc1的14桌面源码／测试路径，本票追加主树证据；保留B6a隐藏探索四行、Bpurpose、12e编辑通知、e092保存通知、80b来源复验与C七字段当前显示版／未提交稿保存及结果重读复位，没有whole覆盖Main或renderer。预算纯元数据严格解码，模型能力未知和硬上限仅按原权威守卫拒绝；旧409／旧成功GET被更新CURRENT或读取超越时不能复活旧提示／结果，同CURRENT合法warning继续显示，普通失败的同键身份仍保留。无模型能力HTTP写入口、正文缓存、第二writer或静默摘要。

主树规定Conda NotAlone、禁dotenv／tracing、PGPORT=55441串行运行node --test tests/assistant-input-budget-public.test.mjs：**25 GREEN／93664.136792ms／skip0／actualexit0**；25实际fixture各001–055逐名账本／repeat0／instance及class清理true／database_remaining=false；实际受控模型调用31。预算read另**3 GREEN／84.660083ms／skip0／actualexit0**，合计28项但不把25个实际HTTP写作28个HTTP。最小硬限409另1 GREEN／4323.436292ms／模型0／55库0，225既有候选版本／复制／样本相关Node GREEN／1370.573917ms，whole桌面TSC及diff通过。日志/private/tmp/notalone-root-input-budget-public-http55.log、/private/tmp/notalone-root-input-budget-read-node.log、/private/tmp/notalone-root-input-budget-minimal-http55.log、/private/tmp/notalone-root-input-budget-related-node.log。首次read在根cwd导致3构建路径ERROR，改规定desktop入口后同代码3G；一次额外端口尝试被沙箱listen EPERM及不存在的jobs文件入口拒绝，未作为产品RED或有效测试证据，未改产品以绕过。

真实Main/preload→认证HTTP→隔离PG和SSR提示已证明；A唯一负责的新普通公开DOM页面预算case仍待正式交付和主树运行，不能用静态HTML或owner自己的28项代替它。完整预算阈值及工具轮后端既有证据保持，完整连续意图／新消息／携入和真正App／供应商质量与停算仍不外推。本票维持claimed、六条原AC文字及未勾状态保留；只有合成数据／可控模型，无App、OCR、微信、外部发送、私料、付费模型、人工或远端操作。

后续新P2的真实主树反馈（2026-10-11）：Root与B规格审查同样发现budget409后CURRENT复验GET异常被空catch吞掉，无法证明输入已失效却清idle并丢同键身份；原25HTTP不覆盖此情形。只净B正式a5eb6a186b83f91504e4757d00b7fc7d7254e4af的c598f2三path增量，先只取新增测试／共享BackendRequestFailure测试出口，在未改A328源时Root两实际HTTP409→PG failed→控制的delivery GET connection／503反例**2 RED／7824.234542ms／actualexit1／模型0／两055repeat0自有库0**；此为受控delivery seam错误，不声称真实TCP断线。

再只净Main最窄12行，区分不能复验与真正404／来源失效，前者显示原connection／unavailable一般失败、隐藏未复验budget并保同次request身份，后者及较晚CURRENT／loading仍失效，不新authorities。Root实际重跑新2故障＋真实confirmed DELETE后404＋8新CURRENT／成功迟到／loading相关回归：**11 GREEN／37225.823917ms／skip0／actualexit0**；11实际055repeat0／instance与class清理true／database_remaining=false，模型10，两新故障同键重试保持turn／key／CURRENT且模型0。日志/private/tmp/notalone-root-budget-read-fault-red-http55.log与/private/tmp/notalone-root-budget-read-fault-fixed-http55.log。TSC与diff再通过；原25／3阶段数及B8／8／1自己的证据各自保留，不将11写为原全25在修后全部重跑。新鲜两轴复核后此预算主题本地提交；公开DOM仍由A唯一case接续、claimed及原AC不改。

### 本轮独立工作树的公开预算提醒场景准备

从总协调正式 `84b5dd32` 接续，预算生产守卫与现有界面不另改；只增加七个明确测试／有限调度路径，保留所有现有 label、nonce、单 Chrome、租约和自有资源清理门禁。`assistant-input-budget` 仅含一个完整 warning 场景：通过真实生产页面先校准实际预算，再在合成模型夹具中把能力设为实际总量加 100，重新连接并明确新开，重新填入相同草稿、语气与要求。只使用合成容量配置，不增加产品能力的 HTTP 写入口；实际两模型、001–055 全名账本与重复迁移 0、named DOM 提示、草稿／本次要求／checkbox、保存历史及当时预算回执均有原精确断言。

旧源相同场景首次 RED 的真实 release 文件 `/private/tmp/notalone-a12-warning-page-red-release.json` 已只读核验：HTTP200／warning、模型2、实际总量9022／容量9122、正式55／repeat0，在缺 namedDOMstatus 的原5000ms断言失败，actualexit1；后续草稿与完整历史断言当时未执行。quiet17／active0／onscreen0／单Chrome、cleanuptrue、源changed[]及独立fresh status exit0/absent，旧窗口已 FULLRELEASE。不改写旧失败，也不把尚未执行的 GREEN 写为通过。

本树 `npm run typecheck`、两个 Python 夹具编译、`git diff --check` 与按正式 `packages: 'external'` 的 headless entry esbuild（write=false，不执行）通过；`node --test tests/headless/command.test.mjs` **10 GREEN／2712.184 ms／skip0／actualexit0**，仅合成 CLI／孩子与租约测试，没有实际页面。首个自写非标准 bundling 试图打包 Playwright 自带外部依赖，产生两个 resolve error；按项目脚本相同 external 方式复验通过，未安装或修改共享依赖，也不计产品 RED。

固定 ONLY7 差异独立 Standards：B Hard0／新增重要 possible Fowler0；独立 Spec：C 新增P0–P3=0，明确此准备只覆盖原AC2的 warning 切片，不能代替硬限、工具轮、未知计量或整12验收。真正公开页面须等待总协调新具名 single240 ACK，期间不沿用旧工作树 ACK、不与 B/C 并发起窗口。State保持claimed、六条原AC及未勾状态保持；没有真实App／原生、微信/OCR、私料、外部模型、人工或远端操作。

2026-10-11：总协调在台北21:24–21:29给本树 `6ad45edb` 的新具名 ONLY warning／single240 ACK。实际先核 clock13:24:45UTC在窗、独立租约 status exit0/absent、986个 tracked backend／desktop／native 源／配置／测试及HEAD字节不变、工作树clean，再以剥除外部tracing与模型环境的受限入口执行 `PGPORT=55441 node scripts/test-pages.mjs --case assistant-input-budget --timeout-seconds 240`。session9742 **actualexit0，完整一场 GREEN**；原 namedDOM status、5000ms断言、草稿／语气／本次要求／checkbox、完整保存讨论、当时预算以及实际 GET 回执等值均执行并通过。真实 HTTP200／warning，模型总2，实际总量9022／容量9122，正式001–055／repeat0。

实际 quiet10／active0／onscreen0／maxApps1／activationPolicies2，singleChrome、cleanupConfirmed=true、Electron/native=false。夹具 finally 的 instance/class 清理及准确自有库 `EXISTS=false` 门禁由实际childexit0和资源清理确认，未冒称总协调独立SQL。退出后986源changed[]／HEAD6ad45same／dirty空，两次独立 fresh status actualexit0/absent，已 FULLRELEASE 本树与OS窗口，不默认第二场。完整 receipt `/private/tmp/notalone-round29-a12-warning-release.json` 和实际日志 `/private/tmp/notalone-round29-a12-page-actual.log` 只保在自有临时目录，没有提交截图或库产物。

该真实 GREEN 闭合上述旧源 warning RED；仍仅此自动提醒场景，不借其关闭硬限完整页面、新消息采用、typed页、携入、退出或大历史读取边界。原六条验收标准和claimed状态继续保留，后续自动工作接续；真实App／原生／人工质量本轮未执行。

Root 净集成 `6ad45edb` 八路径与 `b9b5d360` 实际warning收尾记录后，主树独立完整桌面类型、两夹具编译、两headless入口的正式external-package esbuild和diff通过。租约只读freshstatus实际absent；`npm test` 实际 **40 GREEN／12206.496917ms／skip0**，范围为类型与调度CLI合成进程安全回归，未启动Chrome／Electron／真实App。warning Page仍按提供者具名窗口的单场实际证据计一次；Root独立核对该actual日志、986源无变化与freshstatus释放，不冒充本次新跑Page。hard-limit和超大历史公开验证仍继续，原AC与claimed不改。
