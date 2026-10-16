# v9 计划 Tab 对照：原场失败与额外实例清理

2026-10-16，本场微信正向通过；helper 首次原生获焦后出现新正式 probe，在原严格 gate 下失败。**计划的 Tab 在原场没有执行**，不能据此判定 Tab 保持焦点控制有效或无效。后续工具刷新出现另一默认管理后台实例，Root 的 12 秒 Tab 调用只在该新 manager 导航，不计原场证据。原始失败与额外实例分账保存。

## 原场合同及测量

新窗口 `08:05:43.500Z–08:13:43.500Z`、max1，实际 runner 启动一个冻结 v9 App。Conda、禁 dotenv、隔离随机 userData / `_test` 库；单联系人原模板仅更新时间与自有审计路径，其他字段相等，incoming/longrunning=false。沿已审 `5880e115`，wechat/helper 原25/70秒门和全部 gate不变。v9 ASAR `e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021` 前后相同、strict0。没有模型、发送、新权限、第二联系人或来信扩权。

以下时间均 UTC，本地加8小时。

| 阶段 | 原始事实 |
| --- | --- |
| 微信 trigger / 接收 | `08:07:02.443Z` / `08:07:02.678Z`；原截止 `08:07:27.678Z` |
| 微信正向 | 首 recognized started_at `08:07:16.398504Z`；完整有效、single-frame=true，capture requests/completions/frames/OCR各1；`08:07:17.307Z`被观察到，waitingPaused0；阶段ready=true |
| helper协调等待 | 微信结束后等待Root动作；直到 `08:11:30.702Z` 才写helper trigger，runner收到 `08:11:30.703Z`；该段未伪造helper测量起点 |
| helper原生边界 | 首实际helperFocused `08:11:44.343Z`，CLI checkpoint33，snapshot400行，pendingBefore/跨界完成均为空；70秒原截止 `08:12:40.703Z` |
| 边界后新formal | `08:11:47.188236Z`开始，在固定点后约2.845秒；returned/paused、complete/valid/single-frame=true，四项采集计数全0 |
| 原判 | helper starts1/completed1/invalid=true，在spec:257失败；“没有画面采集”不改签为“没有新正式调用” |

Root实际公开窗口菜单打开小窗。首 Tab 调用立即报告 Computer Use inactive，未发键；后续同call getAX→Tab12s→AX耗约20秒，最后出现“尚未连接”的管理后台。Root确认原场Tab未执行、后续导航实际在新manager；未把新实例接回原case，也不因菜单/AX状态认证连续nativefocus。原场最后helper visible=true、manager hidden，两窗unfocused。Finder信号/阶段未执行，Root确认本场empty-finder从未打开。

runner `08:11:49.227Z` exit1，约5.8分钟。case退出/鉴权停止/进程清理/空联系人与两后续tail gate均未通过，停止后新增字段为null，原结果不改。fixture teardown另证authenticatedStopped=true、app-http-response、backendexit0、DBdropped、unconfirmed=[]。全场formal134 starts/134 completions，不拼为helper阶段证据；有实际PID的CLI started9（version2/follow1/tail6），tail finished returncode0与accepted各6，范围拒绝1，helper checkpoint后tail gate未通过。

## 额外实例及默认目录影响

原App86638、runner86596、worker86602、backend86615已退场；随后实际发现额外App88855，PPID1，启动本地16:11:53，comm及args首路径均为精确v9可执行文件，无`--user-data-dir`。它在原runner结束后约4秒出现，与Root工具刷新时段吻合；单列元数据，不由时序独立认证启动因果。**runner预算启动1个，场后另观察到1个实例，合计2个，额外实例在fixture租约之外。** 不隐去该额外启动或称为同实例。

Root对存活88855实际公开菜单退出，之后未再查询App；`08:14:55Z`核其ESRCH、App/helper/native及backend均无。没有原ChildProcess exitCode，因此额外实例只记录实际菜单动作及PID消失，不认证exit0。

默认`NotAloneDesktop`目录在本场之前已存在，dev/ino16777230/73526279，退场后同身份、0700；未删除或覆盖非own配置。只查已知文件metadata：backend-launch.json、desktop-settings.json不存在，Preferences/Local State的mtime仍为10月8日；没有读取正文、凭据或列举私人资料。缺少整个目录的内容基线，**不认证默认目录内容完全未被额外启动写过**，不以同inode代替内容未变，也不尝试无备份回滚。

## 精确收尾与现场

原场及额外实例共14个登记PID全ESRCH；原userData/fixture目录、lease absent，精确随机PG只读查absent。closing control按run/PID/目录身份归档；未打开的Finder目录按dev/ino+empty删除。独立5秒actual CLI starts9→9，新增0；不代签原case的停止后正式probe计数。全局“无App”检查发生于本组清理时，之后其他Agent的串行App场不属本组、不查询或清理它们。

f3d54dca本场恢复pair按新账的dev/ino/size/SHA删除2文件，逐个核身份和empty删除6目录，全部完成；原官方cache两文件保留且SHA相符，旧closed账、旧模板未改。没有覆盖未知资源或把部分依赖恢复称为完整旧App恢复。

现场为 [`desktop/artifacts/real-sync-visual-v9-tab-control-20261016-1a3744ea-ede9-4de4-a732-bcbb06c5777e/`](../../desktop/artifacts/real-sync-visual-v9-tab-control-20261016-1a3744ea-ede9-4de4-a732-bcbb06c5777e/)，含原测量/results/cleanup、`boundary-failure-projection.json`、`runtime-summary.json`、`root-actual-tab-actions.json`、`post-fixture-extra-app-instance.json`、`default-userdata-extra-instance-impact.json`、资源/PG/quiet核查与`control-archive/`。pair归属与清理在 [`real-sync-v9-cli-repair-tab-20261016-f3d54dca-9b2f-4c9f-b43a-ee39fbd9bd1f/`](../../desktop/artifacts/real-sync-v9-cli-repair-tab-20261016-f3d54dca-9b2f-4c9f-b43a-ee39fbd9bd1f/)。现场被忽略、不提交；私有scope限本地0700/0600，报告不打印身份、locator、正文或凭据。原失败保持，独立Standards／Spec均0项问题，不关闭组合验收。
