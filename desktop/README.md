# 桌面端

Electron + React/TypeScript 的本机 Mac App，当前完成管理后台与横向输入小窗。两个窗口独立打开，关闭时隐藏，可从原生“窗口”菜单恢复；使用“隐藏 NotAlone”整体收起后，窗口菜单只恢复所选窗口。“NotAlone → 退出 NotAlone”明确退出。小窗标题空白区域可拖动，底部图钉按钮可切换置顶；隐藏和恢复保留本次置顶状态，管理后台保持独立。

主进程认证连接本机 Python 后端，并在两个窗口显示真实连接状态。重复启动只恢复已有 App；关闭窗口继续隐藏，明确退出先阻止新业务，再通过原已验证连接确认停读。连接或退出失败保留安全说明和重试入口。联系人、导入、资料、同步管理、生成和候选复制仍未接线，不能把连接成功当作业务闭环可用。

“应用配置 → 本人身份与模型”已沿用后端 setup 接口：空库等待用户明确初始化本人，App 固定使用 `create_only`，服务端在同一事务内原子检查和创建；发现既有身份时拒绝并保持本轮配置不变。`setup/status` 的只读 `runtime_owner_configured` 核对当前实例受控身份在同库存在，就绪时直接复用。全库已有本人但本次运行身份缺失或不存在时提示检查受控配置，不自动选取其他身份。

本人初始化或 DeepSeek 密钥保存成功后，先认证停读同一服务，等待旧运行时退场，再通过正常启动检查重连。初始化已写库和配置而响应丢失时，用户可明确选择“重新加载受控配置”；重载只读取实际配置，不重复初始化。失败显示真实结果，恢复查询结束后再次复核连接与操作，旧错误不能覆盖断线或较新状态。密钥输入为密码框，提交后清空，页面只显示是否配置；配置本身不会发起模型调用。页面说明本机配置文件和 PostgreSQL 资料长期保存、未提供静态加密，以及供应商外部副本的独立删除限制。

后端生产启动会沿用本人身份和已确认同步范围；每次启动或复用前先通过机器环境只读诊断，连接状态不能代替数据库就绪。测试使用本轮随机新建的隔离 `_test` 库、握手、配置与 userData，不访问既有业务库、模型或微信。主进程才持有认证 token，渲染层只收到具名操作和非秘密状态。
已接入默认 `Command+Shift+Space` 的系统注册与小窗显示/隐藏回调。在“应用配置 → 桌面操作”查看真实注册结果并修改组合；无效、注册失败或保存失败时保留旧键与旧设置。支持 `Command`、`Control`、`Alt`、`Shift` 加字母、数字、F1–F24 或常用导航键，至少需要前三种修饰键之一。注册结果不保证该组合没有被其他程序处理；本轮 CUA 输入没有验证全局键实际派发，真实快捷键验收仍待完成，可先使用公开按钮和“窗口”菜单。

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

包含真实 Python 宿主的测试需先激活 Conda `NotAlone`。测试使用当前工作树的 `backend/src`，隔离 dotenv 的读取和写回、握手、owner、模型、CLI/探针和 App 配置。测试准备阶段只对自己随机新建的 `_test` 库显式迁移，App 始终运行真实只读诊断；完成后只清理本轮拥有的库。数据库不可用场景使用受控回环端口，其他生命周期场景使用已迁移的隔离库，不连接已有数据库。

`tests/setup.spec.ts`、`tests/setup-stale.spec.ts`、`tests/setup-recovery.spec.ts` 与 `tests/setup-concurrency.spec.ts` 使用本轮随机 `_test` PostgreSQL 库、正式迁移和真实 `notalone.server.command` / HTTP。受控解释器夹具只从独立 `synthetic.env` 加载本轮本人与合成密钥，继续禁止默认 dotenv，并把模型 URL 固定到无服务的回环端口；CLI 与探针使用不存在的本轮路径。覆盖首次初始化、既有配置、缺失或不存在的运行身份、密钥保存失败、启动失败恢复、经验证的复用服务重启、具名 IPC 限制与迟到响应失效；新增响应丢失后的明确重载、失败刷新失效，以及同库两个真实客户端并发初始化。延迟夹具只控制真实后端的 HTTP 传输，PG 锁只安排并发写入窗口，不替换业务仓储。测试完成只清理本轮库、配置和进程，不调用真实模型或微信。

