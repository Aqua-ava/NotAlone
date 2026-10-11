# 17：退出停止与重开后的中断恢复

State: claimed
Triage: ready-for-agent
Blocked by: [assistant-session-context/08 重新连接后恢复已保存会话](08-saved-session-recovery.md)；[assistant-session-context/14 生成中替换请求与迟到结果失效](14-replace-running-generation.md)

拆分标识：C10（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧04；Q15退出。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)。依赖是完整交付的前置，不代表这些前置已完成；本票尚未实现。

## What to build

真正退出应用停止未完成生成，重开显示“上次生成中断”，只在用户重试后继续。

## Acceptance criteria

- [ ] 真正退出停止未完成生成；重开只显示上次生成中断，由用户明确重试，不自动续跑。
- [ ] 已可靠保存的完成结果保持完成；退出与完成、删除、旧进程迟到的竞态不能复活无效请求。
- [ ] 先在受控生命周期及公开恢复入口验证；真实App停止/重开由C13核对，不能把模拟结果标为原生通过。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

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
