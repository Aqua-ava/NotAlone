# 16：切换会话或关闭小窗时保持生成归属

State: resolved
Triage: ready-for-agent
Blocked by: [assistant-session-context/10 新开、列出与选择旧会话](10-session-list-and-new.md)；[assistant-session-context/14 生成中替换请求与迟到结果失效](14-replace-running-generation.md)

拆分标识：C09（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧04；Q13、Q14及Q15关闭小窗。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)。依赖是完整交付的前置，不代表这些前置已完成；本轮受控自动实现与验收证据见 Answer。

## What to build

切换联系人、切换助手会话或关闭回复小窗后，原生成继续且结果只回到原会话。

## Acceptance criteria

- [x] 切换联系人、同联系人新开/切换会话或关闭小窗时，已发起生成继续；结果只归原会话，不能覆盖当前视图。
- [x] 新开或回到旧会话不自动生成，受控迟到响应验证A结果不覆盖B；范围或来源失效仍拒绝提交。
- [x] 以受控宿主事件验证应用仍运行的生命周期；真正退出由C10处理，真实App证据留待C13。
- [x] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [x] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

这些操作共用“离开当前视图但应用仍运行”的生命周期；验证A返回不覆盖B、新开不自动生成。用受控宿主事件验证，不冒充真实App通过。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

正式A 5693d41后缀净接；以下20HTTP／106Node等归A，主树独立组合另记。

## Answer

2026-10-11 普通生成与受控宿主自动切片：保持 `State: claimed`，整票仍为 partial，未预填原验收项。新鲜上下文从正式 `c0844bb22620e2221f020bdbd7dd149506aa1896` 导出独立源码，不修改 ROOT/PRIMARY。代码接通实际运行，不仅是未使用 registry：公开 `installReplyBridge/createReplyBridge` 进入生产 `JsonClient`、真实后端 HTTP、生产 001–054 迁移的隔离 PostgreSQL。

- 三种明确输入（草稿、直接回应、主动目的）使用唯一 `replyRequestBody`；普通生成先 actual `/replies/prepare`、接受严格五字段实际回执，再以相同 key/body 走原 `/replies` 长链。`replaceReply` 使用正式 `/replace/prepare` 后复用原长链，不复制后端 14 的 lease/guard。实际替换旧 failed、新 completed 唯一，模型实计 2；prepare 本身模型 0。
- 作业只保存认证后端实例所归属连接代、contact/SID/key、实际 turn/input 与 AbortController，不保存正文或完成恢复副本。切联系人、同联系人新开/选择、受控 hide/close 只离开视图，原生成继续并唯一保存原 SID；迟到 A 不能覆盖 B。回到原 SID/重显只读已保存结果，新增模型 0。prepare/default SID 在途离开仍沿原范围，不能用晚到回执向新视图或错误 SID 发请求。
- 发布资格在仍属当前视图时以实际 GET 复验 current input、完成 turn/reply 与来源。AFTER_C.save 可靠完成保持完成，新 CURRENT 不倒退；历史完成 200 不能成为新 CURRENT 的当前候选。旧 GET 晚到不能覆盖较新操作。
- 背景 A 来源事件在 B 视图仍匹配无正文 A 作业并取消；实际来源 DELETE 后 GET 为 redacted、input/reply 均清除。选回原 SID 删除同样取消独立旧作业并实际 404，绑定撤销后候选提交失败；撤销后恢复须显式选择已知 SID，保留 active 生成门禁。连接换代取消旧 transport/UI 资格；原 binding/source 仍有效的 C 可靠完成可留在原 SID，不能把连接变化伪装成来源撤销。真正退出的 old lease interrupt 属于 17。
- `notifyHelperLifecycle` 与 index 仅提供受控 hide/close/focus 接线；助手会话目录薄消费 normal 生成等待，不改 RewritePanel 业务。`beginGenerationClosing(onReceipt)` 提供实际无正文回执接口：prepare 在途时不猜 turn/input，实际回执晚到交付一次并停候选长链（模型 0）。17 仍须在旧 host 可用时完成 explicit interrupt，再关闭后端；该接口和受控事件不等于原生验收。
- 冻结源码 `/private/tmp/notalone-a16-actual-l1sanzc5/frozen` 与 stage 同 byte。8 文件 allowlist、unexpected 0、SHA256 8/8；独立正式 archive 逐项应用 patch 和 whitespace check 通过。共享 session/client/index/AssistantSessionPanel/旧合成 ports fixture 仅提供精确 hunks，ROOT sole 写入并保留 B 的 automaticPaused、来源验证与最新 notify 接线。

