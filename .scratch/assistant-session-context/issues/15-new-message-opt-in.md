# 15：新消息提醒与用户触发重新生成

State: resolved
Triage: ready-for-agent
Blocked by: [assistant-session-context/11 候选编辑、选择与版本回看](11-candidate-edit-history.md)；[assistant-session-context/14 生成中替换请求与迟到结果失效](14-replace-running-generation.md)

拆分标识：C08（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧03；Q6、Q16。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)。依赖是完整交付的前置，不代表这些前置已完成；本轮受控自动实现与验收证据见 Answer。

## What to build

新消息到达保留候选编辑与正在生成的结果，并标记尚未结合；用户点击结合新消息才替换生成。

## Acceptance criteria

- [x] 授权新消息到达不覆盖编辑或自动取消生成，只显示尚未结合；未经用户操作模型调用数不增加。
- [x] 用户明确结合新消息时复验联系人和消息，捕获新快照并通过C07替换；原快照与新快照可区分，保留已保存编辑。
- [x] 替换和累计上下文经过既有C11守卫；旧结果、失效消息和越权消息不能进入当前候选。
- [x] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [x] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

消息归属复核、无自动模型调用、保存编辑不丢；新快照和原快照分开。 替换请求沿用C07接入的C11预算守卫。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

## Answer（2026-10-12策略38场后的原标准收口）

原五条标准的自动范围已满足，原第2／3项补勾，State改为resolved，文字不变。总协调最新固定687ac83a策略38场中，完成后显式采用与生成在途替换的回应／主动共4场全部公开通过；原六HTTP与本B原C112两scene2GREEN／10439.423292ms是本人的分项实际证据，不把总协调本次Page借作自跑。

| 原AC | 实际自动证据及范围 |
| --- | --- |
| 1 | 认证SSE仅传metadata，实际有界消息投影复验后只标尚未结合；完整已保存组编辑保留、未点击模型增量0、在途旧请求未自动取消。 |
| 2 | 显式按钮再核连接／contact／scope／SID与真实消息；回应新target、主动原purpose，新CURRENT／snapshot与旧UUID可区分；在途唯一replace后才release旧模型，旧failed／新completed及实际reply UUID相符。 |
| 3 | 复用C11实际预算和C07／唯一Jobs，来源／消息失效或跨范围拒绝；实际迟到旧模型不覆盖新CURRENT。合法累计4106只从同CURRENT权威要求复原，仍保公共4096声明上限。 |
| 4 | 原owner/contact／来源／删除路径及样本DELETE后三turn redacted、CURRENT／RAM清理、独立样本保留；普通日志不写敏感正文、没有发送接口。 |
| 5 | 原HTTP和Page RED／GREEN、供应方／本人／总协调范围、命令及当前未验边界逐项保留。 |

完成后采用与实际在途replace的DOM范围现都已到达，不再把后者记未跑。旧scope／SID／晚通知不能清新提示，完成仅按新operation、可靠input／reply UUID、同notice／mode／target或purpose收口，不用input对象引用。完整38标签、samecommand整体exit1以及后来仅carry2另窗G的区别见[R11最终收口](../../conversation-reply-strategy/issues/11-combined-strategy-acceptance.md)；C样本／typed／新消息组合另有自己的两scene实际记录，不借其计本人运行或真人保真质量。

真实App／原生、真正系统剪贴板、真人与外部模型未验；A17仍按其原标准claimed。只实现本次用户明确采用，0自动发送、0长期偏好写入、无OCR、微信、私人资料、付费、push、发布或部署，不请求用户实施验收。

## Answer

### 本轮自主协调最终结果（2026-10-12）

真实合成消息经SSE只提醒，不覆盖编辑或自动生成；明确结合复验实际消息与CURRENT并替换。累计要求新反例两场完整通过，最终公开在途两场及删除／预算后段均已执行。

剩余：本票可自主范围已完成。真实模型语义、自然度、关系适配及用户相似度未知；本轮没有原生App、私人资料、微信／OCR、外部发送或远端操作。

证据：[29票逐项结果与实际命令](../../unfinished-work/round29-autonomous-results-20261011.md)、[固定源码、自动验证及清理回执](../../unfinished-work/round29-autonomous-verification-20261011.json)。各次不同来源的计量分列，未把静态审查、合成模型或受控宿主冒为原生／真人通过。原验收文本逐行对共同基线保留；只更新实际可验收的勾选和State。
