# 01：回应场景与明确意愿直达候选

State: resolved
Triage: ready-for-agent
Blocked by: None (can start immediately)

拆分标识：R01（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧01；Q1–Q8明确意愿路径。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-043](../../../architecture/adr/043-conversation-scenarios-and-direction-exploration.md)。依赖是完整交付的前置，不代表这些前置已完成；实际实施结果与未执行项见本票 State 和 Answer。

## What to build

明确选择回应消息场景、目标消息和意愿后生成，已有草稿改写仍可进入并保留内容。

## Acceptance criteria

- [x] 既有目标消息+明确方向生成路径继续可用；新增明确的回应场景入口，并保留原草稿及可进入的改写操作。
- [x] 切换场景不改写输入含义、不自动选择最近消息或调用模型；无目标时不得伪造回复目标。
- [x] 复用既有公开生成及范围校验，写明新增行为和已有回归，不重复建设持续会话或第二套生成链路。
- [x] 改写默认不读取关系背景，只有用户明确开启才使用；无历史和服务失败如实呈现。
- [x] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [x] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

不新建持续会话模型；复用当前公开生成入口。切换场景不静默改意图或调用模型。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：补齐headless runner中的conversation-strategy-entry白名单；原脚本入口已注册但runner遗漏，不能据此宣称页面已执行。TypeScript检查通过；公开页面由本轮总协调在串行受限入口执行。

2026-10-11 B 实施：公开接缝沿用 reply:set-mode → ReplySession → /api/reply/generate；场景切换不提交生成，目标仍需明确选择。先验收既有消息与草稿回归，页面→HTTP/PG 证据待总协调串行预约。新增“回应消息”场景入口并保留草稿操作。

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

## 原正式提交的承接契约（历史阶段）

- 用户可明确进入“回应消息”，内部继续使用 `reply_to_message`；“改写”继续使用 `rewrite_draft`，两类输入及单次生成入口不变。
- 回应必须主动选择当前联系人范围内的 `target_message_id`，并输入本次 `direction`；不选目标不能生成。场景切换只影响当前展示和请求身份，保留同范围草稿、目标与方向，不发起模型调用。
- 公开生成继续经过 `POST /api/reply/generate`、`ReplyService` 的绑定校验、`ReplyGenerator` 和既有 Store。`scopeRevision`、输入变化的新幂等键与联系人／连接变化的迟到失效沿用现有规则。
- R02 后续扩展建议 ID 与输入版本，R04 扩展主动目的；本票不引入新的助手会话、生成或删除模型。

## 原正式提交的 Answer（历史阶段）

2026-10-11：R01 可自主执行的范围已完成。明确“回应消息”入口，保留已有草稿改写、默认关闭关系背景、目标与方向校验、幂等和来源删除路径。没有新增生成链路或助手会话存储。

- TDD：新增公开页面场景首先因缺少“回应消息”入口失败；补齐入口后取得 green。中间两次测试断言校准分别修正依据接口不返回候选正文和幂等重放增加代理请求计数，未据此宣称产品故障。
- 命令：在 Conda NotAlone 中运行 `npm run test:pages -- --case response-scene-entry --case directed-reply --timeout-seconds 240`，新场景1及既有定向回复11场全部通过；真实生产页面/控制器、HTTP、随机隔离PG和可控模型，核对持久依据与同键重放。
- 审查阶段提取共享页面白名单；命令复制夹具先出现缺少该模块的真实失败，补齐复制后 `node --test tests/headless/command.test.mjs` 10/10，`npm run typecheck` 通过，最终 `test:pages -- --case response-scene-entry --timeout-seconds 120` 1/1。父、子入口各自门禁仍有效。
- 两个独立只读 Agent 审查：Standards hard 0，初次possible1（重复白名单）已消除，delta possible0；Spec初次和delta均0。
- 数据影响：仅随机测试库的合成消息、候选和依据；没有读取真实聊天、启用OCR或调用外部模型。最终资源报告 cleanupConfirmed=true；自有Chrome/Python/PG与临时目录正常回收。截图和资源产物未提交。
- 剩余／跳过：真实App窗口、原生能力和模型语义质量未验收，本票自动证据不替代这些结果。总协调/A尚未识别，交付和文件归属已与本轮C对齐；后续收到身份后补交。

## Answer

总协调原先已集成本票源码，现补齐正式 `6856a823` 的逐项验收和历史 Answer，保留本树所有既有 Comments。以上全局端点、共享用例白名单及未识别会话的叙述只说明当时阶段；当前助手生成已沿 A 唯一持久会话 `POST /api/contacts/{contact_id}/assistant-sessions/{session_id}/replies`，仍复用同一 ReplyService／Generator／Store，不恢复旧登记模块或建立第二条生成链。

主树既有 `directed-reply` 的十一场公开回归已实际通过，quiet85、cleanupConfirmed=true；首次来源失效提示不准确的真实失败及修正后回执保留。最近正式 `6143e76` 再运行原 `understanding-direction` 六场和 `response-scene-entry` 一场，全部七场到达 GREEN，实际 CLI exit0、quiet91／active0／onscreen0、单 Chrome、cleanupConfirmed=true、Electron/native=false，`npm run typecheck` 与原安全调度十项通过。该当前入口核明确目标／方向、草稿保留、场景切换零额外模型及真实 HTTP／隔离 PostgreSQL持久化；其中首次全部业务 case 通过但最终观测失败的 exit1 历史保留，重跑未复现，原因未确定。

本票自主实现与自动验证完成；真实 App、原生能力和真实模型语义未执行，按本轮授权范围跳过。这些自动入口与数据契约验收没有将人工结果标为通过，也不关闭 B08–11 或持续会话后续组合。限定文档两轴初审指出当前未实现陈述和缺少 Answer 入口，均仅修正文档并保留原标准；最终 Standards 硬要求／重要 Fowler 可能气味 0、Spec 0。

### 本轮自主协调最终结果（2026-10-12）

回应入口保持目标消息和明确方向，草稿改写兼容；场景切换零模型，不猜最近消息，默认改写不读关系背景。最后策略组合实际走公开入口。

剩余：本票可自主范围已完成。真实模型语义、自然度、关系适配及用户相似度未知；本轮没有原生App、私人资料、微信／OCR、外部发送或远端操作。

证据：[29票逐项结果与实际命令](../../unfinished-work/round29-autonomous-results-20261011.md)、[固定源码、自动验证及清理回执](../../unfinished-work/round29-autonomous-verification-20261011.json)。各次不同来源的计量分列，未把静态审查、合成模型或受控宿主冒为原生／真人通过。原验收文本逐行对共同基线保留；只更新实际可验收的勾选和State。
