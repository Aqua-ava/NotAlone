# Ticket 25 确定性行为证据与评测入口处置

核对日期：2026-10-25。本清单承接 [01 行为基线](../baseline/behavior-matrix.md)，只证明公开业务入口、控制器、存储合同或模块测试的确定性结果。它不证明真实模型质量、实际 App／微信完整链路或生产切换；这些证据按 Ticket 25 报告分栏保留。

## 本轮实际执行

| 检查 | 结果 |
| --- | --- |
| 回复盲包与身份隔离 `backend-ts/test/reply-blind-packet.test.mjs` | 28/28 通过 |
| 回复比较、来源审计与多 attempt 报告器三个测试文件 | 135/135 通过 |
| TS 严格类型检查 | 通过 |
| 归一化与报告复跑 | run 文件逐字节相同；报告 96 条分母、95 成功、1 失败，报告器退出 2（未通过） |
| 后端有界全量 | 1258/1258 通过，0 失败、0 跳过，约 258 秒 |
| 桌面安全组有界全量 | 1011/1012 通过，0 失败、1 明确跳过，约 52 秒；使用 NotAlone Conda Python 3.12 与单一 pnpm Playwright 实例 |

本轮没有重新执行 03–23 的完整历史矩阵。下表“历史执行证据”引用原票签收记录；“静态入口”只表示当前公开接缝和测试资产存在。

## 逐票承接

