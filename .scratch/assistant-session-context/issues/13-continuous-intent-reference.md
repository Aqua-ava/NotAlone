# 13：连续要求、改口与明确编号指代

State: claimed
Triage: ready-for-agent
Blocked by: [assistant-session-context/11 候选编辑、选择与版本回看](11-candidate-edit-history.md)；[assistant-session-context/12 模型预算提醒与超限拒绝](12-input-budget-guard.md)

拆分标识：C06（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧02；Q1、Q7、Q8。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)。依赖是完整交付的前置，不代表这些前置已完成；完整交付仍待接续，当前实现与验证范围见 Answer。

## What to build

用户说“第二条自然一点”或改变意愿后继续生成；明确编号映射当前展示组，含糊指代先澄清。

## Acceptance criteria

- [ ] 前次生成结束后，“第二条自然一点”解析到本会话最近展示组的明确候选；缺项、歧义或跨会话指代要求澄清。
- [ ] 明确改口覆盖冲突要求，兼容要求保留，不写成长期偏好；用户能看到实际继续的候选和要求。
- [ ] 累积讨论经过C11同一输入预算守卫；超限不调用模型，不能只测试一轮而遗漏增长场景。
- [ ] 脚本模型验证明确场景及澄清去向，不宣称真实模型理解质量通过；生成中替换由C07完成。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

只在原生成结束后提交本轮；保留兼容要求、移除冲突要求，不跨联系人/会话解析，不变成长久偏好。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

## Answer

2026-10-11 总协调主树仅集成 A 正式 `155392165fd649b0c6fcf4186cf5375a7ba2e35d` 的五个捕获删除核心路径。复用 C 实际 `CapturedReplyDiscussionUse` 和唯一样本依赖读取口，核验已保存的 owner/contact、SID、输入、turn、历史各自 binding、请求、候选版本及原指纹，将无正文边交给 A 唯一输入闭包。原擦除路径同时清除被选中的无 turn 输入正文，仅清除指向受影响输入的 CURRENT；ADR-044 的独立主动保存样本继续保留。主树已有原 053 前缀迁移夹具，不重复导入该第六路径。

实际命令先激活 Conda `NotAlone`，禁用 dotenv 和 tracing：

- `python /private/tmp/notalone-coordinator-isolated-tests.py /Users/local-user/learn/NotAlone tests.integration.persistence.test_assistant_captured_input_erasure`：8 项真实 PG GREEN／1.168 秒／exit0。首次默认沙箱 socket EPERM 未建测试库，仅属环境入口失败，不计产品 RED。
- 同一 runner 运行 `test_assistant_captured_input_erasure`、`test_assistant_dependency_erasure`、`test_assistant_reply_identity`、`test_reply_discussion_dependencies`、`test_assistant_discussion_context`、`test_assistant_candidate_versions` 六个实际 persistence 模块：94 项 GREEN／12.885 秒／exit0，无 skip。外层正式 001–054 账本与重复 0；两个原候选前缀测试分别实证 001–053 fresh、001–052→仅053，重复均空，外层及两前缀自有库剩余均 0。没有外部模型调用。
- 四个核心文件 `python -m mypy --follow-imports=silent` 通过；五个来源／测试文件 `python -m py_compile` 及 `git diff --check` 通过。限定类型检查不代表全后端已知类型债务通过。

本切片只证明类型化捕获身份复验和数据层删除闭包；C 物理来源／样本删除前的真实 pre-capture 薄调用方仍由 C 接续。完整连续要求、改口与编号指代的 HTTP／公开页面、累积输入预算、A18 携入及后续迁移仍待对应正式交付和主树验证。原验收标准全部保留且未勾选，State 为 claimed，不把 core 的 94 项当完整 A13 或 C06 集成通过。只处理合成资料与自有隔离数据库，没有新正文缓存、第二依赖图、第二 writer、外部发送或付费调用；真实 App、微信/OCR、人工验收、push、部署均按本轮范围未执行。


### 来源删除权威预选择接口的主树集成（2026-10-11）

仅净接 A 正式 `bca4734e98e8a68f755ec4e2098438a39fd66b59` 的两个 backend 源／测试路径；本票只追加主树自身证据，未整文件覆盖 A13。`select_assistant_source_input_dependents` 提取原 eraser 的查询和独立 running rewrite 分类，eraser 与 C 删除前选择共用同一权威规则；复用原 `AssistantInputDependents`、typed captures 和 carry edges，没有第二图、codec、指纹算法、正文缓存或 writer。范围撤销的真正独立 running 草稿仅失败、保留输入正文与 CURRENT；实际来源根和捕获的后继仍清除。C 必须在同 owner 锁及状态／snapshot／parent／receipt 清空之前捕获和选择，再按实际 request IDs 清正文副本。

主树在正式 `ee9e5e2` 的真实001–055迁移下，禁 dotenv／tracing，用同自有随机库 runner 执行 `test_assistant_captured_input_erasure`（现在9项）、`test_assistant_dependency_erasure`、`test_reply_discussion_dependencies`：**33 GREEN／5.012秒／skip0／actualexit0**，真实账本55／repeat0／外层自有库0，没有外部模型。新第9项实际证明同来源撤销的独立运行草稿保留输入与 CURRENT、已捕获的实际依赖正文擦除，预选择与最终擦除一致。单源 silent mypy、两个实际 Python 文件编译与 diff 通过。日志 `/private/tmp/notalone-root-canonical-source-selection-pg.log`。

该最窄提供者已交唯一 C 物理删除消费者；C 的实际 source／sample 薄接线和跨联系人 caller 尚须其正式交付后在主树验证。完整 A13 连续要求／改口／编号与累计预算公开页面仍继续，本票维持 claimed，六条原验收文字与未勾状态保留；不以本次9或33数据库回归关闭本票或 C06。未运行真实 App、微信／OCR、私人聊天或人工质量实验。
