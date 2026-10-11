# 10：两种场景的连续修改与消息衔接

State: open
Triage: ready-for-agent
Blocked by: [conversation-reply-strategy/05 主动目的探索与确认](05-purpose-exploration.md)；[conversation-reply-strategy/06 两种场景的关键澄清与取舍](06-clarification-and-tradeoffs.md)；[conversation-reply-strategy/08 候选消息组逐条编辑与复制](08-message-group-edit-copy.md)；[assistant-session-context/13 连续要求、改口与明确编号指代](../../assistant-session-context/issues/13-continuous-intent-reference.md)；[assistant-session-context/15 新消息提醒与用户触发重新生成](../../assistant-session-context/issues/15-new-message-opt-in.md)

拆分标识：R10（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧04；Q7、Q10、Q11、Q28、Q31。 第二版标识为R09。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-043](../../../architecture/adr/043-conversation-scenarios-and-direction-exploration.md)。依赖是完整交付的前置，不代表这些前置已完成；本票尚未实现。

## What to build

回应与主动聊天都能修改目的、引用组内候选，并在新消息后由用户决定是否结合继续。

## Acceptance criteria

- [ ] 回应和主动路径均支持改口、明确引用组内候选及澄清后继续，目的、方向、候选组和输入版本一致。
- [ ] 新消息由用户决定是否结合，复用C06/C08的连续要求、快照和迟到失效规则，不新建另一套取消或存储。
- [ ] 旧建议、旧问题、旧候选版本不能应用到新输入；越权与来源删除清理新增讨论及派生结果。
- [ ] 不依赖未选方向自动更新R09；手动连续修改可独立验收。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

复用C系版本与失效规则，不再实现另一套；组、方向、改口及消息快照保持一致。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

2026-10-11 明确重试的元数据接口前置：按总协调 01:22:50 裁定，在原探索 handler／唯一 PostgresExplorationStore 增加 `POST /api/contacts/{contact_id}/assistant-sessions/{session_id}/explorations/{exploration_id}/reconfirm`。严格输入为原 B `input_version_id`、实际旧生成 `expected_input_version_id`、全新 `request_key`，以及唯一的原已选 `suggestion_id` 或完全相同的 `direct_intent`。仅允许实际失败旧 turn、旧键已失效且尚无 C 已完成候选；复验同 owner/contact/session、原选择与来源、实际 CURRENT、原 Skill 版本／目录和根 TTL。沿原 A 同事务输入端口签发新 B 确认及选择 UUID，返回无正文的 reference／request key／input UUID／方向来源和实际 Skill 元数据；生成仍由原 `prepare/replies` 路径执行。同键重放读取原回执，不推进或回退当前输入；变体、旧键、其他选择／任务／范围、来源删除、TTL 或 Skill 变化均拒绝。旧任务、旧键和旧回执保持，根 TTL 与自动调用计数不续期，不降级成直接意愿。新确认在原 B 表增加派生行，沿既有字段保存原输入、证据和结果，继承来源依赖及根 TTL；不新增独立正文缓存、表、模型调用或生成链。

TDD 实际记录：首个两场景公开 HTTP 反例因接口尚无而返回 404，1 test／2 FAIL（2.280s），实现后原路径 GREEN（4.594s）。初次夹具误把既有空候选失败的真实 503 期望为 409，未走到新接口，不算此接口 RED。之后先前置 53 项 GREEN（99.752s），C 候选已保存但 A 投影失败的真实反例 1 FAIL（6.032s），加已有 C 状态守卫后原 1 GREEN（3.035s），相关 54 项 GREEN（98.146s）。最终规格复核又发现澄清会重建建议 UUID，服务器原明确选择仍保留旧 ID：两场景澄清→确认原方向→回答→生成失败→再次确认实际返回 500，1 test／2 FAIL（2.916s）。只从已复验的服务器原选择签发新 UUID 兜底后，同反例 GREEN（4.313s）；验证旧记录不变、原 TTL、方向来源与意愿不变、零隐式调用，并沿原生成入口保留澄清回答。

本 B 显式 Conda NotAlone、当前工作树 PYTHONPATH，执行自有随机库入口 `python /private/tmp/notalone-b-isolated-tests.py /Users/local-user/.codex/worktrees/conversation-reply-strategy/NotAlone tests.integration.server.test_exploration_reconfirmation tests.integration.server.test_persistent_reply_exploration tests.integration.server.test_exploration_generation_fields tests.integration.persistence.test_reply_exploration tests.integration.persistence.test_explored_generation`，正式 001–053 实际完整 55 项 GREEN（64.905s、skip0＝32 真实 HTTP／23 直接 PG，外层自有库剩余 0，HTTP 夹具各自清理）。四个改动 source 的 mypy、五文件 py_compile、原探索服务 17 unit（0.004s）和 diff 检查通过。新增 HTTP 覆盖重建宿主后的同键重放、直接意愿、跨范围／严格 JSON、当前输入、来源物理删除、TTL／目录、实际选定 Skill 同版及停用拒绝、已保存候选优先和上述澄清后选择延续。最终源码 Spec 新增 P0–P2 为 0、Standards hard 0／新增重要 Fowler possible 0，原接受 P3 保持；文档最终复核及本地 SHA 随交付补齐。

