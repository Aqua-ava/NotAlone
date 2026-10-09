# 轻量无头页面验证与生产业务接线

Type: task
Triage: ready-for-agent
State: resolved

## 问题与用户决定

串行 Electron 验收仍反复显示窗口并抢焦点，用户日常桌面被打断。用户在“排查 NotAlone 前端重启问题”中明确拒绝虚拟机，并回复“可以”，同意后台真实接口检查与单实例无头浏览器方案。关联 [调度任务 01](01-desktop-test-scheduling.md)；不增加或改动原二十项功能依赖。

## 交付行为

增加不启动 Electron 的页面验证入口，复用已实现 React 页面、生产业务控制器、具名参数校验与真实 HTTP/PostgreSQL，只适配必要的 Electron/操作系统输入与消息传输。先贯通联系人/关系资料及草稿生成/编辑的垂直切片，再支持原普通页面用例继续推进。

## 验收条件

- [x] 入口始终使用单个无头 Chromium，默认命令不显示 App 窗口、抢键盘焦点或激活 Dock，不修改正常产品窗口行为。
- [x] 跨工作树/独立命令全机互斥，串行运行限定范围，用例隔离状态，结束回收本轮浏览器、控制器、HTTP、随机测试库和临时配置；不确定收尾拒绝下一轮，不杀未知进程。
- [x] 生产 React 公开操作贯通真实业务控制器与 HTTP：联系人范围、资料/来源、候选编辑及迟到结果得到实际可见验证，不以假成功桥接或私有状态镜像代替业务。
- [x] 参数与身份校验复用生产代码，renderer 不获得后端 token、数据库连接或任意请求/系统调用；仅测试 host 可访问回环测试传输，不作为交付 App 依赖。
- [x] 记录实测资源和真实命令、失败及收尾结果，区分浏览器/Node/合成后端；不得把无头页面成功称为实际 Electron、系统对话框、剪贴板、快捷键或最终签名 App 已验收。

## 实现与验证范围

- 本机已有 Google Chrome，可先使用锁定 Playwright 支持的 Chrome channel；核对安装/锁定版本及官方文档。Context7 不可用时回退官方一手文档。没有浏览器时明确失败，不隐式下载。
- 仅为实际需要的两个传输适配抽出最小 seam；不引入通用 Agent Harness、Tool/MCP、对外服务或新的产品协议。
- 新入口不连接用户的日常浏览器/profile，使用独立临时上下文；必要文件选择输入只使用本轮合成路径，原生操作明确未支持，不伪造成功。
- Python 激活 Conda NotAlone，加载当前工作树 backend/src；dotenv 读写、握手、owner、模型、CLI/探针与配置独立，只迁移自己创建的随机 `_test` 库，不读私人资料、真实微信或剪贴板，不调用真实模型或外部发送。
- 公共 CLI/公开页面上取得最小 red → green，完成相关 types/build、Standards/Spec 两轴及本地中文提交；无 push/PR。原生宿主桌面启动保持暂停。

## Answer

已完成本任务的最小无头页面接缝。`desktop/npm run test:pages` 明确限定组与时限，使用已有 Chrome、单个独立无头实例和 OS 用户级跨工作树租约；不启动 Electron、不下载浏览器或虚拟机。实际生产 React 公开操作复用 contacts/memory/reply 的业务控制器、具名 handler/validator、preload 传输接口与真实 HTTP/PostgreSQL。测试角色由 host 注册的独立 page 固定，未支持的业务/原生操作明确拒绝；正常 Electron 来源、角色校验与 show/focus 行为保留。

验证记录按实际范围区分：

