# 17：退出停止与重开后的中断恢复

State: claimed
Triage: ready-for-human
Blocked by: [assistant-session-context/08 重新连接后恢复已保存会话](08-saved-session-recovery.md)；[assistant-session-context/14 生成中替换请求与迟到结果失效](14-replace-running-generation.md)

拆分标识：C10（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧04；Q15退出。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)。依赖是完整交付的前置，不代表这些前置已完成；本票尚未实现。

## What to build

真正退出应用停止未完成生成，重开显示“上次生成中断”，只在用户重试后继续。

## Acceptance criteria

- [ ] 真正退出停止未完成生成；重开只显示上次生成中断，由用户明确重试，不自动续跑。
- [x] 已可靠保存的完成结果保持完成；退出与完成、删除、旧进程迟到的竞态不能复活无效请求。
- [ ] 先在受控生命周期及公开恢复入口验证；真实App停止/重开由C13核对，不能把模拟结果标为原生通过。
- [x] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [x] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

与C09离开视图不同；已完成保存仍是完成，退出竞态不得复活旧请求。模拟生命周期先验，真实App证据由C13收口。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。


## Answer

2026-10-11：自动后端部分完成，[17 实现记录](../17-implementation-notes.md)记录无正文退出协议、正式 054 迁移、8 HTTP + 3 迁移及原 14 的 40 项相关自动回归（51G/67.893s、实际迁移 54/repeat0/自有测试库剩余0）。迟到结果不能覆盖新请求，可靠保存完成优先；已非 CURRENT 的原 pending 也可被退出停止，而新 CURRENT 保持不变。

当前仍为 claimed：后端新鲜 Standards 硬性违例0（P3判断1）、Spec 实现错误0，主会话重跑11G/10.162s；桌面真正退出调用与受控宿主／公开页面组合恢复、B 确认方向的新请求桥接仍由主会话继续。人工部分未执行；用户本轮排除真实 App／微信／OCR／19，不修改原验收标准，也不宣称整张任务已经完成。

2026-10-11 总协调最终集成：仅消费正式 17 与实际 B completed 竞争窄修复，原七个后端模块共 **54G/47.562s，skip0**；真实生产迁移 001–054、账本54、重复迁移0、自有隔离库剩余0。命令为 Conda NotAlone 下以 `/private/tmp/notalone-coordinator-style-samples-no-dimension.py` 执行两个 replacement、prepare、两个 lifecycle 及 C reconfirmation/replacement 模块；仅合成 StyleSampleHttpTest 的维度 fixture 设为空，不改变生产门禁。六源 focused mypy、十个 Python 源／测试编译与 diff 检查通过；新鲜 Standards/Spec 均无新增 P0–P2。旧 A051 可靠完成兼容断言仍由唯一 A 负责人另行修正，桌面／受控生命周期／公开页面组合继续，原整票保持 claimed，人工部分未执行。


2026-10-11：按总协调确认和本票可靠完成语义更新原 AFTER_C.save 输入竞态回归；纯正式代码先重现旧断言失败 1F / 0.632s，修订后的实际 C 唯一完成、重放零额外模型和新 CURRENT 不倒退通过，完整输入模块 10G / 6.813s（实际 54/repeat0/库0）。BEFORE_C.save／来源失效拒绝保留。详见[兼容回归记录](../17-implementation-notes.md)；本票保持 claimed，桌面及人工状态未改变。

2026-10-11 总协调精确净接正式7d3兼容测试及两记录后缀，并消费c084六个独立只读typed provider文件；原5unit＋11PG＋输入HTTP10共 **26G／7.405s／skip0**，实际生产迁移001–054／repeat0／自有库剩余0。命令为Conda NotAlone／关闭外部追踪，根 `/private/tmp/notalone-coordinator-isolated-tests.py` 执行 test_assistant_continuation_identity、test_assistant_reply_identity、test_assistant_session_inputs 三模块。四core source focused mypy、七source/test compile通过；新鲜Standards/Spec两切片均无新增阻塞。此兼容修正只保可靠已保存历史、唯一C完成和新CURRENT，不把历史迟到结果当当前可展示；A16 Main发布资格、受控quit及原生人工仍独立未验，本17保持claimed。

2026-10-11 重试来源隐私竞态独立收口：原事务仅比较 `expected_input_version_id` 与 CURRENT UUID 不足以证明输入仍可用。新键明确延续原输入时，原 `require_current_input` 在同 owner 事务继续复验绑定、输入状态及来源，并返回原 turn／discussion 权威依赖供唯一 reserve 继承；不另建图、writer 或正文缓存，同键完成重放仍在原分支处理。

