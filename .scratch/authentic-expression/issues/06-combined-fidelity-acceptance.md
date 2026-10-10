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

### 总协调独立保留测试的正式前置反例（2026-10-11）

仅测试主题 `d3c3595b25a2684ea951845d35f84e520108ca12` 原样接入主树后，在实际001–053随机隔离库执行source场，真实生成、candidate及manual显式保存、A turn正文正向检查均已到达；A09 DELETE仍返回404、期望200，1项实际RED（1.160s），模型仅1次，自有库remaining=0。删除后的独立保留及传递清理尚未到达，不记GREEN；原断言及本票claimed保持。该结果与C此前正式52下404分别保留，等待A09正式删除后端接入再运行两场，不新增另一删除器。

2026-10-11 总协调首轮公开恢复组合：root单case180秒，样本删除场完整通过；原始来源删除场等待manager“选择合成联系人甲”30000ms超时，exit1，未到达断言不标通过。quiet64/active0/onscreen0、单Chrome、cleanupConfirmed=true、Electron/native=false。已交C定位关系页面后的真实联系人导航，原正文/来源/UUID/模型次数断言保持。两入口冲突只新增case及分派，两轴限定0；typecheck通过，CLI首次受sandbox租约写权限限制5/10失败，授权权限复验10/10通过。不是原生或进程重启证据，任务仍claimed。

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

恢复组合页面接续：正式A08已消费为`57735a8`，B三声明薄字段为`dd62af9`。新增具名`authentic-expression-recovery`：在实际公开页面保存独立草稿讨论，显式保存手工样本或有原始来源的候选样本，再以当前拒绝目的生成并核对实际样本载荷／回执。删除样本或通过公开来源管理删除原始来源后，核对旧键、继续和依据拒绝，独立旧键重读保留；断线重连及重新装配后端实例／页面宿主均只恢复独立讨论，相关turn无input/reply，模型不额外调用。

该TEST切片尚未执行页面，不预填GREEN；最小串行预约命令为desktop内`npm run test:pages -- --case authentic-expression-recovery --timeout-seconds 180`，沿原单Chrome/inline范围/nonce/租约门禁，只替受控模型和必要连接生命周期。`restart`只重新装配同一Python夹具中的后端，不称进程重启、退出验收或真实App。A09会话删除、B公开探索/消息组和A12总预算仍待正式依赖。

三项单次声明组合接续：正式B基础／候选组／052已顺序消费至`75c5eb2`，无第二schema。新增回应、主动各一条真实HTTP场景，每场三次实际调用；非空understanding_correction、user_instruction、clarification_answer与当前意图分别传递，表达样本仍独立低权重、不能成为引用事实。沿候选继续时调整表达要求而保留拒绝；A持久输入重读保留各轮字段，同键改澄清答案409且不增调用；删除样本后三轮声明、输入和候选均擦除。原不带声明的六例及报告独立保留。

实际命令：Conda NotAlone/backend内`PGHOST=/tmp NOTALONE_DISABLE_DOTENV=1 LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false PYTHONPATH=src NOTALONE_DECLARED_COMBINED_FIDELITY_CAPTURE=../desktop/artifacts/headless-pages/authentic-declared-combination-http-observations.json python -m unittest tests.integration.server.test_authentic_expression_scenarios tests.integration.server.test_authentic_expression_combination tests.integration.server.test_style_reference_api tests.integration.server.test_exploration_generation_fields tests.integration.server.test_reply_message_groups -q`，先回应新增单例1项green，再联跑17项全green／无skip。231完整reply unit亦green；正式生产001–052重复安装及052存储／升级15项真实PG组件另以随机短名_test库运行，全green、skip0，精确清理owned_database_remaining=0。样本删除竞态的既有租约失效诊断保留，原拒绝／候选0断言不弱化。

唯一E01入口生成新`docs/evaluations/authentic-expression-declared-combination-http-v1.json`，6次实际调用／792.018542ms，结构失败0、独立synthetic_fixture故意保真失败2、真人0／qualityfalse，三项真实质量维度未知；评价及期望没有进入模型。六个实际payload／system／完整输出／UUID和各轮计量保留。此报告覆盖单次声明、样本和基础候选继续，不声称已组合B完整消息组、公开探索Skill、A09或A12。`aed5517`事务hook依赖原B最小建议引用类型，当前树缺该正式前置，未完成cherry已撤销，等待B公开UUID正式切片再接，不引入旧INT公开API。

限定Spec发现持久三轮重读仅zip可能漏检缺轮；已补完整轮数、输入版本和reply_request_id对应断言，两个新场景再次实际green。该复跑不覆盖原六捕获，报告保持上述原始UUID／计量。Standards原主题hard0／smell0，Spec该问题修复后接续复核。

恢复TEST首轮已由总协调在root正式树`edfab2a`运行具名`authentic-expression-recovery`：样本删除场“删除样本后重连与重开保留独立讨论”完整通过；原始来源删除场在断线重连后仍停于“关系资料”，直接等待联系人选择按钮30000ms超时，整场未通过，后续重开断言不记GREEN。实际exit1、quiet64／active0／onscreen0、单Chrome、cleanupConfirmed=true，Electron／native=false；冻结已由总协调解除。最小测试修复只在共用联系人选择步骤先点击公开“联系人与绑定”导航，不改产品控制器，也不放宽正文遮挡、UUID／旧键／依据／继续或模型调用次数断言。修复后的公开GREEN仍待总协调串行复验。

A09独立保留TEST接续：新增`test_authentic_expression_session_deletion`的sample／source两条真实HTTP组合，沿A唯一助手会话删除入口，不实现另一删除器。预先显式保存有原始来源的candidate样本及独立manual样本；删除助手会话后重装后端、拒绝旧会话／回复／依据，检查持久输入正文与旧reply_request不可得，而样本仍可查看、同保存键重读并在新会话作为非事实表达参考。随后分别删candidate样本或原始来源，擦新会话派生输入／候选，独立manual样本保留。

首个source分支实际命令为Conda NotAlone／backend内`PGHOST=/tmp NOTALONE_DISABLE_DOTENV=1 LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false PYTHONPATH=src python -m unittest tests.integration.server.test_authentic_expression_session_deletion.AuthenticExpressionSessionDeletionTests.test_saved_samples_remain_usable_after_session_delete_then_raw_delete_erases_derivatives -q`；旧会话生成及两次显式保存均200，模型实际调用1次，DELETE助手会话期望200实际404，是本树尚未消费A09正式入口的RED。正式001–052随机隔离库精确清理；后续保留／再用／来源清理断言均未到达，不记通过。两条测试全部GREEN和公开页面组合仍待A正式主题，不复制其未提交产品代码，也不请求用户验收。

限定Spec指出还须核对真正生成正文所在的`assistant_session_turn.input_payload`，不能只查051输入索引的content。已增加删除前原turn正文存在的正向对照，以及删除后同owner/contact/session全部turn正文为空或行已删的只读断言。首source再次实际运行：正向对照通过，仍在DELETE404停止（1项failure／1.199秒），后续擦除结果尚未取得；原RED和预期保留。
