# 03：换组、推荐与暂不回应

State: resolved
Triage: ready-for-agent
Blocked by: [conversation-reply-strategy/02 理解、纠正与方向确认闭环](02-understanding-and-direction.md)

拆分标识：R03（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧01；Q23、Q25、Q26、Q30、Q32。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-043](../../../architecture/adr/043-conversation-scenarios-and-direction-exploration.md)。依赖是完整交付的前置；实际实施结果与未执行项见本票 State 和 Answer。

## What to build

用户可换方向组或自己填写，系统可说明推荐但不预选；选择晚点回复得到不生成候选的有效结果。

## Acceptance criteria

- [x] 用户能换一组不同意愿、自行填写方向，推荐可说明依据但不预选；背景不足不强行推荐。
- [x] 换组后旧组不能误选，已有习惯不排除合理立场；输入版本改变使旧结果失效。
- [x] 暂不回应是有效结果，不强制候选、不创建提醒或定时发送，不继续自动联系。
- [x] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [x] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

已有背景不排除合理立场；暂不回应不建定时任务，旧组失效不能误选。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11 公开后端接续：换组以新操作键接续同A会话，重复意愿组拒绝发布，新组旧选择不可确认；明确暂停后旧问题拒绝，未选用户任务最多3次自动更新，原15分钟期限不重置。均进入真实HTTP/正式052 PG反例，未创建提醒或发送能力。页面换组、暂停及生命周期组合仍待接，票保持claimed；自动更新存储守卫不替代R09公开活跃任务验收。

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

2026-10-11 既有B接续：总协调确认本会话为01–11唯一负责人；消费备用B冻结快照中的探索契约与静态模型适配。先补受控模型边界与方向换组/暂停证据，再消费A051真实输入权威；不发布第二套会话存储。尚未完成公开页面或组合验证。

2026-10-11 基础切片：结构化输出拒绝无引用推荐、未知引用、普通细节澄清及原组含空白的重复；暂停只返回未选选项，不创建候选或提醒。运行时只绑定一个输出Tool，强制出站元数据台账，宿主调用前停止不记录实际调用。探索运行时9项＋Skill选择11项共20项通过，两轴限定复审0问题。此切片未公开装配，A051持久版本、暂停动作及公开页面仍待接线；State保持claimed。

## Answer

2026-10-11 自主范围实际交付：沿已正式接入的UUID探索链，两场公开页面均能换另一组不同意愿，当前未确认状态不预选；新A输入版本取代旧组，原旧suggestion/UUID提交真实HTTP409。选择“本次先停下”只结束探索，不生成候选（两次探索模型调用保持2），重读原暂停结果409；用户重新自行填写明确方向或主动目的后沿原普通生成得到候选，总模型调用3。回应普通请求保留正式 `direction_source=direct_input`。没有创建提醒、定时任务或外部发送接口。

实际命令为显式Conda NotAlone内 `npm run test:pages -- --case reply-strategy-transition --case reply-strategy-options --timeout-seconds 180`，session51180 exit0，options回应/主动两场全部到达，真实HTTP/正式001–053随机PG，quiet33/active0/onscreen0、单Chrome、cleanupConfirmed=true、Electron/native=false。首窗口只在回应末尾把direct_input误期待旧direct，属于TEST契约错误，主动和后续case未到达；第二旧预约exit2 app_test_locked未启动浏览器，这两项历史不改记产品RED或GREEN。仅修期望后上述完整原断言通过。拆出尚未执行的R06 confirmed-clarification独立文件不改变R03断言，typecheck通过。

已有结构化输出/范围/来源负例证据继续有效：无引用推荐、未知引用和重复方向均拒绝发布，不足背景不强制推荐，暂停不创建候选。新TEST只控制合成输出并仍经真实production validator；不提供测试业务快捷路径。数据只属于本轮合成owner/contact隔离库，探索与方向按既有TTL/删除路径保存，不写长期偏好，已确认夹具完整清理。

本票自主路径已完成，最终状态与原验收勾选等待R02正式公开UUID整组收尾；R06、R07及A关闭/退出/连续修改不据此关闭。真实模型语义、原生App、剪贴板及人工验收未执行，按用户本轮范围跳过，没有读取微信/OCR、真实聊天或调用额外模型。

本主题最终限定两轴Spec0、Standards hard0/Fowler0；只读审查没有冒充页面运行。本地提交仅含R03 TEST、登记、夹具输出扩展与本票记录。

总协调主树正式消费 `6dcd64e0fbe209410d9abe8f483c9c18a5300407` 后，保留主树原完整页面名单和门禁，只合并本票登记。实际命令为 Conda `NotAlone`、关闭 dotenv／追踪、`PGHOST=/tmp PGPORT=5432 npm run test:pages -- --case reply-strategy-options --timeout-seconds 180`：公开回应和主动两场的原换组、新 UUID／旧确认 409、暂停无生成、自填意愿及 `direct_input` 断言全部到达，exit0。quiet16、active0、onscreen0、单 Chrome、cleanupConfirmed=true，Electron/native=false；仅本轮合成隔离数据库。类型与差异检查通过，限定复审 Standards 硬要求 0／重要气味 0、Spec 0。根树自动集成完成本切片，整票状态仍按上文的未完成依赖保留，人工部分未执行。


2026-10-11 最终任务核对：R02原六场UUID及入口已经各自实际通过并正式 `46e6af7393cd18dea9a0907007af65277d8b6c38` 自动范围resolved，R03前置现满足。R03沿正式 `6dcd64e0fbe209410d9abe8f483c9c18a5300407` 与已运行51180两场options证据完成原全部可自主执行标准：换组新UUID／旧选择409、推荐不预选、无依据推荐及重复意愿由真实validator拒绝、自填明确方向或目的后生成、暂停0生成且无提醒／发送能力。R02正式六场补全范围、来源删除、迟到及原根TTL共同契约，不替代R09任务活跃生命周期。

本次只修改本票状态、原勾选及事实记录，原标准文字和历史失败记录保留；没有新业务变化，不重复启动已通过页面。51180与对应两轴的实际命令／资源和数据影响见本票Answer，root2591另有两场独立复验，不冒作本B执行。最终文档Spec为0项P0–P2、Standards硬问题及新增重要Fowler问题为0，本票State resolved只指可自主执行范围；真实模型语义、真实App／原生及人工验收按本轮范围跳过，R08–R11与A/C剩余不会据此预关闭。