两条真实 HTTP 反例：先从原资料生成，再选定候选续写、无编号准备并中断，公开 GET 得到允许手动重试的 `continued_from_candidate_id=null` 草稿。来源进入 `delete_requested` 而 worker 未清 CURRENT 时新键 prepare 仍 200，**1 RED／1.343s**；补原来源复验后 **1 GREEN／1.387s**。只复验而不继承时，公开 DELETE 已实际完成但新准备复制仍 running，**1 RED／1.461s**；继承原权威依赖后复制及旧内容 redacted、CURRENT 清空，重放拒绝，无关新会话逐字段保留，模型调用不增加。

Conda NotAlone、禁 dotenv／外部追踪、PGPORT=55441，执行 `/private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-round29-a` 加 `test_assistant_retry_source_guard`、`test_assistant_generation_lifecycle`、`test_assistant_generation_prepare`、`test_assistant_session_inputs`、`test_assistant_candidate_carry` 五个 integration.server 模块，实际 **46 GREEN／39.741s／skip0／exit0**。真实001–055账本／repeat0、外层自有库剩余0；原负向迟到用例出现既有无正文租约失效日志，未变为业务失败。两源码限定 mypy、两源码及新测试编译、diff检查通过；固定 ONLY3 SHA256 `f11e2c284b6bfe26e048686494e72dd9451e96f9cf8a9cae4a9c7284d5d6c47a` 独立 Standards 硬性违例0／新增重要 possible Fowler 0、Spec 新增 P0–P3 0；两轴只读，不借为运行证据。

本段仅后端重试来源门禁与删除继承证据；公开宿主退出和恢复组合仍由唯一桌面消费者继续，原生／人工未执行，原五条验收未勾且 State claimed。其它累计要求、超大历史传输及预算页面在途改动未混入本主题。

Root 净接 `7b2af9c4` 后，任务文档仅保留主树已有证据并追加本主题，未导入尚未集成的登记API段落。主树受控隔离 runner 独立执行 `tests.integration.server.test_assistant_retry_source_guard`：**2 GREEN／3.006s／skip0**，真实55迁移逐名账本／repeat0、Fidelity内层与外层自有库残留0；两源码限定mypy、三文件编译、diff及冲突标记检查通过。原验收和claimed保留，宿主退出自动部分仍接续。

2026-10-11 可靠失败终态的退出确认：失败结果已可靠落入原 A turn 与 C request、但失败 HTTP 回包尚在途时，宿主仍可用原实际身份请求确认。原 `/interrupt` 同 owner 事务沿用 input／turn／key／binding／source 门禁，只有 C 最新 attempt 已 failed／expired 且没有任何 running 租约才返回实际六字段 `state=failed, interruption_reason=null`；不把普通失败重分类为 app_quit，不写新失效键或新候选。已退出凭证继续要求原 app_quit 完整证明；旧 failed turn 对应实际运行中的同键 C 重试仍执行原 app_quit 失效，不凭历史 failed 放行。

首两次合成容量1000配默认输出预留4096，配置构造错误 **1 ERROR／0.544s、1 ERROR／0.548s**，均未到产品终态判断，保留且不算业务 RED。修正本测试输出预留100、恢复纯正式原 interrupt 后，可靠预算失败的 matching 请求实际409/generation_not_running，**1 RED／1.040s**；最窄原事务修复后 **1 GREEN／1.059s**。新增实际同键重试进入模型1次、历史 turn 仍 failed 的负向回归，确认它返回 app_quit 而不是普通失败终态；错误输入／其他 owner 继续拒绝，可靠终态重放不改变当前记录，模型增量0。

Conda NotAlone、禁 dotenv／外部追踪、PGPORT=55441，以唯一隔离 runner 运行 `test_assistant_generation_lifecycle`、`test_assistant_generation_prepare`、`test_assistant_retry_source_guard` 三个 integration.server 模块，实际 **29 GREEN／28.226s／skip0／exit0**；真实001–055账本／repeat0、自有库剩余0。原负向迟到请求保留无正文租约失效日志。原生命周期源码限定 mypy、新增源／测试编译及diff通过；固定 ONLY2 SHA256 `a82906fd735fb1448ecda458b99d7e33faaf66af8f1316b4bfaf8da91d865023` 独立 Standards 硬性违例0／新增重要 possible Fowler 0、Spec 新增 P0–P3 0；两轴只读，不借为运行证据。

本段是正式 HTTP 终态协议与隔离 PG 证据，失败回包 gate 的 Main／宿主组合仍由唯一桌面消费者复验，未冒为本人公开页面或原生退出通过。原 AC 和 State claimed 保留，人工／真实 App 本轮未执行，无外部模型、OCR、微信、发送或远端操作。

Root 净接正式 `3fe38933` 后在剥除模型凭据、dotenv与追踪的受控隔离 runner 独立运行完整 `tests.integration.server.test_assistant_generation_lifecycle`：**10 GREEN／11.106s／skip0**，实际55迁移逐名一致／repeat0、自有内外库残留0；单源码限定mypy、两文件编译与diff通过。迟到失效负例保留原无正文异常类别日志。只证实HTTP终态和租约分类；宿主失败回包gate及另一类运行中捕获来源闭包仍接续，原验收及claimed保留。

