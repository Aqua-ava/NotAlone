# 05：主动目的探索与确认

State: claimed
Triage: ready-for-agent
Blocked by: [conversation-reply-strategy/02 理解、纠正与方向确认闭环](02-understanding-and-direction.md)；[conversation-reply-strategy/04 明确目的的主动联系入口](04-proactive-purpose-entry.md)

拆分标识：R05（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧02；Q9–Q15。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-043](../../../architecture/adr/043-conversation-scenarios-and-direction-exploration.md)。依赖是完整交付的前置，不代表这些前置已完成；本票尚未实现。

## What to build

用户只有“想聊聊”等模糊目的时，先探索不同目的与开口方向；用户确认目的后直接进入主动候选路径。

## Acceptance criteria

- [ ] 目的不明确时提供少量不同目的/方向，用户确认或直接输入明确目的后进入主动候选。
- [ ] 模型建议不当成用户决定，纠正时保留明确要求；目的明确后不增加第二次必选开口方式。
- [ ] 目的和输入版本绑定，越权/失效/迟到探索不能生成；关键承诺澄清与取舍由R06，跨轮延续由R10。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

模型建议不确认用户意愿；保留用户纠正，目的明确后不增加第二次开口方式确认。关键问题及取舍由R06交付。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11 公开后端接续：主动模糊目的使用正式purpose_exploration接口，选择/直接输入确认后沿原主动生成链；无选中意愿的澄清回答仍只返回探索，不增加第二次必选开口方式。实际HTTP检查生成前后载荷、A持久重读及模型次数，目的/一次纠正与要求分别保存，current_intent仍是服务器确认原文。伪confirmed请求在A领取前拒绝。页面接续中，原验收不勾选，State保持claimed。

2026-10-11 接续：已建立同一探索应用组件，主动模糊目的只返回方向或关键问题，选择/直接输入意愿才调用既有生成端口；不伪造目标。探索操作键与A持久输入UUID分开，确认只取服务器保存的选择证明，NoSkill延续到生成。17项组件测试通过，含原失败后意愿丢失、暂停旧问题、旧意愿回退及Skill换组重试反例red→green，两轴该组件最终0。未公开装配、未用模拟Store冒充真实HTTP/PG；等待正式A051同事务输入记录，继续接B052及公开页面，验收项保持未勾选。

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

2026-10-11 持久UUID前端核心切片：主动模糊目的的公开页面已串联理解纠正、关键回答、明确选择和原主动生成，回答后仍未确认不产生候选；目的独立保存，不加第二次必选开口方式。真实源删除后的派生目的残留P2已公开RED→GREEN。 真实命令、五场控制／隔离证据与数据影响见[R02本次页面记录](02-understanding-and-direction.md)；非真人或原生验收，原标准保持。

2026-10-11 普通请求与探索改口边界：协调审查发现普通A生成后探索确认B可能仍复用A旧attempt。新增公开 `reply-strategy-transition` 两场均取得真实RED：下一普通HTTP key仍等于A。仅在runStrategy开始时清除旧普通lastAttempt，保留策略操作自身的UUID/键、实际Skill与保存守卫；修后两场新key、B意愿、实际NoSkill禁用、新候选和第4次模型调用均通过，策略确认及新普通请求各自完整同键重放不追加调用。

命令为Conda NotAlone内 `npm run test:pages -- --case reply-strategy-transition --case reply-strategy-options --timeout-seconds 180`，两case实际GREEN，quiet33/active0/onscreen0、单Chrome、cleanupConfirmed=true、Electron/native=false；typecheck通过。首次修后主动最后TEST按钮不存在30秒超时已保留，改用既有主动生成按钮重放；Standards提出聚合catch可能吞收尾错误的硬P2，改为仅捕获页面回调失败，完整收尾失败直接停止且未确认清理不启动下一场，最终限定hard0/Fowler0、Spec0。仅合成资料与受控模型，没有App、OCR、真实聊天、额外模型或人工验收；本切片不关闭完整票和连续生命周期依赖。