实际命令与结果：

1. Conda `NotAlone` 后在冻结 `desktop/` 执行 `PGHOST=/tmp PGPORT=55441 NOTALONE_DISABLE_DOTENV=1 LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false node --test --test-timeout=25000 tests/assistant-generation-ownership-http.test.mjs`：16G / 44.697 秒 / exit 0，模型实计总 15；16 个自有随机 `_test` 库均真实迁移 54、repeat 0，cleanup instance/class 均成功、库不存在。仅替换模型、受控宿主事件与传输延迟，C 完成由生产存储裁定。
2. `node --test --test-timeout=20000 tests/assistant-session-catalog-read.test.mjs tests/assistant-session-catalog.test.mjs tests/assistant-session-deletion-guards.test.mjs tests/assistant-candidate-version-ports.test.mjs tests/assistant-candidate-versions.test.mjs`：106G / 1.152 秒 / exit 0。旧合成 fixture 最窄补 prepare 五字段、原 turn_id 和完成资格 GET 的计数，不把合成 fixture 当 PG 保存证据。
3. 定点 TypeScript：`node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --lib ES2022,DOM --jsx react-jsx --types node --skipLibCheck`，入口为本切片 session/client/jobs/index/AssistantSessionPanel 与现有 renderer window/assets 声明，exit 0。直接使用 esbuild 库，不把 Mach-O esbuild 可执行文件交给 node。

所有逐项 RED/G、入口错误和清理记录保留在 `/private/tmp/notalone-a16-actual-l1sanzc5/logs` 及 `delivery/validation-ledger.json`。实际 RED 包含切联系人 signal 被 abort、生成中 new/select 被拒绝、缺宿主接口、背景 A 来源取消遗漏、AFTER_C.save 旧 200 错发当前 UI、运行中未进 replace prepare、默认 SID 未知时范围拒绝未进入失败状态。初始系统 Python archive API 不兼容、两次定点类型入口遗漏和沙箱回环 EPERM 单列，不记产品 RED；原 Node fixture 未接 prepare 的未完成等待只对 lsof 已证明位于本独立源码的自有 PID 6102/6110 定点 TERM 收尾。

数据影响与剩余项：只处理合成、随机测试库资料，未新增 schema（没有 055 或 fake DDL），不上传/记录正文到普通日志、不增加外发能力。未运行 App/Page/npm test/safe/native、微信/OCR、外部模型，未 commit/push。B 确认方向/关键问题后自动候选生成的实际 prepare hook 尚未顺序消费，不能用三种普通模式 GREEN 代替该长任务；B 未确认自动探索的 hide 生命周期也待与正式 B hook 串行组合。17 真正退出与恢复 UI、ROOT 新鲜两轴审查及正式提交均由主 Agent 后续推进。



### 2026-10-11：normal 切片并发修复补验（仅追加，整票仍 partial）

新鲜实现上下文仅从上述已审冻结 normal 切片复制到 `/private/tmp/notalone-a16-races-ClCr0L/source`。本轮未写 ROOT/PRIMARY，未 stage/commit，未修改 B/C 业务或 backend source。仍保持 `State: claimed`，不预填完整任务验收。

- 目录刷新竞争已实际 RED→GREEN：公开 RPC 启动原生成，真实目录 GET 在传输边界延迟；原 HTTP/C 可靠完成 1 条候选后再放行目录，原实现公开状态仍为 `waiting`。最小修复仅移除生成完成资格对 `catalogPending` 的错误依赖，保留 selectionPending、当前输入/来源复验、连接代、scope 与视图归属门禁。目录读取没有改变当前助手会话。
- 连续替换竞争已实际 RED→GREEN：A 真实模型在途，第一次公开 replace/prepare 得到实际 B 五字段回执，B 长 HTTP 在途；A 的真实 cancelled 异常在传输边界尚未收尾时再次公开替换。原实现 C 实际 HTTP 409，running key 错带 A；修复后 registry `runningReceipt(owner)` 按最新顺序返回仍有效、未取消的实际 running 回执，C 实际 HTTP 200 并取 B key。生产 GET 证明 A/B failed、C 唯一 completed、CURRENT 属于 C，模型实计 2；B 已失效后未新增模型。回执 key/turn/input 均来自实际响应，未猜标识或编造数据库状态。
- 未更改 prepare 严格五字段协议（`session_id`、`turn_id`、`request_key`、`input_version_id`、`state`）。保留原 normal 三模式、未知 SID/prepare 在途、preflight/幂等、CURRENT、来源删除、连接换代、会话删除、hide/close/leave 行为。`hasPending` 的无调用 P3 留作后续独立清理，本轮不扩大修复。