- 初始 `memory-reading` / `draft-rewrite` 两个最小页面组 2/2；资源字段收窄与迟到等待修正后仅重跑改写 1/1；追踪隔离修复后，在启用追踪的合成父环境中经公共 CLI 再跑改写 1/1，owned 回环收集器 trace 为 0。迟到请求通过真正发起的公开生成 Promise 完成后检查新联系人可见状态。
- 追踪隔离的真实 LangChain pipeline 取得旧实现 POST 1 的 red；修复后正控制 POST 1、隔离 POST 0。CLI 构建/runner 与共用 Python 环境清除追踪供应商配置和凭据，并明确关闭现代/旧开关；没有审阅真实密钥或访问外部追踪服务。
- 先前默认 `npm test` 为 24/24（10 条页面 CLI＋14 条 App 调度门禁，合成 Node 孩子）；本次修复只重跑相关 CLI 10/10 和共享传输 6/6，没有重复 24 条或两组全量。types、实际页面入口 build、票据字段/DAG 与 diff 检查通过。
- 共用改写生命周期的真实未知命令故障使 owned Python exit 1、随机测试库残留 0，入口仍拒绝成功收尾、保留资源登记和私有诊断；检查者另核验本轮库/进程后才清理自有目录。正常页面运行确认浏览器、控制器、HTTP、随机库与临时配置回收，App/headless 租约 absent；不确定收尾保锁，不杀未知 PID。

初始有限 12 次 owned PID 观测及后续两次单组各 8 次观测均为 active 0 / 屏上窗口 0 / policy prohibited。最近单组 RSS 采样峰值 KiB：Chrome 自有子树 1,035,920 / 页面控制器 Node 160,000 / 合成 Python 155,120。RSS 为自有子树之和，共享页可重复计，不是精确物理内存或永久上限；未计构建/Swift 编译、额外检查者与 collector 父 Node。有限低频元数据采样不能保证采样间完全没有瞬时激活或窗口行为。

固定候选 `a52ba6e7a0763a3bb5ad29639f91c73f6cd45e96`：完整实现范围 `0dc9cd8b4644264584cecb0a5455301dfb5f19fc→794b38e09854835a80349bda45415bb02632176e` 的 Spec 为 0；修复增量 `794b38e→a52ba6e` 的 Standards hard 0 / possible 0（原 P2/P3 消除，12 smell 全评）与 Spec P0–P3 全 0。本地证据已由主 Agent 按白名单与 SHA256 保全：初始[归档清单](/Users/local-user/.codex/worktrees/mac-desktop-app/NotAlone/desktop/artifacts/headless-entry-794b38e/preservation-manifest.json)，修复[归档清单](/Users/local-user/.codex/worktrees/mac-desktop-app/NotAlone/desktop/artifacts/headless-fix-a52ba6e/preservation-manifest.json)含 12 个白名单日志/截图/资源/交接文件；最小命令和结果见[修复交接](/Users/local-user/.codex/worktrees/mac-desktop-app/NotAlone/desktop/artifacts/headless-fix-a52ba6e/02-headless-review-fix-verification.md)。产物只有本轮合成资料，不提交这些产物，不 push/PR。

本任务 resolved 只表示可供普通页面继续验收的最小接缝完成。09/13/16 的全部普通业务条件、Electron 原生窗口/真实 IPC 来源、系统对话框、剪贴板/快捷键、微信权限、最终签名包与完整 App 交付未由此闭合；原二十票字段、勾选、Answer 和 DAG 保持不动，调度任务 01 仍 claimed。

## Comments

