# 11：策略全路径组合验收

State: open
Triage: ready-for-agent
Blocked by: [conversation-reply-strategy/03 换组、推荐与暂不回应](03-direction-options-and-pause.md)；[conversation-reply-strategy/07 Skill探索、确认与生成的版本延续](07-skill-version-continuity.md)；[conversation-reply-strategy/09 未选方向时的新消息有界更新](09-bounded-direction-updates.md)；[conversation-reply-strategy/10 两种场景的连续修改与消息衔接](10-continuous-scenario-revision.md)

拆分标识：R11（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧05；Q1–Q32组合。 第二版标识为R10。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-043](../../../architecture/adr/043-conversation-scenarios-and-direction-exploration.md)。依赖是完整交付的前置，不代表这些前置已完成；本票尚未实现。

## What to build

公开页面→HTTP/PG组合验证两条路径、方向探索、Skill、消息组与持续修改的隔离/删除和调用边界。

## Acceptance criteria

- [ ] 公开页面经HTTP/隔离PG串联回应、主动、探索、澄清、换组、暂缓、Skill、消息组和连续修改；覆盖隔离、来源删除、断线与恢复。
- [ ] 组合验证方向未选可有界更新、确认后只提醒、关闭探索不取消已发起候选；旧建议/迟到结果拒绝。
- [ ] 保留同句不同前文的可审阅语义用例，合成回归不等真实模型预算、不宣称语义质量或原生App通过。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

同句不同前文保留语义审阅用例，不依赖真实模型预算才执行合成回归；不宣称语义质量或原生App通过。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。


## Answer

2026-10-12 同句不同前文审阅已净集成正式 `a99eeafb` 的三文件。四个独立合成场分别通过真实探索、明确方向确认、候选生成、持久化重读和同键重放；实际八次可控模型，完整前文与真实输入／system prompt可审阅。原报告见[同句不同前文报告](../reports/context-http-controlled-v1.json)：dev分母4、合同失败0、故意语义失败1、未审阅1、真人通过0、quality_verified=false，真实自然度、关系适配和本人相似度未知。Root独立实际HTTP一项GREEN／4.725秒、55迁移逐名／重复0、自有库剩余0；准备报告目录时路径不存在属于准备错误，未当作产品RED，也未新增Root捕获报告。

固定三文件与正式a99逐字节相等，联合SHA256 `2b663d2a359012bb276bbc55c40a9d2d2fc608fc1aa12dbc06406e0c1728eb36`。A独立Standards硬要求0／重要possible0，C独立Spec新增P0–P3及缺失／错误／扩范围0；不将静态审查计作运行。完整36场公开页面组合仍待本轮唯一有限窗口，当前不预勾或关闭本票。无原生App、私人资料、外部模型或远端操作。
