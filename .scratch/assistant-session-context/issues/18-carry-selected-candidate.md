# 18：显式携候选新开与满会话分流

State: resolved
Triage: ready-for-agent
Blocked by: [assistant-session-context/10 新开、列出与选择旧会话](10-session-list-and-new.md)；[assistant-session-context/11 候选编辑、选择与版本回看](11-candidate-edit-history.md)；[assistant-session-context/12 模型预算提醒与超限拒绝](12-input-budget-guard.md)

拆分标识：C12（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧05；Q3、Q17新开。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)。依赖是完整交付的前置，不代表这些前置已完成；后端提供者已接续实现，当前部分交付及剩余验证见 Answer。

## What to build

在普通或已满会话中选择全新开始，或只带指定候选新开；临时要求与整段讨论不被搬入。

## Acceptance criteria

- [x] 普通或已满会话都能选择全新开始，或只携用户明确选中的候选版本；不携整段讨论和临时要求。
- [x] 携入前复验候选、范围与原始来源，失效候选拒绝；新会话不自动生成，旧会话仍可查看。
- [x] 携入内容维持来源传递依赖，来源删除覆盖新旧会话相关副本；保留不依赖该来源的讨论。
- [x] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [x] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

包含候选/来源复验、仅选择版本的内容、来源依赖传递及删除；不是复制整份历史。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。


### 18 最小后端携入与删除血缘切片（自动部分）

2026-10-11：从正式 `0b6780acf1926eca7073f573474d9692ffa033f8` 独立导出，仅叠加本票后端切片及真实 055。公开 `POST /assistant-sessions/{session_id}/new-with-candidate` 只接受已保存选择的 `expected_selection_id`、`candidate_id`、`version_id`，同 owner 事务复验原会话、绑定、当前选择 CAS、完整版本消息组、原始来源及样本后调用目录唯一新会话 writer。新会话不预留任务、不调用模型；只持久化原 UUID 来历与全组指纹，正文逐次从原权威版本读取，不携入整段历史或旧临时要求，改变原会话选择不会更改已携入版本。

- 首条真实 HTTP RED：候选携入 404，1 项 / 0.675 秒；同项接线后 1 项 GREEN / 0.700 秒。原会话删除后 child CURRENT 未清的真实 RED：1 项 / 0.916 秒；同事务预捕获携入边及 C typed 捕获，复用 A 唯一 selector/eraser 后 1 项 GREEN / 0.949 秒。
- `read_candidate_carry_lineage_for_deletion(connection, *, owner_id) -> tuple[AssistantCarryInputLineage, ...]` 是 A 唯一实际携入 origin 适配器：复验真实 parent input/turn/C request/candidate/version、053 历史选择回执及全组指纹，不调用删除期间的来源可用性或 CURRENT guard，不解码 C JSON、不另建图或摘要算法。A9 在清除父版本/选择/C 快照前捕获并计算闭包；实际消费 carry 的后继生成一并清除，无 turn 的 carry 输入也清除 CURRENT。
- 9 项新公开 HTTP 加 3 项实际迁移，共 12 项 GREEN / 8.724 秒：包含整组编辑版、选择 CAS、历史选择变更、模型只得到该组、owner/contact/session 越界、正文注入、来源 delete_requested、新开预算阻断分流、主动样本独立留存，以及携入写入/父删除失败整体回滚。源依赖夹具首跑误用未实际命中聊天的独立 rewrite，错期待拒绝；仅改为真实 reply_to_message 捕获并保留原断言，再跑 7 项 GREEN / 6.571 秒，旧失败日志保留，没有放宽守卫。
- 真实生产 001–055 新装、重复执行 0；实际 001–054 升级仅执行 055，保留旧讨论；账本故障时原约束和 54 条账本整体回滚，解除合成故障后执行真实 055。每个迁移测试库与外层 runner 自有库残留 0。必要相关会话目录、删除、候选版本及 typed 捕获回归合计 57 项 GREEN / 29.278 秒；两个纯协议测试 GREEN / 1.082 秒，四源码有限 mypy 与 14 个 Python 文件编译通过。受控迟到删除回归出现既有无正文租约失效日志，57 项结果仍全部通过。
- 已主动保存的表达样本按 ADR-044 保留，删除父会话不能通过它恢复旧候选；原始资料删除仍须由 C 物理 caller 消费本 typed adapter 收口。该 C 跨会话物理接线及桌面公开操作在后续集成阶段验证，本切片不冒充这两项已完成。

