# 14：生成中替换请求与迟到结果失效

State: claimed
Triage: ready-for-agent
Blocked by: [assistant-session-context/07 默认会话的一次生成与可靠保存](07-default-session-persistence.md)；[assistant-session-context/12 模型预算提醒与超限拒绝](12-input-budget-guard.md)

拆分标识：C07（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧03；Q9。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)。依赖是完整交付的前置，不代表这些前置已完成；本票尚未实现。

## What to build

一次生成未完成时用户提交明确新要求，旧请求失效，新请求得到有效结果。

## Acceptance criteria

- [ ] 旧请求未完成时提交明确新要求，旧请求失效，新请求按有效输入生成；不依赖自然语言编号能力。
- [ ] 同时从公开结果和后端提交验证迟到旧响应不能成为有效候选；覆盖失败、幂等及来源/会话删除竞态。
- [ ] 替换保留有效讨论且沿用C11总预算，超限新输入不绕过守卫；取消不承诺供应商停止计算或计费。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

公开结果与后端提交都拒绝旧响应；可控模型验证迟到、失败、幂等及删除竞态。不依赖自然语言编号能力。 累计讨论输入沿用C11预算守卫；不另建单轮旁路。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

2026-10-11：14 独立上下文先领取前置准备。当前只允许新增本票 helper 与真实 PostgreSQL/HTTP 测试，共享应用、会话存储、输入、回复存储、运行时及 desktop 文件保持冻结；12 总预算完整交付前不接正式替换入口、不声明本票完成。低层接缝验证同一 owner/contact/session 内撤销旧 turn/request 租约与迟到保存，正式 HTTP RED 先等协调方确认共享夹具窗口。人工验收、真实 App/微信/OCR、私人数据、外部模型、部署及 push 均未执行。

## Answer

当前为**后端垂直切片阶段，14 尚未整票交付**；`State: claimed`，验收项未预填通过。正式 HTTP 入口为 `POST /api/contacts/{contact_id}/assistant-sessions/{session_id}/replace`，正文是 `{running_request_key: UUID, replacement: 既有 ReplyServiceRequest JSON}`。服务端同 owner 连接按精确旧键定位 turn/current input，复用 B 规范化及唯一 reserve，同事务失效旧租约并领取新输入；新键重放先于取消，不要求前端猜内部 UUID。

后端 8 项 HTTP 与 14 项 PG 已实际共同通过 22/22，6.481s；生产正式迁移 001–053，随机自有 55441 `_test` 库 cleanup 0。完成先赢用例在实际 `PostgresReplyStore.save()` 事务成功后有限门控返回，核实真实 completed reply / running turn 窗口；此前按首个 owner 锁等待推断 SAVE 的夹具假设已修正。完整历史模型输入与预算计量四项 marker 断言全部保留并通过，现采用正式 12 的真实 consumer。协调方在正式 12 基底另行复验 22/22，6.795s；该记录不替代本 Agent 的实际命令结果。

协调方对后端切片的 Standards 评审报告硬问题 0、Fowler 问题 0；Spec 指出两项自动覆盖缺口，未确认源码错误。仅在自有 HTTP 模块补充模型受控失败后同 new key 重试，以及替换累计预算拒绝与显式新会话恢复，未修改共享生产代码。此前实际运行新增 2 项得到 1 通过、1 失败，1.930s，正式 001–053、cleanup 0：失败重试用例已覆盖旧迟到响应、实际迟到 start/save 持续拒绝、单份新候选、同 turn/current 身份及完成重放；预算用例设定容量 14,800，而实际累计输入与输出预留合计 13,924，正确得到 warning/200，未建立硬超限前提。这是测试阈值设计未触发目标，不记为产品 RED；该失败记录保留。

