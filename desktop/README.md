# 桌面端

Electron／React 桌面通过认证连接本机 TypeScript／DSH 后台，当前业务存储为受控 SQLite。日常开发和实际 App 验收统一使用热更新入口；本文负责命令、源码与诊断导航，产品要求由[现行架构](../architecture/README.md)维护，实际能力与验证按正式代码和具名记录分别判断。

## 日常使用

| 要核对的行为 | 当前入口 |
| --- | --- |
| 联系人、手选归属、前台跟随、同步授权 | [数据契约](../architecture/current/domain-data.md)、[微信同步](../architecture/current/wechat-sync.md) |
| 表达／建议、候选编辑、依据、助手会话 | [回复生成](../architecture/current/reply-generation.md) |
| 记忆提取、处理状态、图文与来源 | [记忆处理](../architecture/current/memory-processing.md)、[提取追踪](../architecture/current/memory-extraction-trace.md) |
| Skill 发现、启停、组合和审核 | [Skill Library](../architecture/current/skill-library.md) |
| 资料位置、来源失效、删除与出站 | [隐私与删除](../architecture/current/privacy-deletion.md) |

窗口菜单管理独立的管理后台和输入小窗；关闭窗口隐藏，明确退出须完成后台停读。顶栏手选确认本次联系人而不停止前台跟随，也不授予正文读取。已有稳定联系人按名称匹配的规则见现行规格，原始 OCR 30%／50% 不单独构成阻断门。

用户明确点击“帮我表达”或“帮我想想”才生成候选；复制、回看、新消息和打开窗口不代表发送，也不自动形成长期偏好。真实消息始终由用户亲自发送。

同步来源相符时自动核对并接续，单人和开发者批量“修复同步”入口退役。来源待确认提示不授予读取资格；“检查微信来源”只打开同步设置，用于核对连接和范围，不会自动解除来源证明，也不新增异源采纳或重新授权能力。关闭同步或退出仍停止新读取，合法已保存资料按原来源与删除合同保留。

联系人头像由获准会话的同步流程从微信本地头像库取得并持久保存，禁止头像联网。联系人页面只加载已保存的本地缩略图；头像缺失不影响聊天同步，暂停同步后已有头像仍可查看。头像随联系人或账户删除，聊天清空保留头像。

记忆页面只装配当前 SQLite 的资料管理与处理状态；后台运行状态缺少 SQLite 标识时显示核验失败，不再回落旧版页面。

