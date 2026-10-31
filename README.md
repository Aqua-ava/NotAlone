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

> **当前阶段：SQLite 开发版。** 默认业务存储已切换到本机 SQLite，本轮代码与合成验收已收尾。真实微信状态、来源连续性等尚未认证的能力保持关闭；首次使用引导、正式分发签名、公证与无开发环境机器验收仍待完成。

## 能做什么

| 你想做的事 | NotAlone 如何帮助你 |
| --- | --- |
| **回应一段消息** | 补充这位联系人的聊天和可选表达方向；已有想法用“帮我表达”，想法留空也可点“帮我想想”。 |
| **把草稿说得更自然** | 在统一工作区输入自己的想法或草稿，点击“帮我表达”；可关闭默认开启的关系语境。 |
| **结合你们的关系背景** | 默认在已确认范围内使用同一联系人的资料，可关闭关系语境，并回看本轮实际参考。 |
| **整理聊天里的关系资料** | 对已获准、来源可验证的单联系人历史保留来源并管理记忆；未核验文字使用独立本机隔离区，不进入检索、记忆或生成。 |

每次回复都属于你明确选择的一位联系人。一次性的表达要求不会静默成为长期偏好，复制候选也不代表发送或采纳。

### 一次回复，四个步骤

| ① 确认联系人 | ② 说明本次输入 | ③ 查看并编辑 | ④ 亲自发送 |
| :--- | :--- | :--- | :--- |
| 在顶部搜索并明确选择一位联系人 | 补充聊天或自己的想法，也可留空点“帮我想想” | 比较候选、展开依据，改成自己的表达 | 复制最终文字，到聊天应用中发送 |

## 快速开始

### 使用 App

目前以源码开发模式为准，受管安装包和首次使用引导不属于本轮交付。已有已确认联系人的手动表达不依赖微信、CLI 或录屏权限；新建微信联系人仍须核验账号、会话及用户确认范围，不能用手动文件导入绕过身份绑定。

1. **检查本机服务与存储。** 启动开发版后，在管理后台确认 SQLite 存储已就绪，并检查本机后端连接。存储就绪不代表模型或微信渠道已经可用。
2. **选择本次联系人。** 使用已确认的联系人，并在使用模型前完成本机模型配置。首次使用流程尚未交付，不把空目录启动成功视为完整可用。
3. **生成并修改候选。** 在统一表达工作区填写自己的想法和补充聊天；生成后查看依据、编辑和复制，最后亲自发送。
4. **区分正常历史与隔离文字。** 微信历史和增量读取由实际支持档控制，未认证时保持关闭。“设置 → 未核验历史”可查看或删除独立隔离文字；这些文字不属于正常联系人资料，也不用于检索、记忆或生成。旧 JSONL 手动历史导入不作为当前 SQLite 入口。

