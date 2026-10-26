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
| **回应一段消息** | 补充这位联系人的聊天和可选表达方向；已有想法用“帮我表达”，想法留空也可点“帮我想想”。 |
| **把草稿说得更自然** | 在统一工作区输入自己的想法或草稿，点击“帮我表达”；可关闭默认开启的关系语境。 |
| **结合你们的关系背景** | 默认在已确认范围内使用同一联系人的资料，可关闭关系语境，并回看本轮实际参考。 |
| **整理聊天里的关系资料** | 单联系人 JSONL 先预览、再确认导入；关系资料与记忆候选保留来源，支持回看和管理。 |

每次回复都属于你明确选择的一位联系人。一次性的表达要求不会静默成为长期偏好，复制候选也不代表发送或采纳。

### 一次回复，四个步骤

| ① 确认联系人 | ② 说明本次输入 | ③ 查看并编辑 | ④ 亲自发送 |
| :--- | :--- | :--- | :--- |
| 在顶部搜索并明确选择一位联系人 | 补充聊天或自己的想法，也可留空点“帮我想想” | 比较候选、展开依据，改成自己的表达 | 复制最终文字，到聊天应用中发送 |

## 快速开始

### 使用 App

以下适用于已取得受管版 `NotAlone.app` 的本机试用。受管运行时无需另装 Conda 或 PostgreSQL；已有已确认联系人的手动表达不依赖微信、CLI 或录屏权限。按 [ADR-087](architecture/adr/087-wechat-confirmed-contact-onboarding.md)，空目录新用户须先配置微信、选择真实会话并确认首位联系人，或按 [ADR-089](architecture/adr/089-all-private-wechat-sync-scope.md)明确授权当前账号全部私聊后自动加入；旧独立创建与导入新建接口待退役，新用户微信接入及最终交付仍需验收。

1. **完成本机设置。** 打开 App，点击“开始本机设置”，在“本人身份与模型”填写本人展示名称，并输入自己的模型密钥。新安装默认使用 DeepSeek 官方（`https://api.deepseek.com`）与 `deepseek-flash`。
2. **选择本次联系人。** 点击顶部联系人下拉框，搜索并明确选择已有联系人，再进入“手动输入本次聊天”。需要添加时，在“联系人”页面通过“添加微信联系人”确认真实会话。
3. **生成并修改候选。** 在统一表达工作区分开填写自己的想法和补充聊天；“帮我表达”整理已有想法，“帮我想想”直接提供可选择的建议候选。关系语境默认开启且可关闭；生成后可查看“本次参考”、编辑和复制，建议不等于你已确认的意图。
4. **需要历史时再导入。** 在“设置 → 高级 → 从文件导入”预览单联系人 JSONL，确认归属后正式导入。混有多位联系人的资料需要先拆分；导入来源可查看和删除。