Root 净集成 `e94dfa2e` 的唯一 `AssistantGenerationJobs` 准备登记API与新测试，不导入另一套registry。未知键先登记验证范围，实际回执迁移同项；退出Promise等待准备和实际异步确认，明确非生成结果才收口，缺回执保留纯身份。主树 `node --test tests/assistant-generation-preparation.test.mjs` 实际 **6 GREEN／194.2925ms／skip0**，完整TypeScript及diff通过，固定提供者两轴无新增阻塞。这是纯元数据Node证据；增强原target停止句柄、宿主HTTP退出与typed生命周期继续由唯一A17消费者和B消费后复验，原票claimed不改。

2026-10-11 模型前捕获来源的失败输入续接守卫：普通改写实际读取同会话旧讨论后，C已在模型前捕获原始来源及讨论身份，但未完成的 A turn 尚没有结果ID或保存后依赖。现在同 owner 事务用实际 contact／request key／binding 找到唯一 C 请求，复用原 `require_reply_sources_current` 和 `require_reply_discussion_dependencies`，校验捕获来源及快照后才显示、延续原输入；新准备继承实际依赖。来源待删时 failed／running 正文与输入索引只显示 unavailable，不伪写 redacted；物理删除继续由原 typed selector／eraser 清除相关输入及复制，不新增图、writer、缓存或迁移。

新两场实际先完成来源回复，再让同 SID 普通改写真正进入模型，捕获的 HumanMessage 含原 C 讨论ID，退出后 GET 取得原输入。原实现对来源待删仍新键 prepare 200、物理 DELETE 后复制未清，实际 **2 RED／3.469s**；修复后 **2 GREEN／4.708s／exit0**。夹具校准曾出现模型 gate 适配和缺 raw 命中错误；初次 GREEN 选择了错误类名，加载错误2／0.000s；相关组曾误指定本树尚未消费的 C 模块，85实际测试通过但整次1 loader error／99.628s，均保留且不算业务 RED 或整组 GREEN。校正入口后，Conda NotAlone、关闭 dotenv／外部追踪、PGPORT=55441，以 `/private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-round29-a` 执行 `test_assistant_retry_source_guard`、`test_assistant_generation_lifecycle`、`test_assistant_generation_prepare`、`test_assistant_continuation`、`test_assistant_session_inputs` 五个 integration.server 模块，实际 **85 GREEN／104.326s／skip0／exit0**，正式001–055／repeat0／自有库剩余0。两源限定 mypy、三文件编译和diff通过；独立两轴对固定 ONLY3 SHA256 `e6e611c3ccf987cece0e822397bfe27c360bd85617d755b3e87adab82b26a199` 只读审查，不借为运行证据。

固定切片的独立 Standards 硬性违例0／新增重要 possible Fowler 0，独立 Spec 新增P0–P3为0；两轴报告分别保留，仅作静态评审。本段仅后端来源隐私续接与删除证据，不代替唯一桌面宿主、公开恢复页面或原生停止／重开；原 AC 未勾与 State claimed 保留。全部测试为合成数据、受控模型、随机隔离库，未读取业务库、私人资料、微信或 OCR，未外部发送、调用外部模型、push、发布或部署。

Root 净接正式 `ab079a1b` 的三个后端路径后，受控隔离runner独立完整执行 `tests.integration.server.test_assistant_retry_source_guard`：**4 GREEN／7.266s／skip0**，真实55账本／repeat0、内外自有库残留0；两源码限定mypy、三文件编译与diff通过。真实模型前已捕获但A尚未保存的来源同样拒绝待删重试、复制随原来源清理；迟到负例保留既有无正文租约异常分类日志。宿主consumer新增历史failed与实际运行租约竞态及Page组合继续，不以此关闭原17真正App退出要求。

2026-10-11 正式连续客户端补准备阶段身份：第8参数 `onPrepareRequest` 仅在唯一 `/continue/prepare` 的实际 promise 发出后回调，交同一个 Jobs authority 标记 HTTP 已在途；canonical body、五字段回执和实际执行回调仍沿原流程。合法 typed 澄清仅报告 preparing、零 prepared／requested，不从错误或缺回执猜测零领取，未知传输仍由原登记项保留。此切片不修改 Host/controller 或构造第二登记图。