实际命令（均先激活 Conda `NotAlone`；完整命令见 `delivery/commands.md`）：

1. 两条单测分别 RED 1F / exit 1 → GREEN 1G / exit 0，无 skip；目录模型 1，双替换 RED 模型 1 / GREEN 模型 2，每次真实迁移 54、repeat 0、fixture 与随机库清理均成功。
2. 独立 `desktop/` 执行 `PGHOST=/tmp PGPORT=55441 NOTALONE_DISABLE_DOTENV=1 LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false node --test --test-timeout=25000 tests/assistant-generation-ownership-http.test.mjs`：保留原 16 条并追加 2 条，18G / 51.537 秒 / exit 0，模型实计总 18；18 个随机测试库实际迁移 001–054、repeat 0，instance/class cleanup 均成功、库均不存在。
3. 原五个 Node 文件完整回归：106G / 1.213 秒 / exit 0，无 skip。定点 TypeScript（session/client/jobs/index/AssistantSessionPanel + renderer window/assets 声明）exit 0。
4. 指定 `/private/tmp/notalone-coordinator-isolated-tests.py` runner 运行 `tests.integration.server.test_assistant_generation_prepare`、`tests.integration.server.test_assistant_generation_replacement`：27G / 21.265 秒 / exit 0，无 skip；真实生产迁移 54、repeat 0，owned database remaining=0。该现有组中的受控 lease 失效仍打印预期 guard 异常堆栈，未将其删除或改成 skip。

新日志位于 `/private/tmp/notalone-a16-races-ClCr0L/logs`，先前所有 RED/G 原日志另保留在其 `prior/`；`delivery/validation-ledger.json` 记录计数、迁移、清库与 SHA256。初始化 PG 的沙箱 shared-memory EPERM 和既有 55441 socket 冲突仅列为环境入口记录，不计产品 RED；实际沿指定隔离 cluster 的本轮随机 `_test` 库验证，未接管或停止既有进程。

更新交付仍为正式 `c0844bb22620e2221f020bdbd7dd149506aa1896` 上的完整 8 文件 allowlist（unexpected 0），本轮 exact increment 仅 session/jobs/actual HTTP test 三文件。完整 stage 与 increment 独立 apply/whitespace 检查、8/8 SHA 核验通过。主 Agent 必须按精确 hunks 合入共享文件；旧 ports fixture 只消费 `a16-strict5-fixture-ports-exact.patch`，保留正式 11 新分页断言；不得用旧完整文件覆盖 `e092de2` 的 saveCandidateVersion→notifyInputChanged、sourceValidation、automaticUpdatesPaused 接线。

数据与剩余范围：只处理合成输入和隔离随机测试库，未增加 schema、私有日志正文或外部发送能力。App/Page/npm test/safe/native、微信/OCR、真实外部模型、部署及 push 均未运行。B 确认方向后的实际 long chain、B hide 生命周期组合、17 真正退出 drain/interrupt、主 Agent 新鲜两轴评审及正式提交仍未完成；本轮两个并发修复完成不代表整票完成。


### 2026-10-11：normal 返回原会话后的替换失败重试补验（仅追加，整票仍 partial）

新鲜上下文从正式 `a3be306813663b3d7f921079b7ba0cfdff7c6a46` 上主 Agent 已组装并验证的 `/private/tmp/notalone-a16-final-hcyou876/source` 复制到自有 `/private/tmp/notalone-a16-returned-guyc_5qz/source`。本轮只编辑临时副本，不写 ROOT/PRIMARY，不 stage/commit，不修改后端或 B/C 业务。保留 `State: claimed`，完整验收项继续未勾选。

