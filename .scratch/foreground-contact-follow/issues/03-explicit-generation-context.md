# 03：显式生成与固定上下文

State: resolved
Triage: ready-for-agent
Blocked by: None

## 交付行为

只有用户明确点击生成操作才提交候选回复任务；请求在取得有效准备回执时固定发起联系人的助手会话、输入版本和有界回复上下文。准备完成后即使切换、编辑或收到新消息，原任务也不能改用后来的界面输入或消息。

本票可在现有单联系人入口独立验证；多联系人有限调度及状态展示由 05 接续。

## 验收条件

- [x] 打开助手、快捷键唤出、定位成功、联系人/助手会话切换、内容恢复和消息事件都不创建候选回复任务。
- [x] 单独确认联系人或方向只更新确认/输入；方向探索、纠正和回答不隐式生成候选。已有会生成的“结合新消息继续”等入口明确表达其生成含义。
- [x] 联系人、方向、预算、资料范围和授权校验通过后，才接受生成并取得可靠准备回执；无法固定材料时明确失败，不虚报已排队。
- [x] 准备回执对应固定的 owner/contact、助手会话、输入版本、请求身份与有界上下文；准备后再执行不得重新读取当前页面决定原请求输入。
- [x] 后来的新消息不进入原生成的初始上下文或后续补查，不使请求自动替换/重启；只保留同联系人“尚未结合新消息”提示，用户明确重新生成才取得新材料。
- [x] 后续只读补查使用原任务的有效资料范围和既有预算；不复制完整历史，也不能用固定快照绕过来源删除、授权撤销、Skill 失效和提交前后版本复验。
- [x] 同键同输入重放可靠结果，不重复请求/候选或模型调用；同键不同输入报冲突，显式替换及失败重试沿用原有身份与失效规则。
- [x] 原任务和新任务的上下文及依据可分别回看，候选不自动发送，旧任务结果不能覆盖不同联系人或新的有效请求。

## 测试与完成条件

使用生产桌面公开生成操作、认证 HTTP 和隔离 PostgreSQL；可控模型在准备、执行和返回处形成可观察的延迟。验证准备 → 新消息/编辑/切换 → 执行仍使用原输入及范围，再显式生成使用新材料；核对原/新依据、模型调用次数、幂等冲突和来源失效。

复用现有准备、请求、上下文和生成归属接缝，不另建通用队列或 Worker 步骤。每条已有生成入口都要验证其明确触发语义，不能只改按钮文字。在 `## Answer` 记录最小相关验证、数据影响及剩余风险后改为 `resolved`；真实 App 和自然语言质量由各自证据另行区分。

## 依据

- [功能规格](../spec.md)：生成调度与固定输入；用户故事 19、22–23、25、27。
- [持续助手会话规格](../../assistant-session-context/spec.md)、[ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)、[ADR-050](../../../architecture/adr/050-continuous-single-frame-contact-follow.md)。
- [领域语言](../../../CONTEXT.md)、[领域读取路由](../../../docs/agents/domain.md)、[工程工作流](../../../docs/agents/engineering.md)。

## Comments

## Answer

实现分支：`codex/explicit-generation-context`。

- 方向确认、纠正和澄清回答只更新探索／输入，公开 HTTP 默认不生成；候选生成明确携带 `generate: true`。桌面“结合新消息”入口标明重新生成，已选建议保留原建议身份。
- 准备回执返回前完成现有联系人、授权、资料、方向与预算检查；预算预检在真实模型 handler 前停止，执行仍逐轮计量。固定原会话、输入和请求下的有界初始材料及历史补查范围，后来消息不能进入原生成；显式新请求可以取得新材料。
- 已完成请求和已有固定材料的失败请求重放原身份；首次预检失败且无固定材料的同键重试必须补齐准备。准备阶段业务拒绝也收尾为 failed，不留下虚假 running。
- 迁移 058 增加所属轮次的 `prepared_context` JSONB。只保存既有有界初始正文及最近 500 条有效来源消息 ID 与初始消息证据 ID 的并集，不复制完整历史；不能承诺任意旧消息都可补查。旧讨论、证据和样本的删除依赖一并登记，输入失效／删除清空固定副本。授权、Skill、版本与来源仍在执行和提交时复验。
- 只使用合成模型、认证回环 HTTP、随机隔离 PostgreSQL；001–058 全新迁移及重复零应用已验证，测试库清理核验为零遗留。未启动真实 App、原生采集或微信，未发送外部消息，未调用外部模型。

### 验证

桌面使用生产 Main/preload 公开桥，后端保持正式装配。执行命令在 `desktop/`：
- `npm test`：类型检查及 44 项安全调度／CLI 合成回归通过。
- `node --test tests/contact-content-restore-http.test.mjs`：17 项通过。
- `node --test tests/assistant-generation-ownership-http.test.mjs`：31 项通过。
- `node --test tests/assistant-input-budget-public.test.mjs tests/assistant-input-budget-approximate-public.test.mjs`：31 项通过。
- 四组 `reply-strategy-{preparation-proof,preparation-retry-ack,clarification-confirm,skill-switch}-http.test.mjs`：10 项通过。并行负载曾使两项 5 秒断言失败，保留原门槛按 `--test-concurrency=1` 重跑对应文件，5 项全部通过；此耗时不作实机性能证据。

后端在 Conda `NotAlone` 下显式设置 `PYTHONPATH=backend/src:backend`，避免 editable 安装指向其他工作树：
- 六组公开探索／准备集成回归共 59 项已逐组通过（包含新增授权预检拒绝不得留下 running）；准备生命周期最终集中重跑 23 项全部通过。
- 新增固定上下文回归曾复现确认自动生成、新消息进入旧初始上下文、首次预检失败同键重试漏固定等反例，按 red → green 修复。
- `node --test tests/explicit-generation-context-http.test.mjs tests/assistant-input-budget-public.test.mjs` 最终 38 项通过，其中固定上下文专属 8 项，所有测试无跳过；同键重试漏固定的反例已转绿。
- 合入最新主线兼容后，`PYTHONPATH=backend/src:backend python -m unittest discover -s backend/tests/unit -t backend -q`：1,326 项全部通过；固定上下文专属 HTTP 8 项再次通过。
- Standards：0 项未解决；Spec：0 项未解决。

### 评审与范围

Standards 与 Spec 分别评审。已修复普通历史查询漏加固定 ID 过滤、旧讨论副本遗漏删除依赖，以及无快照 failed 回执绕过准备三处发现。任务 05 继续负责多联系人有限调度和任务状态扩展；任务 04、06 的持续跟随及正式 App 组合验收不由本票代替。