真实 JsonClient 回环 HTTP 的公开回调反例先 **1 RED／57.680ms**（实际已请求但准备阶段未报告），修复后将 TS 测试经 esbuild 临时bundle，用 `node --test` 实际 **29 GREEN／112.183ms／skip0／exit0**；`npm run typecheck` 与diff通过。固定 ONLY2 SHA256 `3b14046f465fba506c77765116cdd1743f8b0add88de7f5dc81872b42027202f` 独立 Standards 硬性违例0／新增重要possible Fowler0、Spec 新增P0–P3为0，两轴只读。此段只证明客户端阶段合同；唯一 Main／宿主 consumer 继续接线与复验，原 AC／claimed不预填，Page／真实App／原生未执行。

Root 净接 `a5240199` 两个代码／测试路径后，实际合成 JsonClient HTTP 与续答协议 **29 GREEN／101.661375ms／skip0／actualexit0**，完整桌面类型和diff通过。准备回调只在实际HTTP已发起时发生；合法澄清仅报告preparing，不伪造已领取或执行回执。此切片不证明Host退出、原生App重开或人工验收，原AC与claimed保持。

2026-10-11 无raw样本的退出后复制删除闭包：净消费C正式 `9f5c0163` 的单测试源，再于本A树补四行公开GET验证复制在删除前确为running且原输入完整。样本由公开manual保存、source_ids为空且sources列表为空，真正进入受控模型的style_references只含实际样本ID／低权重；HTTP中断后新键仅prepare、模型增量0，随后DELETE样本。原turn已redacted而复制仍running／CURRENT指复制，A本树实际 **2 RED／3.494s**；沿原C `reply_style_sample_dependencies` 继承UUID至既有turn依赖数组、同owner/contact分raw/style并复用 `_require_samples`，最窄复跑 **2 GREEN／3.496s**。两场实际模型分别1／2，准备及删除增量0，独立已完成讨论和后来保存样本保留，重连后复制无正文且CURRENT为空；没有新表、缓存、collector、writer或来源图。

首轮九个相关模块实际 **134项／123.618s，1 FAIL＋1 ERROR**，不能作整组通过：原删除预捕获适配器仍把样本UUID列为raw，指纹不匹配导致样本DELETE500与来源待删身份拒绝。补原 `assistant_captured_input_lineage` 同型分离，只在已有删除身份复验中关闭样本liveguard，原scope／turn／key／binding／版本及指纹门禁保持；两实际失败窄复跑 **2 GREEN／2.927s**。正常读取、继续、版本与携入仍沿样本当前可用性门禁，删除身份不用于恢复正文。

Conda NotAlone、禁dotenv／外部模型环境和tracing、PGPORT=55441，用 `/private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-round29-a` 重新执行 `test_authentic_expression_sample_only_retry`、`test_assistant_retry_source_guard`、`test_assistant_generation_lifecycle`、`test_assistant_continuation`、`test_assistant_candidate_carry`、`test_style_samples` 六个integration.server模块及 `test_assistant_discussion_context`、`test_assistant_captured_input_erasure`、`test_assistant_dependency_erasure` 三个integration.persistence模块，实际 **134 GREEN／124.397s／skip0／actualexit0**；每轮正式001–055／repeat0，内外自有库剩余0。原迟到租约异常日志不含正文，未外推为私料或外部调用。八源mypy、九文件编译、完整桌面typecheck和diff通过。固定ONLY8 SHA256 `9fb9da44f8b4d35a32e5c90a3ab733e38637a780ca96f2a963f04d2301b309d5` 的独立 Standards硬性违例0／新增重要possible Fowler0、Spec新增P0–P3为0；两轴只读，不借为运行证据。

此段仅实际HTTP中断／复制／删除及隔离PG，唯一宿主退出消费者、普通页面恢复和原生退出仍须各自证据；原AC未勾及claimed保持。只有合成数据／受控模型，无真实App、微信、OCR、私料、外部发送、外部模型、push、发布或部署。

Root 独立先接C正式反例，实际 **2 RED／3.527s／55repeat0／自有库0**，无raw手工样本删除后仅prepare复制输入仍running。净接A03八生产路径与原测试四条正向增强后，同一反例和既有来源守卫 **6 GREEN／9.920s／skip0／actualexit0**；55repeat0、自有库剩余0，限定八文件mypy、九文件编译及diff通过。首轮夹带错误模块名产生一个loader ERROR，未冒充完整通过；校正已存在的模块名后取得上述完整六项。仅复用原C样本可用性和A类型来源投影，没有新表／第二依赖图或私人资料；已发现的当前意愿反例仍单独等待修复。


### 准备未领取的事务正证明（2026-10-12）

新增 prepare 拒绝证明只在原 owner 事务内生效：局部 savepoint 回滚领取副作用，再复验同 owner/contact/key 在 A turn 与 C request 均不存在，写既有无正文 `reply_invalidated_key` 阻止排队旧键，外层事务提交后才返回原404/409分类与 `no_generation={contact_id,session_id,request_key,state:not_reserved}`。已领取键、连接／5xx未知、解析未入事务与执行阶段不提供证明；证明写入故障返回503且不残留失效键。合法 typed 澄清不封键、仍可同键明确确认；已领取同键的失效参考不能伪装成零生成澄清。无新迁移、registry、writer、来源图或正文副本。