窗口解除后，仅把此合成模型用例容量明确改为 13,000，实际预算计量与业务守卫不变，全部原断言保留。新增 2 项复验 2/2 GREEN，4.572s；随后完整 10 HTTP＋14 PG 24/24 GREEN，20.834s，均使用正式生产 001–053、随机自有 55441 `_test` 库，cleanup 0。公开替换确实因累计完整历史与新输入硬超限得到 409，实际模型调用增量 0，数据库新候选 0；旧 USER、预算失败 NEW USER 与讨论仍可读取，正确 current input 保留。同样短输入在用户显式新建的空会话内实际得到 200，预算总量不超过同一 13,000 容量，证明新会话恢复沿用守卫。两项评审指出的覆盖缺口均已补齐并实际验证；最终 fresh sourcecut 两轴复审与主 Agent 本地提交尚待执行，整票仍 claimed/partial。

新增检查命令：激活 Conda `NotAlone` 后，使用 `NOTALONE_DISABLE_DOTENV=1 LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false PGPORT=55441 PYTHONPATH=src:backend python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-a-session tests.integration.server.test_assistant_generation_replacement.AssistantGenerationReplacementHttpTest.test_failed_replacement_retries_the_same_new_key_without_reviving_the_old_lease tests.integration.server.test_assistant_generation_replacement.AssistantGenerationReplacementHttpTest.test_replacement_cumulative_budget_blocks_the_model_and_a_new_session_can_generate`。14 生产代码、运行时及当前测试在此次实际清理后稳定冻结；未启动页面/App、真实模型、微信/OCR、外部聊天、部署或 push，未 stage/commit。页面替换与整票验收仍未完成。

完整检查命令：激活 Conda `NotAlone` 后，使用 `NOTALONE_DISABLE_DOTENV=1 LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false PGPORT=55441 PYTHONPATH=src:backend python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-a-session tests.integration.server.test_assistant_generation_replacement tests.integration.persistence.test_assistant_generation_replacement`。后端可靠保存骨干等待协调方 formal，本轮未实现 prepare receipt 或替换 UI，也未应用 09/13 的后续 patch。

主 Agent 最终独立复核：正式 `ac3eeca888c0ff34986924095441ceea32f1e0ba` 导出只加本票六源／测试文件，排除 054、09 helper、13 及桌面未提交源码。实际完整 24 项 GREEN／11.800 秒；runner 查验真实迁移账本为 53 个、001 至 `053_assistant_candidate_versions.sql`，生产 CLI 重复执行空集、自有库清理零。日志 `/private/tmp/notalone-a14-final-fresh-http-pg.log`。Standards 初审硬要求 0、判断性 P3 重复校验 1，移除新 replace 分支两行冗余检查并委托既有 `_completed_turn_payload`；增量复审硬要求／Fowler 0、Spec 原审及增量均 0，异常与成功响应语义相同。受影响十项 HTTP 已用新的首次导入进程再验证，结果在后续提交记录补充。完整二十四项、两项新增真实反馈及旧阈值夹具失败分别保留，不将页面或中断恢复预填通过。

以下为独立前置准备阶段的历史记录，其范围及未执行项只描述当时状态。

- 新增 `backend/src/notalone/persistence/assistant_generation_replacement.py` 的显式事务 helper：`invalidate_running_generation(connection, scope, session_id, turn_id, expected_input_version_id) -> bool`。复用同一连接的 owner 锁与 A051 `require_current_input`，核对当前输入、绑定、来源及精确旧 turn；不打开第二个事务、不接收或复制新请求正文。
- 保留既有 `failed` 终态，撤销当前实际回复请求与本次尝试租约，尝试仅记录无正文稳定原因 `generation_replaced`；旧 turn 的讨论与来源依赖继续保留，旧键使用 C049 `reply_invalidated_key`。无需字段或迁移。仅 reserve 的 running turn 也可首次失效，迟到实际 `ReplyStore.start/save` 与会话 `complete` 均拒绝；不承诺供应商停止计算或计费。
- 受控重复失效须同时证明仍存在同会话、同 turn 的 failed 记录、精确失效键、当前输入/来源仍有效及当前 failed attempt 的替换原因。来源或会话删除凭证不能被当作成功重放；仅 reserve 的失效键不单独构成重放证明。当前输入已推进后，旧 helper 拒绝失效版本。既有同键重试会保留 failed turn、开启新 running lease，helper 以本轮真实租约处理，并保留历史失败原因。
- 新增 `backend/tests/integration/persistence/test_assistant_generation_replacement.py`。首个真实 PostgreSQL RED 证明 no-op 失效入口仍允许迟到保存；受控幂等与失败重试取消分别取得真实 RED→GREEN。最终低层 14/14 通过：迟到领取/保存/完成、reserve-only、受控幂等、失败重试、完成先赢、owner/contact/session/turn/current-input 范围、来源仅作上下文时的删除门禁、实际来源及会话删除、任意删除凭证防误认、外层整体回滚及当前 attempt 缺失时的失败回滚。