- 真实公开 RPC→生产 JsonClient HTTP→隔离 PG 用例先 RED：A 模型在途，公开新开另 SID 再返回原 SID，用户显式输入新草稿并替换。实际 B 五字段 prepare 将 A 置为 failed；原 A 的传输异常受控延迟收尾，B 经原模型边界实际失败并结束。下一次显式新请求原实现再次携带已失效 A key 进入 `/replace/prepare`，实际 HTTP409，模型实计 2。未直接写入数据库 failed、手填 request key 或绕过 prepare。
- 最小修复只增加 registry `cancelRequest(identity)` 和生成调用方的一次消费：使用 registry 已查得的实际回执，按认证后端连接代、contact/SID/request key 精确取消同归属作业。即使 A 已脱离当前视图，它也不再具有 active 运行资格；单纯 leave/new/select/hide/close 继续不取消。不同联系人、SID、连接代或请求键不匹配时不取消，调用方不重建查询对象。旧作业保留无正文回执到原 finally 收尾，不增加恢复正文或第二 writer。
- 同一用例 GREEN：A 传输仍未收尾时，下一次新 key 经原 `/replies/prepare` 实际 HTTP200、模型总数 3，原 SID 的三轮为两 failed、一 completed，CURRENT 属于唯一新完成轮；另 SID 零生成。仍使用 strict5 真实回执、prepare 模型 0、唯一规范正文及原 `/replies` 长链，不实现 B confirm 或 17 drain。

实际命令（均先激活 Conda `NotAlone`；完整命令及日志见本轮 `delivery/commands.md`）：

1. `node --test --test-timeout=25000 --test-name-pattern='返回原SID替换失败后' tests/assistant-generation-ownership-http.test.mjs`：实际 RED 1F / 3.326 秒 / exit1 → 同一测试 GREEN 1G / 3.678 秒 / exit0，无 skip/cancelled；HTTP409→200，模型2→3，两次均54迁移/repeat0/自有库清理成功。
2. `node --test --test-timeout=25000 tests/assistant-generation-ownership-http.test.mjs`：19G / 54.116 秒 / exit0，无 skip/cancelled。原18条源码逐字保留，追加1条；模型实计总21，19次生产001–054迁移/repeat0、instance/class清理成功且自有库均不存在。先前目录及连续两替换的 RED/G 原始日志保存在本轮 `prior/races-logs/`，更早日志沿其 `prior/` 保留。
3. 原五个 Node 文件完整相关回归：106G / 1.343 秒 / exit0；定点 TypeScript session/client/jobs/index/AssistantSessionPanel 与 window/assets 声明 exit0、无诊断。正式11新分页 ports 文件仍为 SHA256 `6fe32af5b0e79d3135804f7749a322de481d9ecac07ffa025a85cb6d38aaece0`。
4. 指定 `/private/tmp/notalone-coordinator-isolated-tests.py` 运行原 prepare/replacement 两个后端模块：27G / 21.751 秒 / exit0，54迁移/repeat0/owned database remaining0；保留原受控 lease 失效的预期异常堆栈，不改后端源码或断言。

本轮原始日志位于 `/private/tmp/notalone-a16-returned-guyc_5qz/logs`。首次沙箱 PG socket EPERM、Node 回环 listen EPERM 单列为环境入口失败，不记产品 RED。第一版新增夹具漏补返回后已清空的草稿，未进入实际替换而测试超时；仅修正夹具，保留日志。只对 ps 命令行与 lsof cwd 均已核验属于本临时源码的 Python PID81165 发送 SIGINT，既有 finally 释放门控并明确报告 instance/class 成功、数据库不存在；未重启、停止或接管既有55441 cluster。

交付以正式 `a3be306813663b3d7f921079b7ba0cfdff7c6a46` 为基线，仍限最终9文件 allowlist；本轮精确增量仅 session/registry/实际 HTTP test/本票追加四文件。原新分页、`saveCandidateVersion→notifyInputChanged`、sourceValidation、automaticUpdatesPaused 接线保留；不得用旧整文件覆盖共享源码。无用 `hasPending` P3 留作独立清理。本轮只处理合成资料，不新增 schema、私有普通日志正文或外部发送能力。App/Page/npm test/safe/native、微信/OCR、外部模型、部署和 push 均未运行。B confirm 长链、B hide 组合、17退出 drain/interrupt、主 Agent 新鲜两轴审查及正式提交仍未完成，不能据本次修复宣称整票完成。


### 2026-10-11：normal 同键失败重试的在途替换与 completed 重放补验（仅追加，整票仍 partial）

新鲜实现上下文从已审 `/private/tmp/notalone-a16-returned-guyc_5qz/frozen` 复制到自有 `/private/tmp/notalone-a16-failed-retry-SKT7G0/source`，正式基线仍为 `a3be306813663b3d7f921079b7ba0cfdff7c6a46`。本轮只修改临时副本，不写 ROOT/PRIMARY，不 stage/commit，不修改后端、schema 或 B/C 业务。`State: claimed` 保持，完整验收项继续未勾选。

