# 工程工作流

修改仓库文件、运行项目、安装依赖、执行测试或准备部署时使用本文件。

## 代码与模块

- 调研笔记保留在 `research/`；实际能力按根 `AGENTS.md` 的运行证据规则核验。
- Python 使用四空格和 PEP 8 命名：模块、函数和变量使用 `snake_case`，类使用 `PascalCase`，常量使用 `UPPER_SNAKE_CASE`。优先小型、带类型标注的函数；副作用放在明确的适配层。
- 按职责分离导入与规范化、联系人数据、记忆与检索、回复生成、后台任务、工具适配器及展示层。文件 I/O、模型调用、持久化和 UI 决策不得混在同一模块。

## 第三方 API 查证

实现或修改可能随版本变化的第三方库 API（如 LangGraph/LangChain）前，先用 Context7 查询当前官方文档和示例，再与项目锁定或实际安装的版本核对兼容性；Context7 不可用或未覆盖时，改查官方一手文档。文档只证明接口约定，实际可用性仍需代码和测试验证。

## 环境

- Python 产品代码使用 Conda 环境 `NotAlone`（Python 3.12）。**不要执行 `conda activate`**，改用 PATH 前缀 `PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH"`，或直接用绝对路径 `"$HOME/miniconda3/envs/NotAlone/bin/python"`、`"$HOME/miniconda3/envs/NotAlone/bin/python" -m pip`。`conda activate` 每次多花 0.5–1.8 秒，日常开发一天调用几百次就是几十分钟纯开销。
- Python 工程位于 `backend/`，包含 `src/notalone/`、`tests/`、`database/` 与 `pyproject.toml`；从仓库根目录安装用 `python -m pip install -e ./backend`。根 `.env` 保持原位置，运行入口见 [后端说明](../../backend/README.md)。
- `desktop/` 是 Electron + React/TypeScript 桌面端；当前已接入受控后端、联系人、历史导入预览、会话读取授权、草稿改写与只读关系资料。完整业务闭环与最新版 App 验收尚未完成；验证按下方“桌面验收”执行，不沿用历史 App 的业务或权限验收。
- **桌面开发只用热更新**：先执行 `cd desktop && npm run dev:status`，已有当前项目开发实例就复用，没有才后台启动 `npm run dev`；`npm start` 也走同一入口。React/CSS 热更新，main、preload、共享代码和 Python 变化由开发监督器经认证退出后串行重启。启动后必须再查 `dev:status`，核对实际 `--notalone-dev` 宿主及其监督器仍存活；服务就绪另查应用界面。发现打包版时通过应用菜单正常退出，不强杀、不继续启动第二份。
- **发布例外只由用户发起**：当前打包和打包验收入口由 `desktop/scripts/release-policy.mjs` 默认拒绝。权限、签名、原生探针、测试或交付验收等任务名称均不自动授权打包；开发能力缺失应修复开发路径或报告具体限制。只有用户明确要求制作发布包或运行打包版时，才在该发布任务中调整门禁。Agent 不得自行修改门禁、换命令直接调用打包库、运行旧包或用确认口令代替用户授权。此约束传给所有子 Agent，恢复长任务时重新执行开发状态检查。工具执行层未隔离写权限，因此这不是不可绕过的安全沙箱。详细使用见[桌面开发模式](../../desktop/README.md#日常开发热更新)。
- **必须由 Agent 启动常驻进程时一律丢后台**：`cd desktop && nohup npm run dev > /tmp/notalone-dev.log 2>&1 & disown`，再用一条有界等待确认就绪 `for i in $(seq 1 60); do grep -q '开发模式：React/CSS 保存即更新' /tmp/notalone-dev.log && exit 0; sleep 1; done; exit 1`。开发端口由 `scripts/development-server.mjs` 随机分配，**不要传 `--host`/`--port`**；`scripts/dev.mjs` 只接受 `--user-data-dir`，其他参数直接报错退出。**严禁在前台运行** `npm run dev`、`ssh -N`、`node dist/standalone/server.js`、`tunnel.py` 这类常驻进程；ssh 隧道用 `ssh -f -N ...` 一次建好，不进入 Agent 调用链。
- `native/macos/` 是 ScreenCaptureKit 与 Vision 的原生 Swift 探针，只验证前台同步能力，不承载领域、存储或回复生成逻辑。
- 修改 macOS App/探针的权限、`Info.plist`、签名、打包或用户可见启动错误前，先读取并更新 [macOS App 权限与启动错误记录](../macos-app-permissions-and-errors.md)。

## 测试与验证

- 除非仓库记录了替代方案，Python 测试使用 `unittest`。测试夹具只能使用合成或匿名化数据。
- 从仓库根目录运行完整 Python 测试用 `python -m unittest discover -s backend/tests -t backend -v`；按 `tests.unit...` / `tests.integration...` 指定模块时在 `backend/` 执行。原生测试入口为 `swift test --package-path native/macos`。
- **验证阶梯**（由便宜到贵，上一层通过再做下一层）：
  1. 单用例：`cd backend && PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" python -m unittest tests.unit.test_模块.类.方法 -v`，秒级；
  2. 相关模块：`cd backend && PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" python -m unittest discover -s tests/unit -t . -v`，十秒级；
  3. 全量：`PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" python -m unittest discover -s backend/tests -t backend`，分钟级。
  同一失败先回到第 1 层复现，不重复重跑第 3 层。全量给时间上限：macOS 没有 `timeout`，用 `perl -e 'alarm 600; exec @ARGV' -- <命令>` 包一层。
- **原生与桌面**：`swift test --package-path native/macos --filter <测试名>` 先跑单例；桌面先 `cd desktop && npm run typecheck`，需要时再 `npm test`。
- **输出裁剪**：测试、构建、校验命令统一 `2>&1 | tail -60`；`git diff` 先 `--stat` 再按文件 `-- <path>`；校验产物用 `jq` 取字段。单次回传超过约 200 行即视为未裁剪。
- 桌面端在 `desktop/` 执行 `npm test`，默认仅 TypeScript 与安全测试调度 CLI/合成进程回归，必须报告真实 App 未运行；`npm run package` 和 `npm run test:package` 当前被发布门禁拒绝。
- 涉及真实 App、签名包及微信的验收时，执行下方“桌面验收”。
- 覆盖范围随实现推进，至少包括正常导入、损坏文件、联系人隔离、来源与删除、空或模糊检索、已确认绑定的增量去重、未绑定会话不读取正文、微信非前台时不采集视觉帧、关闭同步时停读，以及候选回复不会发送外部消息。CLI 后台同步与前台定位按 ADR-030 分别验证。
- 按根 `AGENTS.md` 运行最小相关验证，报告数据处理影响、实际命令和剩余风险；只有实际覆盖的端到端行为才能认证消息渠道集成可用。

## 桌面验收

- 遵循根 `AGENTS.md` 的 Computer Use 要求、发送授权和产品边界，直接操作真实 App、签名包及微信界面并核对结果。无需用户另行批准时段或启动预算，也不强制通过 `test:app`。Agent 连续完成激活应用、点击控件、切换测试会话、移动或缩放窗口、进出助手、复验、故障后重试和收尾；仅将确实依赖用户体验判断的部分交给用户。
- 自动化 Electron 用例可沿用 `test:app` 的隔离夹具、进程追踪和互斥能力；该脚本要求的时间与启动数由 Agent 按测试规模设置，是自动化调度参数，不是用户批准条件，也不限制独立的 Computer Use 验收。普通页面可使用 `test:pages` 的单实例无头 Chrome、生产控制器及隔离 HTTP/PG；页面通过不代表原生能力通过。命令参数见 [桌面说明](../../desktop/README.md)。
- 多个 Agent 或工作树共用桌面时，先核对已有实例与占用，由实际操作者协调，避免并发抢焦点或重复重启。使用独立用户目录和测试数据，完成后核对自有进程及资源；不确定归属时保留现场并查明，不终止未知进程。记录实际操作、结果和清理情况，分别报告自动检查、Computer Use 实测及用户体验反馈。
- 验收须确认同步和去重；私人聊天、联系人身份或截图不提交到仓库。工具能力不可用时说明实际缺口，不能把工具限制解释为还缺用户授权。
- 验收操作不改变产品 OCR 的前台、内存布局分析和名称局部识别边界，也不能据此宣称产品具备自动定位或自动发送能力。

## 开发磁盘占用

- 构建 App、原生探针或运行时前，核对输出卷和临时卷可用空间，以及主仓、工作树和临时目录中本项目的构建占用。桌面资源构建、打包和仓库探针准备入口会在任一写入卷不足 15 GiB 时停止，在线打包同时检查共享下载缓存卷；其他构建入口由执行 Agent 做同样检查，实际峰值较大时另留相应余量。
- 同一任务优先复用固定构建目录和锁定版本的下载缓存。需要独立输出做对照时记录路径，验收后保留当前运行包、最新交付包及至多一份有明确回滚用途的旧包；日志、摘要与源码版本用于留存证据，不以完整 App 或运行时副本替代。
- 每轮结束清理本轮闲置 App、运行时 staging 和编译缓存，并报告前后占用。删除前核对精确路径、Git 跟踪状态及进程引用；保留源码、未提交改动、验收记录、业务数据库、原始资料和备份。工作树本身通过其管理工具归档，不能把整个工作树或 `artifacts/` 当缓存删除。

## 部署

正式环境目标服务器由私有部署配置提供，不代表已经部署。schema、迁移、配置和部署脚本必须区分本地与正式环境，并保证同一套迁移可重复执行。实际连接、安装服务、传输数据或切换流量前，单独确认访问方式、数据范围、备份和回滚方案并完成运行时验证；仓库中不得保存密码、私钥、数据库凭据或其他秘密。

## Git

1. 新增或修改仓库文件后，在最小相关验证完成时自动创建本地提交；纯读取、分析或无文件变更时不提交。
2. 只提交当前任务产生或明确属于当前任务的变更，不捎带用户已有修改，不强行加入被忽略的调研、产物或私密数据。
3. 每个提交只处理一个主题。提交标题使用中文；正文用 `1、2、3、4` 形式列出 3-5 条改动、边界和真实验证结果。
4. 远端操作遵循根 `AGENTS.md` 的明确授权要求。

## 公开前检查

- 公开内容保留产品代码、架构、任务规格与必要合成验收证据；私人协调过程、原始资料、凭据和本机身份信息留在端侧。官网部署主机由 `NOTALONE_WEB_HOST` 显式提供。
- 提交后执行 `node scripts/check_public_history.mjs --ref HEAD --working-tree`，检查当前分支完整可达历史及当前文件；准备公开 `main` 时另执行 `node scripts/check_public_history.mjs --ref main`。检查只在端侧读取，不联网。
- 2026-10-13 本地 `main` 完整历史已按用户授权脱敏；原提交引用通过 [提交映射](../publication-commit-map.tsv) 定位清理后的版本。冻结评测中原摘要仍指向原始证据，新增的脱敏说明区分公开副本与原始运行，不代表重跑。
- 原历史和未提交文件的恢复副本保存在仓库外私有目录。其他开发工作树继续保留原历史，公开时仅使用经过检查的分支；不要用 `--all` 或 `--mirror` 带出未清理分支。已有 GitHub 历史只有在另行授权更新远端后才会改变。