更换版本前，请通过“NotAlone → 退出 NotAlone”正常退出旧版；仅关闭窗口会保留 App 运行。更多操作见 [桌面端说明](desktop/README.md#手动首版使用)。

### 从源码运行

源码开发需要 macOS、Homebrew、PostgreSQL、Swift 与 Node.js ≥ 24。后端统一使用 TypeScript 与 DSH；安装脚本准备锁定的 Node 依赖、开发库与原生探针。**已有数据库请先阅读 [迁移与恢复说明](backend-ts/database/README.md)。**

在仓库根目录运行：

```bash
zsh scripts/install.sh
cd desktop
npm ci
npm run dev
```

启动后还需配置本机后端路径、初始化本人并配置模型；完整步骤如下。源码启动和默认前端打包不等于已取得包含完整运行时的受管版 App。

<details>
<summary><strong>展开源码环境、首次连接与渠道研发配置</strong></summary>

### 1. 准备依赖

| 依赖 | 用途 |
| --- | --- |
| macOS 15+、Xcode 16.4 / Swift 6 | 原生截图、OCR 与会话定位探针；完整原生路径以 macOS 15+ 为基线。 |
| Homebrew、PostgreSQL | 安装脚本准备本地数据库，默认开发库为 `notalone_dev`。 |
| Node.js ≥ 24 | 构建 Electron + React 桌面端。 |
| 微信桌面版、外置 WeChat CLI / WCDB | 使用微信文字同步时需要自行准备。 |
| DeepSeek API Key | 使用真实模型时配置；未配置则模型入口失败关闭。 |

**关于 WeChat CLI：** 本仓库只保留调用外置工具的适配代码、配置接口和相关测试。`wechat-cli` 可执行文件、`libWCDB.dylib` 和独立 CLI 源码不随仓库或 App 提供；本机外置配置见 [桌面端说明](desktop/README.md#外置微信工具)。

### 2. 安装后端与原生探针

```bash
zsh scripts/install.sh
```

脚本检查依赖，按锁安装 TypeScript 后台与桌面依赖，尝试启动本地 PostgreSQL、创建开发库并通过 Node 按版本应用迁移，缺失时生成权限为 `0600` 的根 `.env`，随后构建原生探针。模型密钥由你另行配置；安装过程不启动桌面 App、HTTP 服务或微信读取。

已有数据库请先阅读 [迁移与恢复说明](backend-ts/database/README.md)：无版本记录的旧库会停止等待核验，不自动猜测基线或重放历史 SQL。

### 3. 准备并启动桌面端

```bash
cd desktop
npm ci
npm run dev
```

日常使用 `npm run dev`：React/CSS 保存后热更新，main、preload、共享代码与 TypeScript 后台变化后安全重启。`npm start` 等同于开发模式；仅构建用 `npm run build`。打包与运行打包版仅限用户明确发起的发布任务，`npm run package` 当前受发布门禁限制，详见[日常开发热更新](desktop/README.md#日常开发热更新)。默认包只含前端；可用 `--with-probe` 附带 NotAlone 自研探针，微信 CLI / WCDB 始终由用户在本机另行准备。

### 4. 首次连接与使用

在“应用配置 → 机器环境”的“本机启动路径”中填写项目目录、本机配置文件和握手文件路径。旧配置中的 `pythonExecutable` 仅作兼容读取并忽略，不检查或执行；新配置不需要该字段。原项目、`.env`、数据库和资料路径继续沿用。

保存后点击“重新检查并连接”，连接就绪后进入“本人身份与模型”明确初始化本人并配置模型。

下述是历史渠道研发入口，首版 App 不引导启用：先预览、确认并**正式导入**一份单联系人历史，建立本人微信渠道身份。导入后如提示同步宿主尚未装配，点击“认证停读并重新加载同步服务”；连接恢复后，再到“联系人 → 添加微信联系人”主动选择会话、点击“确认并授权所选会话”，最后开启总开关。仅预览或初始化本人身份还不足以启用微信同步。

微信同步需要在机器环境中另行配置外置 CLI 路径。前台定位探针可稍后配置，其屏幕录制权限及签名归属见 [权限说明](docs/guides/macos-app-permissions-and-errors.md)；目前 OCR 仍有实机验收缺项。

</details>

## 当前进度

| 模块 | 已有进展与验收范围 |
| --- | --- |
| 桌面端 | Electron + React 管理窗口与小窗已接入主要业务流程，完整原生交付仍待验收。 |
| TypeScript / DSH 后端 | 导入、任务、记忆、检索、候选与来源删除已有合成 HTTP / PostgreSQL 闭环验证；真实模型质量需单独验证。 |
| 微信文字同步 | 固定 CLI 版本的单联系人读取、去重、故障恢复与 10 分钟后台运行已有实机证据；多联系人、长时稳定性与最终 App 仍有验收缺项。 |
| 前台 OCR | 仅承担当前微信会话定位；已改为窗口自动布局与名称局部 OCR，无需手填坐标；新版实机移动与缩放验收待完成，不作为后台 CLI 同步门禁。 |
| 检索与记忆 | 生产检索使用 SQL / 全文路径，向量检索未启用；正常记忆维护默认启用逐项来源核验；历史维度放行台账不再是正常维护的前置条件。 |
| 平台与分发 | 当前面向 macOS；Windows 微信适配未实现，桌面包尚未完成 Developer ID 分发与公证。 |

运行证据见 [桌面端说明](desktop/README.md)、[后端说明](backend-ts/README.md)与 [macOS 验收记录](docs/guides/macos-app-permissions-and-errors.md)。架构文档中的设计不代表功能已通过端到端验收。

## 隐私与控制

- **先确认，再读取。** 一次历史导入只归属一位联系人；CLI 正文同步默认仅限主动选择并确认的绑定；按 [ADR-089](architecture/adr/089-all-private-wechat-sync-scope.md)明确开启全部私聊范围后，自动纳入当前账号现有及以后新增私聊，按稳定身份建联。关闭总开关或退出运行时后停读，重新开启只在已确认范围内恢复可检测缺口。
- **发送由你决定。** 候选可编辑，最终消息由你亲自发送；产品没有外部聊天发送 Tool 或后台代发能力。
- **清楚区分本机处理与模型调用。** 本机开发路径使用 PostgreSQL 保存资料；调用真实模型会向配置的服务提供者发送本次必要文本。原始视觉帧默认只在端侧内存中处理，不持久化或上传。
- **资料有来源，也有删除路径。** 可删除单份导入来源及失去来源支持的派生资料；其他来源仍支持的消息保留。微信原聊天、原始导入文件与外部模型副本须分别处理，当前来源删除入口不提供联系人或账户整体删除。
- **完整追踪同样属于敏感资料。** 含正文的提取追踪默认保存在数据库，持续到手动删除或来源删除；90 天任务清理只清终态任务元数据。`.env`、私人聊天、追踪、备份和截图不应提交到 Git。

自动采纳必须带来源、标记为 `auto` 且可撤销；模型置信度与来源支持不等于真实准确率。[维度放行台账](docs/evaluations/memory/dimension-release/memory-adoption-dimension-release-ledger.md)保留历史评测与显式维度协议。默认自动采纳按 [ADR-085](architecture/adr/085-source-verified-automatic-adoption.md)：通过来源及适用检查后自动裁决，不以额外语用、置信度或风险标签制造人工待办；人工保护、删除及关系矛盾待定例外保留。

主动收藏表达样本按[ADR-082](architecture/adr/082-retire-explicit-style-samples.md)退役；候选编辑、复制及用户明确管理的长期表达偏好保留。

## 开发与文档

```text
NotAlone/
├── desktop/          Electron + React/TypeScript 桌面端
├── backend-ts/       TypeScript 业务、DSH profile、SQL 迁移与 Node 测试
├── native/macos/     Swift 原生截图、OCR 与会话定位探针
├── website/          独立静态官网
├── scripts/          安装、部署与公开前检查
├── docs/             工程、操作与验证说明
└── architecture/     现行规格、设计草案与 ADR
```

| 想了解什么 | 从这里开始 |
| --- | --- |
| 操作说明、评测与研究材料的分类入口 | [文档索引](docs/README.md) |
| 桌面运行、构建与验收 | [desktop/README.md](desktop/README.md) |
| 后端安装、HTTP 与 CLI | [backend-ts/README.md](backend-ts/README.md) |
| 数据库升级与旧库恢复 | [backend-ts/database/README.md](backend-ts/database/README.md) |
| 原生探针与权限 | [native/macos/README.md](native/macos/README.md) · [权限与启动错误](docs/guides/macos-app-permissions-and-errors.md) |
| 领域词汇与架构决策 | [CONTEXT.md](CONTEXT.md) · [架构索引](architecture/README.md) |
| 记忆的来源、提取与删除 | [完整追踪](architecture/current/memory-extraction-trace.md) · [维度放行台账](docs/evaluations/memory/dimension-release/memory-adoption-dimension-release-ledger.md) |
| 开发约定与任务工作流 | [AGENTS.md](AGENTS.md) · [工程工作流](docs/agents/engineering.md) |
| 官网预览与部署 | [website/README.md](website/README.md) |

TypeScript 后台、桌面端与原生探针分别管理依赖、构建和测试；领域逻辑留在普通后台模块。根目录 `.env` 和私人导入目录 `chat_exports/` 已由 Git 忽略。

<details>
<summary><strong>开发前：本地隐私检查</strong></summary>

首次克隆后启用本地推送前隐私检查（需要 PATH 中可用的 Node.js）：

```bash
node scripts/install_git_hooks.mjs
```

该命令将本仓库的 `core.hooksPath` 设为 `.githooks`；已有其他自定义钩子目录时会停止，避免覆盖。Git 默认 `.git/hooks/` 中的旧钩子保留在磁盘上，但启用后不再执行；有自定义钩子时应先合并。每个新克隆都需安装一次。本地检查针对本次推送的每个提交或标签及完整可达历史，发现问题或无法检查时阻止推送；删除远端引用不扫描。它只在端侧读取，输出问题位置，不输出命中的敏感值。浅克隆须补齐历史。

本地钩子可被跳过，也不保证识别所有隐私。

</details>

## 命令与验证

日常入口是 `cd desktop && npm run dev:status`，复用已有开发实例；没有实例才运行 `npm run dev`。后台由官方 DSH profile 装配 TypeScript 业务模块，沿用原 `.env`、PostgreSQL、本人和联系人身份及资料位置。

```bash
cd backend-ts
npm run typecheck
npm test
# 显式查看固定 Git 树中的旧实现比较登记；不会默认启动历史Python
npm run test:historical -- --list
```

```bash
cd desktop
npm run typecheck
npm run test:inventory
npm test
```

固定本地向量模型准备使用 `node scripts/prepare_memory_embedding.mjs`；已有缓存可用 `--offline` 验证，不读取聊天或业务配置。正常业务运行不会下载模型。

数据库只读诊断和明确补齐入口：

```bash
node backend-ts/src/schema-prepare-cli.ts --migrations backend-ts/database/migrations
node backend-ts/src/schema-prepare-cli.ts --prepare --migrations backend-ts/database/migrations
```

历史 Python 后台及测试已从当前工作树清理，对照仍保存在固定 Git 提交与显式独立测试环境；登记及命令见 `backend-ts/test/historical-inventory.json`、`npm run test:historical -- --list`。`backend-ts/database/` 的 SQL 和 `backend-ts/test/fixtures/` 下的合成 JSON／JSONL 夹具保留原始字节，现已归入 TypeScript 后台；冻结历史清单中的原路径仅用于来源追溯。历史结果不表示当前源码通过，正常测试不依赖 Conda 或 Python 后端。

迁移本轮的固定采集为96/96成功、96次物理调用、0重试；用户明确跳过回复盲评和启动／内存对照，未评／未测不写为通过。详见[范围及实测记录](.scratch/dsh-ts-migration/final-acceptance-closeout/capture-summary.json)。当前源码开发验证与旧安装包、发布验收分别记录。