- 新增实际公开 RPC→生产 JsonClient HTTP→隔离 PG 的第20条用例，原19条源码逐字保留。首轮模型真实失败后，用户同键重试先取得原身份的实际 `failed` strict5 prepare；原 `/replies` 重试实际进入第二次模型调用，后端 canonical prepare 返回 `running`，历史 turn 仍为 `failed`。原实现显式 `newRequest: true` 被 waiting 门禁静默丢弃，0新 RPC/0新 key，实际 RED。最小修复后原 replace prepare HTTP200，原键失效、新 CURRENT 唯一完成；回执未伪标成 running，未预填DB状态或猜测标识。
- registry 只新增本地 `preparing/prepared/requesting` 阶段。client 在原长请求已交给 transport 后调用无参数 `onRequested`，已有 `onPrepared` 与严格五字段保持；`requestReceipt(owner)` 提供最新有效作业的真实已知身份，failed 重试仅在长请求已提交后获得该资格。是否正在运行继续由原后端 canonical replace 检查，未复制 lease/guard 或增加第二 writer。`cancelRequest` 仍按连接代、contact/SID/key 精确取消；leave/new/select/hide/close 不取消。
- completed 同键重放在途时的显式新请求也建立实际 RED（0新 prepare）→GREEN（普通 prepare HTTP200）；重放新增模型0，新请求新增模型1。completed 回执不进入 replace，迟到 cached 结果不能把 CURRENT 或当前候选回退到旧输入，已可靠完成历史仍完成。prepare 身份尚未知时显式新请求保持关闭。
- 同用例通过传输发送门控补验早到竞争：真实模型失败后的重试已交给 transport、尚未取得后端租约时，显式 replace 实际 HTTP409 `generation_not_running`，整份公开会话快照不变，无额外模型。用同一实际生产正文重读拒绝；保留 JsonClient 原 reason 白名单，不扩大 UI 协议。该行为是拒绝过早替换，不承诺供应商停止计算。

实际命令与结果（均在本独立源码；完整命令见 `/private/tmp/notalone-a16-failed-retry-SKT7G0/delivery/commands.md`）：

1. Conda NotAlone 后执行 `PGHOST=/tmp PGPORT=55441 NOTALONE_DISABLE_DOTENV=1 LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false node --test --test-timeout=25000 --test-name-pattern='首轮模型失败后的同键重试' tests/assistant-generation-ownership-http.test.mjs`。失败重试 RED 1F/2.929秒/exit1→GREEN 1G/3.432秒/exit0；completed 重放 RED 1F/3.607秒→GREEN 1G/3.793秒；含 early send 断言的最终单条 1G/4.024秒，模型实计5，54迁移/repeat0/自有库不存在。
2. 同一实际 HTTP/PG 文件最终完整回归：20G/60.893秒/exit0，无 skip/cancelled，模型实计总26。20个自有随机 `_test` 库均真实迁移001–054、repeat0，instance/class cleanup成功且数据库均不存在。原19的54.116秒/模型21原日志与源码保留，不改写旧结果。
3. 原五个 Node 文件完整相关回归：106G/1.240秒/exit0，无 skip/cancelled；定点 TypeScript session/client/jobs/index/AssistantSessionPanel 与现有 window/assets 声明 exit0，无诊断。正式11新分页 ports 文件仍为 SHA256 `6fe32af5b0e79d3135804f7749a322de481d9ecac07ffa025a85cb6d38aaece0`。
4. 原隔离 runner 执行 prepare/replacement 两个后端模块：27G/21.138秒/exit0，54迁移/repeat0/owned database remaining0；原预期 lease 失效异常堆栈照实保留，不改断言或 skip。

原始日志保存在 `/private/tmp/notalone-a16-failed-retry-SKT7G0/logs`，上轮19条及更早所有 RED/G 另保留在 `/private/tmp/notalone-a16-failed-retry-SKT7G0/prior`。首次默认沙箱 PG socket EPERM、未 ready fixture 的 exit1/databaseName null 只记环境入口，不记产品RED；没有建立测试库。early send 初稿断言误期待 JsonClient 暴露非白名单 reason，原日志保留为夹具预期错误；仅改为公开后端相同正文重读，没有修改产品 reason 白名单。实际测试使用现有55441 cluster，未重启、停止或接管其他进程。

