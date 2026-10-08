# 01：双窗口 App 与品牌外观

Type: task
State: resolved
Triage: ready-for-agent
Blocked by: None
Spec: ../spec.md

## 交付行为

运行实际 Electron App，分别打开管理后台和输入法式小窗，使用已审阅的 logo、水彩风格和横向候选布局。

覆盖规格用户故事：8、12。

## 验收条件

- [x] 打包资源可加载，两个独立窗口可打开、关闭隐藏、恢复；管理后台和小窗形态对应已审阅原型。
- [x] React/TypeScript 类型检查与实际 Electron 双窗口自动化冒烟通过；退出回收 App 进程。
- [x] 只搭建本任务所需的窗口及页面，不把原型模拟数据当成业务结果。

## 测试与范围

- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Comments

- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。
- 2026-10-08：在独立工作树、分支 `codex/mac-app-01-windows` 开始实现；固定评审基础为 `8748d1517df2f2e9a48868b0dc269725fed21d9f`。测试使用实际 Electron App 的公开按钮、原生窗口/菜单操作和可见结果，独立用户数据目录；本任务不启动 Python、不读取握手/.env、不访问业务库、微信或外部模型。
- 2026-10-08：验收完成；两轴复核均无剩余问题。向自己的分支执行 `git merge --no-edit codex/mac-desktop-app`，最新集成 tip 仍为上述基础，结果 `Already up to date.`；未切换主工作区或集成工作树分支，未执行任何远端 Git 操作。

## Answer

已交付实际 Electron 管理后台与 680×216 横向输入小窗，沿用已审阅的原始 logo、淡蓝水彩、米白纸张及少量拼贴。关闭隐藏、互相打开、原生菜单恢复和明确退出均通过实际窗口验收；未连接业务使用中文空/未就绪状态，联系人、生成和复制不可执行。

### red → green

1. 实际 Electron 成功启动后，双窗口行为测试先因缺少“联系人与绑定”可见界面失败；最小实现窗口与公开控制后通过。
2. 品牌/未就绪行为测试先因找不到 NotAlone logo 失败；加入原件和真实空状态后通过。
3. 工程评审发现加载失败路径后，隔离构建副本移走入口 HTML 的真实 App 测试先因缺少中文安全说明失败；修复为销毁失败窗口、无脚本说明页、公开菜单重试后通过。故障只在隔离副本中制造，不修改签名包或应用私有模块。

### 命令与结果

以下命令在 `desktop/` 执行，实际平台为 macOS 15.7.5 / arm64；Electron 44.7.0、React 19.3.0、TypeScript 7.0.2、Playwright 1.64.0 已精确锁定并实际运行。

| 命令 | 实际结果 |
| --- | --- |
| `npm install --no-audit --no-fund` | 安装并生成锁文件成功；首次 Electron 下载较慢，使用官方 GitHub 发行包并校验 SHA256 后完成运行时准备 |
| `npm run typecheck` | 通过 |
| `npx playwright test tests/errors.spec.ts` | 先 red；实现后 1 项通过 |
| `npm test` | 完整桌面测试 3 项通过，全部操作真实 Electron App |
| `npm run package` | 编译、本机白名单打包和 ad-hoc 签名通过 |
| `NOTALONE_TEST_APP_EXECUTABLE="$PWD/out/NotAlone-darwin-arm64/NotAlone.app/Contents/MacOS/NotAlone" npx playwright test tests/windows.spec.ts --output=artifacts/packaged` | 当前签名包的 2 项窗口/品牌行为测试通过；退出码 0 |
| `codesign --verify --deep --strict --verbose=2 out/NotAlone-darwin-arm64/NotAlone.app` | 主 App 和嵌套框架/Helper 严格验证通过 |
| `codesign --display --verbose=2 --entitlements - …`、`plutil -p …/Contents/Info.plist` | identifier 为 `com.notalone.desktop`；签名为 ad-hoc，仅有 `allow-jit`；无系统权限用途说明，ATS 任意传输关闭 |
| LaunchServices 独立启动 + 原生窗口操作 + Cmd+Q | 当前包可直接打开管理后台，打开/收起小窗；正常退出后本轮 App/Helper 进程与临时用户目录均回收 |
| 仓库根 `git diff --check` | 通过 |

### Standards

固定基础为 `8748d1517df2f2e9a48868b0dc269725fed21d9f`。只读专职评审初评 2 项：加载失败缺少安全说明（明确违反台账）和测试生命周期重复（判断建议）；均已修复。复核 `48198d98cf70cea2c4c6cd83c536f9afa2290ce2`，剩余 0 项。

### Spec

只读专职评审以本规格和第 01 张任务为范围，初评与复核均 0 项：缺项 0、范围越界 0、错误实现 0。后端连接、快捷键、剪贴板及业务退出停读属于后续任务。

两轴结果：Standards 0 剩余；Spec 0 剩余。

### 产物与接续职责

工作树为 `/Users/local-user/.codex/worktrees/mac-app-01-windows/NotAlone`，本地分支为 `codex/mac-app-01-windows`。构建产物与截图被忽略，未提交：

- App：`desktop/out/NotAlone-darwin-arm64/NotAlone.app`。
- 当前签名包的窗口截图：`desktop/artifacts/packaged/windows-管理后台和输入小窗可独立打开、关闭隐藏并恢复，退出回收进程/manager-window.png` 和同目录 `input-window.png`，均已人工查看。
- 故障说明截图：`desktop/test-results/errors-资源缺失时显示安全中文说明，修复资源后可从公开菜单重新打开/window-error.png`，已人工查看。

`src/main/index.ts` 负责 App 生命周期、原生菜单与窗口 IPC 装配；`windows.ts` 负责创建、打开/隐藏/恢复、错误重试和调用来源验证；`resources.ts` 负责随包协议与网页权限拒绝。`src/preload/index.ts` 和 `src/shared/window-bridge.ts` 只暴露三个具名窗口操作。`src/renderer/index.tsx` 负责两窗口可见交互，`pages.ts` 提供管理页文案，样式/图标/logo 独立。`tests/app-fixture.ts` 集中管理真实 App 与临时目录；测试入口及打包运行方式见 `desktop/README.md`。

### 数据影响与边界

只使用公开品牌资源、随包静态资源和随机隔离用户目录。没有启动 Python、读取默认 `backend.info` 或 `.env`、访问业务库/微信/私人资料/模型凭据、调用原生采集、申请系统权限或发送消息。没有停止或替换历史 App/探针，未修改 TCC。签名仅面向本机 arm64 运行，没有 Developer ID、公证或公共分发验收。

本任务无阻塞或未验收项。后端、联系人绑定与读取、导入、资料、同步、模型生成、剪贴板、快捷键、菜单栏状态及认证退出停读保持后续任务范围，窗口验收不证明业务集成可用。
