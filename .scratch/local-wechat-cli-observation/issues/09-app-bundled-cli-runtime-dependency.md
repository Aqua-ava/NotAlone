# 09 — App bundled wechat-cli 运行时依赖修复

Type: task
Triage: ready-for-agent
State: resolved
Blocked by: none

## What to fix

修复 macOS App 启动 bundled `wechat-cli` 时找不到 `libWCDB.dylib`，导致全局
CLI 只读事件流立即退出、同步状态显示 `cli_command_failed`，并让系统反复弹出
“NotAloneApp.app 想访问其他 App 的数据”授权框的问题。

## Confirmed evidence

- 终端中的用户安装版 `wechat-cli` v1.6.20 可以保持全局 sessions 只读流运行。
- App 构建产物中的同版本 `wechat-cli` 单独启动即返回 `tool_error`；错误明确指出
  缺少 `libWCDB.dylib`。
- App 原先只复制 `wechat-cli` 可执行文件，没有复制其运行时动态库。
- 用户界面表现为跨 App 数据授权框持续重复出现；根因是 bundled CLI 启动失败后，
  同步流程不断创建新的失败访问进程，而不是授权文案或联系人绑定逻辑本身。
- 本次诊断只读取 CLI 状态/事件流，没有发送微信消息，也没有扩大 NotAlone 数据写入范围。

## Implementation

1. `macos_app/scripts/build_app.sh` 同时复制 `wechat-cli` 与 `libWCDB.dylib` 到
   `Contents/Helpers`，分别签名；依赖不完整时不再留下半可用 bundled helper，后端回退
   到 PATH 中的用户安装版本。
2. `EnvironmentLocator` 增加 bundled 运行时库定位；`BackendSupervisor` 将库路径通过
   `WECHAT_CLI_WCDB_LIB` 传给后端，避免依赖 Finder 启动时的工作目录。
3. 新增 Swift 回归测试，锁定 App 构建目录能找到 bundled 动态库。

## Verification

- 先运行回归测试，确认旧代码因缺少定位接口失败；补实现后
  `swift test -q --filter BackendConnectionTests`：6/6 通过。
- `zsh macos_app/scripts/build_app.sh`：构建成功，并输出已打包 `libWCDB.dylib`。
- 使用重建后的 bundled CLI 启动全局只读事件流：收到事件，流未异常退出。
- 干净重启重建后的 App：bundled 全局流与联系人只读子进程保持运行，未再观察到
  重复授权弹窗。
- `codesign --verify --deep --strict --verbose=2`：App、CLI 和动态库签名有效。
- `git diff --check`：通过。

## Temporary boundary and removal condition

这是 App 打包兼容层，不改变 CLI 读取范围、联系人绑定、cursor、消息写入或手动发送边界。
只有当未来 `wechat-cli` 发布版本确认自带自包含运行时，且新的 bundled CLI 全局流冒烟
连续通过后，才可以移除动态库复制与环境注入；移除前仍需保留回归测试或替换为等价的
打包完整性检查。

## Answer

已完成。下一步仍是重新启动使用新构建产物的 NotAlone App，再由用户手动执行原有的
Follow 人工验收；本地自动化通过不等于真实微信消息验收通过。