精确增量只含 session/client/registry/实际 HTTP test/本票追加五文件，完整最终交付仍为正式基线上的9文件 allowlist。原目录刷新、连续两替换、返回原SID精确取消、CURRENT、范围/来源复验、连接换代、关闭与 unknown prepare 门禁保留；未扩展编辑草稿的猜测组合或清理无用 `hasPending`。只处理合成输入与随机测试库，不上传私人正文、不新增 schema 或外发能力。App/Page/npm test/safe/native、微信/OCR、外部模型、部署、push 均未运行；B confirm/hide组合、17退出/中断、页面/原生及主Agent新鲜两轴审查和正式提交仍未完成，不据本轮 GREEN 宣称整票完成。


2026-10-11 主会话最终正式组合：最终普通三模式九文件新鲜Standards硬性0、possible P3 1（未使用hasPending辅助方法）；Spec新增P1/P2及越界0，B确认／回答、17退出排空和公开页面仍为后续明确partial。本树正式B/C提供者9f13b20＋61949cd上，完整实际20 / 20 HTTP→PG GREEN／57.709秒、合成模型26，20次正式54/repeat0及instance/class自有库0；原目录／版本五模块106 / 106 Node GREEN／1.284秒、全TypeScript exit0。初始纯源快照未连接已安装esbuild的三次依赖失败原日志保留，不记产品RED；仅连接只读node_modules后运行上述正式结果，未安装依赖或进入App。所有生产八文件与fresh审查freeze SHA逐字一致，原四次P2 RED历史均保留，不以本切片称整票完成。

2026-10-11 总协调主树精确净接A正式 `5693d41` 八个生产／测试路径与本票Answer。Main三方合并只有导入段一处冲突：同时保留A replaceReply和主树B ReplyClarificationEdit；其它自动合入保留ROOT12e编辑开始通知、e092保存通知、80b来源检查及B strategyJob.sourceValidation。未整包替换Main，真实App未启动。

主树第一次相关三套Node 116项为115通过／1失败／1096.02625ms：C旧受控传输没有新prepare回执及生成turn_id，普通生成因严格协议失败，不能把此夹具不匹配当成生产RED。只补合成POST prepare的同Scope实际已定义turn/input/key/state元数据及原生成turn_id，保持C全部来源／范围／样本断言；相同三套 **116 GREEN／1144.233834ms／skip0／actualexit0**。这份合成tuple不证明真实prepare或模型调用，下面独立实际HTTP／PG才证明接线。

Conda NotAlone／desktop，禁dotenv和tracing，执行 `PYTHONPATH=/Users/local-user/learn/NotAlone/backend/src:/Users/local-user/learn/NotAlone/backend node --test --test-reporter=spec tests/assistant-generation-ownership-http.test.mjs`，session78236 **actualexit0／20 GREEN／60319.436375ms／skip0**。真实preload具名桥接→Main／JsonClient→认证HTTP→每项隔离PG，控制三种普通模式的模型和宿主事件；日志20条actual model_counts小计26，20次正式001–054账本核验／repeat0，20份instance/class清理均true、database_remaining均false。原prepare严格身份、离开返回、隐藏、目录等待、迟到结果、连接／会话归属、同键失败重试及再次显式替换、完成重放、早到replace精确409/model0/current不变的完整断言通过；20执行期间主树runtime/fixture/迁移保持字节不变。

主树完整TypeScript、diff通过；新鲜Standards硬要求0／重要possible0，新问题未把原unused hasPending P3重复列为新增。B确认与澄清回答的注册、17退出排空和真正公开页面仍由对应后续切片继续，不能用普通20项或合成宿主事件提前填它们为通过；State保持claimed。原生真实App、用户验收、微信及付费模型按本轮范围未执行，无新增正文副本、DDL、外部调用或发送能力。

### 本轮自主协调最终结果（2026-10-12）

切换联系人、助手会话及关闭小窗保留已发候选归属；迟到旧结果不能覆盖当前视图。受控宿主和公开生命周期已验证；真正App证据属于原规格后续边界，本轮没有冒称原生通过。

剩余：本票可自主范围已完成。真实模型语义、自然度、关系适配及用户相似度未知；本轮没有原生App、私人资料、微信／OCR、外部发送或远端操作。

证据：[29票逐项结果与实际命令](../../unfinished-work/round29-autonomous-results-20261011.md)、[固定源码、自动验证及清理回执](../../unfinished-work/round29-autonomous-verification-20261011.json)。各次不同来源的计量分列，未把静态审查、合成模型或受控宿主冒为原生／真人通过。原验收文本逐行对共同基线保留；只更新实际可验收的勾选和State。
