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