- 2026-10-09：主 Agent 通过 read_thread 核对直接人类反馈及“可以”，先记录新的测试接缝和边界。只读环境确认 arm64、16 GiB 内存、约 39 GiB 空闲及现有 Chrome；这些不是浏览器资源实测或静默性证明。虚拟机方向已排除，原二十票 DAG 保留。
- 2026-10-09：实现者在独立工作树认领。首先贯通联系人、关系资料与改写的真实页面接缝；全程只使用单个无头浏览器和合成隔离后端，不启动 Electron。
- 2026-10-09：候选实现接通 `test:pages` 的两个最小真实页面组；contacts/memory/reply 的生产 handler/validator 与 preload 传输复用，Electron 来源与 helper 角色检查由生产 adapter 保留。headless 固定角色只由 host 注册 page，未支持原生/业务入口明确拒绝。随机隔离 HTTP/PG、单 Chrome 两组 2/2 通过；有限 12 次只读 owned PID 观测 active/屏上窗口均为 0、策略 prohibited。RSS 峰值 KiB：Chrome 子树 1,034,880、页面控制器 Node 177,760、合成 Python 192,384；共享页可能重复计，构建/编译开销未计入，不代表永久上限或瞬时行为保证。正常收尾 lease absent。CLI red 揭示异步赋值覆盖截止码/收尾码，修复后最小 8/8 绿，最后安全回归待记录。原生与整票业务未由此完成；保持 claimed，等待主 Agent 两轴评审。
- 2026-10-09：主 Agent 候选前指出资源全局字段过宽及迟到断言未等待原公开操作完成。已收窄为全局只 PID/PPID、仅自有子树读取 RSS/进程名，浏览器退出后不观察旧 PID，收尾等待在途采样；迟到组通过真实具名生成 Promise 确认旧操作已完成后才检查切乙页面。相关改写组 1/1，通过 8 次 owned PID 观测为 active 0 / 屏上窗口 0 / policy prohibited；最新 RSS KiB Chrome 1,027,536 / Node 156,256 / Python 153,584。主 App 与 headless 租约均 absent；真实日志保存在本轮交接目录，未更新普通功能票或原生验收状态。
- 2026-10-09：最终最小验证：`npm test` 24/24（10 条无头 CLI＋14 条既有 App 调度门禁，均合成进程），`npm run typecheck`、`npm run build`、票据字段/DAG 与 diff 检查通过。同步现有租约 `.d.mts` 的可选 mode 声明；默认命令不启动浏览器或 Electron。候选待主 Agent Standards/Spec 双轴评审，未写 Answer 或 resolved。
- 2026-10-09：双轴评审 Spec 0；Standards 指出父环境外部追踪泄漏及改写生命周期重复。共用隔离器剥除全部 LANGSMITH_/LANGCHAIN_ 配置、凭据并关闭追踪开关，覆盖 CLI 构建/Node/Python；核对官方 LangSmith 与已装 core 1.5.5 / langsmith 0.11.0 / langchain 1.3.15。真实合成 pipeline 在 owned 回环收集器上的旧实现 red 为 POST 1；修复后正控制 1、隔离 0，恶意启用追踪的合成父环境经公共 CLI 跑真实 draft-rewrite 1/1、trace 0。该次 8 次 owned PID active/屏上窗口 0/0、policy prohibited，峰值 RSS KiB：Chrome 子树 1,035,920 / Node 160,000 / Python 155,120；正常清理、租约 absent。两改写入口共用最小生命周期，通道失败仍尝试 stdin EOF 收尾；实际未知命令故障 exit 1、随机测试库残留 0，但未确认 marker 不撤销，私有诊断先保留后由本轮检查者核验清理。相关 CLI 10/10、共享传输 6/6 与 types/build 通过；未重复既有 24 条/两组全量或 App 验收。日志在本轮交接目录，原二十票/DAG不动，保持 claimed/no Answer 等待主 Agent 增量评审。
- 2026-10-09：主 Agent 完成固定 `794b38e→a52ba6e` 增量两轴：Standards hard 0 / possible 0、原 P2/P3 消除，Spec P0–P3 全 0；保留先前完整实现 Spec 0。本地证据归档于 `/Users/local-user/.codex/worktrees/mac-desktop-app/NotAlone/desktop/artifacts/headless-fix-a52ba6e`（12 白名单文件 SHA256 保全）及初始 `desktop/artifacts/headless-entry-794b38e`。仅据已记录的最小接缝/实际验证写 Answer、勾辅助条件并 resolved；本轮只做文档 diff/二十票辅助检查，不再 types/build/runtime/page/App/DB。初始两组、最近单组、旧24安全与本次10+6、RSS/静默采样限制及原生/09/13/16/完整App未闭合分别保留；原二十票/DAG与调度01均不改。
