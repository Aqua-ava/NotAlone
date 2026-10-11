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
