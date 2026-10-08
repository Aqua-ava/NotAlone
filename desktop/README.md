# 桌面端

Electron + React/TypeScript 的本机 Mac App，当前完成管理后台与横向输入小窗。两个窗口独立打开，关闭时隐藏，可从原生“窗口”菜单恢复；“NotAlone → 退出 NotAlone”明确退出。小窗标题区域可拖动。

此阶段尚未连接 Python 后端，页面如实显示“尚未连接”，联系人、导入、资料、同步、生成和候选复制均未就绪。不会启动 Python、访问业务库、默认握手或 `.env`，也不运行微信 CLI/探针、不申请系统权限。全局快捷键、菜单栏状态入口与业务能力由后续任务接入，不能将本阶段的窗口验收视为业务集成可用。

## 本机运行与构建

需要 macOS 13 或更新版本、Node.js ≥ 22.12，以及构建图标/本机签名所需的 Xcode Command Line Tools。依赖版本固定在 `package-lock.json`。

```bash
cd desktop
npm ci
npx install-electron     # 首次显式准备锁定版本的 Electron 运行时
npm run typecheck
npm run test:app
npm start
npm run package
```

本机 arm64 产物为 `out/NotAlone-darwin-arm64/NotAlone.app`。可在 Finder 双击打开；包只包含编译后的本地资源和最小启动清单，不依赖开发服务器、原型目录或仓库绝对路径。打包只替换本目录的 `out/` 产物，不覆盖历史 App。当前为 ad-hoc 本机签名，未做 Developer ID 分发、公证或 DMG；权限与签名边界见[台账](../docs/macos-app-permissions-and-errors.md)。

## 实际 App 自动化

使用 Playwright 的 experimental Electron 支持，在真实窗口上操作公开按钮和原生关闭/菜单。测试使用独立随机用户数据目录并正常回收进程；不读取 React 私有状态，不访问已有业务数据。构建源码资源与打包 App 共用同一行为测试：

```bash
npm test
NOTALONE_TEST_APP_EXECUTABLE="$PWD/out/NotAlone-darwin-arm64/NotAlone.app/Contents/MacOS/NotAlone" \
  npx playwright test tests/windows.spec.ts --output=artifacts/packaged
```

窗口测试验证双窗口打开、关闭隐藏、互相恢复、菜单恢复、退出回收，以及随包 logo 加载和真实未就绪状态。`npm test` 还通过隔离构建副本的入口资源缺失，验证安全中文说明和公开菜单重试；不修改签名包。截图在 `test-results/` 或指定 `artifacts/` 目录中，均不提交。它不证明后端握手、联系人隔离、快捷键、剪贴板、权限或退出停读已验收。

## 工程边界

| 目录 | 职责 |
| --- | --- |
| `src/main/` | 窗口、原生菜单、当前 App 生命周期和本地资源路由；后端生命周期尚未接入 |
| `src/preload/` | 只暴露打开管理后台、打开小窗、隐藏调用方窗口三个具名操作 |
| `src/renderer/` | React 界面、交互与展示状态 |
| `src/shared/` | 跨进程桥接类型 |
| `tests/` | 实际 Electron App 公开行为自动化 |
| `scripts/` | 本地资源编译、白名单打包、图标与 ad-hoc 签名 |

渲染层开启 context isolation、进程沙箱、关闭 Node 集成；正常界面只从受控 `notalone://app/` 资源加载，设置 CSP、拒绝导航/新窗口/网页权限。主进程校验桥接的窗口、主框架、精确资源来源和零参数。入口资源失败时使用无脚本的安全中文说明页，来源校验拒绝它调用桥接；可从原生菜单重试。临时界面会话使用内存分区；默认应用配置目录是 `~/Library/Application Support/NotAloneDesktop`，与历史 App 分开，当前不保存草稿或业务数据。

联系人、导入、数据库、记忆、检索及候选生成由 [Python 后端](../backend/README.md)提供。平台原生截图、OCR 与会话定位由 [Mac 原生探针](../native/macos/README.md)提供，Windows 平台适配尚未实现。

新 UI 继续遵守[产品边界](../CONTEXT.md)：用户确认联系人与读取范围、查看并编辑候选、亲自发送；后端接入后桌面退出必须停止本次后台读取。原 Swift 主界面已按 [ADR-036](../architecture/adr/036-retire-swift-main-interface.md) 退役，新宿主边界见 [ADR-037](../architecture/adr/037-electron-dual-window-host.md)。

已核对的官方接口资料：[Electron 安全](https://www.electronjs.org/docs/latest/tutorial/security)、[BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)、[App 生命周期](https://www.electronjs.org/docs/latest/api/app)、[资源协议](https://www.electronjs.org/docs/latest/api/protocol)、[打包器](https://electron.github.io/packager/main/)、[Playwright Electron](https://playwright.dev/docs/api/class-electron)。锁定 Electron 44.7.0 / Playwright 1.64.0 在本机已实际运行；文档和版本锁定本身不能替代上述验收。
