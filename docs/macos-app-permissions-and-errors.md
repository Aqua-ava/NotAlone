# macOS App 权限与启动错误记录

状态：维护中  
最后更新：2026-09-08  
适用范围：`NotAloneApp.app`、`NotAloneSyncProbe.app`、`notalone-sync-probe` 和随主 App 打包的 `wechat-cli`

这是一份长期维护的权限与错误台账。凡是新增系统权限、修改权限说明文字、替换 CLI/探针、调整签名或新增用户可见错误，都必须先更新本文档，再更新代码、构建脚本和回归验证。

## 1. 产品边界

NotAlone 的本地读取必须满足以下条件：

- 只读取用户已确认绑定的微信联系人范围；联系人数据按 `owner_id + contact_id` 隔离。
- `wechat-cli` 只读读取本机微信数据；不得通过 CLI、后台进程或 Tool 发送微信消息。
- 屏幕采集只用于微信处于前台时定位当前会话；原始画面只在端侧内存中处理，不持久化、不上传。
- 权限申请必须对应明确功能，不能为了绕过错误而改成更宽泛的权限或要求用户开启 Full Disk Access。

## 2. 当前权限清单

当前正式路径只有两类 macOS 权限申请。其他权限不应被 NotAlone 主动申请。

| 编号 | 权限 | 触发目标 | 配置位置 | 触发时机 | 允许后能做什么 |
| --- | --- | --- | --- | --- | --- |
| P-01 | 访问其他 App 的数据 | `NotAloneApp.app` 启动签名后的 `wechat-cli` | `macos_app/App/Info.plist` 的 `NSAppDataUsageDescription` | 用户开启 CLI 全量同步，并且后台需要读取已绑定会话时 | 通过本机只读 CLI 更新已绑定微信会话消息 |
| P-02 | 屏幕与系统音频录制 | 主 App 启动的前台同步探针，或独立菜单栏探针 | `macos_app/App/Info.plist`、`macos_sync_probe/App/Info.plist` 的 `NSScreenCaptureUsageDescription` | 用户进行前台微信会话定位/屏幕采集时 | 在微信前台读取当前窗口的会话标题、选中行和聊天区域定位信息 |

### P-01：访问其他 App 的数据

系统弹窗标题和说明目前是：

> “NotAloneApp.app”想访问其他 App 的数据。
>
> NotAlone 仅在你开启 CLI 全量同步后，通过本机只读 CLI 读取已绑定的微信会话数据，用于更新消息；不会发送消息或读取未绑定联系人。

这是正常的一次性授权入口，但在同一个稳定签名的构建中，不应随每轮同步、每个联系人或每次 CLI 子进程启动重复弹出。

#### 已记录的历史错误

2026-09-08 曾出现以下组合：

- 系统授权框持续重复出现；
- App 同步状态显示 `cli_command_failed`；
- CLI 失败输出中出现 `tool_error`；
- Follow 流显示未运行。

确认根因不是权限说明文案，也不是联系人绑定，而是 App 只打包了 `wechat-cli`，漏掉它运行时动态加载的 `libWCDB.dylib`。bundled CLI 启动即退出，同步流程反复创建失败访问进程，最终表现为权限框反复出现。

永久防线：

1. `macos_app/scripts/build_app.sh` 必须同时复制并签名 `wechat-cli` 与 `libWCDB.dylib`。
2. `BackendSupervisor` 通过 `WECHAT_CLI_WCDB_LIB` 显式传入动态库路径，不依赖 Finder 的工作目录。
3. 缺少动态库时不得留下半可用的 bundled CLI；后端应回退到完整的 PATH CLI。
4. 每次构建后必须验证 App、helper 和动态库的签名，以及 bundled CLI 的只读事件流能持续运行。

实现记录见：[App bundled CLI 运行时依赖修复](../.scratch/local-wechat-cli-observation/issues/09-app-bundled-cli-runtime-dependency.md)。

