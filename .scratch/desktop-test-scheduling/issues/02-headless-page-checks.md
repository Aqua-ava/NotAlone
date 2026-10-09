# 轻量无头页面验证与生产业务接线

Type: task
Triage: ready-for-agent
State: claimed

## 问题与用户决定

串行 Electron 验收仍反复显示窗口并抢焦点，用户日常桌面被打断。用户在“排查 NotAlone 前端重启问题”中明确拒绝虚拟机，并回复“可以”，同意后台真实接口检查与单实例无头浏览器方案。关联 [调度任务 01](01-desktop-test-scheduling.md)；不增加或改动原二十项功能依赖。

## 交付行为

增加不启动 Electron 的页面验证入口，复用已实现 React 页面、生产业务控制器、具名参数校验与真实 HTTP/PostgreSQL，只适配必要的 Electron/操作系统输入与消息传输。先贯通联系人/关系资料及草稿生成/编辑的垂直切片，再支持原普通页面用例继续推进。

## 验收条件

- [ ] 入口始终使用单个无头 Chromium，默认命令不显示 App 窗口、抢键盘焦点或激活 Dock，不修改正常产品窗口行为。
- [ ] 跨工作树/独立命令全机互斥，串行运行限定范围，用例隔离状态，结束回收本轮浏览器、控制器、HTTP、随机测试库和临时配置；不确定收尾拒绝下一轮，不杀未知进程。
- [ ] 生产 React 公开操作贯通真实业务控制器与 HTTP：联系人范围、资料/来源、候选编辑及迟到结果得到实际可见验证，不以假成功桥接或私有状态镜像代替业务。
- [ ] 参数与身份校验复用生产代码，renderer 不获得后端 token、数据库连接或任意请求/系统调用；仅测试 host 可访问回环测试传输，不作为交付 App 依赖。
- [ ] 记录实测资源和真实命令、失败及收尾结果，区分浏览器/Node/合成后端；不得把无头页面成功称为实际 Electron、系统对话框、剪贴板、快捷键或最终签名 App 已验收。

## 实现与验证范围

- 本机已有 Google Chrome，可先使用锁定 Playwright 支持的 Chrome channel；核对安装/锁定版本及官方文档。Context7 不可用时回退官方一手文档。没有浏览器时明确失败，不隐式下载。
- 仅为实际需要的两个传输适配抽出最小 seam；不引入通用 Agent Harness、Tool/MCP、对外服务或新的产品协议。
- 新入口不连接用户的日常浏览器/profile，使用独立临时上下文；必要文件选择输入只使用本轮合成路径，原生操作明确未支持，不伪造成功。
- Python 激活 Conda NotAlone，加载当前工作树 backend/src；dotenv 读写、握手、owner、模型、CLI/探针与配置独立，只迁移自己创建的随机 `_test` 库，不读私人资料、真实微信或剪贴板，不调用真实模型或外部发送。
- 公共 CLI/公开页面上取得最小 red → green，完成相关 types/build、Standards/Spec 两轴及本地中文提交；无 push/PR。原生宿主桌面启动保持暂停。

## Comments

- 2026-10-09：主 Agent 通过 read_thread 核对直接人类反馈及“可以”，先记录新的测试接缝和边界。只读环境确认 arm64、16 GiB 内存、约 39 GiB 空闲及现有 Chrome；这些不是浏览器资源实测或静默性证明。虚拟机方向已排除，原二十票 DAG 保留。
- 2026-10-09：实现者在独立工作树认领。首先贯通联系人、关系资料与改写的真实页面接缝；全程只使用单个无头浏览器和合成隔离后端，不启动 Electron。
- 2026-10-09：候选实现接通 `test:pages` 的两个最小真实页面组；contacts/memory/reply 的生产 handler/validator 与 preload 传输复用，Electron 来源与 helper 角色检查由生产 adapter 保留。headless 固定角色只由 host 注册 page，未支持原生/业务入口明确拒绝。随机隔离 HTTP/PG、单 Chrome 两组 2/2 通过；有限 12 次只读 owned PID 观测 active/屏上窗口均为 0、策略 prohibited。RSS 峰值 KiB：Chrome 子树 1,034,880、页面控制器 Node 177,760、合成 Python 192,384；共享页可能重复计，构建/编译开销未计入，不代表永久上限或瞬时行为保证。正常收尾 lease absent。CLI red 揭示异步赋值覆盖截止码/收尾码，修复后最小 8/8 绿，最后安全回归待记录。原生与整票业务未由此完成；保持 claimed，等待主 Agent 两轴评审。
- 2026-10-09：主 Agent 候选前指出资源全局字段过宽及迟到断言未等待原公开操作完成。已收窄为全局只 PID/PPID、仅自有子树读取 RSS/进程名，浏览器退出后不观察旧 PID，收尾等待在途采样；迟到组通过真实具名生成 Promise 确认旧操作已完成后才检查切乙页面。相关改写组 1/1，通过 8 次 owned PID 观测为 active 0 / 屏上窗口 0 / policy prohibited；最新 RSS KiB Chrome 1,027,536 / Node 156,256 / Python 153,584。主 App 与 headless 租约均 absent；真实日志保存在本轮交接目录，未更新普通功能票或原生验收状态。
- 2026-10-09：最终最小验证：`npm test` 24/24（10 条无头 CLI＋14 条既有 App 调度门禁，均合成进程），`npm run typecheck`、`npm run build`、票据字段/DAG 与 diff 检查通过。同步现有租约 `.d.mts` 的可选 mode 声明；默认命令不启动浏览器或 Electron。候选待主 Agent Standards/Spec 双轴评审，未写 Answer 或 resolved。
- 2026-10-09：双轴评审 Spec 0；Standards 指出父环境外部追踪泄漏及改写生命周期重复。共用隔离器剥除全部 LANGSMITH_/LANGCHAIN_ 配置、凭据并关闭追踪开关，覆盖 CLI 构建/Node/Python；核对官方 LangSmith 与已装 core 1.5.5 / langsmith 0.11.0 / langchain 1.3.15。真实合成 pipeline 在 owned 回环收集器上的旧实现 red 为 POST 1；修复后正控制 1、隔离 0，恶意启用追踪的合成父环境经公共 CLI 跑真实 draft-rewrite 1/1、trace 0。该次 8 次 owned PID active/屏上窗口 0/0、policy prohibited，峰值 RSS KiB：Chrome 子树 1,035,920 / Node 160,000 / Python 155,120；正常清理、租约 absent。两改写入口共用最小生命周期，通道失败仍尝试 stdin EOF 收尾；实际未知命令故障 exit 1、随机测试库残留 0，但未确认 marker 不撤销，私有诊断先保留后由本轮检查者核验清理。相关 CLI 10/10、共享传输 6/6 与 types/build 通过；未重复既有 24 条/两组全量或 App 验收。日志在本轮交接目录，原二十票/DAG不动，保持 claimed/no Answer 等待主 Agent 增量评审。