真实 HTTP 首条 RED／1.550s 后 GREEN／0.991s；新三场边界 GREEN／2.420s。新增两场后的一次5项运行因新测试块位置失配有1FAIL，改正后保留原业务断言；原77相关执行为71通过及6个新增证明字段导致的精确旧响应形状失配／105.251s，未冒称全绿。只校正这六项到严格四字段证明，各独立守卫使用新nonce以免前次永久barrier遮住后续守卫，和新增五项共 **11 GREEN／9.982s／skip0**，正式55／repeat0／自有库0；不重复已通过旧组合。第一轮追加测试曾误传UUID字符串及放错晚到测试块，1ERROR与1FAIL仅夹具前提错误，原日志保留。

真实回环 JsonClient 首条回调 RED（30项中1FAIL／90.417ms），最窄客户端修复后30 GREEN／92.434ms，路径／身份／执行／500／额外正文／连接变化负向加入后 **37 GREEN／96.917ms**。whole typecheck、六源 limited silent mypy、八Python编译及diff通过。仅显式具名prepare有限形状与三UUID、实际连接generation匹配才进入第9个 `onNoGeneration` 回调；错误仍仅安全分类、执行和未知不清身份。普通及typed消费者、同Map同键unknown别名正证明释放由对应唯一消费者继续接线；本提供者证据不冒称Main／Host／原生退出已整体完成。原AC及真实State保持，权威身份式中断重建另切片继续。

主树精确净接 sole A `547c716a` 的十四条提供者／协议／测试路径，保留现有其它路由和消费者。独立 runner 执行五个新的 prepare 拒绝正证明场景及四个当前意愿／表达样本实际 HTTP 矩阵，**9 GREEN／19.583秒／skip0／actualexit0**，正式001–055、repeat0、自有随机数据库0；日志 `/private/tmp/notalone-root-proof-and-fidelity-v2-http-pg.log`。同一9项组合不冒为旧77全量，四场C矩阵的12模型输入／调用独立捕获、质量仍未验证。完整桌面类型及两标准页面入口静态bundle通过；协议测试最初本机listen受沙箱EPERM，环境失败不算业务RED，明确授权本机监听后实际37项全部通过，日志 `/private/tmp/notalone-root-proof-client-node-green.log`。普通和确认候选消费者的同Map正证明收口继续，真实App未执行，原State claimed不改变。


### 原身份恢复提供者：编号、完整累计要求与删除（2026-10-12）

新增仅三UUID的 `POST .../retry-interrupted/prepare` 与同body的执行入口：`original_turn_id/original_input_version_id/request_key`。原owner事务核原failed/app_quit实际终态、绑定、CURRENT（首次）和C实际捕获的raw／discussion／样本依赖；同新键精确绑定两UUID恢复来历后只重放自己的实际turn/input。完整原content／Skill／编号保存版本和4106码点要求保持，唯一A reserve领取；准备五字段0模型，执行沿原生成与可靠保存并返回actual `restored_input`。不接受renderer正文，不新增writer／来源图／DDL。

净消费C正式4ff的唯一237行测试为本树57ed，不改原断言。本人首编号draft垂直停在missing404，**1 FAIL／1.215s**，仅记新provider未实现；接线后同项**1 GREEN／2.181s**。五个原C场景最终 **5 GREEN／11.724s／skip0**，formal001–055逐名／repeat0及内外自有库0；actual capture五行全部control_contract_completed，完成三场各2模型，两个删除场各1模型，准备与删除模型增量0。三个模式保原拒绝意愿、完整编辑版本低权重／is_current_draftfalse、>4096要求、同新键重放0额外；手工样本无raw时和物理raw删除都清原／typed／恢复三turn与CURRENT，独立manual样本保留。日志 `/private/tmp/notalone-a-authoritative-retry-five-green.log`、capture `/private/tmp/notalone-a-authoritative-retry-five-green-capture.json`。五源码limited mypy、七文件compile和diff0；fixed6 SHA256 `9c288036df2942cae9d83e4d301574c297070309fd42fbf8830ae58f5b83fa68`：B独立Standards硬要求0／重要Fowler possible0，C独立Spec新增P0–P3为0，仅只读六源，未借本人五G计自测。

此片只证明上述三模式恢复HTTP，Main／Host正式身份消费者尚待净消费。另新增已确认策略回应／主动两个actual409 invalid_reply_input **2 PRODUCT RED／2.026s**；同轮原用户稿恢复已GREEN，不能用它代替confirmed。原B reconfirm同事务seam的后续修复独立记录，不放宽公开字符串限额或把失败看作无领取。原17五AC／claimed在消费者及受控退出真实组合完成前不勾；真实App原生停止／重开仍禁止且未执行，不请求用户验收。