使用 Playwright 的 experimental Electron 支持，在真实窗口上操作公开按钮和原生关闭/菜单。测试使用独立随机用户数据目录并正常回收进程；不读取 React 私有状态，不访问已有业务数据。构建源码资源与打包 App 共用同一行为测试：

```bash
npm test
NOTALONE_TEST_APP_EXECUTABLE="$PWD/out/NotAlone-darwin-arm64/NotAlone.app/Contents/MacOS/NotAlone" \
  npx playwright test tests/windows.spec.ts --output=artifacts/packaged
```

窗口测试验证双窗口打开、关闭隐藏、互相恢复、菜单恢复、整体隐藏后仅恢复目标窗口、退出回收，以及随包 logo 加载和真实未就绪状态。macOS 的 `hide` 菜单角色由 Cocoa 执行，`MenuItem.click()` 不执行该默认动作；自动化确认公开菜单项后，通过 `Menu.sendActionToFirstResponder('hide:')` 执行原生隐藏，再操作窗口菜单并读取两窗可见结果。实际 CUA 点击菜单另行核验同一边界。后端测试通过公开 App 操作和本机 HTTP 核验单实例、受控启动/复用、认证、断线重试、握手非法或变化、迟到状态、退出失败/超时与恢复；包含实际 `notalone.server.command` 和 `BackendServer` 的启动/停读场景。入口资源故障只修改隔离构建副本，不损坏签名包。

`tests/desktop-controls.spec.ts` 验证注册结果、改键与重启恢复、注册/保存失败保留旧键、正文置顶按钮、隐藏恢复及退出注销。注册失败场景在隔离启动包装中先安排系统注册，再同步加载原始 App 入口；只控制必要系统边界，不替换业务模块，不调用快捷键回调，签名包跳过该夹具。截图在 `test-results/` 或指定 `artifacts/` 目录中，均不提交。这些验收不证明全局键盘派发、联系人隔离、剪贴板、权限或真实微信渠道可用。

`tests/startup-diagnostics.spec.ts` 验证 Python/包缺失、数据库不可用、缺基线、账本漂移、待迁移和必要结构缺失，以及公开路径修正和重试。真实只读 Python 入口与实际 `BackendServer` 均来自当前工作树。App 以 `/` 为工作目录、清空 Conda 变量并限制 PATH，检查无需预先激活终端的启动条件；这项自动化不等同于用户在 Finder 双击的实机验收。`tests/startup-cancellation.spec.ts` 在受控 Python 包装边界延迟诊断并忽略 SIGTERM，验证超时/退出回收自有子进程、迟到结果不能启动后端；释放后仍执行真实诊断入口。

`tests/startup-setup.spec.ts` 联合真实首启 HTTP 与本轮迁移库，验证账本漂移同时阻止既有运行时复用和初始化后的重启，修正测试条件后由公开操作恢复；路径停读未获确认时，配置保持不变且不另起服务。测试只故意修改并恢复本轮已执行的账本 checksum，不提供业务库补写记录或恢复工具。

## 非秘密启动配置与退出

主进程读取当前 userData 中的 `backend-launch.json`。在“应用配置 → 机器环境”可查看、修正和保存下列非秘密绝对路径。Python 和项目目录必须同时提供；没有可核验的项目环境时阻止启动和复用，显示恢复说明：

```json
{
  "pythonExecutable": "/绝对路径/Conda环境/bin/python",
  "projectDirectory": "/绝对路径/NotAlone",
  "envFilePath": "/绝对路径/受控配置.env",
  "backendInfoPath": "/绝对路径/backend.info",
  "wechatCliPath": "/绝对路径/wechat-cli",
  "syncProbePath": "/绝对路径/notalone-sync-probe"
}
```

未保存时，`envFilePath` 默认使用所选项目根目录 `.env`，`backendInfoPath` 默认使用 `~/.notalone/backend.info`；受控运行可用 `NOTALONE_ENV_FILE` / `NOTALONE_BACKEND_INFO` 提供初始值。已保存路径优先于这些初始环境变量。CLI/探针可留空，显示对应渠道不可用；诊断只检查可执行文件，不运行 helper，缺 helper 不阻塞独立的后端配置能力。保存文件只含路径，不含配置内容、模型密钥或握手 token。

诊断固定调用已核验的绝对解释器及 `-m notalone.startup_diagnostics --migrations ...`，诊断就绪后才允许 `-m notalone.server.command`；两者从所选项目的 `backend/src` 加载代码，不依赖 Finder 的 PATH、工作目录或其他 checkout 的 editable install。只读入口使用有界连接和 READ ONLY 事务，仅核对必要 schema 元数据、审计基线与迁移账本，不读取联系人/聊天正文、不迁移或接管业务库、不创建参考库。缺基线、文件或账本漂移、待迁移和必要结构缺失分别显示恢复说明；已有业务库的升级需要另行明确授权。机器就绪与本人身份/模型首启分开显示。