实际命令：先 `source /Users/local-user/miniconda3/etc/profile.d/conda.sh && conda activate NotAlone`，再执行 `NOTALONE_DISABLE_DOTENV=1 LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false PGPORT=55441 PYTHONPATH=src:backend python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-a-session tests.integration.persistence.test_assistant_generation_replacement`。早期首切片使用当时真实正式 001–051；最终完整低层检查使用当前真实正式 001–052，不注入迁移占位。每轮均创建随机自有 `_test` 库并输出 `owned database remaining=0`。默认 sandbox 的本地 PG socket 访问被拒后，使用已授权测试范围的提权调用完成；未访问业务库。`python -m py_compile` 两个新增 Python 文件及 `git diff --check` 通过；未配置或声称静态类型检查通过。

最小后续入口提案：生成请求显式携旧 `turn_id` 和 `expected_input_version_id`，新要求继续使用既有 `ReplyServiceRequest`，不依赖自然语言候选编号。正式 reserve 接线须先识别新键同输入重放，避免再次取消或回退当前指针；新输入校验、失效与领取的事务安排以及累计总预算复用待 12/B 的正式接口和协调窗口决定。本阶段未实现该入口，也未扩展 13、15、16、17。

本阶段只改本票与两个新增文件。`server/app.py`、`application/assistant_session_service.py`、`application/reply_service.py`、`persistence/assistant_session_store.py` 及其 reserve、`assistant_session_inputs.py`、`reply_store.py`、`reply/store.py`、`reply/adapters/langchain_runtime.py`、`reply/context.py` 和全部 desktop 文件保持冻结。正式 HTTP/公开页面 RED、总预算 GREEN、完整相关回归、Standards/Spec 最终评审、本地提交和本票收口均未执行；由协调方继续授权同上下文推进。人工、真实 App/微信/OCR、私人数据、外部模型、19、部署及 push 均跳过。

主 Agent 最终变更后的 HTTP 记录：去掉 replace 分支冗余两行后，首次十项实际 9 通过、1 urllib HTTP timeout，36.941 秒、同库清理零，保留 `/private/tmp/notalone-a14-guard-refactor-http.log`，不能记该轮整体 GREEN。窄原用例独立复跑 1/1 GREEN、1.104 秒；临时只记请求类别与时长的合成探针执行十项及该用例额外三次，共 13/13 GREEN、26.034 秒，HTTP 最大耗时 3.4 秒、模型门控最大 2.905 秒、HTTP error 0，原 10 秒时限和所有业务断言不变。默认 sandbox 首次诊断调用 PG socket 被拒，库未创建，该错误不记产品 RED；授权的自有库调用后才产生以上结果。最后新进程去掉探针执行原十项，10/10 GREEN、11.338 秒，真实账本 001–053/重复迁移空集/自有库残留零。初次超时未再次复现，原因尚未确定，不能宣称已修复观测或业务时序缺陷；原完整 24 项结果、增量两轴 0 和失败历史分别保留。探针仅在临时 cut 中，不进入源码或提交。

本次正式交付仅 replace 后端六源／测试与本票记录，精确排除 09 的新清理函数改动（它已另行正式）、054、13、所有桌面未提交项。唯一 `generate_reserved` 链、旧键与迟到保存失效、完成先赢、重放不回退、真实累计预算拒绝保持；prepare 身份回执、替换页面与后台结果归属正在独立上下文推进，原整票继续 claimed，自动部分尚未全部完成、人工部分未执行。


