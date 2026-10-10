# 07：Skill探索、确认与生成的版本延续

State: claimed
Triage: ready-for-agent
Blocked by: [conversation-reply-strategy/02 理解、纠正与方向确认闭环](02-understanding-and-direction.md)

拆分标识：R07（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧03；Q16–Q22、ADR-043。 第二版标识为R06。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-043](../../../architecture/adr/043-conversation-scenarios-and-direction-exploration.md)。依赖是完整交付的前置，不代表这些前置已完成；本票尚未实现。

## What to build

启用的有效场景Skill辅助理解和方向，显示实际版本并可关闭或更换；从探索、确认到候选生成沿用同一有效选择，无匹配或明确关闭时仍可走通通用流程。

## Acceptance criteria

- [ ] 最多选用一个已启用、范围有效的不可变Skill版本，展示实际名称/版本；无匹配使用通用流程。
- [ ] 从探索到方向确认再到生成沿用同一有效版本；明确关闭后生成不能退回自动选回，更换后旧策略结果失效。
- [ ] 库revision变化、禁用或删除使旧目录与结果失效；提交与恢复都不得带回旧正文或两个版本的混合上下文。
- [ ] 方向探索只加载受控静态内容，无业务Tool补查、外部查询或扩权；只用合成包，不创作具体邀约Skill。
- [ ] 方向探索不接入表达样本；样本引用实现后的跨规格实际载荷验证由E06完成。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

至多一个版本，库revision/删除使旧结果失效；无业务Tool补查或扩权。只用合成包，不创作邀约Skill。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11 公开后端接续：真实合成Skill包经静态read_file Tool加载，探索固定一个不可变版本并在确认后的原生成链使用同版本；明确disabled两段均NoSkill、不能auto回退。目录变更拒绝旧读取/选择，用户明确关闭并刷新时保留原已选意愿。新增模型前与实际保存边界revision竞态反例均先RED后GREEN，拒绝时候选0。探索未装配表达样本port；E06组合载荷与A12正式总预算仍待接，页面版本展示/更换亦未执行，票保持claimed。

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

2026-10-11 既有B接续：静态选择模块按既有SkillPort读取最多一个版本，以validate_skill_version核对启用、owner/contact和不可变目录身份；明确关闭/无匹配都返回NoSkill，旧指定版本不回退。跨范围目录和正文两次red→green、6项受控模块验证通过。完整探索→确认→生成及库revision失效路径待A051/B052实际接线与公开页面；未标验收通过。

2026-10-11 基础切片补充：auto仅在服务端已核验主要沟通场景时精确匹配applicable_scenes，入口类型和描述文字不能代替任务识别；未知任务使用NoSkill。显式user固定实际版本，非user禁止携带版本。相关20项模块测试通过，两轴限定复审0问题；尚未完成探索→确认→生成或库revision的真实公开闭环，保留原验收项。

2026-10-11 持久UUID前端核心切片：公开页面关闭Skill后完成两场探索及确认，再次普通生成HTTP均保持skill_disabled=true；请求快照固定实际版本或NoSkill，UI自动／指定／关闭偏好分别保存。普通生成丢关闭选择P2已公开RED→GREEN。实际版本选择／更换／revision页面与A12探索总预算仍待接，保持claimed。 真实命令、五场控制／隔离证据与数据影响见[R02本次页面记录](02-understanding-and-direction.md)；非真人或原生验收，原标准保持。
2026-10-11 探索完整请求预算：正式A12接口已消费为c6a9381，B只在原单次探索SDK适配器构造最终ModelRequest并调用同一require_request；包含system、完整输入与静态Skill、唯一输出工具schema、最终参数和供应商framing，实际输出预留绑定到调用。移除旧24000字符的假总预算。能力或绑定计量未知时不调用模型；错误公开409与共同纯元数据，不带正文。

TDD未知能力原行为仍调用模型，首1项真实RED；公共守卫接线后新5＋原9探索单元14通过。预算错误原被通用503遮蔽，两场HTTP先RED后改为共同metadata，最小1项两场通过。最终52相关HTTP/正式001–053随机PG通过（49.670s，owned database remaining=0），含新3预算HTTP、21持久探索、原原子/存储及C五个样本/Skill组合；273完整回复单元通过（1.766s）。新测试逐项比较完整计量请求与实际调用参数，覆盖输出预留、温和提醒、每次变输入重查、不同模型counter、参数绕过、完整静态Skill超限前0调用。

Context7在本环境未提供，转查官方ModelRequest文档并核对实际Conda版本（LangChain1.3.15/core1.5.5/openai1.5.1/deepseek1.1.0）。两轴静态Spec0/Standards hard0；1条未知profile默认构造重复P3接受保留，B不擅改A公共预算工厂，两个适配器默认均拒绝且受反例覆盖。上述只证明显式合成协议，不当真实供应商计量、自然语言质量或A12整票完成。公开页面接共同guard复验、实际Skill更换/revision仍继续，票保持claimed。
共同guard公开回归实际完成：Conda NotAlone中 `npm run test:pages -- --case reply-strategy-dialogue --case conversation-strategy-entry --timeout-seconds 240` 全部通过，前者回应与主动21完整来源闭环、后者明确主动目的／原入口切换／待确认依据及持久重读均到达。quiet26/active0/onscreen0、单Chrome、cleanupConfirmed=true、Electron/native=false；本轮测试处理合成资料，真实供应商模型及人工验收未执行。完整Skill版本选择／更换／revision公开用例继续接续，预算这批结果不替代那些验收项。


2026-10-11 总协调实际复验正式47完整探索预算：273回复单元GREEN（1.792s）、30实际HTTP／001–053隔离PG GREEN（37.655s）／自有库0，type通过。新旧普通／探索转换与明确主动入口两labels180公开exit0，实际NoSkill延续与同键0调用；quiet26／cleanuptrue，无原生App或外部模型。预算装配保留A共同守卫、C生成接口，unknown仍失败关闭。限定两轴0；完整实际Skill版本更换和历史／连续生命周期仍未以本切片通过。