连接后先点击“停止服务以修改路径”，通过原已验证目标认证确认停读并等待服务退场，才恢复路径编辑。失败保留旧目标和“重试停读并退出”，不能保存新路径或另起后端。保存不会自动连接；点击“重新检查并连接”重新经过只读门禁，重复重试不会启动多个后端。

握手必须是当前用户拥有、没有组/其他用户访问权限的普通文件，拒绝符号链接、重复字段和非法 `127.0.0.1:1–65535` 地址。HTTP 不跟随重定向，不向界面转发原始错误、stdout/stderr 或 token。认证 POST 返回 `state: stopped` 后可以退出；响应未确认时只向原连接查询状态。断线、超时和子进程消失都不能代替停读确认。退出失败会打开管理后台并保留“重试停读并退出”；不启动新读取，不改持久同步开关。只回收本 App 创建并仍持有身份的子进程，不根据握手 PID 杀复用实例。

握手和启动配置以非阻塞方式打开后再核验普通文件，拒绝符号链接；FIFO 不会卡住连接或退出，启动配置限制为 8 KiB。正常连接阶段的明确重试会重新认证最新合法握手，成功后替换连接；退出开始后则固定原已验证目标，认证中的新握手不能改变关闭目标。连接中明确退出会取消尚未发生的启动，并在最终 spawn 前复查；已创建的子进程仍等待握手、认证确认与受控收尾。

## 工程边界

| 目录 | 职责 |
| --- | --- |
| `src/main/` | 窗口、菜单、资源、单实例、全局快捷键和非秘密桌面设置；`startup/` 管理路径与只读机器门禁，`backend/` 管理启动、握手、认证 HTTP、连接与退出状态 |
| `src/preload/` | 具名窗口、桌面设置和后端桥接及非秘密状态订阅，不暴露通用 IPC、URL 请求或认证信息 |
| `src/renderer/` | React 界面、交互与展示状态 |
| `src/shared/` | 跨进程桥接类型 |
| `tests/` | 实际 Electron App 公开行为自动化 |
| `scripts/` | 本地资源编译、白名单打包、图标与 ad-hoc 签名 |

渲染层开启 context isolation、进程沙箱、关闭 Node 集成；正常界面只从受控 `notalone://app/` 资源加载，设置 CSP、拒绝导航/新窗口/网页权限。主进程校验桥接的窗口、主框架、精确资源来源、参数个数和类型。入口资源失败时使用无脚本的安全中文说明页，来源校验拒绝它调用桥接；可从原生菜单重试。临时界面会话使用内存分区；默认应用配置目录是 `~/Library/Application Support/NotAloneDesktop`，与历史 App 分开；`desktop-settings.json` 只保存 `helperShortcut`，不保存草稿、候选、置顶状态或业务资料。

联系人、导入、数据库、记忆、检索及候选生成由 [Python 后端](../backend/README.md)提供。平台原生截图、OCR 与会话定位由 [Mac 原生探针](../native/macos/README.md)提供，Windows 平台适配尚未实现。

新 UI 继续遵守[产品边界](../CONTEXT.md)：用户确认联系人与读取范围、查看并编辑候选、亲自发送；后端接入后桌面退出必须停止本次后台读取。原 Swift 主界面已按 [ADR-036](../architecture/adr/036-retire-swift-main-interface.md) 退役，新宿主边界见 [ADR-037](../architecture/adr/037-electron-dual-window-host.md)。

已核对的官方接口资料：[Electron 安全](https://www.electronjs.org/docs/latest/tutorial/security)、[BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)、[原生菜单](https://www.electronjs.org/docs/latest/api/menu)、[App 生命周期](https://www.electronjs.org/docs/latest/api/app)、[全局快捷键](https://www.electronjs.org/docs/latest/api/global-shortcut)、[拖动区域](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)、[资源协议](https://www.electronjs.org/docs/latest/api/protocol)、[打包器](https://electron.github.io/packager/main/)、[Playwright Electron](https://playwright.dev/docs/api/class-electron)。锁定 Electron 44.7.0 / Playwright 1.64.0 在本机已实际运行；文档和版本锁定本身不能替代上述验收。