Skill 管理页直接连接 SQLite 库与联系人分组管理，提供自动发现、核验、启停与分组配置；不装配旧后端的学习、审核发布、历史回滚或方法政策界面及桥接。未识别为当前 SQLite 库的响应显示核验失败。已采纳的学习与发布目标继续保留在 [Skill Library](../architecture/current/skill-library.md#6-已采纳的学习审核与发布目标)，后续接入当前宿主并独立验收。

当前 SQLite 的旧 JSONL 文件导入、旧方向探索及旧独立连续修改入口已退役；文件导入的已采纳数据约束不代表正常入口开放。Skill 自动学习、表达偏好等已采纳目标也不能仅凭旧页面或组件存在认定当前可用；当前宿主能力见[正式装配](../backend-ts/src/sqlite-host-plugin.ts)。

### 手动首版使用

该旧锚点保留用于历史链接。当前使用已确认的既有联系人进行手动表达，不因手选建立微信身份或同步权限；新用户首位联系人及正式交付能力分别核验。旧手动首版记录见[历史说明](../docs/history/desktop-development-history.md#桌面说明整理前记录)。

### 查看本次参考

当前候选依据和历史快照的展示、编辑、复制及删除合同集中见[候选展示、编辑与发送](../architecture/current/reply-generation.md#候选展示编辑与发送)。未知来源或时间不以当前资料补写；读取依据不触发重新生成。

## 数据库沿用与结构补齐

本机业务资料位于 App `userData/managed/sqlite/notalone.sqlite`。受控启动核验实例身份、迁移校验和、结构与完整性，沿用已确认资料目录；缺失、损坏或未知结构保留现场，不以新空库绕过。

空目录由切换控制面建立独立数据库身份。发现旧数据库、旧写入者或不能确认归属的对象时保持维护态，不自动迁入、清理或恢复旧授权。模型配置、用户 Skill 原目录与外部原件分别保留。具体启动合同见[SQLite 存储](../backend-ts/src/storage/sqlite/README.md)，历史切换证据见[验证记录](../docs/verification/20-sqlite-cutover-and-legacy-cleanup.md)。

## 本机运行与构建

需要 Node.js ≥24、根 pnpm workspace 依赖；桌面和原生开发目标为 macOS 15+／Apple Silicon。平台声明见 [app-platform.json](scripts/app-platform.json)。自研原生组件构建需要可用的 Swift／Xcode Command Line Tools；正常后台不需要 Python、Conda 或 PostgreSQL。

在仓库根目录安装锁定依赖：

```bash
pnpm install --frozen-lockfile
```

### 日常开发热更新

先检查当前项目实例，有可用宿主和监督器就复用；仅状态允许启动时运行开发命令：

```bash
cd desktop
pnpm run dev:status
pnpm run dev
```

启动后再次执行 `pnpm run dev:status`，核对真实 `--notalone-dev` 宿主与监督器仍存活，再从实际界面判断服务就绪。Agent 启动常驻实例时按[工程工作流](../docs/agents/engineering.md#环境)放后台，不把常驻进程留在工具调用前台。发现打包版通过菜单正常退出，不打开第二份或强杀未知进程。

React／CSS 保存后热更新；main、preload、共享 TypeScript 和后台源码变化由监督器在编译成功、认证停读及生成结算后串行重启。未确认停止时保留原实例和恢复提示。源码触发的重启后台预加载窗口，使用 Dock 或窗口菜单查看；首次启动正常显示管理后台。临时未保存界面状态可能在主进程重启后清除。

后台连接丢失分两类处理：状态探测偶发超时需连续三次才断开，原进程仍存活时按 2／4／8／15 秒退避自动接回同一实例；后台报告“存储不可用”（存储线程因单个动作超过 15 秒等原因被终止，设计上不自动重开）则接回无效，自有后台进程会被直接回收并重新拉起，滚动 10 分钟内最多自动重启 3 次，超出后保留“重新检查并连接”入口。非自有进程、换库或旧实现不触发自动重启。

交互终端输入 `r` 回车可请求重启；`Ctrl+C` 或 App 菜单退出走正常收尾。`pnpm start` 与 `pnpm run dev` 相同。开发服务随机分配本机端口，脚本仅接受 `--user-data-dir /绝对路径`，不接受 `--host`／`--port`。

开发版顶部变化辅助资源来自 `desktop/.dev/resources/notalone-probe`，完整性或签名核验失败时回到正常周期观察，不搜索配置探针旁的任意文件。开发源码覆盖仅在内存生效，不改写保存的项目路径；旧 `pythonExecutable` 兼容忽略，不能作为启动修复方向。

### 他人改码时的稳定实例

其他 Agent 在主工作区持续改代码时，主工作区的热更新实例会因每次保存重启，半成品源码还可能使本机服务起不来。需要在此期间照常使用 App 时，从主工作区运行 `pnpm run dev:stable`（Agent 同样放后台）：

- 在同级目录 `<仓库名>-stable` 创建主工作区 HEAD 的 Git worktree 快照，在其中运行同一套 `scripts/dev.mjs`，仍是热更新开发模式而不是打包版。只含已提交内容，主工作区的保存、未提交改动和编译失败都不会影响它。
- 默认沿用已有快照；`pnpm run dev:stable --update` 切到主工作区当前 HEAD，运行中的实例随后经认证停读自动重启。快照落后时启动输出会提示落后的提交数。
- `node_modules`、`.env`、`model-permits`、`local-tools` 和媒体校验产物以符号链接共享主工作区，Electron 沿用同一真实路径，不会因换目录重新授权；Skill 只读器在快照内自行构建。
- 该实例使用真实资料目录并持有单实例锁。此时 Agent 自己的验收改用 `pnpm run dev -- --user-data-dir /绝对路径` 的独立合成资料目录，不终止用户的实例；核对快照实例在 `<仓库名>-stable/desktop` 下运行 `pnpm run dev:status`。
- 不再需要时先从 App 菜单正常退出，再用 `git worktree remove ../<仓库名>-stable` 移除快照。

### 默认 SQLite 开发入口

正常开发沿同一官方 profile 启动受控 SQLite，不需要 runtime 选择标记。独立合成验收可选择新的绝对 userData 目录，先核对实例占用，并在退出后核验本轮资源：

```bash
pnpm run dev:status --user-data-dir /绝对路径/隔离目录
pnpm run dev --user-data-dir /绝对路径/隔离目录
```

隔离目录不能含真实资料；需要隔离模型配置时通过本节下方的启动配置明确指定合成配置文件，避免继承真实供应商配置。数据库身份、授权、排除与停读资格仍须正常核验，空目录不代表微信或模型已配置。

### 资源构建与发布边界

`pnpm run build` 只构建源码资源，`pnpm run typecheck` 检查类型；构建通过不证明 UI、权限或渠道可用。输出卷和临时卷需留有至少 15 GiB 空间，自有构建缓存按[工程磁盘规则](../docs/agents/engineering.md#开发磁盘占用)清理。

`package`、直接打包脚本与 `test:package` 均受[发布门禁](scripts/release-policy.mjs)阻止，没有环境开关或确认口令。只有用户明确提出发布任务，才在该任务中审查发布流程；开发、权限排查或原生验收不授权打包或运行旧包。

品牌图标源为 `src/renderer/assets/logo.png`，App 母版为 `assets/app-icon.png`。需要更新母版时可在 `desktop/` 执行 `swift scripts/render-app-icon.swift src/renderer/assets/logo.png assets/app-icon.png`；生成图标不构成发布授权。

## 屏幕录制授权

启动与热重启只静默检查权限，缺失时显示真实状态；用户点击授权入口才请求系统许可。系统设置中核对实际运行的应用或探针，开发模式可能显示 Electron；系统要求重开时正常退出并重新启动开发模式。权限命令不采集聊天，权限就绪也不证明联系人绑定或 OCR 正确。

正式前台观察仅处理当前前台、可见唯一微信窗口的内存画面，并只对名称区域 OCR。原生协议与显式诊断见[Mac 探针](../native/macos/README.md)，实际排查见[权限与错误指南](../docs/guides/macos-app-permissions-and-errors.md)。

## 外置微信工具

微信正文读取使用明确配置的本机开发读取器，App 不自动搜索 PATH、旧包 CLI 或任意缓存，也不通过截图获取正文。路径来自 `backend-launch.json` 的 `wechatCliPath`，已保存值优先于 `NOTALONE_WECHAT_CLI`。缺少工具如实报告能力不可用，不影响独立的模型配置或合法本机回复资料使用。
当前账号元数据读取器认证微信 4.0.6（29387）。已连接用户可在同步设置中主动重新核验版本与来源；连接检测只在失败说明中返回脱敏的检测版本、构建号和固定支持范围。版本不匹配时不读取会话或正文，页面提示更新读取器适配而不是关闭版本核验。App 不自动下载、重签名微信或保存管理员密码。

完整上游源码位于被 Git 忽略的 `local-tools/wx-cli/`，本仓只维护受控扩展与来源锁。构建产物放在其 `.notalone-builds/` 新直接子目录；构建、切换、共享进程、来源兼容及能力认证见[私聊历史适配层](wechat-history/README.md)。构建成功不等于能恢复旧来源资格或已通过真实微信验收。

### 仓库探针与核心库

需要独立准备自研探针时，在 `desktop/` 使用：

```bash
pnpm run prepare:probe -- --destination /已有父目录/新的探针目录
```

入口只从固定仓库源码快照构建并检查架构、完整性及签名，拒绝覆盖已有目标；不执行生成的探针或读取微信。当前运行文件集合由[探针运行时清单](scripts/probe-runtime.mjs)定义，不能沿用旧文档中的文件数量推断完整性。原生协议与单元测试见[探针说明](../native/macos/README.md)。

### 已退役分发路径的历史记录

第三方 CLI／WCDB 的旧捆绑分发、旧 helper 参数及许可核查只供追溯，见[历史记录](../docs/history/desktop-development-history.md#桌面说明整理前记录)。它们不构成当前开发入口或发布授权。

### 旧包许可材料与人工验收

旧包的 Finder、快捷键、签名和许可验证只覆盖对应字节与场次。记录保留在[桌面开发历史](../docs/history/desktop-development-history.md#桌面说明整理前记录)；发布任务须重新核对当次制品与范围。

### 离线检查包

该旧锚点保留供历史台账引用。当前 `test:package` 受发布门禁阻止，不用于日常验证；旧 ZIP、签名与通知复核步骤见[历史记录](../docs/history/desktop-development-history.md#桌面说明整理前记录)。

## 桌面验收与自动化测试

先核对[测试分类](tests/README.md)和 `tests/inventory.json`，再运行最小相关检查。在 `desktop/` 的常用入口为：

```bash
pnpm run typecheck
pnpm run test:inventory
pnpm test
```

`pnpm test` 只运行类型、登记检查和已核准的 `safe-node` 列表；macOS 部分用例会编译或签名合成组件，但不启动实际 App。页面、原生、模型和真实微信结果分别记录。

`pnpm run test:polling` 是包含无头 Chrome 用例的窄回归，执行前核对本机浏览器与对应合成夹具。当前 `test:pages --case` 已退役为固定历史树指引；该脚本仅保留状态查询和合成租约探针，不能据旧 README 命令启动页面组合。现行页面测试按 inventory 指定具体文件并核对其准备条件。

### 安全检查与预约 App 验收

此旧锚点保留。`test:app` 仍有范围、期限、启动数与互斥参数，但这些是自动化 runner 的限制，不是用户必须重新批准时段的规则，也不授权运行打包版。现存用例须逐一核对开发模式兼容性；不能为执行旧夹具绕过 `pnpm run dev`。只读占用查询：

```bash
pnpm run test:app:status
pnpm run test:pages -- --status
```

实际 UI 验收主动使用可用 Computer Use 操作热更新 App 与任务范围内微信；先协调已有实例和焦点，使用合成或匿名资料，核对真实显示及交互。未知租约或进程归属先查明，不删除锁或按进程名终止。历史人工预约、窗口数量及包验收不成为当前开发的前置许可。

## 历史页面与专项验收记录

旧 Python／PostgreSQL HTTP、页面和 App 夹具、日期测试成绩及特定阶段暂停记录已移至[桌面开发历史](../docs/history/desktop-development-history.md#桌面说明整理前记录)。需要复现固定旧树时从[历史测试入口](../backend-ts/test/HISTORICAL.md)核对登记与独立环境，不从当前源码恢复旧后台。

### 轻量无头页面验证

现行入口见[测试分类](tests/README.md)的 `headless` 行；旧 `test:pages --case` 组合及其成绩仅在历史文档保留。

### 授权经验草稿页面（09）

已采纳的学习与审核要求见 [Skill Library](../architecture/current/skill-library.md)。旧页面组只是对应版本证据，不证明当前 SQLite 学习入口已开放。

### 旧资料升级退役

旧升级页面、IPC、HTTP 与执行入口已退役；既有资料按当前记忆管理和删除合同处理。历史升级副本仍在来源删除范围内。

### 同输入审核与范围发布页面（11）

审核发布的现行要求见 [Skill Library](../architecture/current/skill-library.md)，旧页面实施与验证记录见[历史说明](../docs/history/desktop-development-history.md#桌面说明整理前记录)。

## 非秘密启动配置与退出

主进程读取当前 userData 的 `backend-launch.json`，只保存非秘密绝对路径。解析、默认值与优先级以[配置模块](src/main/backend/config.ts)为准，旧 Python 字段兼容忽略：

```json
{
  "projectDirectory": "/绝对路径/NotAlone",
  "envFilePath": "/绝对路径/受控配置.env",
  "backendInfoPath": "/绝对路径/backend.info",
  "wechatCliPath": "/绝对路径/wechat-cli",
  "syncProbePath": "/绝对路径/notalone-sync-probe"
}
```

未保存路径时可由 `NOTALONE_ENV_FILE`、`NOTALONE_BACKEND_INFO`、`NOTALONE_WECHAT_CLI` 与 `NOTALONE_SYNC_PROBE` 提供初始值；后台环境缺省使用项目 `.env`，握手缺省为 `~/.notalone/backend.info`，随后受控 SQLite 启动可能按实例配置投影专用位置。配置不保存模型密钥或握手 token。

当前 SQLite 正常界面不提供旧路径编辑表单。确需修改路径时先正常退出并确认原服务停读，再修改相应 userData 的配置，沿正常开发入口重新检查；不能在仍持有原运行时或停读未知时替换目标。配置文件拒绝符号链接和非普通文件，大小上限 8 KiB。

握手、认证 HTTP、连接与退出由[后端宿主](src/main/backend/host.ts)管理。只接受同用户私有普通握手文件和合法回环地址，不跟随重定向；token、原始 stdout/stderr 和敏感错误不进入 renderer。明确退出固定原已认证连接并确认停读，超时、断线或进程消失不冒充成功；失败保留恢复入口，不另起读取进程或改变持久总开关。后台自身各阶段有硬上限，仍超过 30 秒确认窗口且认证目标是本 App 自有子进程时，宿主升级为 SIGTERM→SIGKILL 回收并确认退出（见[停读说明](../docs/guides/macos-app-permissions-and-errors.md#连接状态与停读确认)）；后台明确报告失败、复用的他方进程或回收失败不升级。

## 工程边界

| 目录 | 职责 |
| --- | --- |
| `src/main/` | 窗口、菜单、单实例、启动、认证后端、受控文件与各领域桥接；业务资料和生成交给后台。 |
| `src/preload/` | 具名操作、类型和非秘密状态订阅；不暴露通用 IPC、任意 URL 或认证信息。 |
| `src/renderer/` | React 展示与交互；不直接访问数据库、密钥或微信。 |
| `src/shared/` | 跨进程协议类型。 |
| `scripts/` | 热更新监督、资源构建、显式原生准备、测试调度和发布门禁。 |
| `tests/` | 按登记区分安全 Node、页面、原生和 App；存在文件不等于当前验收已通过。 |

renderer 使用 context isolation、进程沙箱和关闭 Node 集成；受控 `notalone://app/` 资源设置 CSP 并拒绝导航、新窗口和网页权限。主进程校验调用窗口、主框架、精确来源及参数。资源失败说明页不取得桥接权限。平台采集由[Mac 探针](../native/macos/README.md)提供，Windows 适配尚未实现。

### 2026-10-12 最终包真实CLI退出分项

历史场次见[桌面开发历史](../docs/history/desktop-development-history.md#桌面说明整理前记录)，不覆盖当前开发宿主的停读验收。

## 2026-10-14 自动前台定位

该旧锚点转至[现行微信同步](../architecture/current/wechat-sync.md)与[原生探针](../native/macos/README.md)。旧人工 profile、统一 0.90 门槛与旧包结果只保留历史。

### OCR 本机可视化验收

正式验收在热更新 App 中核对实际名称、状态与联系人的归属；独立预览只能证明局部观察，协议及权限范围见[原生探针](../native/macos/README.md)。

### 持续联系人实机协调（失败留窗）

先核对已复用的开发实例与当前授权范围，失败时保留真实原因和现场。旧签名包协调文件协议及当时报告见[历史记录](../docs/history/desktop-development-history.md#桌面说明整理前记录)，不作为启动当前 App 的前置条件。

### 候选回复与依据展示

当前展示与版本操作见[回复生成](../architecture/current/reply-generation.md#候选展示编辑与发送)；旧样本收藏、方向确认和历史 UI 成绩不恢复为当前要求。
