# 08：重新连接后恢复已保存会话

State: resolved
Triage: ready-for-agent
Blocked by: [assistant-session-context/07 默认会话的一次生成与可靠保存](07-default-session-persistence.md)

拆分标识：C02（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧01；Q4。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)。依赖是完整交付的前置，不代表这些前置已完成；本票实际状态与验证见 Answer。

## What to build

重新连接或重新打开应用后显示该联系人的已保存讨论与候选，不自动生成。

## Acceptance criteria

- [x] 断开后重新连接或重开时，通过同联系人公开入口显示已保存讨论及候选，模型调用数不增加。
- [x] 恢复前重新核验owner/contact、授权与来源；删除或失效内容不返回，读取失败可重试，不把缓存当有效结果。
- [x] 只恢复已保存结果，不自动重试未完成请求；退出中断的状态裁定由C10交付。
- [x] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [x] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

恢复前检查范围与来源；删除后不能恢复；只恢复已保存结果，运行中任务的退出判定由C10交付。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

## Answer

2026-10-11：自动部分完成，人工部分未执行。本票的 `resolved` 仅表示上述自动交付完成；受控宿主重建不等于真实 App 重开，原生生命周期及 19 未验收。

### 已实现范围

- 新连接重新选择已确认联系人时，从后端默认会话入口重新核验范围并读取已保存讨论与原候选；恢复只展示保存记录，不触发生成。
- 读取失败清空保存投影中的正文，提供「重试读取已保存讨论」按钮；只在用户重试时再次读取，不把旧缓存当有效结果。
- 未保存的草稿、表达方向、主动目的、临时选项、候选编辑及实际选择不会跨连接或跨启动带回。运行中记录仅显示尚未完成，不自动重试，也不在本票裁定退出中断。
- 保留既有 owner/contact、连接代次、来源删除与迟到读取门禁；通用历史 GET 的只读语义保持不变，重新选择后的自动恢复通过默认入口核验有效绑定。

### 已有真实证据

- 实现 Agent：`npm run typecheck` 通过；`git diff --check` 通过。未运行真实 App、普通页面或占用桌面测试租约，未创建提交。
- 主 Agent 执行 `PGHOST=/tmp PGPORT=55441 npm run test:pages -- --case assistant-session-recovery --timeout-seconds 180`：旧实现重连后无法显示已保存讨论，得到真实 RED；增加自动读取后同一场景 GREEN，断线重连及重建宿主后的模型调用总数仍为 1。GREEN 的静默观测 14 次，active/window 均为 0，单 Chrome，`cleanupConfirmed=true`。
- 主 Agent 执行 `PGHOST=/tmp PGPORT=55441 npm run test:pages -- --case assistant-session-recovery-guards --timeout-seconds 300`：前五个具名场景通过，覆盖迟到 GET 跨联系人、旧连接响应与来源失效、运行中记录不自动重试、实际来源删除与迟到读取及重开、默认恢复授权与跨 owner/contact 拒绝。这些场景覆盖已有门禁，不宣称新造 RED。
- 同一 guards 运行的第六场读取失败清正文通过，随后因专用重试按钮缺失得到预期真实 RED（exit 1）；本次观测 82 次，active/window 均为 0，单 Chrome，`cleanupConfirmed=true`。重试入口已补，尚待同场 GREEN。
- 总协调在相同冻结工作树串行复验 `assistant-session-recovery-guards`：六个具名场景全部通过，exit 0；静默观测 40 次，active/window 均为 0，单 Chrome，`cleanupConfirmed=true`，Electron/native 均未运行。随后 `assistant-session-persistence` 三场与 `draft-rewrite-session` 一场全部通过，exit 0；静默观测 28 次，active/window 均为 0，收尾确认。
- `directed-reply` 回归前两场通过，第三场目标来源撤回后界面把所有拒绝误称绑定失效，运行在提示断言处停止，因此本次 exit 1 如实保留。旧场景仍预期单次接口的 500；第一轮修复误将该情形仅按 `target_message_unavailable` 分类。测试保持精确拒绝分类、模型零调用和候选不可见，保留刷新及转草稿验收。该失败静默观测 25 次，active/window 均为 0，单 Chrome，收尾确认。
- 上述第一轮修复仅映射目标 ID 不存在，第二次 `directed-reply` 仍在第三场提示断言得到 RED。进一步核验消息仍存在而来源退出有效范围时返回 `source_unavailable`，故补齐这一已知安全分类；没有改写宿主的业务判定或泛化断言。第二次失败静默观测 25 次，active/window 均为 0，收尾确认。
- 第三次 `PGHOST=/tmp PGPORT=55441 npm run test:pages -- --case directed-reply --timeout-seconds 300` 实际 11 场全部 GREEN，exit 0。精确 `409 assistant_session_rejected/source_unavailable`、模型零调用、候选不可见、刷新及转草稿均通过；`no_active_binding` 仍显示原绑定提示。静默观测 85 次，active/window 均为 0，单 Chrome，收尾确认，Electron/native 均未运行。
- 最后复验 `assistant-session-recovery` 一场与 `assistant-session-recovery-guards` 六场全部 GREEN，exit 0；静默观测 50 次，active/window 均为 0，单 Chrome，收尾确认。上述受限页面均由总协调串行持有 OS 租约执行。
- 总协调在同一工作树执行 `npm test`：TypeScript 与安全 CLI 40/40，fail 0、skip 0、exit 0；仅合成 CLI 和静态核查，没有启动页面、浏览器、Electron、App 或探针。Standards 硬规范/气味 0，Spec 0；两轴独立只读审查最终未发现剩余问题。

所有 Python/页面准备使用已激活的 Conda `NotAlone`、合成模型和隔离 PostgreSQL；没有外部模型调用、真实微信读取或发送，没有迁移私人资料。

### 数据影响与剩余验证

本票不新增含正文存储结构；恢复读取沿用 07 的权威讨论、候选及来源依赖。首次选择有效联系人时可能创建该联系人的空默认会话，不保存未提交输入；正文不写入普通日志或控制计数。

恢复、相关页面回归、安全 CLI 与 Standards/Spec 双轴评审均已完成。自动部分完成，人工部分未执行。真实 App/原生生命周期留给后续受限验收，不能以页面结果代替；本轮按用户要求跳过 19，不启动真实 App、微信或 OCR。没有 push、发布或部署；继续 09–18，本票完成不是持续目标结束。
