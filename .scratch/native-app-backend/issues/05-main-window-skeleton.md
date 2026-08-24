# 05 — 主窗口骨架：联系人列表、同步开关、菜单栏降级

Type: task

**Triage:** ready-for-agent
**State:** resolved

**What to build:** 用户双击打开带主窗口的 NotAlone 应用：三栏骨架的左栏显示联系人列表与同步状态角标，可以开启/关闭前台增量同步并立即看到状态变化；菜单栏应用降级为轻量状态入口，查询后端状态，不再周期性拉起子进程；主窗口应用负责拉起并监管后端子进程，退出时一并收掉。

**Blocked by:** 01（后端服务骨架与进程内测试接缝）

- [x] 主窗口应用为独立 Swift Package，位于仓库根目录、与探针包平级；形态为正常窗口应用。
- [x] 应用自动拉起并监管后端子进程（沿用 conda 环境路径探测经验），退出时收掉；后端不可用时界面给出清晰错误。
- [x] 左栏联系人列表含展示名称与同步状态角标，保持 owner 范围隔离。
- [x] 同步开关操作经后端 API 生效，菜单栏与主窗口立即反映状态。
- [x] 菜单栏应用停止每 3 秒拉起子进程轮询，改为查询后端；保留开关键与状态显示。
- [x] 屏幕录制权限只需授予主窗口应用，探针作为其子进程运行；探针调试窗口暂时保留在菜单栏应用中。

## Comments

- 来源规格：`.scratch/native-app-backend/spec.md`。架构依据：ADR-020。
- 屏幕录制权限与签名身份经验见仓库既有冒烟记录（探针重建需稳定签名）。

## Answer

- 后端新增同步控制面：`SyncHost`（`server/sync_host.py`）在常驻进程内按心跳驱动前端同步循环，替代菜单栏 3 秒轮询子进程；共享装配工厂 `front_sync/factory.py` 供 CLI 与 server 复用（薄壳架构），`FrontSyncEngine.sync_enabled()` 供宿主判断开关。
- 后端 API 新增 `/api/sync/{status,enable,disable,check}`，JSON 契约由进程内契约测试钉住（不含消息正文，无同步宿主时 503 `sync_unavailable`）；`notalone-server` 接线 SyncHost 与握手文件。
- 菜单栏与主窗口的跨进程连接经握手文件（`~/.notalone/backend.info`，0600，写入 address/token/pid，退出或 SIGTERM 时清理）；第二个后端实例经 pid 探测拒绝启动，落实 ADR-020「一次只能有一个后端实例驱动同步」。
- Swift 新增 `macos_app/` 包：`NotAloneAppCore`（握手解析、HTTP 客户端、进程监管 supervisor）+ `NotAloneApp`（SwiftUI 三栏窗口：左栏联系人列表含同步角标与开关、中/右栏占位，后端不可用错误横幅，3 秒轮询，崩溃自动重启）；菜单栏应用改为查询 `/api/sync/*`，保留开关键、状态显示与 OCR 调试窗口，删除两级绑定确认子菜单（确认入口由 07 主窗口提供，CLI `confirm-binding` 兜底）。
- 验证：新增 29 项 Python 测试（SyncHost 单元、sync API 契约、握手文件、`notalone-server` 子进程级 SIGTERM/单实例冒烟）；`unittest` 全量 526 项通过（2 项真实模型冒烟跳过）；`swift build`（macos_app 与 macos_sync_probe）与 `swift test`（探针包 21 项）通过；`compileall` 与 `git diff --check` 干净。
- 双轴 code-review（Standards + Spec）无遗留硬违规；修复项包括测试断言私有字段、死代码 `_CHANNEL`、Middle Man 转发、factory 弱类型、菜单栏 503 文案、failed 状态单行道、SIGTERM 清理、单实例检测与 docstring 播种语义。
- 数据影响：仅新增内存线程与本地握手文件；全量测试使用合成 UUID 与 `_test` 库，不触碰生产数据。冒烟曾对正式库 owner 开关做 enable/disable 并恢复原状，无消息写入。
- 剩余风险：SSE 状态推送尚未接线（同步状态经 3 秒轮询反映，消息流实时推送属 06 票）；真实微信前台下的端到端表现与屏幕录制权限授予需人工冒烟（沿用既有冒烟记录惯例）。