2026-10-11 来源清理正式 b819 之后，总协调原二十四项真实得到 22 通过、两项来源删除旧原因断言失败：A051 已物理擦除实际输入并置空匹配 CURRENT，原失效入口正确返回 `input_version_stale`。窄兼容补丁保留完整拒绝及零新增模型断言，增加同 owner/contact/session/turn/input 精确 SQL 证明 `(CURRENT=None, input.state=redacted, input.content=None, dependency_ids=[], turn.input_payload=None)`；未用宽泛异常代替原因。`_generate_reserved` 捕获并收窄本地 `reply`，缺配置仍沿 `reply_unavailable` 拒绝，无 cast、ignore 或第二生成链。

独立正式 1675 导出只加上述应用方法及 PG 测试，两个来源删除回归加原公开迟到替换 HTTP 共三项 GREEN／2.320 秒，实际生产 CLI 001–053／重复执行空集／自有测试库残留零。核心三源 `python -m mypy --follow-imports=skip` GREEN；默认全依赖静态调用暴露既有跨十四文件六十项错误，没有报告整树类型检查通过。最初测试方法名错误仅为 loader ERROR，不记产品 RED。该兼容主题与正在补竞争状态投影的 prepare 回执、13、054、桌面改动分别交付；原整票自动部分继续、人工部分未执行。

上述兼容切片最终新鲜 Standards 硬要求／重要 Fowler 0、Spec 0；只正式交付两个源／测试及本票记录。另一个 prepare 状态投影 P2 仍有独立真实 RED 与修复流程，不用这三项或兼容审查盖过。

2026-10-11 总协调精确消费0e8ec054及正式d1abdfb修正后，原两个模块实际24项通过10.159秒／skip0，正式001–053／重复0／自有随机库剩余0。两条来源删除反向保留CURRENT NULL、051 input redacted/content NULL/dependencies []、旧turn input_payload NULL及精确input_version_stale拒绝；旧模型迟到仍被原租约与当前输入守卫拒绝。两个源文件focused mypy通过；另含server/app.py的默认单文件静态检查仍34条可空分支等诊断，未宣称全树类型检查通过。此前主树24=22通过／2原因不匹配与service可空类型失败保留，修正不宽放异常或删除物理清理断言。此为替换后端切片，prepare竞态、桌面生命周期与整票剩余仍未关闭。

2026-10-11 身份回执独立切片：`POST .../{session_id}/replies/prepare` 接收原生成 JSON，`POST .../{session_id}/replace/prepare` 接收原替换 JSON。两个入口复用唯一规范化、B prepare hook、reserve 及同事务替换 writer，只返回真实 `session_id/turn_id/request_key/input_version_id/state`，不启动模型。旧键失效后不能重领；新键重放不取消后续请求、不回退 CURRENT。准备阶段只固定实际身份；完整历史与最终模型预算仍由原长生成链校验，未宣称新增预算预检接口。

首轮十四项新增真实 HTTP 场景已逐项 RED→GREEN，覆盖零模型领取、同键 running 竞争及唯一模型、completed／failed 回执、实际 B 探索确认的规范输入、严格方法／scope、原替换 CAS／来源／已删除会话、失败预算和迟到模型。两项旧来源原因断言在正式 b819 下失败，随后由前述独立兼容提交解决。该阶段完整三模块 38 GREEN／25.259 秒；主 Agent 的冻结 ONLY14 副本又得 38 GREEN／22.382 秒，实际迁移 001–053、重复空集和测试库残留零。

新鲜 Spec 指出状态投影 P2：C 同键重试已 running 而 A turn 仍 failed，或者 C 已可靠 SAVE completed 而 A complete 尚未执行，回执原先只报物理 A 状态。两条真实 HTTP／PG 竞争分别 RED／2.929 秒、RED／1.062 秒；单个只读 SQL 同 owner/contact/key 并复验可选 reply ID，按 C 真实执行状态投影后分别 GREEN／7.630 秒、GREEN／1.565 秒。实际 A／C 行版本前后相同，模型总数均一，不新增 writer 或状态值，不改 C 生成链。中间一轮新增测试 JSON 顶层字段误读导致 KeyError，只修夹具，保留失败日志。

