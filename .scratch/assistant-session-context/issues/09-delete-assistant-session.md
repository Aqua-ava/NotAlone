# 09：用户删除一段助手会话

State: claimed
Triage: ready-for-agent
Blocked by: [assistant-session-context/07 默认会话的一次生成与可靠保存](07-default-session-persistence.md)

拆分标识：C03（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧01；Q10、Q18。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)、[ADR-044](../../../architecture/adr/044-explicit-style-sample-retention.md)。依赖是完整交付的前置，不代表这些前置已完成；本票尚未实现。

## What to build

用户在当前会话主动删除讨论及使用痕迹，再次读取失败，独立微信资料与关系记忆仍保留。

## Acceptance criteria

- [ ] 用户确认后删除当前助手会话，讨论、候选、使用痕迹和恢复副本不可再读；独立微信来源与关系记忆保留。
- [ ] 重复删除幂等，部分失败可重试；删除期间生成返回不能复活会话，完成以不可读取验证为准。
- [ ] 按ADR-044保留用户已主动保存的独立表达样本，删除确认说明独立样本仍保留及其删除入口，不保留该会话的隐藏讨论副本；样本仍受原始聊天来源删除约束。
- [ ] 本票实现会话清除规则；样本管理接入后的真实业务存储组合验证归E06，不因E04尚未交付而伪报样本场景已通过。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

包含确认、重复删除、失败重试及正在生成时删除的失效检查；实际新增副本均不可恢复，不等待最终验收补安全。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

## Answer

2026-10-11：基础实现与页面闭环已验证，双轴审查发现下列组合缺口正在修复；本票仍为 claimed。自动证据仅来自合成模型、真实 HTTP／隔离 PostgreSQL 和生产页面的受控宿主；人工部分未执行，不等于真实 App 生命周期验收。

- `DELETE /api/contacts/{contact_id}/assistant-sessions/{session_id}` 只接受 `{"confirmed":true}`。在同一 owner 锁及事务中清除助手输入、turn、回复请求与候选及传递派生内容，为 reserve-only／failed／running 请求留下无正文旧键失效凭证。删除失败整体回滚；重复删除返回 404，界面只在同范围、同连接、同确切会话 GET 确认 404 后完成清除，读取失败可重试。
- 删除后停止当前投影的等待、读取和候选缓存，清除草稿、方向、目的及本次选项；迟到结果和旧请求不能复活讨论。明确清除序号与默认选项在同一状态发布，普通状态回显不覆盖正在编辑的文字；切换联系人、新会话或连接后的输入不受旧删除结果影响。
- 确认文案说明独立微信资料、关系记忆和用户已主动保存的表达样本仍保留，并提供实际样本管理入口。按 ADR-044 保留样本，不用样本保留会话全文或恢复讨论；原始来源删除仍由 C 的中央删除路径负责清理相关样本和派生内容。本票不新建含正文 schema，不依赖未交付的 11／讨论 helper，也不直接访问 053 版本表。

实际验证均在 Conda `NotAlone`，关闭 dotenv 与外部追踪：

```bash
PGPORT=55441 python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-a-session tests.integration.persistence.test_explored_generation tests.integration.server.test_assistant_session_deletion tests.integration.server.test_reply_message_groups tests.integration.server.test_core_business_flow
npm run typecheck
PGHOST=/tmp PGPORT=55441 npm run test:pages -- --case assistant-session-deletion --timeout-seconds 180
PGHOST=/tmp PGPORT=55441 npm run test:pages -- --case assistant-session-deletion-faults --case assistant-session-deletion-lifecycle --timeout-seconds 240
```

- 12 项专属后端删除测试通过，覆盖确认、范围、独立资料／样本保留、运行中与 reserve-only 删除、旧键重放、传递派生、rollback 与失败重试。主 Agent 最近组合回归共 23 项 GREEN／19.649 秒，生产 runner 安装真实正式 001–053，自有测试库残留 0；001–053 是实际测试版本，不代表本票使用 053 接口。
- 首次公开页面得到缺删除按钮的 RED；接线后在草稿清空断言得到 RED，补明确草稿清除序号后基础一场 GREEN，quiet 9／active 0／onscreen 0、单 Chrome、收尾确认。
- 后续两 case 首次在「删除传输失败保留输入，实际仍可读时只允许重试」的重试完成后得到本次要求残留 RED，其他七场未到达。保留原断言，补回复输入清除序号后重跑，3 项故障场景和 5 项生命周期场景全部到达 GREEN：DELETE 失败保留与重试、DELETE 成功但复核失败、已外部删除 404 幂等及严格参数拒绝、生成中删除且迟到结果／旧键拒绝、已保存响应迟到、跨联系人／同联系人新会话／连接变化的旧复核不清新输入。重连和受控宿主重建无旧讨论缓存，独立 raw／消息／记忆／显式样本保持，零额外模型调用。最终 quiet 54／active 0／onscreen 0、单 Chrome、`cleanupConfirmed=true`。
- 所有页面由总协调独占 OS 用户租约串行执行，Electron/native 均为 false。类型与差异检查通过；没有运行真实 App、微信、OCR、外部模型或 19，没有使用私人聊天、push、发布或部署。完整自主目标继续 10–18；本票不能作为持续目标结束。

提交前双轴首次审查：Standards 硬要求 1、判断性气味 1；Spec 3。实际缺口为跨会话继续候选但仅 reserve 成功／request INSERT 失败时遗留派生输入，以及未主动保存的候选粘贴副本、同联系人新默认会话继承旧删除提示。第 13 项公开 HTTP 回归已取得 DELETE 父会话后子 turn 仍为 failed 的真实 RED，正在修复，不把前述 8 场页面 GREEN 当作该组合已覆盖。注册列表重复为沿用既有父／子两端安全门禁的判断性气味，本票保留门禁，不据此扩大为整套测试调度重构。

回归审计还发现原测试用 `/api/replies` 验证全局旧键，仅得到不存在路径的 404；这一点不能作为全局生成拒绝证据。实际全局入口是 `/api/reply/generate`。专属后端及生命周期测试已纠正路径：删除前合法同输入重放 200、候选和模型次数不变；删除后按既有全局接口精确拒绝为 500 `reply_generation_failed`，模型次数不增加，没有为迁就断言改全局业务。原助手会话入口和新默认会话的旧键拒绝证据不受影响。整票尚未完成前不宣称自动部分完成。

后端审查修复已完成独立切片：第 13 项公开 HTTP 先得到 reserved 子 turn 未清除的真实 RED／0.946 秒；同 owner/contact 候选谱系定位 request 尚未存在的后继 turn，写无正文旧键，复用可选 `turn_ids` 清除并复验空正文后，13 项专属 GREEN／9.994 秒。最近完整相关命令仍为上列四模块，共 24 项 GREEN／20.142 秒，正式 001–053、自有库残留 0；另外确认专属删除库残留 0。限定后端及通知端口复审 Standards 硬要求／新增气味 0、Spec 0，原 P1 闭合；整票另两项 UI P2 仍未关闭。

通知类型已独立提交 `2cd7810bf3299a3f7d2422718edd4d9aab9c6ee7`，仅五个 readonly 身份／版本字段及可选 `ReplySessionState.confirmedSessionDeletion`，无正文、无执行动作。生产者仍属于后续 09 前端主题，只有原确切会话 GET 404 且 contact/scope/connection/pending 仍匹配后才同次发布，C 按新 revision 清理关联的未保存样本编辑及来历；已保存样本、列表样本复制和无关手写保留。接口类型不能冒充生产者已正式交付。
