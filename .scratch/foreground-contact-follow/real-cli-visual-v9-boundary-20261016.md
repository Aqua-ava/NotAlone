# v9 视觉组合：原生条件边界复验

2026-10-16，沿已审 `5880e115` 测量边界夹具，冻结 v9 的微信阶段正向通过；helper 首次原生获焦后又出现新正式 probe，严格保留失败。runner 1、约 2 分钟；没有重设起点、延长 25/70 秒总窗口或把旧结果拼成通过。Finder 未执行。

新 8 分钟/max1 场为 `07:56:17.616Z–08:04:17.616Z`，实际一次 App 启动。Conda、禁 dotenv、随机隔离 userData / `_test` 库；单联系人原模板只更新时间及本场审计路径，其他字段逐一相等，incoming/longrunning=false。没有模型、发送、新权限、第二联系人或来信扩权。v9 ASAR `e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021`，前后 strict 0、ASAR 不变；实际 spec 摘要与 `5880e115` 一致。

## 分阶段事实

时间均为 UTC，本地加 8 小时。

| 阶段 | 本场结果 |
| --- | --- |
| 微信 trigger / 接收 | `07:57:19.057Z` / `07:57:19.204Z`；截止 `07:57:44.204Z` |
| 微信等待前置 | 7 次合法完整 paused，capture requests/completions/frames/OCR 均 0，单独保留 |
| 微信正向边界 | 首 recognized 的 started_at 为 `07:57:34.4527Z`，完整有效、single-frame=true，四项计数均 1；runner `07:57:35.721Z` 观察到；阶段 starts1/completed1/invalid=false/ready=true |
| helper trigger / 接收 | `07:58:14.985Z` / `07:58:15.099Z`；原截止 `07:59:25.099Z` |
| helper 原生起点 | 首次实际 helperFocused 的观察时刻 `07:58:29.972Z`；CLI checkpoint17，snapshot157 行；没有边界前 pending probe，跨界完成列表为空 |
| helper 新正式 probe | started_at `07:58:33.9800652Z`，在固定起点后约 4.008 秒；returned/paused、complete/valid/single-frame=true，四项采集计数均 0 |
| helper 判定 | starts1/completed1/invalid=true/ready=false；helper 条件要求固定点后无新正式 probe，故在 spec:257 失败，不把零画面采集改签为零观察调用 |
| 最后窗口状态 | helper visible=true，manager hidden，两窗 unfocused；不据此推断系统前台或持续焦点 |

Root 实际在 helper 信号后公开菜单打开同一小窗，并在同次 CUA 调用循环 Raise 同一窗口、fresh AX，目标 20 次；调用 10.915 秒后报告 App quit，Root 立即停止，没有再 getApp。没有提供实际完成迭代数，不能将目标 20 次写为完成 20 次，也不因这些动作认证连续原生焦点。未写 Finder 信号、未操作 Finder。原始证据只支持“固定原生起点后有新 formal 调用”；不能把失焦或此调用单独归因产品、CUA 或某一条窗口恢复语句。

runner 于 `07:58:35.612Z` exit1。case 的正常菜单退出、鉴权停止、进程退场、最终空联系人及两后续 tail gate 均未通过，停止后新增计数为 null，原结果不改。fixture teardown 另证 authenticatedStopped=true / app-http-response、backend exit0、DB dropped、unconfirmed=[]，不代签 case 通过。全场正式 probe starts53/completed53，非 helper 阶段计数；实际 CLI 有 PID 的 started5 次（version2、follow1、tail2），tail finished returncode0/accepted各2，范围拒绝1次，未推断拒绝原因。helper checkpoint 后的 tail gate 未通过，不将全场 tail 计数算成其连续性。

## 精确收尾与现场

9 个登记 runner/worker/App/backend/CLI PID 均 ESRCH；userData、fixture目录、租约 absent；只读按精确随机库名查询 absent；default userData 身份不变，无 App/backend/native 残留。Root 未操作的空 Finder 目录按 dev/ino+empty rmdir，closing control 按身份及 run/PID 校验归档。独立 5 秒 actual CLI starts5→5，新增0；不扩为 case 尚未验证的 formal 停止后计数。

本轮仅以 COPYFILE_EXCL 从相同官方缓存恢复原批准路径的2文件/6目录，新归属账独立于旧 closed repair；两文件在本组退场后核 dev/ino/size/SHA 精确删除，6目录按身份且为空后 rmdir。官方缓存保留且 SHA 匹配，原模板与旧 closed账未改；没有恢复完整旧 App，也未改 v9 bundle。

原始现场在 [`desktop/artifacts/real-sync-visual-v9-boundary-20261016-d3b3766b-95ac-4dab-8a79-a8a6a0978d9b/`](../../desktop/artifacts/real-sync-visual-v9-boundary-20261016-d3b3766b-95ac-4dab-8a79-a8a6a0978d9b/)，保留 scope/归属、原测量/结果/cleanup、`boundary-failure-projection.json`、`runtime-summary.json`、`root-actual-helper-actions.json`、精确资源/PG/quiet核查与 `control-archive/`。新 repair/cleanup 账在 [`real-sync-v9-cli-repair-boundary-20261016-e2021956-81f0-4cda-a5fe-f2a827cb5292/`](../../desktop/artifacts/real-sync-v9-cli-repair-boundary-20261016-e2021956-81f0-4cda-a5fe-f2a827cb5292/)。现场被忽略、不提交；私有 scope 限本地0700/0600，报告不打印身份、locator、正文或凭据。原先各场失败保持，独立Standards／Spec均0项问题，不关闭组合验收。