此处退出事件只以合成宿主的既有旧键失效凭证适配；未消费 A 工作中 054、未直接改 A turn／正文／当前指针，不据此宣称 A17 生命周期完成。真实 `interrupt→reconfirm→prepare/replies`、迟到结果、重装、级联删除与公开页面组合仍待 A 正式接口；本票 open 和原验收标准保持，R08–R11 自主集成继续。只处理合成消息及隔离数据库，无真实 App、OCR、私人聊天、额外外部模型、人工验收、外部聊天发送或远端写入。

2026-10-11 来源删除后生成领取测试的前置校准：总协调消费本 B 重确认及 C 传递删除后发现，原测试仍以已删探索的旧输入 UUID 作 expected，先触发 A 当前输入 CAS 冲突，尚未到达 B 来源守卫。本 B 在 e222 正式前置上独立复现最小一项 ERROR（1.294s、正式 001–053、自有库剩余 0）；这是测试前提过期，不冒充新的产品失败。只改原测试：先真实断言 CURRENT 为空、原 051 输入 redacted 且 content 为 NULL，再把 expected 更新为实际 None，保留原已删除 suggestion／reference，要求精确 AssistantSessionRejected.reason=exploration_stale，并保持零生成 turn 和探索派生正文擦除断言。业务源码、顺序与门禁没有改动。

同一最小测试实际 GREEN（2.185s、正式 53、skip0、自有库剩余 0）；继而在显式 Conda／本树 PYTHONPATH、自有随机库原入口联跑 test_exploration_reconfirmation、test_persistent_reply_exploration、test_exploration_generation_fields、test_reply_exploration、test_explored_generation，完整原 55 项 GREEN（66.374s、skip0＝32 真实 HTTP＋23 PG、正式 001–053、自有库剩余 0）。原最小 ERROR 和先前 55 项通过记录各自保留。原测试 py_compile 和 diff 检查通过；限定测试／最终记录 Spec 新增 P0–P3 为 0，Standards hard 0／新增重要 Fowler possible 0。本票仍 open、原验收项保留，不将该测试修复说成公开路径、A14 删除 reason 或 A17 真实中断通过。

2026-10-11 总协调精确消费B正式4b1及2bd夹具修正，在本树原五模块完整56项实际通过75.649秒／skip0（本树包含另一个已正式回归，与B自身55项分别计量）；正式001–053、迁移重复0及外层自有随机库剩余0。此前56=55通过／1ERROR72.906秒真实保留：旧fixture传已删expected版本，提前A CAS，未验证B guard；修后先核实际CURRENT None／051redacted与content NULL，再用expectedNone及原已删suggestion触发精确exploration_stale，零turn和派生正文清理均到达。业务守卫未宽化，四源类型检查、17unit、compile与diff及最终两轴无重要问题。仅完成明确重试后端元数据切片；真实A17中断、A13连续语义与公开组合仍继续，本票open及原标准不变。

2026-10-11 总协调仅消费 B 正式76ae56d 的 replace 路由四行 owner 类型收窄：其余 A 回执、替换、054、中断 source／tests 此前已root9232252正式，不重复导入。明确 replacement_owner 为 UUID 后委托唯一 service；不可用仍使用既有503 owner_uninitialized，不加cast／ignore或改变来源、输入、迟到、预算与鉴权门禁。主树 Conda NotAlone 下 `python -m mypy --follow-imports=silent src/notalone/server/app.py` 前78条、后77条，按去行号诊断集合严格比较只删除一条该新增replace可空owner错误，无新增诊断；77条既有通用入口诊断继续保留，未宣称全仓类型通过。app.py编译及diff检查通过；B本人修正后原十项真实HTTP G14.335属其交付证据，主树后续组合运行另记，不借作本次根本人新HTTP。R10 open及原标准保持，自动连续修改继续，无正文/schema/外部调用变化。

2026-10-11 上述 owner 窄守卫的主树动态相关复验已完成：净接 C 正式2a8的真实HTTP中断测试后，prepare17／HTTP interruption8／迁移3／C reconfirmation及replacement2／原replacement HTTP10共 **40G／42.834s／skip0**，原Conda隔离入口 `/private/tmp/notalone-coordinator-style-samples-no-dimension.py`、正式生产迁移001–054／repeat0／自有库剩余0；三迁移场景核实际账本、升级与回滚。C重确认含两scene，测试仅合成模型及StyleSampleHttpTest维度fixture为空，不改变生产门禁。原十替换HTTP已在这40中本人实际执行，不借B14.335s计量；明确HTTP中断不等于真实宿主停止模型。原状态open及桌面连续修改、leave/quit组合剩余保持。
