<p align="center">
  <img src="website/assets/logo.png" width="240" alt="NotAlone 标志" />
</p>

<h1 align="center">NotAlone</h1>

<p align="center">
  <strong>让表达更贴近真实关系，也更贴近你。</strong><br />
  面向真实联系人的中文关系感知回复助手
</p>

<p align="center">
  <code>macOS 15+ · Apple Silicon</code> · <code>本机资料</code> · <code>手动发送</code> · <code>开发中</code>
</p>

<p align="center">
  <a href="#能做什么">能做什么</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#当前进度">当前进度</a> ·
  <a href="#隐私与控制">隐私与控制</a> ·
  <a href="#开发与文档">开发文档</a>
</p>

---

有时难的不是写出一句话，而是对这个人、在这段关系里，找到合适的表达。

**NotAlone 帮你把想说的话整理成可编辑的候选回复。** 先明确选择联系人，再粘贴对方的文字或写下自己的草稿；需要时，可以结合这位联系人的历史与关系资料，查看回复依据，修改成自己的表达，最后亲自发送。

> **当前阶段：本机集成验收中。** 手动输入是当前使用入口；微信自动接入尚未交付，正式分发签名、公证与无开发环境机器验收仍待完成。

## 能做什么

| 你想做的事 | NotAlone 如何帮助你 |
| --- | --- |
| **回应一段消息** | 粘贴这位联系人的当前文字，补充你想表达的方向，生成候选回复。 |
| **把草稿说得更自然** | 输入自己的草稿和表达要求，再选择、修改候选；默认仅使用本次输入。 |
| **结合你们的关系背景** | 明确开启关系语境后，检索同一联系人的资料，回看生成时使用的依据。 |
| **整理聊天里的关系资料** | 单联系人 JSONL 先预览、再确认导入；关系资料与记忆候选保留来源，支持回看和管理。 |

每次回复都属于你明确选择的一位联系人。一次性的表达要求不会静默成为长期偏好，复制候选也不代表发送或采纳。

### 一次回复，四个步骤

| ① 确认联系人 | ② 说明本次输入 | ③ 查看并编辑 | ④ 亲自发送 |
| :--- | :--- | :--- | :--- |
| 创建或明确选择一位联系人 | 粘贴对方文字，或写下自己的草稿与表达方向 | 比较候选、展开依据，改成自己的表达 | 复制最终文字，到聊天应用中发送 |

## 快速开始

### 使用 App

以下适用于已取得受管版 `NotAlone.app` 的本机试用。普通使用无需单独安装 Conda、PostgreSQL、微信或 CLI，也不要求录屏权限。

1. **完成本机设置。** 打开 App，点击“开始本机设置”，在“本人身份与模型”填写本人展示名称，并输入自己的模型密钥。新安装默认使用 DeepSeek 官方（`https://api.deepseek.com`）与 `deepseek-flash`。
2. **选择本次联系人。** 在“联系人”中创建联系人，再明确点击选择，进入“手动输入本次聊天”。
3. **生成并修改候选。** “回应粘贴文字”用于对方的当前文字与自己的表达方向；“改写”用于自己的草稿。生成后可以展开依据、编辑和复制。
4. **需要历史时再导入。** 在“历史导入”预览单联系人 JSONL，确认归属后正式导入。混有多位联系人的资料需要先拆分；导入来源可查看和删除。

