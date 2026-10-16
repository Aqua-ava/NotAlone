# v9 真实 CLI 与视觉组合重试

2026-10-16，本场在微信阶段首个新正式观察返回 `paused`、采集计数全 0，视觉保持零采集，但未满足该阶段要求的正向识别。原 case 立即失败，runner 1；helper 和 Finder 阶段未执行，不再重复本流程。此前空配置诊断的获焦片段不作为本组合通过证据。

## 独立范围与实际失败

沿既有批准的单联系人私有模板，只更新本场时间与自有审计路径；locator、approved_texts、依赖路径等固定字段逐一相等，`allow_incoming_test_text=false`、`long_running=false`。新 8 分钟/max1 窗口为 `07:25:09.588Z–07:33:09.588Z`，私有 scope 截止 `07:33:09.000Z`，不复用旧预算。Conda `NotAlone`、禁 dotenv、随机隔离 userData / `_test` 库，既有 fixture 未改。冻结 v9 ASAR 为 `e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021`，前后 strict 验签 0、ASAR 未变。

Root 实际操作微信并直接写本轮 `wechat` 信号。Root 明确反馈：该信号之后没有进行任何 NotAlone 或 GUI 操作；未到 helper/Finder，不执行后续原拟“helper trigger 后立即 Raise”的对照。Root 未在失败后查询或重启 App。实际观察如下（均 UTC）：

| 事件/字段 | 本场值 |
| --- | --- |
| wechat trigger | 07:26:29.346 |
| phaseStartedAt | 07:26:29.354 |
| 首个阶段内正式 probe-start | 07:26:30.167574 |
| outcome / native_status | returned / paused |
| complete / valid / single_frame_requested | true / true / true |
| capture_requests / capture_completions / frames_received / header_ocr_calls | 0 / 0 / 0 / 0 |
| 阶段证据 | starts 1 / completed 1 / pending 0 / invalid true / ready false |
| 最后自有窗口观察 | helper visible=true，manager visible=false，两窗 focused=false |

`real-sync-visual-independence-acceptance.spec.ts:128` 的微信分支要求 `recognized` 且四项计数均为 1；本次返回合法、完整的暂停结果，因此断言为 invalid 并停止。不能将它写成录屏缺失、原生调用失败或权限通过，也不能根据自有窗口状态推断系统前台或具体暂停原因。

runner 于 `07:26:32.234Z` exit 1。全场正式测量 23 次 starts / 23 次 completed；这包含阶段前数据，不拼成微信阶段正向结果。真实 CLI 按有实际 PID 的 started 行去重计 4 次：version 2、sessions_follow 1、tail 1；该 tail 的 finished returncode 为 0，accepted 1 次。审计另有 1 次范围拒绝，原因未推断。预留无 PID 行不算额外进程；阶段未完成，不能认证 helper/Finder 期间 CLI 连续性、空联系人最终核验、来信或双联系人。

## 退出、隔离与资源清理

case 的 `passed/normalQuit/authenticatedStopped/ownedProcessesGone/emptyContactConfirmed` 全部 false，停止后新增计数字段为 null；原结果未改。失败后的 fixture teardown 单独记录 `authenticatedStopped=true`、来源 `app-http-response`、backend exit 0 / signal null、databaseDropped=true、unconfirmedResources=[]。这是故障收尾证据，不改签 case 正常菜单退出。

独立核验 8 个登记 runner/worker/App/backend/实际 CLI PID 均 ESRCH；本场 userData 与夹具临时目录不存在；仅对该随机测试库按精确名称执行只读 PG 查询，确认不存在；租约 absent；未发现 App/backend/native 剩余进程；默认 userData 身份不变。停止后独立 5 秒审计 actual CLI starts 4→4，新增 0；不扩为 case 尚未验证的正式 probe 停止后计数。control 按身份与 matching run/PID/closing 归档。Root 确认本场空 Finder 从未打开，随后按 dev/ino 和 empty 检查 rmdir。

最初前置曾发现瞬时 backend PID 52321，未启动本场、未终止该未知进程；它在复查前自行退场，Root 与本 Agent 均只读确认 gone。之后重新核无占用，才创建新窗口和启动唯一 App；未推断该 PID 的会话归属。

本轮恢复的 `wechat-cli`、`libWCDB.dylib` 此后不再使用。按 Root 明确指令，两文件逐一核 dev/ino/size/SHA 后删除，6 个此前新建目录核身份且为空后逐个 rmdir，全部成功；原官方缓存两文件保留且 SHA 匹配，旧私有模板未改变。未删除未知或非空资源；未把此前部分依赖修复称为恢复完整旧 App。

现场位于 [`desktop/artifacts/real-sync-visual-v9-retry-20261016-5de786e5-381e-4a02-b156-78e444084173/`](../../desktop/artifacts/real-sync-visual-v9-retry-20261016-5de786e5-381e-4a02-b156-78e444084173/)：`execution-scope.json`、私有 `scope.json`、归属记录、原 case results/measurements/cleanup、`first-stage-failure-projection.json`、`runtime-summary.json`、`resource-verification.json`、`database-verification.json`、`post-stop-audit-verification.json` 和 `control-archive/`。依赖精确清理记录为 [`dependency-cleanup.json`](../../desktop/artifacts/real-sync-v9-cli-repair-20261016-79d1f5b1-99d5-4234-a2c5-ece46719ee40/dependency-cleanup.json)。这些现场被忽略、不提交；私有 scope 限本地 0700 目录/0600 文件，不在报告打印身份、locator、正文或凭据。

本场没有发送消息、外部模型调用、新权限、来信或第二联系人扩权。未修改产品或测试，独立Standards／Spec均0项需修，不关闭组合验收或相关任务。
