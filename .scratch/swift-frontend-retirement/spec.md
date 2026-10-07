# 清理旧 Swift 主界面

状态：已完成，验证与双轴审查通过。基线：`b6e53cb8e0d396fd4a44fd827ceb4c94de00c9a4`。

## 用户请求

用户已选择后续使用 TypeScript + React，并明确要求本轮“先进行清理就好了”，新 UI 由用户另行重新设计。本轮删除旧 Swift 主界面，不制作新 UI，也不迁移旧布局。此前为新前端临时创建的脚手架一并撤回。

## Implementation Decisions

- 删除 `macos_app/` 的 SwiftUI 视图、状态、HTTP/SSE 客户端、后台监管器、Swift 包、测试、权限配置、构建脚本及 README。
- 保留 `src/notalone/` 的 Python 后台、HTTP/SSE 契约、数据库与迁移、全部业务测试，以及 `macos_sync_probe/` 的 Mac 原生截图、OCR、定位和独立调试入口。
- 安装脚本只构建原生探针，不再调用旧主 App 构建或提示打开不存在的应用；README 如实说明桌面界面和首启向导暂不可用，CLI 入口保留。
- 用新 ADR 局部修订旧 SwiftUI 宿主决策，保留旧 ADR 与权限历史记录；不声明 React、Electron 或 Windows 集成已经实现。
- 不触碰 `.env`、凭据、数据库、真实聊天、绑定、正在运行的进程、权限设置或旧的本机构建产物。

## Testing Decisions

这是删除及入口清理，不新增实现或重复测试。运行安装脚本语法检查、旧入口引用检查、原生探针现有测试和构建，以及使用合成数据的现有 Python 后台核心契约／退出停读测试；不执行机器级安装脚本或真实微信读取。完成后按仓库工作流进行 Standards / Spec 双轴审查，并创建本地提交。

## Out of Scope

新 UI 的视觉与交互设计、React/Electron 脚手架、跨平台打包、Windows 微信适配、后台重构、数据迁移、外部发送、push 和 PR。

## 验收

1. 版本库中不再存在旧 Swift 主界面源码；Mac 原生探针代码与 Python 后台保持原样。
2. 当前安装和使用文档不再指向已删除的主 App 入口，并说明暂时没有主窗口。
3. 没有引入新 UI 或替代布局；合成验证与实际未验证部分如实记录。

## 验证记录

- `zsh -n scripts/install.sh` 与 `git diff --check` 通过；当前 README、安装脚本、探针 README 和工程入口中没有旧 App 构建／打开调用。
- `swift test --package-path macos_sync_probe --scratch-path /tmp/notalone-swift-retirement-probe-tests -q`：35 项通过，CLI 和独立菜单栏目标编译成功。临时目录中的 `notalone-sync-probe --self-test` 通过；未运行采集。
- 加载 `conda shell.zsh hook` 并 `conda activate NotAlone` 后，`NOTALONE_DISABLE_DOTENV=1 python -m unittest tests.unit.server.test_runtime_shutdown tests.unit.server.test_connection_info tests.integration.server.test_app tests.integration.server.test_message_api tests.integration.server.test_reply_api tests.integration.server.test_memory_api tests.integration.server.test_setup_api tests.integration.server.test_import_task_api tests.integration.server.test_events -q`：92 项通过。只使用合成测试回调和 `_test` 库夹具；初次尝试因 shell 未初始化 Conda 而失败，初始化后重跑通过。
- `git diff --numstat -- src tests database pyproject.toml macos_sync_probe/Sources macos_sync_probe/Tests macos_sync_probe/scripts` 为空；Python、数据库和原生探针实现未改动。
- 删除了 37 个旧主界面版本库文件；本轮临时创建的 `desktop_app/` 已撤回，没有新 UI／脚手架。旧本地忽略构建产物保留，不属于源码或提交。
- 未执行机器安装脚本、真实 App／微信／模型或 Windows 集成；没有读取、迁移或删除真实用户数据。当前无主窗口与图形首启向导，后续 UI 另行设计。
- Standards / Spec 初审各发现同一处 README 残留页面描述，已改为当前后台接口说明；复审两轴均 0 项剩余。旧 ADR 的正文与原因保留，仅追加指向 ADR-036 的局部修订备注。