最终十六项专属加原十项 HTTP／十四项 PG 共 40 GREEN／24.647 秒；正式 53 项迁移与账本一致、重复执行空集、自有库零。核心三源 mypy GREEN；App 原有 78→78、整个后端原有 329→329／234 文件，新增错误均零，未宣称整树通过。冻结证据 `/private/tmp/notalone-a14-state-projection-freeze.json`，后续新鲜两轴与仅本主题提交仍在推进。替换按钮、后台归属、退出恢复和公开页面未完成；原整票 claimed，自动部分继续、人工部分未执行，不运行真实 App、19、私人资料、外部模型或 push。

最终回执后端独立新鲜复审：Standards 硬要求／重要 Fowler 0，Spec 0；前述状态 P2 已按真实 C 竞争窗口关闭。正式提交仅四源、十六项专属测试及本票，排除已独立正式的兼容 PG 测试、13、C 工作源码、054 和全部未完成桌面接线。六文件与已验证冻结副本逐字一致。


2026-10-11：后续真实 B 确认完成窗口修复。C 已实际保存 completed，而 A complete 有限暂停，此时新独立讨论推进 CURRENT；原同键普通 prepare 再次走 B 的新生成 CURRENT 守卫，实际返回409/input_version_stale。公开真实 B explorations→confirm→C.save→A.complete 等待用例为 1F/1.037s，最小同 owner/contact/key/binding 与实际可选 C ID 查询确认已完成、原规范输入与 C sole 来源门禁后为1G/1.590s。它只跳过 completed 的新生成门禁，不写 A/C 状态、不回退 CURRENT；修改 Skill 的同键输入仍409，实际 A/C xmin不变、模型2次。初次门控未进入是 B lazy store 注入位置的夹具错误，保留日志，不记产品RED。

该原9bef加 ONLY14两源测试冻结的完整原40+新1为41G/27.318s，真实001–053/账本53/repeat0/自有库0。正式17已独立提交0137671a2b0856922fce7fd5988f7877867136e0；当前窄修复另以这个真实54基底冻结，保留17的 interruption_reason 与唯一完成关联，不借未提交13/18源码。主会话在该正式基底执行原40+新1+17的8 HTTP与3迁移，实际 **52G/34.393s**，真实001–054/账本54/repeat0/全部自有库0；核心3文件mypy通过，改动源码与测试compileall通过；桌面替换/后台归属/受控宿主/页面组合与人工仍未验，不宣称整票完成。


### 本次窄修复的新鲜双轴结果

Standards：硬性违反0、判断性Fowler问题0。实际C身份/规范输入/来源复验后只跳过新生成门禁，17中断与失效键先检查，无新增writer或CURRENT写入。

Spec：本热修缺失/partial0、范围外0、实现错误0；实际B confirm/C.save窗口成立，同键修改Skill继续拒绝，可靠完成与新CURRENT均保留。整票桌面和页面组合、17宿主恢复仍未完成，人工部分未执行；审查与52项自动结果不能代替它们。

2026-10-11 总协调最终集成：仅消费正式 17 与实际 B completed 竞争窄修复，原七个后端模块共 **54G/47.562s，skip0**；真实生产迁移 001–054、账本54、重复迁移0、自有隔离库剩余0。命令为 Conda NotAlone 下以 `/private/tmp/notalone-coordinator-style-samples-no-dimension.py` 执行两个 replacement、prepare、两个 lifecycle 及 C reconfirmation/replacement 模块；仅合成 StyleSampleHttpTest 的维度 fixture 设为空，不改变生产门禁。六源 focused mypy、十个 Python 源／测试编译与 diff 检查通过；新鲜 Standards/Spec 均无新增 P0–P2。旧 A051 可靠完成兼容断言仍由唯一 A 负责人另行修正，桌面／受控生命周期／公开页面组合继续，原整票保持 claimed，人工部分未执行。