### P-02：屏幕与系统音频录制

这项权限只服务于前台同步探针，不等同于微信数据库读取权限。菜单栏探针启动时只检查权限，不会自动反复请求；用户点击“请求屏幕录制权限”后才调用 `CGRequestScreenCaptureAccess()`。

常见用户可见状态：

- `需要屏幕录制权限`
- `NotAlone: 请允许权限后重新检测`
- `未授予屏幕与系统音频录制权限。请在系统设置中允许启动探针的应用后重试。`
- 机器可读错误码：`screen_capture_permission_missing`

处理方式：

1. 打开“系统设置 -> 隐私与安全性 -> 屏幕与系统音频录制”。
2. 允许实际执行采集的、已签名的 NotAlone App/探针。
3. 回到菜单栏选择“重新检测权限”，不需要反复重启 App。

权限记忆依赖代码签名身份。`macos_sync_probe/scripts/build_app.sh` 和 `build_cli.sh` 优先使用本机稳定的 Apple Development 证书；退回 ad-hoc 时，每次重建都可能需要重新授权，不能把这种构建当作权限持久性验证。

## 3. 不应主动申请的权限

当前代码和 entitlements 未使用以下权限：

- Full Disk Access：不应要求用户开启；微信读取范围由只读 CLI 和已绑定联系人约束。
- Accessibility：不使用辅助功能控制微信，不点击、滚动、输入或发送。
- Automation / Apple Events：不控制其他 App 的 UI，不添加自动化权限。
- 摄像头、麦克风、通讯录、定位、蓝牙、日历和提醒事项：当前功能不需要。
- 网络访问权限：主流程只访问本机 `127.0.0.1` 后端，不因本地 HTTP 请求要求额外系统权限。

JSON 导入使用用户主动打开的文件选择器，只读取用户选择的文件；这不是启动时的系统权限申请，也不能扩展为扫描用户文件系统。

## 4. 错误对照表

| 用户看到的现象/错误码 | 含义 | 优先检查 | 不要做什么 |
| --- | --- | --- | --- |
| “想访问其他 App 的数据”反复弹出 | P-01 的访问进程反复失败或签名/打包不稳定 | `wechat-cli`、`libWCDB.dylib` 是否同时存在；签名是否稳定；只读流是否存活 | 不要让用户反复点击“允许”，不要要求 Full Disk Access |
| `cli_command_failed` / `tool_error` | CLI 已启动但命令失败 | 直接运行 `--version` 和只读 `tail`；查看是否缺动态库、CLI 版本不兼容或微信状态不可读 | 不要把原始 stderr、聊天正文或凭据显示到 UI/日志 |
| `cli_not_found` | 找不到 CLI | bundled helper、`PATH`、`NOTALONE_WECHAT_CLI` | 不要静默换成未签名的临时构建 |
| `cli_timeout` | CLI 超时 | 微信是否可读、进程是否残留、当前操作是否超出超时边界 | 不要无限创建新的 CLI 子进程 |
| `cli_output_invalid` | CLI 返回不符合 JSON/事件契约 | CLI 版本和输出协议 | 不要猜测或继续写入消息 |
| `cli_key_refresh_required` | 本机 CLI 读取密钥需要刷新 | 按 CLI 自身的本机密钥刷新流程处理 | 不要在 NotAlone 中保存或回显密钥 |
| `screen_capture_permission_missing` | P-02 未授权 | 系统设置中的屏幕与系统音频录制开关、实际签名主体 | 不要改成 Accessibility 或要求 Full Disk Access |
| `probe_not_found` / `probe_timeout` / `probe_output_invalid` | 前台定位探针不可用、超时或输出损坏 | 探针路径、签名、探针自检和前台状态 | 不要猜测当前联系人，也不要把错误联系人写入数据库 |
| `后端不可用` / `后端状态读取失败` | 本地 `notalone-server` 未启动、握手失败或 API 超时 | `~/.notalone/backend.info`、后端 PID、`127.0.0.1` API | 不要把后端连接问题误判为 macOS 权限问题 |
| `后端返回错误状态 500`（生成候选时） | 模型运行或 Skill 辅助资源读取失败；不是 macOS 权限弹窗 | 模型服务连通性、Skill 资源是否属于当前版本、是否出现重复 `read_file`；先重试候选生成 | 不要反复点击权限允许，不要回显模型原始错误，也不要因此发送消息 |
| `回复生成超时` / `本次生成尝试过多` | 模型或只读 Tool 在本次有界运行内未完成 | 运行预算、模型响应、Skill 资源反馈和候选请求台账 | 不要把未完成请求当成已生成或已发送 |
| `Follow 流：未运行` | Follow 当前没有启动或已退出 | Follow 控制状态、CLI 可用性和用户是否启动人工验证 | 不要把状态文字当作消息发送失败，也不要自动发送消息 |

