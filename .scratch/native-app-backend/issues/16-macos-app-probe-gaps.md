# macOS App 与前台探针遗留项（第三轮审查）

Triage: needs-triage
State: open

## 背景

2026-09-18 第三轮只读审查（macos_app 与 macos_sync_probe 全量 Swift 源码 + 迁移与脚本）。同轮已修复：握手文件默认路径不展开 `~`（Finder 启动 CWD=/ 时解析成 `/~/.notalone/...`，复用既有后端与崩溃恢复整体失效）、BackendSupervisor 并发 launch 重入（continuation 被覆盖造成永久挂起 + 共享 Process 实例被并发 terminate；改为 Mutex 内原子登记 LaunchFlight、多等待者共享同一次结果、connection/lastError/lastExitCode/readBuffer 全部纳入锁）、后端重启后 SSE 客户端仍指向旧端口（attach 检测连接变化时重建）、探针 CLI 的 stdout 契约（参数错误改走 stderr 并以非零退出）、`--watch` 循环被单次瞬态错误杀死（窗口/区域/OCR 瞬态失败按跳过本轮处理，权限缺失才退出）、install.sh 首装路径（keg-only psql）与迁移 035。以下为遗留项。

## Swift App（macos_app）

1. **BackendSupervisor 读取缓冲与终止回调的剩余竞态**：状态已合并进 Mutex，但 `Process.isRunning`/`run()`/`terminationHandler` 的时序（旧进程 terminationHandler 在新 launch 后异步触发读 stderr）仍可能覆盖 `lastError` 文案。需要以"每代进程一个状态快照"方式彻底隔离。
2. **`requestWithBody` 把所有 409 归为"回复被拒绝"**（`BackendClient.swift:621-627`）：导入提交的 409 `import_commit_failed` 无 `reason` 字段，界面显示"回复被拒绝：unknown"，误导。建议按端点/错误码区分映射。
3. **置信度按百分数格式化恒显示 0%/1%**（`MainWindowView.swift:729,824`）：后端 confidence 是 0–1，`%.0f` 直接当百分数。改为 `%.0f%%` 前先乘 100 或 `%.1f` 比例展示。
4. **SSE task.progress 用上一个任务的 errorCode 回填新任务**（`AppModel.swift:256-264`）：后端 TaskProgressPayload 不含 error_code（`sse.py:48-56`），建议后端补字段或前端在新任务开始时清空。
5. **`BackendClient.init` 对握手地址强制解包**（`BackendClient.swift:33`）：`URL(string:)!` 对用户可写、可能被篡改的握手文件崩溃；对齐 `SseEventClient` 的可选绑定。
6. **断线对账只补拉最新 50 条**（`AppModel.fetchLatestAndMerge`）：突发 >50 条时中间消息静默丢失且 `knownMessageIds` 记忆导致后续不补；需按页推进补齐到已知水位。
7. **attach 时 `checkSetupStatus` 单次失败 → SSE 永不启动且无重试**（`AppModel.swift:995-1009`）。
8. **Info.plist 声明无效键 `NSAppDataUsageDescription`**：非 Apple 认可的 usage key，属误导性死配置。
9. **`build_app.sh` 未指定 `-swift-version 6`**：打包产物与 `swift build` 的语言模式/并发检查强度不一致。

## 前台探针（macos_sync_probe）

10. **全部重活压在 MainActor**（`CaptureSupport.swift:422`、`MenuBarProbeApp.swift:372-401`）：像素复制 + 全图边界扫描 + Vision `.accurate` OCR 同步执行于主线程，每帧可阻塞数百毫秒到秒级，菜单栏与轮询卡顿；需移到后台执行。
11. **`previousHash` 仅在 OCR 成功后更新**（`MenuBarProbeApp.swift:386-393`，注释表明刻意）：持续失败时每秒无限重试截图+全图扫描，无退避告警；与 10 叠加成周期性冻结。设计取舍需要决策（失败时是否更新 hash 或引入退避）。
12. **`--session --json` 中 Vision 瞬态错误被归类 `probe_failed`**（`main.swift:193-210`）：按设计"证据不可读"应是稳定 `ok:true`；瞬态 OCR 失败被报成环境失败。需要区分"证据不可读"与"环境级失败"。
13. **JSON ok:false 路径退出码仍为 0**（按 in-band 契约设计）：shell 条件判断的调用方把失败当成功；需要契约决策（文档化或改退出码）。
14. **同步轮询 Task 无防重入**（`MenuBarProbeApp.swift:95-97`）：后端挂起时每 3s 堆积一个 Task（URLSession 60s 超时），最多约 20 个并发轮询。
15. **`SCShareableContent.excludingDesktopWindows(false, …)`**（`CaptureSupport.swift:444-447`）：与"最小范围"注释意图相悖（结果由 bundleID 过滤兜住，仅多枚举）。
16. **探针菜单栏 App Timer→target 强引用环**：App 生命周期对象，不构成真实泄漏，仅记录。

## 为什么没抓到

App target 无自动化测试（Package.swift 只覆盖 NotAloneAppCore）；竞态需要真实时钟交错；菜单栏 App 人工验证用标准微信布局且把卡顿归因于 OCR 本身；CLI 参数路由无测试。

## Comments