主树权威中断恢复独立集成：精确净接 A `cc987b206149321bd7b50d10678ff22e4a1129d2` 六条生产源及 C `4ff9f227` 唯一237行新HTTP测试。两端同一严格三UUID正文，准备回原五字段且零模型，执行返回原reply与权威restored_input；恢复原完整已选组和合法4106码点累计要求，不从renderer重建正文，不放宽新输入4096。Conda NotAlone、PGPORT55441、禁dotenv／全部tracing／外部密钥，运行 `python /private/tmp/notalone-round29-controlled-tests.py /Users/local-user/learn/NotAlone tests.integration.server.test_authentic_expression_interrupted_authoritative_retry`：**5 GREEN／11.916秒／skip0／actualexit0**，001–055账本／repeat0／自有库0，日志 `/private/tmp/notalone-root-authoritative-retry-five-http-pg.log`。限定五源silent mypy与七文件compile／diff通过；固定提供者独立 Standards／Spec 两轴0。原未交路由404仅是准备状态，不称产品RED；已确认策略的权威恢复另有真实409反例，正由唯一提供者修复，桌面Main／mapper与Host同Map消费继续，本票claimed与真实App未验保留。

### 主树已确认策略的权威恢复复验（2026-10-12）

精确净接 sole A `c3a5973b` 三生产源与新模式HTTP测试，原 `reconfirm` 仅抽同一owner事务helper供恢复复用，不构造新writer、来源图或renderer正文。原用户草稿的实际输入与完整单条要求保持；回应和主动的已确认策略恢复从原实际选择复验并建立新有效任务，旧B键不会冒充新A request key。提供者两场真实409 invalid_reply_input RED保留；主树用唯一随机隔离库 runner 独立执行 `tests.integration.server.test_assistant_interrupted_authority_modes`，**2测试 GREEN／3.029秒／skip0／actualexit0**，其中第二测试分别覆盖已确认回应与主动，故不是三个测试。001–055逐名账本、repeat0及自有库0，日志 `/private/tmp/notalone-root-confirmed-recovery-three-http-pg.log`；固定四文件独立两轴0。原5场typed恢复与本模式分开计量；Main/Host及原生未验继续，State claimed保留。

### 主树已确认策略准备的严格零领取证明（2026-10-12）

精确净接 sole A `d7787ddb` 五生产／协议／测试路径。仅两条公开策略prepare在真正 A 事务证明后附无正文 `exploration_preparation`，绑定原path task、原input、action以及confirm suggestion或answer operation；JsonClient只有explicit对应范围、原请求体和实际动作全部匹配才接受服务端实际request key，不拿operation UUID或泛503当生成身份。旧keyless未知别名无法证明等价，继续保留，由原同Map处理。

主树随机隔离 runner 独立执行 `tests.integration.server.test_exploration_preparation_rejection`：**3实际HTTP GREEN／2.891秒／skip0／actualexit0**，55逐名迁移repeat0、自有库0；八个合成本机 HTTP 协议用例 **8 GREEN／71.819625ms／skip0**，额外正文、错动作／身份、未知503和非具名入口均拒绝。日志 `/private/tmp/notalone-root-confirmed-no-generation-three-http-pg.log`、`/private/tmp/notalone-root-exploration-proof-client-node.log`。类型通过，固定五源两个独立审查轴0；严格Main consumer接线继续，当前keylesstoken的明确证明不会解除旧未知alias，真实App未执行，原State claimed不变。


2026-10-12 已确认意愿typed与重复app_quit恢复补充：原typed变更要求保留实际confirmed_suggestion，私有历史确认仍需原A/C可靠completed与完整意愿／来源、自己的真实领取及CURRENT；明确改口才移除旧确认来源。普通恢复的fallback continuation不代表typed，分型仅核同owner/contact/SID B实际request_key与原failed Aturn.key，再复用既有reconfirm。独立C原144行测试不改，A实际2RED／2.640s→2G／5.941s；新typed加重复恢复最小三项最终**3G／12.010s／skip0／55逐名repeat0／内外自有库0**。编号完整参考、累计要求、同键0额外、scope拒绝、raw／手工样本删除闭包、独立manual保留均从真实HTTP观察。原8G／21.293s不覆盖再次恢复，历史夹具失配及产品RED分别保留；详情见[13](13-continuous-intent-reference.md)与fixed5 `d4105c8b5a13b3395f07590c0f807c39f3f78d92f9353ca1700e1979f83bef10`。三源码mypy／五编译／diff0。此为sole provider证据，不借为Main／Host／公开DOM或原生退出通过；原五AC与State claimed保持，最终消费者由各唯一owner接续，无新增writer／图／DDL／正文缓存。

