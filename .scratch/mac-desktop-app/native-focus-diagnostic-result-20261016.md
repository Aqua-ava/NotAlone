# 冻结 v9 原生焦点最小诊断结果

2026-10-16，以诊断提交 `c3732d0c` 的现有 `native-focus-acceptance.spec.ts` 启动一次冻结 v9，空隔离配置、工作目录 `/`。诊断 case 通过，旧快捷键 case 跳过，报告 2.8 分钟、runner 0；这只证明诊断正常完成。普通重开与系统整体隐藏后重开都实际捕到 helper 原生获焦，随后也记录到 App 失活和 helper blur。本场不支持把此前真实 CLI 组合的焦点超时归因为产品缺少 `app.show`，亦不证明该组合已修复或全程持续获焦。

本报告独立 Standards／Spec 均0项需修，不预填任务关闭状态。原真实 CLI 视觉场失败保持不变。

## 同包、范围与动作来源

- App 为 `remaining-nine-final-20261016-v9/NotAlone-darwin-arm64/NotAlone.app`，ASAR SHA-256 `e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021`。启动前及收尾 `codesign --verify --deep --strict` 均为 0，ASAR 未变；不重包、不重签，不以当前源码代替包内证据。
- 禁 dotenv，显式 `NOTALONE_NATIVE_FOCUS_DIAGNOSTIC=1`、冻结 `NOTALONE_TEST_APP_EXECUTABLE` 和本场私有 control。通过既有 `test:app`、单文件、单 worker、retries 0、max launches 1；绝对窗口为 `07:16:49.480Z–07:24:49.480Z`，预留最后 15 秒收尾，实际一次 App 启动，`07:19:47.090Z` runner 结束。
- 空 `launchConfiguration` 和 cwd `/` 由原 case 固定；没有后端、PG、微信、CLI、探针、产品 HTTP/API、外部模型、消息发送或权限操作。采样只读本 App 状态及事件；不落盘标题、页面 URL、输入、全局 App 清单或画面。
- Root 独占 CUA：公开菜单创建 helper；普通条件实际点 helper 隐藏、管理窗关闭 x，再置前自建空目录窗口、公开菜单打开 helper；系统条件实际“隐藏 NotAlone”、置前自建空目录窗口、公开菜单打开 helper。两条件均在最后 GUI 调用后另行等待 3 秒，再核验并写对应信号；没有单独计量最后 GUI 到信号的全部延迟，工具、协调及执行间隔不包含在这 3 秒内。退出前先发 quit，再实际公开菜单退出。以上动作由 Root 实际反馈单列在 `root-actual-actions.json`，时间口径以 Root 后续补充为准，不由程序状态代签 GUI 动作。
- 两次 CUA 操作曾返回 `user-changed`：初始定位自有空目录窗口，以及系统隐藏菜单首次点击；Root 重新读取当时 AX 状态后，使用当前控件完成操作。公开菜单退出后一次 AX 查询超时 `-10005`，Root 未再查询或重启。这些工具状态保留为操作记录，不认定为产品故障原因。
- `setup-helper-created`、`ordinary-hide-open-done`、`system-hide-open-done`、`quit` 四个 trigger 都由 Root 直接写入，均为匹配本轮 runId 的 36 字节字符串、无换行；写入前核当前 stage/runId/PID/租约与截止。action signal 只表示操作完成，不认证焦点。

四个 trigger 的归档修改时刻依次为 `07:17:25.876Z`、`07:18:13.886Z`、`07:19:07.948Z`、`07:19:36.894Z`。例如系统重开后的获焦样本起点 `07:18:53.197Z` 到对应 trigger 相差 14.751 秒，不能以显式等待 3 秒代替这一完整间隔。

## 原始观察与连续采样片段

以下时间均为 2026-10-16 UTC，本地时间加 8 小时。采样配置 250ms，阶段切换还会立即加采一次；“连续片段”指相邻记录连续满足条件，不把两点之间扩为未经观察的 OS 保证。helper 数字 ID 为 2，manager 为 1。

共保存 408 个样本、68 个事件：setup 1、ordinary 190、system 216、quit 1。所有样本完整，`unknown=false`，样本/事件/字节均未饱和。最终 `disposed=true`、`cleanupComplete=true`，文件 144426 字节，小于 1MiB。fixture 的 `focusCertified=false`、`actionSignalsCertifyFocus=false` 均保持。

| 阶段 | helper visible/focused 且 focusedWindowId=2 的连续采样片段 | 点数 | 首尾跨度 | 与动作的关系 |
| --- | --- | --- | --- | --- |
| ordinary | 07:17:57.641–07:18:08.705 | 45 | 11.064s | 公开菜单重开后主要片段 |
| ordinary | 07:18:11.545–07:18:12.550 | 5 | 1.005s | 后续再次激活片段 |
| ordinary | 07:18:13.641–07:18:13.893 | 2 | 0.252s | 阶段结束前片段 |
| system | 07:18:14.131–07:18:14.143 | 2 | 0.012s | 本阶段初始，整体隐藏前 |
| system | 07:18:14.896–07:18:15.147 | 2 | 0.251s | 整体隐藏前 |
| system | 07:18:22.710–07:18:24.487 | 8 | 1.777s | 整体隐藏前 |
| system | 07:18:32.303–07:18:35.069 | 12 | 2.766s | 整体隐藏前 |
| system | 07:18:53.197–07:18:55.471 | 10 | 2.274s | 整体隐藏后实际重开，manager 仍 hidden |

