# L2/L3 具名 driver 工程证据

两个 driver 已可执行并接入冻结 `FormalExecutor`。旧业务固定 `3c168296e9e8edaa43b8b323ff693e790e709069`，新业务固定 `e60074b5946b8d1c990fcb75ba13bd58f789b2fb`。生产依赖 30 份与初始 `9b20e99c771d87986579f4343c68bb743afe2bc4` 逐 SHA 相等；已知外部差异仅为评测报告器 `reply-comparison.ts` 的输出／费用策略更新，见 `source-audit.json`。

最终 e600 小型业务汇总是 `notalone-layered-evidence-MY7X4R-summary.json`。实际官方 SDK / DSH profile、生产 PG 存储、文档工具、独立来源核验与真实 ModelHost 均已运行；供应商严格为 localhost 机械回显。

| 工程场景 | 两域×双臂 | 实际 HTTP | PG job 预约 | 非空结果／取消结果 |
| --- | ---: | ---: | ---: | --- |
| 非空成功 pair | 4 个运行 | 24 | 24 | 各 1 场景、1 画像，保留引用版本 |
| HTTP 503 | 4 个运行 | 4 | 4 | 全失败、0 新场景／画像 |
| 持久取消后迟到写入 | 4 个运行 | 4 | 4 | 全取消、0 新场景／画像 |

该汇总 `HTTP=outer used=journal physical=32`，账本余 968。journal 为 responded 28 / failed 4 / unknown 0，失败没有退款。SDK 与业务重试均为 0，503 后无第二次请求；成功文档工具后续回合属于不同物理调用，均已记账。新臂共 16 条出站台账及 16 条 ModelHost 会计回执；旧原普通整理 transport 对应两者为 0，只保留旧 job 预约数与真实 ModelHost 许可桥，未补造生产回执。

最终守卫证据 `notalone-layered-evidence-eEN6ef-summary.json` 使用不同冻结 case ID，覆盖两域双臂的权限撤回、实际 PG 来源变更、租约代次推进，共 12 次探针。真实供应商 HTTP / outer 预约均为 0；来源／租约 8 项保留 failed，权限 4 项经 journal authority 保留 unknown。权限拒绝前内层已建立保守 PG 预约，因此不能把该预约冒充物理发送；原始失败、未发送及计数不匹配证据均保留。

过去 `as_of` 的最小 RED 为 `notalone-layered-clock-eWqacL-summary.json`：真实 PG 观察到新 L3 内部租约已在 10 月 23 日过期，新臂完成 3 次 L2 HTTP 后在 L3 物理发送前失败。旧臂虽非空成功，其内部画像租约也已过期，旧源码只按注入内容时钟判断。这是实际时间资格缺口，不能通过改全局 Date、PG now 或延长评测伪租约消解。精确接线点与后续新 pin 回执见 `time-qualification.json`。

基础验证为 3 个公开边界测试通过，薄 profile TypeScript 检查通过；最终业务 12 项及守卫 12 项检查通过。成功输出来自真实发布事务并带原来源版本，但 localhost 自报 supported 不证明语义正确。未启动 App／微信、未读真实联系人、原 `.env`、密钥或原累计账本，未运行真实供应商、完整 1152/120/96 或独立语义评审。

正式质量运行数仍为 0，冻结非回复 1056／统一 1152 分母完整保留。五阶段、首 token、旧内部租约及完整主宿主的评测时钟接线仍未获正式资格。输出实际记录为旧 8192／新 393216，不设容量或费用门槛；用量是 localhost 夹具声明值，费用保持 unknown。

原始资料和失败保存在仓库外 0700 / 0600 目录；所有早期 RED、失败、unknown 与实际物理请求列入 `probe-history.json`，没有并入正式质量通过率。`cleanup.json` 记录仅自有合成库、profile、socket 与 archive 的清理，不终止未知进程。没有修改生产、冻结 seam、oracle、primary、既有人类测试或 Git index；本地提交由主协调负责。

根随后提交 `64943d17483723ce66eef417728501c788d8cb84` 后，仅追加了一对固定过去 `as_of` 的真实 SDK/profile/PG/ModelHost localhost 复验：两臂各 6 HTTP、场景 1／画像 1。新内容保存时间仍为 `2026-10-23T04:00:00Z`，新租约在实际 PG 观察时有效；旧内部租约仍已过期。证据见 `notalone-layered-clock-BJlxtL-summary.json`。该追加关闭新运行租约的工程失败，旧时间与正式语义资格继续 unknown；原 e600/RED 证据逐字未改，后续完整集成 pin 仍需根提供后只读复核。