| 票／行为 | 静态确定性入口 | 历史执行证据 | 范围与数据边界 | 评测入口处置 | 当前缺口 |
| --- | --- | --- | --- | --- | --- |
| 03 宿主、首用、owner、原库生命周期 | [runtime.test.mjs](../../../backend-ts/test/runtime.test.mjs)、[host-storage.test.mjs](../../../backend-ts/test/host-storage.test.mjs)、[startup-continuity.test.mjs](../../../desktop/tests/startup-continuity.test.mjs) | [03 Answer](../issues/03-desktop-backend-lifecycle.md#L46)、[控制面根验收](../ts-controlplane-root-acceptance/validation.md) | owner 独立；未知库停止写入；不创建替代空库 | TS 启动/宿主测试保留；Python 启动链由 24／26 收敛与退役 | 完整首用、发布包和独立机器仍不在本票 |
| 04 联系人确认、切换和读取 | [contact-context.test.mjs](../../../backend-ts/test/contact-context.test.mjs)、[contact-session.spec.ts](../../../desktop/tests/contact-session.spec.ts) | [04 Answer](../issues/04-contact-context.md#L46)、[前台联系人根验收](../foreground-location/desktop-acceptance.md) | `owner_id + contact_id`；无绑定、改名、重名、低置信度不猜身份 | TS 联系人测试保留；旧手动创建入口在 24／26 退役，历史记录读取删除保留 | 根会话最终 App 证据仍须纳入 25 |
| 05 生成、候选、引用、预算与持久 | [reply-contract.test.mjs](../../../backend-ts/test/reply-contract.test.mjs)、[reply-scope.test.mjs](../../../backend-ts/test/reply-scope.test.mjs)、[reply-store.test.mjs](../../../backend-ts/test/reply-store.test.mjs)、[reply-comparison.test.mjs](../../../backend-ts/test/reply-comparison.test.mjs) | [05 Answer](../issues/05-traceable-replies.md#L46)、[回复业务根验收](../reply-business-root-acceptance/accepted-manifest-v2.json) | 范围和输入版本在物理调用前复验；晚结果不保存；最终发送始终人工 | 新 TS 报告器、盲包与来源审计保留；旧 Python `reply/fidelity_evaluation.py`、`experiments/reply_comparison.py` 仅隔离为历史工具，26 退役 | 真实模型报告失败：新臂 1 次失败、5 个配对新增假事；延迟未定 |
| 06 Skill 目录、版本、启停、资源和删除 | [skill-http.test.mjs](../../../backend-ts/test/skill-http.test.mjs)、[skill-files.test.mjs](../../../backend-ts/test/skill-files.test.mjs)、[skill-cleanup.test.mjs](../../../backend-ts/test/skill-cleanup.test.mjs) | [06 Answer](../issues/06-reply-skill-library.md#L46) | 授权目录、每轮零或一个合法版本；模型不能管理发布 | TS 测试保留；Python Skill 管理测试隔离，26 清理 | 未完成完整桌面独立导入/导出入口验收 |
| 07 想法、澄清、方向与固定 Skill | [exploration-runtime.test.mjs](../../../backend-ts/test/exploration-runtime.test.mjs)、[exploration-skill-service.test.mjs](../../../backend-ts/test/exploration-skill-service.test.mjs)、[reply-exploration-guards.test.mjs](../../../backend-ts/test/reply-exploration-guards.test.mjs) | [07 Answer](../issues/07-exploration-skill-replies.md#L52) | 建议不冒充确认；换联系人不串意图；只读固定版本 | TS 探索测试保留；旧探索评测探针仅按历史材料保留 | 真实模型方向质量未单独评价 |
| 08 讨论保存、编辑、选择、恢复、删除 | [assistant-discussion-service.test.mjs](../../../backend-ts/test/assistant-discussion-service.test.mjs)、[assistant-discussion-http.test.mjs](../../../backend-ts/test/assistant-discussion-http.test.mjs)、[assistant-generation-stop.test.mjs](../../../desktop/tests/assistant-generation-stop.test.mjs) | [08 Answer](../issues/08-discussion-continuity.md#L46)、本地修复 `505e8deb` | 按联系人隔离；来源删除和迟到结果不能复活；切换／隐藏窗口不取消原生成 | TS 讨论、投影和停止测试保留；旧会话粗票是重拆而非退役 | 主动停止和根 App 复验由并行切片及根会话完成 |
| 09 记忆、修正与长期表达偏好 | [memory-mutations.test.mjs](../../../backend-ts/test/memory-mutations.test.mjs)、[preference-management.test.mjs](../../../backend-ts/test/preference-management.test.mjs)、[memory-preferences-host.test.mjs](../../../backend-ts/test/memory-preferences-host.test.mjs) | [09 Answer](../issues/09-memory-and-preferences.md#L46)、[偏好验证](../memory-preferences/validation.md) | 联系人／本人分开；一次策略不静默长期化；来源可查可删 | TS 管理测试保留；主动表达样本保持退役 | 完整真实模型语义质量不在本清单 |
| 10 来源提取、核验和任务水位 | [extraction-flow.test.mjs](../../../backend-ts/test/extraction-flow.test.mjs)、[extraction-protocol-contract.test.mjs](../../../backend-ts/test/extraction-protocol-contract.test.mjs)、[extraction-worker-control.test.mjs](../../../backend-ts/test/extraction-worker-control.test.mjs) | [10 Answer](../issues/10-memory-extraction-verification.md#L46)、[实施证据](../task10-implementation/handoff.md) | 仅本任务来源；核验失败不采纳；晚写拒绝 | TS 提取链保留；Python `memory_extraction/evaluation*.py` 隔离为历史评分材料，26 处理 | 提取 140 例真实模型质量、语义标注和费用未在本轮执行 |
| 11 采纳、更新、待确认、拒绝 | [memory-adoption.test.mjs](../../../backend-ts/test/memory-adoption.test.mjs)、[extraction-adoption-service.test.mjs](../../../backend-ts/test/extraction-adoption-service.test.mjs) | [11 Answer](../issues/11-memory-adjudication-adoption.md#L46)、[证据](../task11-implementation/evidence.md) | auto 不伪造用户确认；错误、变化和未知分开；来源失效拒绝 | TS 采纳测试保留；旧 Python adoption 测试只作历史回放 | 自动采纳真实质量门禁未单独给模型证据 |
| 12 来源处理追踪与反查 | [source-processing-trace.test.mjs](../../../backend-ts/test/source-processing-trace.test.mjs)、[extraction-evidence.test.mjs](../../../backend-ts/test/extraction-evidence.test.mjs) | [12 Answer](../issues/12-source-processing-trace.md#L46)、[证据](../task12-implementation/evidence.md) | 追踪正文与最小台账分开；删除路径保留 | TS 追踪测试保留；旧 `memory_trace.command` 由 26 退役 | 历史不可观察载荷继续标 unknown |
| 13 L2 场景、目录和覆盖 | [l2-scenario-service.test.mjs](../../../backend-ts/test/l2-scenario-service.test.mjs)、[l2-scenario-shared-host.test.mjs](../../../backend-ts/test/l2-scenario-shared-host.test.mjs) | [13 Answer](../issues/13-l2-scenario-organization.md#L46)、[证据](../task13-implementation/evidence.md) | 按本人／联系人；generation/revision 一致；旧结果不覆盖 | TS L2 测试保留；Python organization-quality suite 仅隔离历史，26 处理 | 无统一真实模型 L2 质量报告 |
| 14 L3 本人／联系人画像 | [l3-profile-service.test.mjs](../../../backend-ts/test/l3-profile-service.test.mjs)、[l3-profile-workspace.test.mjs](../../../backend-ts/test/l3-profile-workspace.test.mjs) | [14 Answer](../issues/14-l3-profile-overview.md#L46) | 本人／联系人分开；推断不等于事实；撤回不恢复旧版 | TS L3 测试保留；旧画像质量套件隔离 | 83/126 完整质量、正式预算和人审未覆盖；根 App 最终证据待归并 |
| 15 Skill 学习、审核、发布与谱系 | [skill-learning.test.mjs](../../../backend-ts/test/skill-learning.test.mjs)、[skill-runtime.test.mjs](../../../backend-ts/test/skill-runtime.test.mjs) | [15 Answer](../issues/15-skill-learning-review.md#L49) | 草稿不发布；模型无发布权；审核读实际 L2/L3 | TS 学习测试保留；旧学习运行链由 26 审计 | 真实模型学习质量和完整桌面审核未在本轮执行 |
| 16 单联系人历史导入 | [history-import-api.test.mjs](../../../backend-ts/test/history-import-api.test.mjs)、[history-runtime.test.mjs](../../../backend-ts/test/history-runtime.test.mjs) | [16 Answer](../issues/16-contact-history-import.md#L46) | 一次导入只属一个联系人；混合联系人拒绝；消息与提取分离 | TS 导入测试保留；Python import/preview 入口由 26 退役 | 旧“导入新建联系人”接口保持待退役，不复活 |
| 17 来源、联系人、讨论删除 | [cross-domain-deletion-http.test.mjs](../../../backend-ts/test/cross-domain-deletion-http.test.mjs)、[reply-assistant-erasure.test.mjs](../../../backend-ts/test/reply-assistant-erasure.test.mjs) | [17 Answer](../issues/17-cross-domain-deletion.md#L47) | 清除消息、记忆、L2/L3、Skill、讨论、任务和已知副本；晚结果不复活 | TS 删除测试保留；旧删除命令由 26 清理 | 账户彻底删除 UI 仍属原首用票缺口 |
| 18 微信账号、会话和全部私聊授权 | [wechat-scope-api.test.mjs](../../../backend-ts/test/wechat-scope-api.test.mjs)、[wechat-setup.test.mjs](../../../backend-ts/test/wechat-setup.test.mjs)、[sync-scope.test.mjs](../../../backend-ts/test/sync-scope.test.mjs) | [18 Answer](../issues/18-wechat-scope-binding.md#L46) | 显式授权；元数据同意不等同正文授权；稳定身份冲突不猜 | TS 微信范围测试保留；Python WX 命令只保留受控适配，26 审计 | 根真实微信最终范围证据待归并 |
| 19 后台增量同步、停读和重连 | [sync-incremental-api.test.mjs](../../../backend-ts/test/sync-incremental-api.test.mjs)、[sync-incremental-reconnect.test.mjs](../../../backend-ts/test/sync-incremental-reconnect.test.mjs)、[sync-incremental-suppression.test.mjs](../../../backend-ts/test/sync-incremental-suppression.test.mjs) | [19 Answer](../issues/19-private-incremental-sync.md#L46)、[根最终验收](../incremental-root-final-acceptance/validation.md) | 仅运行且开关开启时读；关闭/退出停读；排除项不自动恢复 | TS 增量链保留；旧 CLI 同步命令由 26 退役 | 真实全量微信追赶仍与 20 原票关联 |
| 20 历史分页、checkpoint 与覆盖门禁 | [sync-history.test.mjs](../../../backend-ts/test/sync-history.test.mjs)、[wechat-history-status-host.test.mjs](../../../backend-ts/test/wechat-history-status-host.test.mjs) | [20 Answer](../issues/20-history-gap-recovery.md#L46) | 授权范围；空/失败不等于完整；覆盖不足阻止生成 | TS 历史同步测试保留；Python full-sync 只作受控历史适配 | 原真实微信票 08 曾为 claimed；最终实际覆盖仍由根核验 |
| 21 前台唯一微信窗口名称定位 | [foreground-location-locator.test.mjs](../../../backend-ts/test/foreground-location-locator.test.mjs)、[foreground-location-probe.test.mjs](../../../backend-ts/test/foreground-location-probe.test.mjs)、[foreground-location-authority.test.mjs](../../../backend-ts/test/foreground-location-authority.test.mjs) | [21 Answer](../issues/21-foreground-contact-location.md#L46) | 仅名称区域内存 OCR；不读正文/列表、不切换滚动、不持久帧 | TS 探针与定位测试保留；旧 `front_sync.command` 由 26 退役 | 首次并行全量曾出现 `probe_timeout` vs `probe_warming`，单例通过；最终全量需复跑 |
| 22 后台任务租约、进度、停止与恢复 | [background-task-management.test.mjs](../../../backend-ts/test/background-task-management.test.mjs)、[task-api.test.mjs](../../../backend-ts/test/task-api.test.mjs)、[extraction-task-runner.test.mjs](../../../backend-ts/test/extraction-task-runner.test.mjs) | [22 Answer](../issues/22-background-task-management.md#L48)、[证据](../task22-implementation/evidence.md) | 合法 owner/联系人；原子领取；停止/删除后晚结果不提交 | 唯一 TS Worker 测试保留；`memory_upgrade` 枚举退役且不领取 | 完整真实 App/微信任务收口由根会话完成 |
| 23 用量、费用、设置与诊断 | [model-ledger.test.mjs](../../../backend-ts/test/model-ledger.test.mjs)、[usage-summary-http.test.mjs](../../../backend-ts/test/usage-summary-http.test.mjs)、[diagnostic-export.test.mjs](../../../desktop/tests/diagnostic-export.test.mjs) | [23 Answer](../issues/23-usage-settings-diagnostics.md#L46)、[根验收](../task23-root-acceptance/validation.md) | 物理调用即使取消仍记账；未知不填 0；诊断不含正文、身份或密钥 | TS 台账与诊断测试保留；旧 Python ledger/startup 由 26 退役 | 根 App 用量/费用最终可见证据待归并 |

## 评测入口迁移

必须保留的新 TS 入口：

- 盲包与来源绑定：[reply-blind-packet.mjs](../../../backend-ts/experiments/reply-blind-packet.mjs)、[build-reply-blind-packet.mjs](../../../backend-ts/experiments/build-reply-blind-packet.mjs)、[reply-blind-packet.test.mjs](../../../backend-ts/test/reply-blind-packet.test.mjs)。
- 统一报告器：[reply-comparison.ts](../../../backend-ts/src/reply-comparison.ts)、[reply-comparison-sources.ts](../../../backend-ts/src/reply-comparison-sources.ts) 及三个比较测试文件。
- 冻结召回兼容：[retrieval-frozen-validation.mjs](../../../backend-ts/test/retrieval-frozen-validation.mjs)、[retrieval-python-parity.test.mjs](../../../backend-ts/test/retrieval-python-parity.test.mjs)；只作确定性 parity，不冒充模型表现。
- 确定性域测试：上表 TS 测试作为迁移后入口，不能由“插件能被调用”代替。

仅隔离保留、到 Ticket 26 再做退役审计：

- `backend/src/notalone/reply/fidelity_evaluation.py`、`experiments/reply_comparison.py`：回复历史评分/对比，已被 TS 报告器与盲包替代。
- `memory_extraction/evaluation*.py`、`replica_experiment.py`、`retrieval/evaluation.py`、organization-quality 与 hindsight 系列：离线历史实验，不得被产品启动或隐式调用。
- `scripts/benchmark_memory_recall.py`、`scripts/compare_tencent_extraction.py`、`scripts/replay_grounded_extraction.py`、`experiments/pgvector/*`：历史复现与诊断，不属于发布运行闭包。

明确不恢复或退役：

- 产品生成后的额外语义复核模型已退役，不借评测补回。
- `memory_upgrade` 自动升级执行、主动表达样本、Todo/自动过程摘要、时间/日历/联网工具按现行 ADR 不迁移。
- 手工创建联系人和导入新建联系人入口不再扩展；历史记录读取与删除保留。

## 仍阻止签收

- 真实模型报告 `overall=failed`：新臂失败率高于旧臂，且比较出 5 个配对新增假事风险。
- 旧采集没有可验证五阶段、首事件、首 token 和最终持久结果时间线，延迟门禁保持未定。
- prompt、tool schema、旧 profile 与 response fingerprint 不能恢复，模型等价只到同请求配置。
- 提取、L2/L3、Skill 学习等域尚无可提交的统一真实模型质量/费用矩阵。
- 实际 App、真实微信范围、主动停止和根会话整链路证据仍须由根会话返回；未发送外部消息。