更换版本前，请通过“NotAlone → 退出 NotAlone”正常退出旧版；仅关闭窗口会保留 App 运行。更多操作见 [桌面端说明](desktop/README.md#手动首版使用)。

### 从源码运行

源码开发需要 macOS、Homebrew、Conda、PostgreSQL、Swift 与 Node.js ≥ 22.12.0。后端使用 Python 3.12；安装脚本会准备开发库与原生探针。**已有数据库请先阅读 [迁移与恢复说明](backend/database/README.md)。**

在仓库根目录运行：

```bash
zsh scripts/install.sh
conda activate NotAlone
cd desktop
npm ci
npx install-electron
npm start
```

启动后还需配置本机后端路径、初始化本人并配置模型；完整步骤如下。源码启动和默认前端打包不等于已取得包含完整运行时的受管版 App。

<details>
<summary><strong>展开源码环境、首次连接与渠道研发配置</strong></summary>

### 1. 准备依赖

| 依赖 | 用途 |
| --- | --- |
| macOS 15+、Xcode 16.4 / Swift 6 | 原生截图、OCR 与会话定位探针；完整原生路径以 macOS 15+ 为基线。 |
| Homebrew、Conda、PostgreSQL | 安装脚本依赖；Python 使用 `NotAlone` 环境，默认开发库为 `notalone_dev`。 |
| Node.js ≥ 22.12.0 | 构建 Electron + React 桌面端。 |
| 微信桌面版、外置 WeChat CLI / WCDB | 使用微信文字同步时需要自行准备。 |
| DeepSeek API Key | 使用真实模型时配置；未配置则模型入口失败关闭。 |

**关于 WeChat CLI：** 本仓库只保留调用外置工具的适配代码、配置接口和相关测试。`wechat-cli` 可执行文件、`libWCDB.dylib` 和独立 CLI 源码不随仓库或 App 提供；本机外置配置见 [桌面端说明](desktop/README.md#外置微信工具)。

### 2. 安装后端与原生探针

```bash
zsh scripts/install.sh
conda activate NotAlone
```

脚本检查依赖、创建 Python 3.12 环境并安装后端，尝试启动本地 PostgreSQL、创建开发库并按版本应用迁移，缺失时生成权限为 `0600` 的根 `.env`，随后构建原生探针。模型密钥由你另行配置；安装过程不启动桌面 App、HTTP 服务或微信读取。

已有数据库请先阅读 [迁移与恢复说明](backend/database/README.md)：无版本记录的旧库会停止等待核验，不自动猜测基线或重放历史 SQL。

### 3. 准备并启动桌面端

```bash
cd desktop
npm ci
npx install-electron  # 首次显式准备锁定版本的 Electron 运行时
npm start
```

`npm start` 先构建再启动 Electron。仅构建可在 `desktop/` 执行 `npm run build`，本机打包使用 `npm run package`。默认包只含前端；可用 `--with-probe` 附带 NotAlone 自研探针，微信 CLI / WCDB 始终由用户在本机另行准备，完整步骤见 [本机运行与构建](desktop/README.md#本机运行与构建)。

### 4. 首次连接与使用

在“应用配置 → 机器环境”的“本机启动路径”中填写 **Python 可执行文件**、**项目目录**和**本机配置文件**的绝对路径：分别对应 `NotAlone` 环境的 Python、仓库根目录和根 `.env`；后端握手文件保留默认路径。Python 路径可在已激活 `NotAlone` 的终端用 `python -c 'import sys; print(sys.executable)'` 查看。

保存后点击“重新检查并连接”，连接就绪后进入“本人身份与模型”明确初始化本人并配置模型。

下述是历史渠道研发入口，首版 App 不引导启用：先预览、确认并**正式导入**一份单联系人历史，建立本人微信渠道身份。导入后如提示同步宿主尚未装配，点击“认证停读并重新加载同步服务”；连接恢复后，再到“同步设置”主动选择会话、点击“确认并授权所选会话”，最后开启总开关。仅预览或初始化本人身份还不足以启用微信同步。

微信同步需要在机器环境中另行配置外置 CLI 路径。前台定位探针可稍后配置，其屏幕录制权限及签名归属见 [权限说明](docs/macos-app-permissions-and-errors.md)；目前 OCR 仍有实机验收缺项。

</details>

## 当前进度

| 模块 | 已有进展与验收范围 |
| --- | --- |
| 桌面端 | Electron + React 管理窗口与小窗已接入主要业务流程，完整原生交付仍待验收。 |
| Python 后端 | 导入、任务、记忆、检索、候选与来源删除已有合成 HTTP / PostgreSQL 闭环验证；真实模型质量需单独验证。 |
| 微信文字同步 | 固定 CLI 版本的单联系人读取、去重、故障恢复与 10 分钟后台运行已有实机证据；多联系人、长时稳定性与最终 App 仍有验收缺项。 |
| 前台 OCR | 仅承担当前微信会话定位；已改为窗口自动布局与名称局部 OCR，无需手填坐标；新版实机移动与缩放验收待完成，不作为后台 CLI 同步门禁。 |
| 检索与记忆 | 生产检索使用 SQL / 全文路径，向量检索未启用；记忆按维度自动采纳的默认放行表为空。 |
| 平台与分发 | 当前面向 macOS；Windows 微信适配未实现，桌面包尚未完成 Developer ID 分发与公证。 |

运行证据见 [桌面端说明](desktop/README.md)、[后端说明](backend/README.md)与 [macOS 验收记录](docs/macos-app-permissions-and-errors.md)。架构文档中的设计不代表功能已通过端到端验收。

## 隐私与控制

- **先确认，再读取。** 一次历史导入只归属一位联系人；CLI 正文同步仅限主动选择并确认的绑定。关闭总开关或退出运行时后停读，重新开启只在已确认范围内恢复可检测缺口。
- **发送由你决定。** 候选可编辑，最终消息由你亲自发送；产品没有外部聊天发送 Tool 或后台代发能力。
- **清楚区分本机处理与模型调用。** 本机开发路径使用 PostgreSQL 保存资料；调用真实模型会向配置的服务提供者发送本次必要文本。原始视觉帧默认只在端侧内存中处理，不持久化或上传。
- **资料有来源，也有删除路径。** 可删除单份导入来源及失去来源支持的派生资料；其他来源仍支持的消息保留。微信原聊天、原始导入文件与外部模型副本须分别处理，当前来源删除入口不提供联系人或账户整体删除。
- **完整追踪同样属于敏感资料。** 含正文的提取追踪默认保存在数据库，持续到手动删除或来源删除；90 天任务清理只清终态任务元数据。`.env`、私人聊天、追踪、备份和截图不应提交到 Git。

自动采纳必须带来源、标记为 `auto` 且可撤销；模型置信度与来源支持不等于真实准确率。目前 [维度放行台账](docs/memory-adoption-dimension-release-ledger.md)为空，通过其他门槛的候选仍待确认。

## 开发与文档

```text
NotAlone/
├── desktop/          Electron + React/TypeScript 桌面端
├── backend/          Python 领域代码、HTTP/CLI、测试与 SQL 迁移
├── native/macos/     Swift 原生截图、OCR 与会话定位探针
├── website/          独立静态官网
├── scripts/          安装、部署与公开前检查
├── docs/             工程、操作与验证说明
└── architecture/     现行规格、设计草案与 ADR
```

| 想了解什么 | 从这里开始 |
| --- | --- |
| 桌面运行、构建与验收 | [desktop/README.md](desktop/README.md) |
| 后端安装、HTTP 与 CLI | [backend/README.md](backend/README.md) |
| 数据库升级与旧库恢复 | [backend/database/README.md](backend/database/README.md) |
| 原生探针与权限 | [native/macos/README.md](native/macos/README.md) · [权限与启动错误](docs/macos-app-permissions-and-errors.md) |
| 领域词汇与架构决策 | [CONTEXT.md](CONTEXT.md) · [架构索引](architecture/README.md) |
| 记忆的来源、提取与删除 | [完整追踪](architecture/current/memory-extraction-trace.md) · [维度放行台账](docs/memory-adoption-dimension-release-ledger.md) |
| 开发约定与任务工作流 | [AGENTS.md](AGENTS.md) · [工程工作流](docs/agents/engineering.md) |
| 官网预览与部署 | [website/README.md](website/README.md) |

Python、桌面端与原生探针分别管理依赖、构建和测试；领域逻辑留在后端。根目录 `.env` 和私人导入目录 `chat_exports/` 已由 Git 忽略。

<details>
<summary><strong>开发前：本地隐私检查与 CI 范围</strong></summary>

首次克隆后启用本地推送前隐私检查（需要 PATH 中可用的 Node.js）：

```bash
node scripts/install_git_hooks.mjs
```

该命令将本仓库的 `core.hooksPath` 设为 `.githooks`；已有其他自定义钩子目录时会停止，避免覆盖。Git 默认 `.git/hooks/` 中的旧钩子保留在磁盘上，但启用后不再执行；有自定义钩子时应先合并。每个新克隆都需安装一次。本地检查针对本次推送的每个提交或标签及完整可达历史，发现问题或无法检查时阻止推送；删除远端引用不扫描。它只在端侧读取，输出问题位置，不输出命中的敏感值。浅克隆须补齐历史。

GitHub Actions 的最小 CI 在 push、Pull Request 或手动触发时检查完整历史、Python 3.12 合成单元测试、桌面端类型与纯逻辑测试。不启动微信、Electron、数据库或真实模型，不上传测试附件。CI 不携带本机 `.env` 和私有地址清单，因此不能替代本地检查；本地钩子可被跳过，也不保证识别所有隐私。远端 CI 尚需实际运行验证。

</details>

## 命令与验证

下列命令默认从仓库根目录执行；Python 命令先运行 `conda activate NotAlone`。展开需要的部分即可。

<details>
<summary><strong>配置与手动后端入口</strong></summary>

后端 CLI / 服务从当前目录向上查找已有 `.env`，shell 环境变量优先。从 `backend/` 首次初始化时，显式设置 `NOTALONE_ENV_FILE=../.env`，避免把配置写进源码目录。迁移命令不自动读取 `.env`。

| 变量 | 用途 |
| --- | --- |
| `NOTALONE_DATABASE_URL` | PostgreSQL 连接串，本地示例 `postgresql:///notalone_dev`。 |
| `NOTALONE_OWNER_ID` | 当前用户 UUID；首次导入可用 `--initialize-owner` 生成并写回受控 `.env`。 |
| `NOTALONE_ENV_FILE` | 指定受控配置文件路径。 |
| `NOTALONE_WECHAT_CLI` / `NOTALONE_SYNC_PROBE` | 指定外置 CLI / 原生探针的可执行文件路径。 |
| `NOTALONE_DEEPSEEK_API_KEY` | 模型凭据；缺失或为空时真实模型入口失败关闭。 |
| `NOTALONE_DEEPSEEK_MODEL` | 模型名，默认官方 `deepseek-flash`。 |
| `NOTALONE_DEEPSEEK_BASE_URL` | 模型服务地址；变更服务提供者前核对数据处理范围。 |
| `NOTALONE_TEST_DATABASE_URL` | 隔离测试库，名称必须以 `_test` 结尾。 |
| `NOTALONE_MEMORY_DIMENSION_GATE` | 默认开启维度放行门；只有显式 `0` 才回退到原有三道采纳门槛。 |

官方 `deepseek-flash` 默认使用完整文字请求长度估算，并另留输出与安全余量；界面明确标记估算。`input_budget_unavailable` 表示本地无法核验当前模型的输入长度配置，不表示账户余额不足，详见 [ADR-062](architecture/adr/062-official-deepseek-reply-input-budget.md)。

```bash
python -m pip install -e ./backend  # 已运行安装脚本时可省略
notalone-server --help
notalone-server                   # 手动启动回环 HTTP 服务
```

服务默认监听 `127.0.0.1`，由系统分配端口；接口沿用本地服务 token 与固定用户范围。已有库升级、迁移记录和备份按 [数据库说明](backend/database/README.md)处理。

</details>

<details>
<summary><strong>历史导入：预览 → 确认联系人 → 导入</strong></summary>

预览校验完整文件、本人身份和唯一联系人，统计消息类型；单文件最多 64 MiB / 500,000 条消息。默认隐藏文件名和联系人标识，人工核对时才使用 `--show-identifiers`。

```bash
notalone-ingest-preview chat_exports/example.jsonl
notalone-ingest-preview --show-identifiers chat_exports/example.jsonl

# 先预览，再人工选择一个已有联系人
notalone-ingest chat_exports/example.jsonl \
  --contact-id '11111111-1111-1111-1111-111111111111'

# 首次显式初始化本人，并确认创建一位新联系人
notalone-ingest chat_exports/example.jsonl \
  --initialize-owner --new-contact-name '联系人展示名称'
```

`--contact-id` 与 `--new-contact-name` 二选一。联系人、来源、确认记录与消息同事务写入，失败整体回滚；同一用户、联系人和文件摘要的 active 来源重复导入不重复写入。不同文件复用冲突消息身份时拒绝整批导入。普通输出只含状态与计数，不含聊天正文或各类 ID。

</details>

<details>
<summary><strong>微信增量同步与授权绑定</strong></summary>

CLI 按每位联系人的独立游标读取文字增量，前台 OCR / 探针仅用于会话定位。定位失败不阻断已确认绑定的后台读取，CLI 不可用时不回退到 OCR 正文。

首次授权使用桌面“同步设置”：主动选择会话、确认归属并点击“确认并授权所选会话”，随后再开启总开关。CLI 的旧前台绑定入口需要可信前台证据，不作为当前默认首用路径。

```bash
notalone-front-sync contacts  # 列出当前用户已有的内部联系人
notalone-front-sync status    # 执行一次同步检查，可读取已授权增量；只输出元数据
notalone-front-sync enable    # 确认绑定后，明确开启总开关
notalone-front-sync disable   # 关闭并停读
```

高级入口 `notalone-front-sync confirm-binding --contact-id '...' --locator 'wxid...'` 沿用前台绑定证据；证据不可核验时拒绝，`status` 的前台候选也受该条件限制。当前 OCR 尚无可信实机自动定位结果，不能据 CLI 元数据推断该入口已可完成首绑。

绑定使用 CLI 返回的稳定私聊定位标识，不靠昵称猜测联系人，也不会静默改绑。首次列表默认不选，新增会话不自动授权；消息保留来源并与历史导入去重。重新开启后的有界补齐遵循 [ADR-025](architecture/adr/025-cli-background-sync-gap-backfill.md)，后台同步与前台定位的独立边界见 [ADR-030](architecture/adr/030-confirmed-contact-background-sync-consent.md)。

</details>

<details>
<summary><strong>记忆提取、管理与完整追踪</strong></summary>

```bash
notalone-extract-memory --contact-id '...'  # 全量/增量提取，重跑跳过已完成部分
notalone-task-worker --contact-id '...'     # 处理一个联系人任务
notalone-task-worker --contact-id '...' --retry-task-id '...'
notalone-memory-add --contact-id '...' --category taboo --text '...'
notalone-memory-add --category recent_state --text '我下周出差'  # 本人资料
notalone-memory-list --contact-id '...'
notalone-memory-delete --contact-id '...' --memory-id '...'
notalone-task-cleanup  # 清理超过 90 天的终态任务元数据，不清理含正文追踪
```

提取先做证据契约与逐条来源语义核验，再执行置信度、风险、维度放行、删除指纹与写入裁决。低于 0.7、敏感或未知风险的候选留待确认；未核验不能自动采纳。默认维度放行表为空，旧候选不会被补认证或重新自动采纳。完整规则见 [ADR-036](architecture/adr/036-per-dimension-adoption-release.md)、[ADR-046](architecture/adr/046-source-bound-dimension-evidence.md)与 [放行台账](docs/memory-adoption-dimension-release-ledger.md)。

提取、来源核验与写入裁决使用既有思考模式，配置的服务须支持 `thinking.type=enabled` 与结构化工具结果。模型置信度不等于实测准确率，来源支持也不证明现实真伪；来源时间不等于事件时间或状态仍有效。局部对照与残留问题见 [语义与来源复测](docs/memory-source-scope-fidelity-20261002.md)。

实际提取默认保存来源处理、窗口、模型输入与返回、规则及写入结果。普通命令只输出状态和元数据；以下命令由你主动读取或删除敏感追踪，查询不构建模型：

```bash
notalone-memory-trace --contact-id '...' list --limit 100
notalone-memory-trace --contact-id '...' list --before '...'  # 上一页 next_before
notalone-memory-trace --contact-id '...' show '...'
notalone-memory-trace --contact-id '...' find contact_memory '...'
notalone-memory-trace --contact-id '...' find message '...'
notalone-memory-trace --contact-id '...' delete '...'
notalone-source-trace --contact-id '...' find message '...'
notalone-source-trace --contact-id '...' show '...'
```

缺失历史记录显示 `not_recorded`，手输资料显示 `not_applicable`，无法观察最终供应商载荷时显示 `not_observable`。追踪写入失败停止当前批次、不推进水位；手动删除追踪保留权威消息与记忆，来源删除清除受影响追踪正文。HTTP 查询、分页与删除契约见 [完整追踪](architecture/current/memory-extraction-trace.md)。

本地后端会在本次导入或增量观察提交后自动排队相应记忆任务；独立 `notalone-front-sync` 只保存来源与消息，不自动提取。缺少模型配置时任务保持 queued，失败可显式恢复原任务；候选回复优先于尚未开始的后台模型调用。调度、重试与停止边界见 [ADR-038](architecture/adr/038-import-triggered-memory-work-and-reply-priority.md)与 [ADR-034](architecture/adr/034-explicit-failed-task-recovery-selection.md)。

</details>

<details>
<summary><strong>来源删除与回复依据</strong></summary>

本地后端按已确认联系人提供来源列表、单份来源删除、任务状态与回复依据。删除请求持久化且可重试，不依赖模型密钥；只有完成清除与复核才显示删除完成。

| HTTP 入口 | 用途 |
| --- | --- |
| `GET /api/contacts/{contact_id}/sources` | 列出当前联系人的来源。 |
| `DELETE /api/contacts/{contact_id}/sources/{source_id}` | 请求删除一份来源及受影响资料。 |
| `GET /api/tasks/status?contact_id=...&task_id=...` | 查询持久任务状态与步骤。 |
| `GET /api/contacts/{contact_id}/replies/{reply_request_id}/evidence` | 读取生成时保存的依据快照。 |

依据接口返回实际选入的上下文、选入原因和候选引用，不重新检索或调用模型。普通草稿润色使用本次草稿、指令、受控 Skill 与明确选中的续写候选；只有显式设置 `include_relationship_context=true`，才允许在已确认联系人范围内检索背景资料。

来源删除清除该来源及失去支持的聊天、记忆历史正文与回复快照；共享来源支持的资料保留。不含正文的最小模型调用记录保留，它不证明外部副本已经删除。完整约束见 [隐私、模型调用与删除](architecture/current/privacy-deletion.md)，实际实现与验收以代码、测试及 [桌面端说明](desktop/README.md)为准。

</details>

<details>
<summary><strong>检索与记忆准确率评测</strong></summary>

检索与召回评测只使用合成数据；生产检索仍为 SQL / 全文，向量路径未启用。

```bash
notalone-retrieval-evaluate
notalone-retrieval-evaluate --json
(cd backend && python -m unittest tests.integration.persistence.test_retrieval_evaluation)
(cd backend && python -m unittest tests.unit.retrieval.test_recall_evaluation)
```

检索评测覆盖同义、短语、时间、无结果、冲突与跨联系人隔离；没有匿名运行观察值时，引用纠错率与候选拒绝率为 `N/A`。召回评测的 109 条合成中文用例使用真实评分器与回复上下文组装，不连接数据库或模型，详见 [召回基线](docs/memory-recall-evaluation-baseline.md)。

记忆提取准确率评测默认跳过并返回退出码 2；只有显式提供专用 `NOTALONE_EVALUATION_API_KEY` 才向配置的模型服务发送仓库合成用例。凭据由 shell 安全注入，不写入命令历史：

```bash
python -m notalone.memory_extraction.evaluation
python -m notalone.memory_extraction.evaluation --dimension subject
python -m notalone.memory_extraction.evaluation --thinking
python -m notalone.memory_extraction.evaluation --baseline
```

评测不读 `.env` 或真实聊天、不连接数据库、不写记忆；模型名和地址沿用 `NOTALONE_DEEPSEEK_MODEL` / `NOTALONE_DEEPSEEK_BASE_URL`，可重复 `--case` 选择用例。退出码 0 表示全通过，1 表示有失败；`--baseline` 只在固定合成集观察未经核验的潜在去向，不提供生产绕过入口。

保留的七维度用例与独立来源挑战逐项检查命题、主体、限定、时间、去向和遗漏。单维度达标签要求用例数 ≥15、假事 0、记错人 0、一般错误 ≤1；语义标注覆盖单独报告，不参与标签判定。有限合成结果不能推断真实聊天准确率，达到门槛仍须逐类批准并记入 [放行台账](docs/memory-adoption-dimension-release-ledger.md)。评测中的 `auto` 不执行生产存储裁决，也不叠加运行时维度放行门。

独立方法复刻实验仍只处理固定合成场景，需专用凭据，不挂接生产或写入记忆：

```bash
python -m notalone.memory_extraction.replica_experiment \
  --split all --repetitions 2 --output-dir /tmp/new-synthetic-output
```

实验没有替换默认提取。方法、局部收益与残留问题见 [复刻实验报告](docs/memory-method-replication-experiment-20261002.md)与 [主体及事实状态迭代](docs/memory-subject-state-iteration-20261002.md)。

</details>

<details>
<summary><strong>合成测试与后端闭环验收</strong></summary>

```bash
conda activate NotAlone
NOTALONE_DISABLE_DOTENV=1 python -m unittest discover -s backend/tests -t backend -v
```

测试不读取 `chat_exports/` 中的私人资料。PostgreSQL 集成测试默认使用本地 `notalone_test`，或通过 `NOTALONE_TEST_DATABASE_URL` 指定名称以 `_test` 结尾的隔离库；每个用例只清理自己的合成数据。

核心业务闭环与增量观察记忆任务可分别验证：

```bash
(cd backend && NOTALONE_DISABLE_DOTENV=1 python -m unittest \
  tests.integration.server.test_import_auto_flow \
  tests.integration.server.test_core_business_flow -v)

(cd backend && NOTALONE_DISABLE_DOTENV=1 python -m unittest \
  tests.integration.server.test_observation_auto_flow -v)
```

用例使用真实 HTTP、正式生产模块、PostgreSQL 与 scripted fake model，自建、迁移并清理随机 `_test` 库，需要本机 PostgreSQL 与建库权限。验证导入、原任务处理、检索、候选依据、幂等、失败恢复、联系人隔离、来源删除及关闭边界；不使用现有业务库或外部模型凭据，也不证明真实模型质量或微信现场集成可用。

桌面与原生探针的基础验证入口：

```bash
(cd desktop && npm test)                # 类型与安全回归，真实 App 不运行
swift test --package-path native/macos
```

真实 App、普通页面与权限验收遵循 [工程工作流](docs/agents/engineering.md)及 [桌面验收与自动化测试说明](desktop/README.md)。

</details>