总协调独立净集成验证：仅上述新typed1及重复恢复2项，主树实际3G／12.162秒；55逐名迁移、重复0、自有库剩余0，三个限定mypy与五文件compile通过。提供者12.010秒与本次12.162秒分列，不借为Main／宿主／页面或真人验收。


### 公开生成归属与权威恢复消费者（2026-10-12）

本人唯一普通Main/client/权威mapper净切片：实际准备的noGeneration只交原Map严格核验并结算；泛HTTP无回执拒绝不释放身份。中断恢复冻结原turn/input及新key三UUID，prepare与execute使用同一正文、实际五字段回执和原连接停止句柄。lastAttempt保留原恢复身份及新key，完成ACK丢失或普通模型失败后的同key显式重试仍走canonical，不转回公开正文解析。返回actual restored_input须精确匹配两UUID恢复来历、实际receipt和完整可靠GET后，才映射候选snapshot；完整已选消息组及合法累计要求保留，公开单次4096边界不扩大，未保存草稿和options不覆盖。

本人在已正式交付后端上先真实公开Main/preload→HTTP/隔离PG：原编号回应4106累计及草稿完整引用两场均在旧mapper拒绝，**2RED／6537.990667ms**、模型各1、55/repeat0/库0；首轮回应4096emoji在公开版本编辑前置校验失败，不冒该失败为canonical反例，换同样合法4096甲后才取得这两个RED。最窄消费者后两场2G／8444.541334ms；首类型一处unknown窄化失败保留，改为已与actual恢复输入全等的typed完成回读后type0、两场2G／7389.119083ms。

fresh Spec又发现消息分页异步间隙会让已接受较晚CURRENT被旧observed覆盖；仅加实际反例取得**1RED／5977.396334ms**、模型3/库0。用同一个acceptLatestRead在映射await前后核最新完整snapshot/CURRENT/active/completed/key/replyID，发布只用最新observed。最后三个新消费者 **3 GREEN／12051.323583ms／skip0**，实际模型2+2+3=7，55/repeat0/自有库0；真实模型输入观察同时断言完整低权重已选版本、4106累计、原意愿、同三UUID重放、零额外模型和未保存编辑。

正式协议变更后只校准原CAS反例两项观察路径为 `/retry-interrupted/prepare`，其CURRENT、重复409、原身份、草稿／options、跨范围及模型断言保留。仅跑受影响公开原输入恢复切片 **8 GREEN／28823.82625ms／skip0**、实际模型合计6，每份55/repeat0/库0；包含完整大草稿预算拒绝、合法Unicode、两模式原意愿、CAS推进、正常失败同key及撤销绑定。没有重复跑旧全36组。

实际命令仍为Conda NotAlone、关闭dotenv及全部外部tracing的 `/private/tmp/notalone-a07-18-node.mjs <本树> --test tests/assistant-interrupted-authoritative-retry-http.test.mjs`，相关八场只按name-pattern选择，日志 `canonical-consumer-red2.log`、`canonical-late-read-red.log`、`canonical-consumer-final3.log`、`canonical-related-recovery.log` 位于 `/private/tmp/notalone-a17-*`。完整TypeScript与diff通过。fresh Standards本消费者硬0／重要0／新增low0（旧位置回调P3接受）；fresh Spec原分页P2静态闭合、新M/W/C0。审查仅只读，未拿静态结论当运行证据。

本提交Main只从本树HEAD提取retryInterruptedGeneration、generateInput、lastAttempt及client导入，其余成员保持原字节；同树唯一B typed/runStrategy/A15增量仍另待正式净接，绝不混入本consumer提交。没有第二Map、writer、正文缓存、普通正文日志或发送接口。按ADR-044保来源及样本删除链，主动保存独立样本不随讨论自动删除；无新增DDL。17仍claimed，原AC未勾，Page最终组合由总协调唯一入口验证，本会话无Page租约。真实App退出／重开、原生权限窗口、真人语义、微信、OCR、私人聊天、外部模型、19逐项跳过；不push／发布／部署。


### 同冻结策略命令的准备响应丢失关联（2026-10-12）

总协调最终审查发现新的实际缺口后，仅解除本人唯一Jobs Map冻结。唯一B在公开Main/preload→真实HTTP及隔离PG中，仅丢首次prepare响应，保留实际后端执行；confirm实际回执、answer实际回执和confirm严格未领取证明三场均在显式同命令重试后被旧未知身份阻塞退出。其test-only净切片SHA256 `5e4ebfd75fffed2314dc3a8938d4feb07af23d0244219acefad54fcd0b73e855`；三场合计 **3FAIL／9946.214167ms**，实际模型2＋3＋1；正式001–055、repeat0、自有库清理0。这是总协调／B提供的产品RED，本人没有重复执行或冒称为本人HTTP验证。