实际命令：Conda `NotAlone`，`PGPORT=55441 python /private/tmp/notalone-coordinator-isolated-tests.py <本票独立源码> tests.integration.server.test_assistant_candidate_carry tests.integration.persistence.test_assistant_candidate_carry_migration`；同 runner 的 `tests.integration.server.test_assistant_session_catalog tests.integration.server.test_assistant_session_deletion tests.integration.persistence.test_assistant_captured_input_erasure tests.integration.persistence.test_assistant_candidate_versions.AssistantCandidateVersionsStoreTest`；`PYTHONPATH=src python -m unittest tests.unit.application.test_assistant_candidate_carry -q`；`PYTHONPATH=src python -m mypy --follow-imports=silent` 四源码；`py_compile` 14 文件。dotenv、LangSmith 与 LangChain tracing 均关闭。日志保留在任务独立临时交付目录，不提交合成正文或运行产物。

本票保持 claimed，原 Acceptance criteria 未改写或预勾：自动后端部分完成，桌面自动部分继续，人工部分未执行。未运行 Page、真实 App/native、19、微信/OCR、私人聊天或外部模型，未 push、发布、部署。


主 Agent 最窄提供者交付复核：当前正式 `04d1cbb` 独立导出，仅叠加本票16文件（15后端源／测试含正式055、以及本票状态与准确追加），没有13／15 working、桌面及C物理消费者。关键父会话删除、来源待删后历史CURRENT推进、ADR-044先主动保存样本的三项实际HTTP／PG回归 **3 / 3 GREEN／2.494秒**；正式001–055账本匹配、repeat0、外层与测试自有库剩余0，日志 `/private/tmp/notalone-a18-root-provider-448wsl6n/root-provider3.log`。原实现12项、57相关PG与真实RED／夹具错误记录保持，不将本次窄复核重复记为原完整组合。

新鲜两轴：Standards硬性违例0、possible Duplicated Code P3一项（同事务重复resolve，可后续复用；不引入跨事务缓存）；Spec新错实现0／范围扩张0。`read_candidate_carry_lineage_for_deletion(connection, *, owner_id)` 向唯一选择器提供已复验的 `AssistantCarryInputLineage`；真正C物理删除消费、桌面Main／公开Page仍未完成。原验收框不预勾，State保持claimed；自动部分持续推进、人工与原生部分未执行。本次只创建本地提交，无push、发布、部署。


### 总协调主树提供者独立集成复验（2026-10-11）

主树从 A 正式 `2de3f6469fd969b29c2df5b3ef15ce7f2605fcbd` 精确净接十五 backend／迁移／测试路径及本票阶段记录；直接patch check／apply通过。共享 app 仅导入和新路由分发，保留主树既有B owner guard、准备接口及其它处理，没有以owner整文件覆盖当前版本。055由sole A提供，真实迁移扩展candidate_carry输入，携入正文仍从实际已选择版本读取，持久化来历仅元数据；没有占位迁移。

Conda `NotAlone`，禁 dotenv／tracing，执行 `/private/tmp/notalone-coordinator-isolated-tests.py /Users/local-user/learn/NotAlone` 加 `tests.integration.server.test_assistant_candidate_carry`、`tests.integration.persistence.test_assistant_candidate_carry_migration`：**12 GREEN／10.544秒／skip0／actualexit0**。原9实际HTTP、3真实迁移验证正式001–055账本／repeat0；迁移测试的三个自有库及外层自有库剩余全部0。再加原 `test_assistant_discussion_context`、`test_assistant_dependency_erasure`、`test_assistant_captured_input_erasure`：**57 GREEN／16.382秒／skip0／actualexit0**，同样55 ledger／repeat0及三个迁移／外层库0；不是借owner57的29.278秒。两项新增应用单元GREEN0.967秒，四文件限定silent mypy、十四实际Python文件compile及diff通过，未知全后端类型债务未冒称通过。