适配层只向 UI 暴露稳定错误码和安全说明，不回显 CLI 原始输出、数据库路径、完整会话标识、聊天正文或凭据。相关实现：[CLI 错误定义](../src/notalone/wechat_cli/errors.py)、[前台探针适配器](../src/notalone/front_sync/probe_adapter.py)。

## 5. 构建前后的固定检查清单

### 构建检查

- [ ] 只使用 `zsh macos_app/scripts/build_app.sh` 构建主 App。
- [ ] 主 App 的 `Contents/Info.plist` 保留 P-01/P-02 两个说明键，文案和本文档一致。
- [ ] `Contents/Helpers/wechat-cli` 存在且可执行。
- [ ] `Contents/Helpers/libWCDB.dylib` 存在且可读。
- [ ] helper、动态库和主 App 使用稳定签名；无稳定证书时明确标记为 ad-hoc。
- [ ] 运行 `codesign --verify --deep --strict --verbose=2 macos_app/build/NotAloneApp.app`。

### 自动化检查

- [ ] `swift test -q`（`macos_app`）。
- [ ] `swift test -q`（`macos_sync_probe`）。
- [ ] `conda run --no-capture-output -n NotAlone python -m unittest discover -s tests -q`。
- [ ] `git diff --check`。
- [ ] 使用 bundled CLI 运行一次只读 `tail --mode sessions --follow --jsonl --strict-read-only`，确认进程不会立即退出。

### 人工验收

- [ ] 干净启动新构建的主 App：P-01 最多首次出现一次，不得按同步轮次重复出现。
- [ ] P-01 授权后，只能看到已绑定范围的只读同步；不发送消息。
- [ ] P-02 由用户明确点击请求，授权后用“重新检测权限”恢复，不重复弹窗。
- [ ] 微信不在前台、会话无法定位或权限缺失时，系统应失败关闭，不猜测联系人。
- [ ] 选中已绑定联系人的消息或输入改写草稿后，候选生成显示 1-3 条可编辑文本、依据和引用；生成失败不触发任何外部发送。
- [ ] 真实微信验收与本地自动化分开记录；自动化通过不能代替用户手动操作微信。

## 6. 新增权限或新弹窗时的变更规则

发现新的系统弹窗或用户可见错误时，先记录以下信息，再改代码：

1. 弹窗标题和完整说明文字。
2. 触发它的 App bundle id、可执行文件、父进程和具体用户动作。
3. 是首次申请、重复申请，还是权限已有但功能失败。
4. 读取范围、写入范围和是否会接触真实联系人数据。
5. 可复现命令、稳定错误码、最小回归测试和人工验收步骤。

然后同步更新：

- 本文档的权限清单和错误对照表；
- 对应 `Info.plist`、entitlements 和构建/签名脚本；
- 自动化回归测试；
- `macos_app/README.md` 或 `macos_sync_probe/README.md` 的用户操作说明；
- 对应 `.scratch/` 任务文件及验证结果。

未经上述记录和验证，不得把新的系统权限申请直接交给用户处理。
