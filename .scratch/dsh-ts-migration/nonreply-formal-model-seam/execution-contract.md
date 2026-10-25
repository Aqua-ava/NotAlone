# FormalExecutor 接缝

用户已明确约定测试边界：根注入许可、同问题持久预算及受控供应商端口；发送前重核源码、服务端来源、范围、版本、租约、取消与实际请求。最小验证是一对非空提取及预算拒绝。此文件记录该已授权接缝，不另要求确认。

`FormalExecutor` 默认离线。CLI 只提供 `plan` / `preflight`；执行只能通过根在内存中注入的 `permission`、`budget`、`supplier`、`business`、`source` 端口。没有 real CLI、环境开关、密钥读取或默认外部 transport。`loopback_fake` 是证据属性，不是许可。

唯一问题额度预留责任为外层 broker。内层仍执行产品 PG/ModelHost 调用记账、来源、租约及输入容量守卫，但不得再绑定诊断问题账本。broker 的绑定来自可信启动环境和已核验源码，拒绝依赖请求正文中的 `budgetBound` 等自报字段。每个物理请求先做唯一持久 reserve，取得当前 ACK，再复核；失败、未知、预留后异常均不退款。重试必须重新进入 broker。

根持久预算端口 `reserve(binding)` / `ack(reservation)` 共用同一问题、两臂、所有尝试及有限绝对 deadline。本目录 `bindExistingProblemBudget` 只绑定既有账本，复用已验证的 reply bridge，不创建、清空或扩额；合成测试另行创建带 synthetic 名称的 SQLite。全局 deadline 与消息／评测时间完全分离。

`supplier.send({request, binding, reservation, beforeWrite, signal})` 必须在实际 socket 写入前调用并等待一次 `beforeWrite()`，并将返回的单次 capability 原样放入返回值 `send_ack`。capability 仅此闭包可产生；旧 ACK、跨请求 ACK、没有 ACK、复用调用均拒绝。根端口负责对实际传输的 raw 字节做相同 hash 校验、禁重试和 redirect；该端口属于可信计算边界，恶意端口不能由 JavaScript 接口变成网络沙箱。

实际签名为 `supplier.validate({request,binding})` 在 reserve **之前**验证最终 header、路径与结构；`beforeWrite(actualRaw)` 再核实际字节。返回值必须有 `physical_attempted:true`，授权后异常的真实物理状态保持 unknown。首次失败锁住本逻辑运行的后续出站，后来的内部到达仍记录，但不再 reserve/send；这不冒充产品内部恢复循环已经关闭。

`business.open(run)` 返回已固定的业务 session：`assertCurrent()` 从服务端 PG 取得范围、来源版本和任务租约；`run(dispatch,signal)` 的每次模型 HTTP 均经 broker；`close()` 负责收尾。正式端口还必须返回实际 profile、ModelHost、职责flags、来源清单与可信启动环境证据。本目录最小业务适配首先接提取公开合同；不把测试私有 handler 或假输出当正式生产宿主完成证明。

原冻结计划保留 1056 非回复及 1152 统一分母。选择最小成对集合只改变 `not_run` 状态，不缩分母。正式语义资格、完整矩阵、独立盲审均另列。提取消息锚点与 Skill 时钟资格默认关闭；即使供应商已获许可，也不能自动打开时间资格。

2026-10-25 根转达人类决定：输出容量及费用不作阻塞、停止或验收门槛。历史 4096 只作为原 pin 的实际配置记录，不硬编码为接缝要求；后续两臂统一实际控制随根的新完整 commit 固定。实际 tokens、费用、失败及累计调用仍记录；不因暂豁免推断供应商硬上限，不变更历史材料、oracle 或历史结果。

根后续明确授权的生产增量仅为 `HostReplyOptions.extractionRetryPolicy` → `ExtractionBatchService.Options` → 原 Flow 的 `max_retries/retry_delay_ms`。评测内部构造时设 `{maxRetries:0,retryDelayMs:0}`；省略仍沿原默认5/30000，无新HTTP或用户env开关。故障回归已实际观测新E1/V0、will_retry=false、失败PG记账1。精确SHA另列 `production-patch-manifest.json`，原4f89行为及used4失败保留。

真实端口与其余域仍由根完成：内置 `extractionBusiness` 只实现一对提取；L2/L3/Skill必须提供具名业务适配。旧 reply `vendor-forward.mjs` 的现成relay只允许两个官方端点，不含 Beta strict；不能将其未经适配用于strict。产品 `model-provider.ts` 的 ordinary/strict 来源/许可守卫均已保留在 broker 上游。根须注入经过审核的两种供应商发送端口，不能凭接口存在称为已完成真实transport。

`bindExistingProblemBudget` 继承旧bridge的有界当前round合同，拒绝过期或continuations。需要继续同一过期问题时必须由根按已授权续期提供正确端口；本目录不新建真实账本或重置used。CLI `preflight` 缺端口返回2；执行不通过CLI开放。
