# 04：明确目的的主动联系入口

State: resolved
Triage: ready-for-agent
Blocked by: [conversation-reply-strategy/01 回应场景与明确意愿直达候选](01-response-scene-entry.md)

拆分标识：R04（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧02；主动链路、Q1–Q8。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-043](../../../architecture/adr/043-conversation-scenarios-and-direction-exploration.md)。依赖是完整交付的前置，实际实现与验证见下方 Answer。

## What to build

没有对方目标消息时，用户明确说明目的，直接比较开口方式与候选。

## Acceptance criteria

- [x] 没有对方目标消息时，以明确主动目的提交，开口方式与候选一起比较，不需要先确认方式再生成。
- [x] 主动目的扩展既有统一输入契约，不伪造对方消息、不自动回复最近消息、不绕过绑定和来源验证。
- [x] 无历史可按当前目的形成条件性表达，原草稿和回应入口兼容，切换不自动调用模型。
- [x] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [x] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

使用独立的主动目的输入，不伪造目标消息；已明确目的无需再确认方式，不破坏原草稿与回应入口。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Answer

2026-10-11：本票可自主执行的实现与自动验证完成。独立 `InitiateConversation(purpose: ConfirmedDirection)` 与 `user_purpose` 依据沿既有生成链、联系人绑定和来源守卫保存，不制造目标消息；用户明确目的后一次生成多种开口及候选，不增加方式确认步骤。切换场景不调用模型，草稿保留，主动入口不自动选最新消息。主体来自已消费的正式 `2f29ceb`、共享来源守卫 `da370f7` 与 A08；本票未新建生成器或存储。原删除后旧键仍200的反例在正式来源守卫下转为拒绝，历史失败记录保留。

最新独立验证使用实际生产迁移001–053，没有pending辅助schema：

- 激活 Conda `NotAlone`，用本轮自有随机库执行 `tests.integration.server.test_strategy_flow`、`tests.integration.server.test_reply_message_groups`：4项真实HTTP/PG全部通过，5.506秒，自有数据库残留0。无历史目的输入不含 `current_text` 或 `target_message_id`，只有本次目的依据；同键原结果重读零新增模型调用、跨owner拒绝；待确认资料仍标待确认，实际来源删除后依据404且旧键拒绝。
- `cd desktop && npm run test:pages -- --case reply-strategy-dialogue --case conversation-strategy-entry --timeout-seconds 240`：两case实际通过。入口case从草稿切到回应、再切主动，空目的不能生成且模型0调用；填目的后直接显示两种候选，载荷仅本次目的，查看已保存讨论及待确认依据成功。资源quiet26、active0、onscreen0、单Chrome，cleanupConfirmed=true，Electron/native=false。同窗口的两场21来源策略路径证据属于R02/R05/R06/R07，不代替本票以外验收。
- 最新相关273项回复单元、TypeScript和预算主题限定两轴已通过；本票收尾记录限定Standards hard0、Fowler judgement0、Spec0，只采用已实际到达的证据。

数据影响：新增的本次目的及依据按owner/contact隔离并沿原删除路径处理，不写长期偏好，不新增外部聊天发送能力；测试仅使用合成消息与可控模型。合成结果证明输入、控制和存储契约，自然语言的条件性表达质量仍未知。按照本轮授权，真实App、系统剪贴板、真实聊天、外部模型质量及人工验收均跳过，未宣称通过；页面结果不能代替原生验收。R05的模糊目的探索、R08编辑复制和R09–R11生命周期及组合仍各按原票接续，不由此关闭。

总协调主树消费正式记录 `10b6f11e6b104375dfa834933d674f8aae3f8ad9`。在 Conda `NotAlone`、关闭 dotenv／追踪、`PYTHONPATH=src:.` 环境运行 `python /private/tmp/notalone-coordinator-isolated-tests.py /Users/local-user/learn/NotAlone tests.integration.server.test_strategy_flow tests.integration.server.test_reply_message_groups`：4 项真实 HTTP／正式 001–053 随机 PostgreSQL GREEN／5.795 秒，自有数据库残留 0。主树 `2032e742433b4f2ff4e045c17189d92c88453c6b` 已实跑 `reply-strategy-transition` 与 `conversation-strategy-entry` 两 case／180 秒，入口原断言到达，quiet26、cleanupConfirmed=true、Electron/native=false。记录限定 Standards 硬要求 0／重要气味 0、Spec 0；未新增业务源码或数据处理能力，原验收及未执行部分保持。

## Comments

2026-10-11 B 实施：公共输入为 InitiateConversation(purpose: ConfirmedDirection)，沿用 GenerateReply/ReplyService；HTTP content.type=initiate_conversation，purpose为独立字段，无target_message_id。user_purpose保留为独立证据，050扩展原白名单。明确目的直接比较候选，切换场景不调用模型、不改变草稿或回复方向。自动类型检查及回复单元回归已通过；真实PG待048/049连续迁移集成，公开页面case已编写，尚未执行。

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

### 本轮自主协调最终结果（2026-10-12）

主动场景使用真实明确目的，不伪造对方目标；复用统一生成入口，无第二次必选开口方式。切换不调用模型。

剩余：本票可自主范围已完成。真实模型语义、自然度、关系适配及用户相似度未知；本轮没有原生App、私人资料、微信／OCR、外部发送或远端操作。

证据：[29票逐项结果与实际命令](../../unfinished-work/round29-autonomous-results-20261011.md)、[固定源码、自动验证及清理回执](../../unfinished-work/round29-autonomous-verification-20261011.json)。各次不同来源的计量分列，未把静态审查、合成模型或受控宿主冒为原生／真人通过。原验收文本逐行对共同基线保留；只更新实际可验收的勾选和State。