只在原唯一Map的ActiveJob增加可选、无正文五字段task/input/action/suggestion/operation UUID命令身份；beginPreparation第四参严格精确字段、复制冻结。confirm使用薄客户端同冻结命令的私有一次UUID，answer使用实际冻结操作UUID且suggestionId必须null；原正文及action来历由唯一B薄客户端绑定。取得实际准备回执或严格NoGen证明后，只关联同owner/generation和同五字段、preparing、传输已结束、无key、无实际回执的旧身份。不同task/input/action/suggestion/operation、不同范围、live、legacy及实际回执全部继续保留；没有按owner批量释放，没有新Map、writer、正文缓存、日志、DDL或发送接口。

本人先只加六个契约，以旧Map取得 **6项中5FAIL／89.346209ms**，确认缺失命令关联；最窄实现后完整 **15GREEN／95.698208ms、skip0**，覆盖actual receipt、strict proof、各身份边界、实际回执及在途保留、精确字段拒绝、复制冻结及finally当前UI存活。实际命令为禁dotenv／全部外部tracing的 `/private/tmp/notalone-a07-18-node.mjs <本树> --test tests/assistant-generation-preparation.test.mjs`；RED、GREEN及type日志在 `/private/tmp/notalone-a17-command-alias-{contract-red,contract-green,type}.log`。完整TypeScript与diff检查通过；未跑旧36、8、Page、OS或真实App。

fresh Standards本两文件硬0／重要0，仅新陈旧注释P3已修；原两种proof镜像P3仍接受。fresh Spec Missing/Wrong/Creep均0；静态审查不代替唯一B薄客户端绑定及原三场产品GREEN。本人此提交只含Jobs1、契约1及本记录1，源码1净切片SHA256 `ba930768dca1e6fd5b8237085ce039d85ece469c210b9115638e619690d5d4eb` 已交总协调，实际组合验证由B／总协调继续。本票仍claimed、原AC未勾；ADR-044的主动保存独立样本和删除链保持，真实App退出／重开、原生权限、真人语义、私人聊天、微信、OCR、外部模型及19逐项跳过，无push、发布或部署。

总协调独立命令关联验证：正式6edad唯一Map与e85唯一薄调用净集成，原三实际ACK丢失场3 GREEN／9694.099792ms、六实际受控模型、55×3重复0／三自有库清理0；原15Map契约GREEN／111.662667ms、完整类型通过。同冻结HTTP正文与真实回执／严格证明不变，仅关联已结束无回执旧身份；live、legacy、不同范围／命令保持失败关闭。此自动结果不替代真实App与最终公开组合，本票状态暂按原范围保留。

### 本轮自主协调最终结果（2026-10-12）

自动部分完成：受控quit／准备停止／恢复、完成和失败回包竞态、来源及样本删除、原身份重放和同冻结策略命令ACK丢失均有真实Main→HTTP→隔离PG结果。主树39项退出／携入、7项权威／意愿／proof和3项命令关联分别通过。

剩余：原第1、3条要求真正App停止／重开；本轮只实际执行受控宿主和具名公开页面窗口，真正App停启未执行，保留原文和未勾选、State claimed。工程要求原生运行使用用户认可的有限时段与显式test:app入口；本轮没有这项实际验收记录，受控结果不代替原生证据，不请求用户实施验收。

证据：[29票逐项结果与实际命令](../../unfinished-work/round29-autonomous-results-20261011.md)、[固定源码、自动验证及清理回执](../../unfinished-work/round29-autonomous-verification-20261011.json)。各次不同来源的计量分列，未把静态审查、合成模型或受控宿主冒为原生／真人通过。原验收文本逐行对共同基线保留；只更新实际可验收的勾选和State。

### 冻结新增功能后的19／17收尾（2026-10-12）

用户明确要求先做可自行验证的收尾、OCR继续暂停。原公开Main→HTTP／隔离PG最小四场退出等待、运行后只读恢复／显式重试、可靠完成保留及来源删除守卫再次实际4／4、16.267秒、skip0，模型0＋2＋1＋0；四份真实001–055迁移／repeat0／库0。19的双联系人／多会话页面交叉及两来源后继／携入删除已通过，详见[19结果](19-combined-native-acceptance.md#answer)。本轮未改生产生命周期或新增功能。

真实App用例 `desktop/tests/assistant-native-lifecycle.spec.ts` 已准备、类型通过、默认跳过：同一自有userData内最多两次源App启动，公开菜单退出，验证小窗close继续、quit中断、重开只读和明确重试；CLI／OCR路径为本轮不存在路径，无外部模型。真正App尚未运行，仍保留原第1、3条未勾选和claimed，Triage改为ready-for-human仅等待工程要求的有限时段确认，不要求用户亲自实施测试；通过后按实际证据收口。
