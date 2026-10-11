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


主树删除测试兼容补充（2026-10-11）：仅净接 A 正式 `ec808c02c58d0f93bd67822767d5ebf86d5319b7` 的必要两个测试路径。第9项原先先手工执行 A 擦除、再执行 C 物理删除，后者按新契约严格预捕获时已找不到 A 正文；只移除这一次重复 `_delete_source` 调用，保留所有真实选择／独立输入／CURRENT／失败与 redacted 断言。此项验证权威预选择和擦除的纯 seam；C 物理调用方由其单次同事务实际删除测试负责，不降低 typed 校验或把原 ERROR 藏为 skip。原 A18 嵌套清理语义主树 ee9 已同，仅空行差不重复净。普通 jobs 夹具的三处账本计数从54机械升级为已正式055，仍与实际全部文件／数据库账本逐名比较且repeat0。

主树禁 dotenv／tracing、Conda NotAlone 下重跑 `test_assistant_captured_input_erasure`：**9 GREEN／1.374秒／skip0／actualexit0／真实55账本／repeat0／外层库0**。新055 jobs 夹具另在同主树已正式B6a源净增下实际运行隐藏探索负向和普通hide／close继续正向两项生产桥接→HTTP→PG：**2 GREEN／6110.748917ms／skip0／actualexit0**，两份日志各自55／repeat0／instance与class清理true／database_remaining=false，合成调用各1、共2，没有外部模型；不借 A18项9.443秒或其3项10.393秒。首次 Node 未激活Conda被原入口门禁提前拒绝，未建服务或数据库，不计产品RED；同代码补环境后实际两项通过。两个改动文件编译及diff通过。日志 `/private/tmp/notalone-root-canonical-fixture55-pg.log`、`/private/tmp/notalone-root-hidden-exploration-http-pg.log` 与原环境门禁日志保留。

本主题仅测试契约和真实前缀兼容；完整连续意图／预算UI、C实际来源／样本 caller与55携入、B公开生命周期仍按各唯一负责人接续。A13保持claimed及六条原AC未勾，本次无产品源修改，不据九PG或两HTTP关闭A13/C06/B09。

### 本轮独立工作树：连续要求正式提供者与选定版本要求修复

2026-10-11：从总协调正式 `84b5dd32` 的独立工作树接续已明确属于本轮的 14 个 provider/client 源码与测试路径；不会丢弃既有在途接口。本切片接通公开 `POST /api/contacts/{contact_id}/assistant-sessions/{session_id}/continue`，真实展示组与具体保存版本在同 owner/CURRENT 事务内核验，再沿唯一 reserve、输入指纹、依赖图及回复运行时生成；结构化澄清先于领取和模型。实际改口及兼容要求只属于本助手会话，不写长期记忆，选择版本的完整消息组与原来源仍受删除约束。

新增 P2 反例在正式提供者原代码独立取得 **2 RED／1.884 秒／actualexit1**：选定保存版本的“不要承诺”从实际输入中遗漏；与“自然一点”冲突的“正式一点”错误返回 200。只在权威 resolver 将选定保存版本的要求并入既有 requirements，再复用原 fail-closed 守卫；同两反例 **2 GREEN／4.109 秒／actualexit0**。保存版本中的未知要求不会自动猜兼容；完整两段版本测试明确 keep 原“保持两段完整。”，保留原版本、整组正文、保存重读和同键重放断言。

实际验证命令先激活 Conda `NotAlone`，关闭 dotenv 与 LangSmith/LangChain tracing，仅使用 `/tmp` socket 55441 的随机自有隔离库：

```bash
PGPORT=55441 python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-round29-a tests.integration.server.test_assistant_continuation tests.integration.server.test_assistant_session_inputs tests.unit.application.test_assistant_continuation
npm run typecheck
node --input-type=module -e 'import {build} from "esbuild"; const result=await build({entryPoints:["tests/assistant-continuation-client.test.ts"],bundle:true,platform:"node",format:"esm",write:false}); await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);'
```

完整相关 **51 tests／52.848 秒／OK／skip0／actualexit0**，真实生产 001–055 全名账本匹配、重复迁移 0，续答夹具及外层自有数据库剩余均为 0。实际默认 JsonClient 的合法 Unicode 4096 边界、33／2048 条既有要求、澄清动作、冲突零模型／零请求、范围、来源删除及累计预算均通过。Node **26 GREEN／55.166 ms／skip0／actualexit0**；完整桌面类型检查、三个来源的 limited silent mypy、九个 Python 文件编译及 diff 检查通过。首次未升级沙箱的 socket 连接被 EPERM 拒绝，没有创建测试库，也不计产品 RED。

两轴分别由现有独立 B／C Agent 只读执行固定 `84b5dd32→14 pending` 差异：Standards 硬规范 0、重要 possible Fowler 0；Spec 新增 P0–P3 为 0，明确 typed Main／公开页面及 prepare/jobs/退出仍属后续切片。两轴不代替测试，也不将部分提供者当完整交付。原 `State: claimed`、六条原验收标准和未勾状态保持；B/C 正式消费、用户可见 typed 连续讨论、A15/16/17/18 与组合继续。没有新增正文缓存、DDL、外部模型、私人资料、微信/OCR、外部发送、真实 App、人工验收、push、发布或部署。

### 续答准备回执与正式客户端的同输入执行