真实测试覆盖三个UUID严格入口、实际选择和版本身份、跨范围／来源拒绝、只带选定组／无临时要求、零自动模型、物理旧会话删除前typed捕获及carry边进入A唯一闭包、派生副本清除和独立讨论／主动保存样本保留、后继输入与回滚。删除前专用来历读取复用原A指纹，不进入availability或CURRENT门禁；普通读取和生成仍检查来源可用性，也不另造C图或writer。实际日志 `/private/tmp/notalone-root-candidate-carry-provider-http-pg.log`、`/private/tmp/notalone-root-candidate-carry-related-pg.log` 保留。

这仍是后端提供者切片：桌面携入RPC／选择与满会话分流、公开Page→HTTP→PG闭环由A继续，C物理source／sample pre-capture和sole A canonical独立草稿例外选择接口继续。主树新055不会用旧A16/A17硬编码54的夹具通过冒新前缀结果；其机械升级由A另主题交付。原五条验收不勾，State claimed，不据12／57关闭整18或C06。只处理合成资料与随机隔离库，无付费／外部模型、原生App、微信/OCR、私人聊天、外部发送、push、发布或部署。


主树新鲜 Standards 发现新 HTTP 嵌套夹具在 setup 后才注册清理、且 doCleanups 的失败可能被外层吞掉。仅本测试生命周期修正：setup 前注册 cleanup wrapper，内层清理返回 False 时令外层失败；产品源与业务断言未改。实际 unittest 公共运行边界的两个私有故障探针（部分 setup 失败仍释放已分配资源、内层 cleanup 失败不能成为外层 GREEN）先 **2 RED／0.001秒／exit1**，修复后 **2 GREEN／0.001秒／exit0**；未创建数据库、HTTP 或模型，不将其冒为业务端到端。日志 `/private/tmp/notalone-root-carry-cleanup-lifecycle-red.log`、`/private/tmp/notalone-root-carry-cleanup-lifecycle-green.log`。

清理修正后用同 Conda／禁 dotenv 与 tracing／自有随机数据库命令重跑原九 HTTP 和三迁移：**12 GREEN／11.135秒／skip0／actualexit0**，真实001–055账本及repeat0，三个迁移库与外层库剩余全部0，日志 `/private/tmp/notalone-root-candidate-carry-cleanup-fixed-http-pg.log`。这是修正后的实际重跑，不替换此前12／57或owner的数字。新鲜 Standards Hard0／重要possible0，旧清理P2关闭；Spec删除前专用来历读取表述已限定，普通读取和生成仍检查来源可用性。桌面及C物理组合继续，本票仍claimed，原五条验收文字和未勾状态保留。

## Answer

### 本轮自主协调最终结果（2026-10-12）

普通会话与受控预算已满会话都可全新开始或只携明确选定版本；新会话零模型、旧记录保留，来源物理删除清新旧相关副本并保留无关讨论。主树3HTTP及最后2场公开DOM均通过。

剩余：本票可自主范围已完成。真实模型语义、自然度、关系适配及用户相似度未知；本轮没有原生App、私人资料、微信／OCR、外部发送或远端操作。

证据：[29票逐项结果与实际命令](../../unfinished-work/round29-autonomous-results-20261011.md)、[固定源码、自动验证及清理回执](../../unfinished-work/round29-autonomous-verification-20261011.json)。各次不同来源的计量分列，未把静态审查、合成模型或受控宿主冒为原生／真人通过。原验收文本逐行对共同基线保留；只更新实际可验收的勾选和State。