普通条件合计 52 个 helper focused 样本；system 合计 34 个，其中只有最后 10 个属于整体隐藏之后的重开，不能把 34 个全部归为重开成功。所有上述获焦片段 `appHidden=false`、`appActive=true`。

## App hidden/active 时序与条件偏差

普通阶段 `appHidden` 全程为 false。`appActive` 的完整连续采样变化如下：

| 起止 UTC | appActive |
| --- | --- |
| 07:17:26.136–07:17:29.401 | false |
| 07:17:29.654–07:17:36.263 | true |
| 07:17:36.514–07:17:54.111 | false |
| 07:17:54.362–07:18:08.705 | true |
| 07:18:09.002–07:18:11.294 | false |
| 07:18:11.545–07:18:12.550 | true |
| 07:18:12.803–07:18:13.390 | false |
| 07:18:13.641–07:18:13.893 | true |

普通条件只在 `07:17:35.508Z` 一点同时捕到两窗 hidden。manager 的 `hide` 事件为 `07:17:35.408Z`，随后 `07:17:35.624Z` 又 `show`，间隔 216ms；自有空目录窗口操作期间样本中 manager 仍 visible。因此不能把该条件标为持续满足“两窗均隐藏”的理想前置。helper 重开于 `07:17:57.524Z` 收到原生 focus 事件，`07:18:08.838Z` App resign-active、紧接 helper blur；后续再次激活/失活均保留。

system 阶段的完整 hidden/active 连续采样变化如下：

| 起止 UTC | appHidden | appActive |
| --- | --- | --- |
| 07:18:14.131–07:18:14.143 | false | true |
| 07:18:14.394–07:18:14.644 | false | false |
| 07:18:14.896–07:18:15.147 | false | true |
| 07:18:15.399–07:18:22.435 | false | false |
| 07:18:22.710–07:18:24.487 | false | true |
| 07:18:24.740–07:18:32.049 | false | false |
| 07:18:32.303–07:18:35.069 | false | true |
| 07:18:35.321–07:18:52.937 | true | true |
| 07:18:53.197–07:18:55.471 | false | true |
| 07:18:55.725–07:19:08.037 | false | false |

整体隐藏时两窗同时 visible=false/focused=false，71 个样本；`appHidden=true` 与 `appActive=true` 的组合是原始值，未归一化，也不能据此认证外部 App 实际前台。重开后 manager 保持 hidden、helper visible/focused=true，随后 `07:18:55.558Z` App resign-active、`07:18:55.560Z` helper blur；后段直到采样结束 helper 仍 visible、focused=false。

Root 的 CUA state 查询本身可能改变焦点；本场没有记录全局前台 App，不能将这些 active/blur 转换单独归因产品或任何一次具体 CUA 调用。可以确认同冻结包在两类操作后都具备实际原生获焦片段；无法据此确认真实 CLI 组合的持续焦点、完整桌面交付或物理快捷键。

## 退出与自有资源

Root quit trigger 为 `07:19:36.894Z`，之后实际点公开菜单退出；原 case 验证 App exit 0，`normalQuit=true`。observer 在 quit 信号之前已经 dispose、清理计时器及自身监听并持久化，未用退出强制终止代替采样清理。

`07:21:00.222Z` 精确核验：runner 40704、worker 40708、App 40709 均 ESRCH；本场 userData 不存在；租约 absent；本场检查记录中 App/backend/native 活跃计数均为 0，不扩大为全系统清理保证；默认 userData dev/ino 与前置一致；v9 strict 与 ASAR 不变。Root 先用 CUA 只关闭本场自有空目录窗口，之后按 dev/ino 和空目录检查 rmdir；未操作其他窗口。control 在核匹配 run/PID/closing 和目录身份后改名 `control-archive`，保留信号和状态证据，原入口不存在、不再接收操作。

本地现场为 [`desktop/artifacts/native-focus-diagnostic-v9-20261016-cacd523f-7c4a-4f53-b1c6-9fce935db9c0/`](../../desktop/artifacts/native-focus-diagnostic-v9-20261016-cacd523f-7c4a-4f53-b1c6-9fce935db9c0/)，被忽略、不提交；内含 `execution-scope.json`、`controller-owned.json`、`owned-snapshot.json`、`root-actual-actions.json`、`control-archive/`、`run.log`、`runner-exit.json`、`diagnostic-analysis.json`、`resource-verification.json` 及原 case observations/results。原始样本和事件为首要证据，分析文件保留逐阶段全部状态转换。

本次没有业务数据、私人聊天、凭据或画面落盘；没有新增产品读取或发送能力。仅认证本场诊断执行与记录，不认证持续焦点、完整交付或根因，也不补勾 18 的真实 CLI／视觉组合验收或其他原票条件。
