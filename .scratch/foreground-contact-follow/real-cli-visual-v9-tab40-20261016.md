# v9 单 call Tab40 对照：工具拒绝与原严格失败

2026-10-16，本场微信正向通过；helper 首次实际原生获焦后出现新正式 probe，按原 gate 失败。Root 在同一次 CUA 调用中完成公开菜单打开输入小窗和 AX 读取，但 `pressKey(Tab, {durationMs:40000})` 被工具立即拒绝，返回允许范围 `0..30000`。**Tab 没有实际按下，不能评价其焦点保持效果。** 本场未自动复试，Finder 未打开或触发，原失败保持。

## 本场合同

独立新窗口 `08:22:47.690Z–08:30:47.690Z`、max1，私有 scope 截止不晚于租约。Conda、禁 dotenv、一个隔离 userData 和随机 `_test` 库；沿原已批准单联系人 template，仅更新时间和自有审计路径，其他字段相等，incoming/longrunning=false。现有 spec 与已审 `5880e115` 相同，微信25秒、helper/Finder70秒及原严格 gate 均未改变。没有模型、发送、新权限、第二联系人或来信扩权。

启动前核资源占用、默认目录身份、scope 静态校验及 v9 strict0，按现有 `npm run test:app -- --interactive ... --max-launches 1 -- tests/real-sync-visual-independence-acceptance.spec.ts` 启动。实际 runner 只启动一个冻结 v9 App；本场未观察到工具刷新额外实例。前后 ASAR 都为 `e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021`，结束后签名 strict0。没有据此声称当前全部 live 源码与冻结包一致。

## 原始阶段事实

时间均 UTC，本地加8小时。

| 阶段 | 记录 |
| --- | --- |
| 微信 trigger / 接收 | `08:23:50.008Z` / `08:23:50.213Z`；原截止 `08:24:15.213Z` |
| 微信正向 | 边界前6次合法 paused 另账；首 recognized started_at `08:24:04.292022Z`，`08:24:05.095Z`观察到，完整有效、single-frame=true，capture requests/completions/frames/OCR各1；阶段ready=true |
| helper trigger / 接收 | `08:24:33.071Z` / `08:24:33.197Z`；原70秒截止 `08:25:43.197Z` |
| helper 固定边界 | 首实际 helperFocused `08:24:42.338Z`，CLI checkpoint17，snapshot139行；pendingBefore及跨界完成为空，completionWallClockCertified仍false |
| 边界后新 formal | started_at `08:24:44.820926Z`，固定点后约2.483秒；returned/paused、complete/valid/single-frame=true，四项采集计数全0 |
| 原判 | helper starts1/completed1/invalid=true，在 spec:257 strict gate 失败；没有采集画面不能代替没有新正式调用 |

Root 的实际单 CUA call 为动态 freshAX→公开“窗口”菜单→“输入小窗”→AX→请求 Tab40，最后一步立即参数拒绝；调用2.275秒返回，未发键。工具文档未给出这一 macOS 实际上限，本次错误提供了上限证据。Root随后只用进程检查确认App已退，不再查询App AX或启动实例。不能将拒绝前的菜单/AX状态认证为持续原生focus，也不把这次失败归因为未执行的Tab效果。

原测量显示 helper 最后 visible=true、manager visible=true，两窗 unfocused。Finder 未进入，两个后续 fresh-tail gate 均未通过。runner `08:24:46.269Z` exit1，1 failed，约1.7分钟。case 的正常退出、鉴权停止、进程清理、空联系人 gate 仍false，停止后新增字段仍null；不以 teardown 覆盖。全场正式 probe 47 starts/47 completions，仅作全场计数。有实际PID的CLI started5（version2/follow1/tail2），tail finished returncode0及accepted各2、范围拒绝1；全场tail不拼作helper边界后gate通过。

## 分账收尾

fixture teardown 另证 authenticatedStopped=true、stopSource=app-http-response、backend exit0/signal=null、databaseDropped=true、unconfirmed=[]。`08:27:58Z`独立核9个归属PID全部ESRCH，隔离userData与fixture目录、实际interactive lease均absent；精确随机PG名只读查询absent。Root确认本场Finder从未打开，按dev/ino+empty移除自有空目录；closing control匹配run/PID/目录身份后归档。默认userData原dev/ino保持，未读取或删除其内容；不认证目录内容完全未变化。

`08:29:09Z–08:29:14Z`独立5秒actual CLI starts5→5，新增0；不代签原case停止后的正式probe计数。随后其他Agent串行App活动不归本组，不查询或清理。

本场外置依赖修复使用独立e0594309新账，COPYFILE_EXCL从已核官方cache恢复2文件/6目录，仅恢复旧批准路径的依赖，不是完整旧App或v9 bundle恢复。结束后按本账dev/ino/size/SHA核验删除2文件，逐层核身份及empty删除6目录，unconfirmed=[]；官方cache两文件保留且SHA相同，旧closed账及原模板未改。此前1a3744ea场的f3d54dca pair已在新场前独立清理，本场不复用其预算或清理账。

现场：[`real-sync-visual-v9-tab40-20261016-6e3245e1-c839-4f4a-b32a-7ef40ec78e56/`](../../desktop/artifacts/real-sync-visual-v9-tab40-20261016-6e3245e1-c839-4f4a-b32a-7ef40ec78e56/)，包含原results/measurements/cleanup、固定字段边界投影、Root实际动作记录、runtime摘要、PID/PG/quiet/package核查和control-archive。依赖账为[`real-sync-v9-cli-repair-tab40-20261016-e0594309-0e92-44d4-b790-27a1f96e72c6/`](../../desktop/artifacts/real-sync-v9-cli-repair-tab40-20261016-e0594309-0e92-44d4-b790-27a1f96e72c6/)。现场被忽略，不提交；私有scope仅本地0700/0600，不打印身份、locator、正文或凭据。本报告与[前次Tab未执行及额外实例报告](real-cli-visual-v9-tab-control-20261016.md)、[先前Raise对照](real-cli-visual-v9-boundary-20261016.md)分列，独立Standards／Spec均0项问题，不关闭组合验收。
