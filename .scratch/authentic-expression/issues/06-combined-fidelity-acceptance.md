# 06：跨场景保真、样本与删除组合验收

State: claimed
Triage: ready-for-agent
Blocked by: [authentic-expression/05 生成时有界引用表达样本](05-bounded-style-reference.md)；[conversation-reply-strategy/10 两种场景的连续修改与消息衔接](../../conversation-reply-strategy/issues/10-continuous-scenario-revision.md)；[assistant-session-context/08 重新连接后恢复已保存会话](../../assistant-session-context/issues/08-saved-session-recovery.md)；[assistant-session-context/09 用户删除一段助手会话](../../assistant-session-context/issues/09-delete-assistant-session.md)；[conversation-reply-strategy/07 Skill探索、确认与生成的版本延续](../../conversation-reply-strategy/issues/07-skill-version-continuity.md)

拆分标识：E06（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧04；第一版组合。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-044](../../../architecture/adr/044-explicit-style-sample-retention.md)。依赖是完整交付的前置，不代表这些前置已完成；本票尚未实现。

## What to build

在回应、主动、连续修改和消息组中验证样本保真与删除，覆盖重新连接恢复、Skill探索不带样本，以及删助手会话后主动保存样本独立保留的组合行为。

## Acceptance criteria

- [ ] 回应、主动、消息组及连续修改均覆盖样本冲突、整组承诺一致性、来源依赖和逐例报告；复用前票测试而不补造基础功能。
- [ ] 通过C02真实业务恢复入口验证：引用样本后删除样本或原始来源，再重连/重试/继续，不能取得已删内容，无关讨论保留。
- [ ] 通过R07验证存在样本且启用Skill时，方向探索实际模型输入不含样本；方向确认后生成才有界选取样本。
- [ ] 通过C03验证删助手会话后已主动保存样本仍可查看和使用，但旧讨论不可恢复；随后删除样本或其原始来源，样本及相关派生内容不可得。
- [ ] 交付离线报告和失败/未知说明，不等真实模型预算；无外部评测时明确语义与自然度未验证。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

不等真实模型预算才交付离线能力；没有外部评测时明示语义/自然度未验证，不将本票关闭解释为真实质量达标。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

## Answer（真实依赖逐步接续）

2026-10-11：已消费正式A051`7c97856`为本树`8c1cc57`，完整连续迁移与唯一current input UUID／同事务来源守卫保持，未复制A/B未提交实现。先增加正式助手HTTP的两条组合回归：删样本或实际后台删原始来源后，重新装配后端读取、同键和继续均不能恢复相关输入／候选／generation UUID，无关讨论保留；删样本仍保留独立原始来源active。第一来源单例已通过，随后联跑两个组合及原七个样本参考HTTP，9项全部通过、无skip；每类生产迁移器完整001–051，数据库精确DROP并核验不存在。原实现已满足本切片，不编造新RED或改产品来制造失败。

实际命令先激活Conda `NotAlone`，在backend执行`PGHOST=/tmp NOTALONE_DISABLE_DOTENV=1 LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false PYTHONPATH=src python -m unittest tests.integration.server.test_authentic_expression_combination tests.integration.server.test_style_reference_api -q`；只替受控模型，`dimension_release=None`。每条组合模型只调用1次，重新装配及删除后的拒绝均不增加调用。

以`8c1cc57`为固定点的两轴限定审查最终0；审查只读这两份切片文件，没有代执行页面或扩大验收范围。

该实例重建不冒充A08真实页面恢复或进程重启。A09会话删除、B07探索版本与B10连续修改／消息组、A12总预算尚未正式交付，本票不勾验收项，不以基础组件代替最终组合；这些剩余项等待实际依赖后继续，不请求用户实施或质量验收。无App、OCR、微信、外部模型或远端操作。

独立后端组合接续：新增`test_authentic_expression_scenarios`，回应和主动各三次真实助手HTTP：当前拒绝与旧答应样本冲突、沿已有候选继续改短句、合法结构但故意答应并增加时间地点／陪同的错误输出。每次都核对本次意图载荷、样本非事实回执、同键重读及调用次数；删样本后三轮输入／候选全部遮挡，旧键／依据／继续拒绝，没有额外模型调用。原候选继续接口的验证不代替B10两场景／消息组完整交付。

首个回应单例1项green，随后`PGHOST=/tmp NOTALONE_DISABLE_DOTENV=1 LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false PYTHONPATH=src NOTALONE_COMBINED_FIDELITY_CAPTURE=../desktop/artifacts/headless-pages/authentic-combination-http-observations.json python -m unittest tests.integration.server.test_authentic_expression_scenarios tests.integration.server.test_authentic_expression_combination tests.integration.server.test_style_reference_api -q`实际11项green、无skip，三类随机隔离库均执行正式001–051并精确清理。样本删除竞态期间有既有失败标记租约失效诊断，原拒绝和候选0断言仍通过；未放宽守卫。

唯一E01报告入口读取上述六个实际调用捕获，交付`docs/evaluations/authentic-expression-combination-http-v1.json`：6开发例，结构失败0，逐例独立synthetic_fixture保真故意失败2，真人0／qualityfalse，token及真实语义／自然度／关系适配／本人相似度未知。输入／system／输出／UUID和测量保留；评价字段未发送给模型。用例范围只包括当前正式基础继续链，Skill版本、澄清附加字段、完整消息组、A09删除和A12预算尚未被该报告覆盖。本票仍claimed，后续消费真实接口后补组合，不新增外部模型实验。

以`a1fab20`为固定点的六文件限定Standards／Spec最终均0，逐例核验6/6源捕获一致、实际payload没有评价字段、故意错误与未知维度均保留。该复审只读，不代替剩余真实依赖的自动集成。