本轮从 `0ec5a1ae` 继续十个明确路径：新增 `POST /continue/prepare`，与 `/continue` 使用同一严格 `ContinueAssistantSession` 命令及唯一 reserve 事务，准备只领取实际 turn/input/key，不调用模型，返回无正文五字段回执。旧键同 canonical 命令的准备、执行和完成重放复用身份；输入改变冲突。准备后 CURRENT 推进、退出中断或会话删除均拒绝旧执行，可靠完成历史保持完成。

正式 `continueAssistantSession` 先准备再执行，同一次构造和克隆的 body 不从界面重取；回执及最终 turn/input、scope、connection generation 逐项校验。`onPrepared`／`onRequested` 只交实际元数据给唯一作业 authority，不另建缓存或 writer。默认认证 JsonClient 的有限澄清只对 exact `/continue` 和 `/continue/prepare` 放行；附加查询、额外路径、未知字段和其他错误仍拒绝原正文。

真实公开 HTTP：缺少准备路由 **1 RED／1.155 秒→1 GREEN／1.796 秒**；默认 JsonClient 原先只执行一次、没有生命周期回执的反例 **1 RED／1.599 秒→1 GREEN／2.006 秒**，修复后两次 HTTP 与相同 body、准确回执及冻结版本要求通过。新 CURRENT 回归首次把生成返回附带 session 元数据与历史 reply 投影直接比较，造成 3 项中 1 个夹具失败／3.232 秒；改为公开读取前后同投影比较，保留全部拒绝、零模型和 CURRENT 不回退断言，不记为产品 RED。

沿前段实际命令完整复验 continuation、session inputs 及应用单元：**56 tests／58.038 秒／OK／skip0／actualexit0**，生产001–055逐名账本和重复执行0、续答内层与外层随机库剩余0。合法成功客户端现在明确两次 HTTP（prepare零模型、execute一次模型），澄清仍一次 HTTP／零模型；原 Unicode、2048条要求、幂等、来源删除和预算断言保持。Node **28 GREEN／63.391 ms／skip0／actualexit0**；whole桌面类型、四源 silent mypy、Python 编译与 diff 通过。

固定 `0ec5a1ae→十路径` 差异两轴各自独立只读：B Standards Hard0／新增重要 possible Fowler0；C Spec新增P0–P3=0。真实 Main 的晚准备退出排空、B typed UI、公开页面和原生均仍属后续切片，不据 prepare HTTP 或回执客户端关闭原13／16／17。State与原AC未改，不新增迁移、外部模型或发送能力。

### 合法选定要求的完整累计与改口预算

本轮净消费既有正式 f2 的额外要求修复，已由 `0ec5a1ae` 实现的选定版两行不重复。`AccumulatedReplyRequirements` 仅表示同事务解析完成的完整要求集合；从实际 continuation 元数据复原时核对持久 content 全文一致，其余字段仍走原公开 parser。单次公开 JSON 的4096码点限制保持，合法旧要求与新明确要求累计超过4096后不被误拒、截断或摘要，仍进入唯一实际模型预算守卫。原版不继承后续编辑或兄弟分支要求，明确改口保留兼容要求、冲突仍先澄清，同键完整重放不增加模型。

真实选定版4096个合法Unicode码点加新要求与意愿，原实现返回400／assistant_continuation_request_invalid，**1 RED／1.895s**；最窄提供者修复后 **1 GREEN／2.918s**。此前加载器和夹具参数错误未计产品RED。Conda NotAlone、关闭 dotenv／追踪、PGPORT=55441，`/private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-round29-a` 加 `tests.integration.server.test_assistant_continuation`、`tests.integration.server.test_assistant_session_inputs`、`tests.unit.application.test_assistant_continuation`、`tests.unit.application.test_assistant_continuation_identity`，实际 **68 GREEN／85.376s／skip0／exit0**；正式001–055／repeat0、续答内层及外层自有库剩余0。`cd backend && PYTHONPATH=src python -m unittest discover -s tests/unit/reply -t . -q` 实际 **295 GREEN／1.778s／exit0**；原权限拒绝合成 Skill fixture 的安全日志保留，未访问真实Skill或外部模型。两源码 limited mypy、三文件编译、整树桌面类型和diff通过。

固定 ONLY3 SHA256 `a5ea8500ac034d17a6d4f4f08ade3e0de9ac7c594c7b751666ac97cf783638bf` 经独立 Standards 硬性违例0／新增重要possible Fowler0与独立 Spec 新增P0–P3为0，未借两轴为运行证据。这里只关闭已复现的累计要求提供者缺口；公开 typed 控件、宿主／页面组合继续由正式消费者验证，原13 State claimed和六条未勾AC不预填，真人／真实App未执行。没有新增writer、图、DDL、正文缓存、私人资料、OCR、微信、外部模型或发送，也未push、发布或部署。

Root 净接正式 `9463f7db` 的两源码与七项新增HTTP测试增量，保留已存在选定版本修复和dca准备协议。主树受控隔离runner独立完整 `test_assistant_continuation` **51 GREEN／75.849s／skip0**，续答内层与外层精确清理0；独立 `discover -s tests/unit/reply -t .` **295 GREEN／1.630s／skip0**。两运行均真实55迁移逐名一致／repeat0／自有库剩余0，未有外部模型凭据。两源码限定mypy、三文件编译与diff通过；单次公开4096限制保持、完整累积由原预算守卫计量。旧无正文租约异常和合成Skill permission-denied负例提示保留，均无业务失败。公开typed实际结果另由B/C具名页面证据集成，不借HTTP关闭页面或原生要求。