更换版本前，请通过“NotAlone → 退出 NotAlone”正常退出旧版；仅关闭窗口会保留 App 运行。更多操作见 [桌面端说明](desktop/README.md#手动首版使用)。

### 从源码运行

源码开发使用 macOS、Node.js ≥ 24 和 pnpm 11.25.0；原生探针开发另需 Xcode / Swift。后端统一使用 TypeScript 与 DSH，默认业务存储为本机 SQLite；SQLite 使用 Node 的内置模块，不需要另装数据库服务。

先确认 Node.js ≥ 24 和 pnpm 11.25.0 可用。若尚未安装 pnpm，可使用 `npm install --global pnpm@11.25.0`；已安装时无需执行。然后在仓库根目录运行：

```bash
pnpm install --frozen-lockfile
pnpm run dev:status
# 状态为 stopped 时再启动
pnpm run dev
```

启动后还需核对本机后端路径与模型配置。源码启动不等于已取得包含完整运行时的安装包；日常开发和验收使用 `pnpm run dev`。

<details>
<summary><strong>展开源码环境、首次连接与渠道研发配置</strong></summary>

### 1. 准备依赖

| 依赖 | 用途 |
| --- | --- |
| macOS 15+、Xcode 16.4 / Swift 6 | 原生截图、OCR 与会话定位探针；完整原生路径以 macOS 15+ 为基线。 |
| Node.js ≥ 24、pnpm 11.25.0 | 安装锁定依赖，运行 TypeScript / DSH、SQLite 与 Electron 开发版。 |
| 微信桌面版、外置 WeChat CLI / WCDB | 微信渠道研发另行准备；组件存在不等于真实读取能力已认证。 |
| 模型供应商 API Key | 使用真实模型时配置；未配置则模型入口失败关闭。 |

**关于 WeChat CLI：** 本仓库只保留调用外置工具的适配代码、配置接口和相关测试。`wechat-cli` 可执行文件、`libWCDB.dylib` 和独立 CLI 源码不随仓库或 App 提供；本机外置配置见 [桌面端说明](desktop/README.md#外置微信工具)。

### 2. 准备后端与原生探针

```bash
pnpm install --frozen-lockfile
```

该命令只准备 workspace 依赖。原生探针按[原生开发说明](native/macos/README.md)单独构建；模型配置另行保留。

依赖使用 `pnpm install --frozen-lockfile` 安装，开发版启动时受控初始化或重开 SQLite 实例，详见[默认切换与验证记录](docs/verification/20-sqlite-cutover-and-legacy-cleanup.md)。


### 3. 准备并启动桌面端

前后端统一由根目录 pnpm workspace 管理，版本锁定在根 `pnpm-lock.yaml`；`backend-ts/` 和 `desktop/` 各自声明依赖。请在仓库根目录安装，不使用 `npm install` 或 `npm ci` 安装项目依赖。运行脚本不会自动安装或修改锁文件；`pnpm run dev` 运行桌面开发入口。

根目录可运行 `pnpm typecheck`、`pnpm test:backend`、`pnpm test:desktop`；`pnpm test` 串行执行两端测试。新增依赖用 `pnpm --filter ./backend-ts add <包名>` 或 `pnpm --filter ./desktop add <包名>`。

```bash
pnpm install --frozen-lockfile
pnpm run dev:status
# 状态为 stopped 时再启动
pnpm run dev
```

日常使用 `pnpm run dev`：React/CSS 保存后热更新，main、preload、共享代码与 TypeScript 后台变化后安全重启。`pnpm start` 等同于开发模式；仅构建用 `pnpm run build`。打包与运行打包版仅限用户明确发起的发布任务，`pnpm --dir desktop run package` 当前受发布门禁限制，详见[日常开发热更新](desktop/README.md#日常开发热更新)。

### 4. 首次连接与使用

本机启动配置提供项目目录、模型配置与握手路径；SQLite 配置由开发启动探针交给正式宿主。默认启动只装配 SQLite 插件，缺少有效 SQLite 配置时停止连接。旧配置中的 `pythonExecutable` 仅作兼容读取并忽略。

业务数据库位于当前 App `userData` 下的 `managed/sqlite/notalone.sqlite`。实例创建、重开和结构升级由受控启动流程管理；发现冲突或未确认清理时进入维护状态。模型配置、Skill 与外部原始资料继续保留。

微信渠道需要显式的外置 CLI 配置、联系人授权和能力认证。前台定位探针的屏幕录制权限及签名归属见[权限说明](docs/guides/macos-app-permissions-and-errors.md)；OCR 不作为后台 CLI 同步的门禁。当前真实微信未认证能力保持关闭，代码和合成验证的完成不代替真实支持档。

</details>

## 当前进度

| 模块 | 已有进展与验收范围 |
| --- | --- |
| 桌面端 | Electron + React 管理窗口与小窗已接入主要业务流程，完整原生交付仍待验收。 |
| TypeScript / DSH 后端 | 默认 SQLite 宿主已接入联系人、历史、任务、记忆、检索、候选与统一删除；代码、合成和已记录的开发 App 验证按本轮范围收尾，真实模型质量单独记录。 |
| 微信文字同步 | 已实现变化页增量与本机持久检查点，日常同步不再每轮重扫历史行；当前授权范围已在开发实例恢复读取，首次索引与待补历史仍按实际进度展示。状态查询、消息事件流及验证边界见 [ADR-133](architecture/adr/133-page-delta-private-history-sync.md)，未认证能力继续关闭。 |
| 前台 OCR | 仅承担当前微信会话定位；已改为窗口自动布局与名称局部 OCR，无需手填坐标；新版实机移动与缩放验收待完成，不作为后台 CLI 同步门禁。 |
| 检索与记忆 | 生产检索使用 SQL / 全文路径，向量检索未启用；正常记忆维护默认启用逐项来源核验；历史维度放行台账不再是正常维护的前置条件。 |
| 平台与分发 | 当前面向 macOS；Windows 微信适配未实现，桌面包尚未完成 Developer ID 分发与公证。 |

本轮 SQLite 证据见[默认切换](docs/verification/20-sqlite-cutover-and-legacy-cleanup.md)与[组合收尾记录](docs/verification/21-three-specs-integrated-acceptance.md)。[桌面端说明](desktop/README.md)、[后端说明](backend-ts/README.md)和旧验收记录包含历史阶段内容；架构设计和旧版本测试不代表当前真实能力已经认证。

## 隐私与控制

- **先确认，再读取。** 一次历史导入只归属一位联系人；CLI 正文同步默认仅限主动选择并确认的绑定；按 [ADR-089](architecture/adr/089-all-private-wechat-sync-scope.md)明确开启全部私聊范围后，自动纳入当前账号现有及以后新增私聊，按稳定身份建联。关闭总开关或退出运行时后停读，重新开启只在已确认范围内恢复可检测缺口。
- **发送由你决定。** 候选可编辑，最终消息由你亲自发送；产品没有外部聊天发送 Tool 或后台代发能力。
- **清楚区分本机处理与模型调用。** 业务资料保存在本机 SQLite；调用真实模型会向配置的服务提供者发送本次必要文本。未核验文字使用独立隔离库，禁止进入检索、记忆或生成。原始视觉帧默认只在端侧内存中处理，不持久化或上传。
- **资料有来源，也有删除路径。** 来源、联系人及聊天清空按统一删除流程处理相关派生资料；其他合法来源仍支持的消息保留。微信原聊天、外部原始文件与模型供应商副本分别处理，清空边界无法认证时显示待确认。
- **完整追踪同样属于敏感资料。** 含正文的提取追踪同样受来源与删除规则约束。`.env`、私人聊天、追踪、备份和截图不应提交到 Git。

自动采纳必须带来源、标记为 `auto` 且可撤销；模型置信度与来源支持不等于真实准确率。[维度放行台账](docs/evaluations/memory/dimension-release/memory-adoption-dimension-release-ledger.md)保留历史评测与显式维度协议。默认自动采纳按 [ADR-085](architecture/adr/085-source-verified-automatic-adoption.md)：通过来源及适用检查后自动裁决，不以额外语用、置信度或风险标签制造人工待办；人工保护、删除及关系矛盾待定例外保留。

主动收藏表达样本按[ADR-082](architecture/adr/082-retire-explicit-style-samples.md)退役；候选编辑、复制及用户明确管理的长期表达偏好保留。

## 开发与文档

```text
NotAlone/
├── desktop/          Electron + React/TypeScript 桌面端
├── backend-ts/       TypeScript 业务、DSH profile、SQLite 存储与 Node 测试
├── native/macos/     Swift 原生截图、OCR 与会话定位探针
├── website/          独立静态官网
├── scripts/          安装与公开前检查
├── docs/             工程、操作与验证说明
└── architecture/     现行规格、设计草案与 ADR
```

| 想了解什么 | 从这里开始 |
| --- | --- |
| 操作说明、评测与研究材料的分类入口 | [文档索引](docs/README.md) |
| 桌面运行、构建与验收 | [desktop/README.md](desktop/README.md) |
| 后端安装、HTTP 与 CLI | [backend-ts/README.md](backend-ts/README.md) |
| 当前 SQLite 初始化、切换与验证 | [默认切换记录](docs/verification/20-sqlite-cutover-and-legacy-cleanup.md) · [SQLite 架构](architecture/adr/109-controlled-sqlite-storage-foundation.md) |
| 原生探针与权限 | [native/macos/README.md](native/macos/README.md) · [权限与启动错误](docs/guides/macos-app-permissions-and-errors.md) |
| 领域词汇与架构决策 | [CONTEXT.md](CONTEXT.md) · [架构索引](architecture/README.md) |
| 记忆的来源、提取与删除 | [完整追踪](architecture/current/memory-extraction-trace.md) · [维度放行台账](docs/evaluations/memory/dimension-release/memory-adoption-dimension-release-ledger.md) |
| 开发约定与任务工作流 | [AGENTS.md](AGENTS.md) · [工程工作流](docs/agents/engineering.md) |
| 官网本地预览 | [website/README.md](website/README.md) |

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

日常入口是 `pnpm run dev:status`，复用已有开发实例；没有实例才运行 `pnpm run dev`。后台由官方 DSH profile 装配 SQLite 业务插件，按当前 `userData` 和预期数据库身份重开同一实例，模型配置独立保留。

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

SQLite 存储状态可在管理后台的“SQLite 存储诊断”查看。结构升级由当前注册的 SQLite 迁移和启动流程管理；旧 `schema-prepare-cli.ts` 已退役。

历史 Python 后台及测试已从当前工作树清理，对照仍保存在固定 Git 提交与显式独立测试环境；登记及命令见 `backend-ts/test/historical-inventory.json`、`npm run test:historical -- --list`。`backend-ts/test/fixtures/` 下的合成 JSON／JSONL 夹具保留原始字节，现已归入 TypeScript 后台；冻结历史清单中的原路径仅用于来源追溯。历史结果不表示当前源码通过，正常测试不依赖 Conda 或 Python 后端。

迁移本轮的固定采集为96/96成功、96次物理调用、0重试；用户明确跳过回复盲评和启动／内存对照，未评／未测不写为通过。详见[范围及实测记录](.scratch/dsh-ts-migration/final-acceptance-closeout/capture-summary.json)。当前源码开发验证与旧安装包、发布验收分别记录。
