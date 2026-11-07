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

**NotAlone 帮你把想说的话整理成可编辑的候选回复。** 确认本次联系人，补充聊天或自己的想法，结合获准的关系资料生成建议；查看依据、修改成自己的表达，最后亲自发送。

> **当前使用源码开发版。** 桌面采用 Electron／React，后台采用 TypeScript／DSH 和本机 SQLite。各能力是否可用取决于当前配置、授权与来源核验；开发版能启动不代表独立安装包、完整首用或真实渠道已通过验收。

## 能做什么

| 你想做的事 | 当前使用方式 |
| --- | --- |
| 整理自己的想法 | 在联系人工作区输入想法或草稿，点“帮我表达”。 |
| 获得表达建议 | 补充聊天，或留空想法点“帮我想想”；候选不代表你已采纳其立场。 |
| 结合关系背景 | 使用同一联系人合法的本机消息和记忆，可关闭背景；开启时自动使用最近最多 50 条消息，并查看实际依据。 |
| 管理关系资料 | 查看、修正、删除资料；历史与增量按各自规则处理，图片与文字共同提供记忆证据。 |

### 一次回复，四个步骤

| ① 确认联系人 | ② 说明本次输入 | ③ 查看并编辑 | ④ 亲自发送 |
| :--- | :--- | :--- | :--- |
| 明确选择，或核对有效前台名称匹配的已有联系人 | 填写想法、补充聊天或请求建议 | 比较候选，展开依据，修改成自己的表达 | 复制已保存版本，到聊天应用中发送 |

新消息、联系人切换或打开窗口不自动生成。一次性要求、候选选择和复制都不会静默成为长期偏好；复制不等于发送。

## 快速开始

### 使用 App

1. 从下方源码入口启动，检查本机存储与后端连接。存储就绪不代表模型或微信读取已可用。
2. 在「设置 → AI 服务」配置受支持的接收地址和对应密钥。保存配置不代表已经调用或验证模型；实际生效与兼容边界见[桌面说明](desktop/README.md)。
3. 使用已确认联系人，或通过当前开放的微信连接流程确认账号及所选会话。工具准备、账号确认、读取授权和前台名称匹配是不同资格。
4. 在统一工作区明确生成、查看依据、编辑并复制，最终亲自发送。已有联系人的合法本机资料不必等待微信、历史同步或记忆处理完成。

当前正常历史来自授权微信同步；手动历史文件导入是已采纳但尚未开放的目标合同，不能用它绕过联系人建联。独立隔离文字也不进入正常检索、记忆或回复。具体能力与操作入口见[桌面端说明](desktop/README.md)。

更换运行版本前通过“NotAlone → 退出 NotAlone”正常退出；只关闭窗口仍会保留 App。日常开发使用热更新实例，打包或运行打包版只在用户明确提出的发布任务中进行。

### 从源码运行

需要 macOS、Node.js ≥24 和锁定的 pnpm 版本（当前为 11.25.0，见 [package.json](package.json)）。原生路径面向 macOS 15+／Apple Silicon，探针编译还需匹配的 Xcode／Swift，见[原生说明](native/macos/README.md)。SQLite 使用 Node 内置模块，不另装数据库服务。

在仓库根目录安装锁定依赖并检查已有开发实例：

```bash
pnpm install --frozen-lockfile
pnpm run dev:status
```

已有本项目实例就复用；仅状态为 stopped 时运行：

```bash
pnpm run dev
```

React／CSS 保存后热更新，main、preload、共享代码和 TypeScript 后台的变更由监督器安全重启。启动后再次检查 `dev:status` 并在界面确认就绪。开发脚本的选项、后台启动和实例归属检查统一见[桌面开发说明](desktop/README.md#日常开发热更新)。

依赖在根 workspace 安装，使用根 `pnpm-lock.yaml`，不在子项目另跑 `npm install` 或 `npm ci`。新增依赖使用 `pnpm --filter ./backend-ts add <包名>` 或 `pnpm --filter ./desktop add <包名>`。

微信渠道另需受支持的本机外置读取工具及授权；工具或动态库存在不证明真实读取能力通过。配置与版本限制见[外置微信工具](desktop/README.md#外置微信工具)，权限和安全诊断见[开发权限指南](docs/guides/macos-app-permissions-and-errors.md)。

## 当前进度

| 范围 | 如何判断当前状态 |
| --- | --- |
| 桌面、后台与存储 | 正常入口使用 Electron／React、DSH／TypeScript 和受控 SQLite。模块能力与接口见[后端导航](backend-ts/src/README.md)。 |
| 微信历史、增量、图片与前台定位 | 按当前来源核对与实际运行证据逐项判断；名称匹配不认证前台账号，OCR 不作为后台同步门禁。规则见[同步规格](architecture/current/wechat-sync.md)。 |
| 记忆处理与检索 | 历史自动分批、增量独立调度，内容拒绝与技术故障分开；默认来源核验不依赖历史维度放行台账。规则见[记忆处理](architecture/current/memory-processing.md)与[回复规格](architecture/current/reply-generation.md)。 |
| Skill | 授权根内核验后默认启用，可停用；正常回复按需组合多个有效包。学习／审核发布等目标与当前开放入口分开，见[Skill 规格](architecture/current/skill-library.md)。 |
| 独立分发与平台 | 当前开发面向 macOS；独立机器首用、签名、公证、发布包和其他平台须按各自发布任务验收。 |

来源不变时，退出重开按已接纳位置自动接续；重新认证与开发者批量修复入口退役，日常使用无需“修复同步”。真实来源变化仍停读待明确核对，不通过恢复动作接纳异源或重新授予读取权限。

历史迁移、合成测试和真实模型样例只证明各自记录的版本与范围。验证材料从[文档索引](docs/README.md)按需查找，README 不维护重复的阶段通过数量。

## 隐私与控制

- 联系人范围按稳定身份隔离；同步默认仅所选会话，明确全部私聊授权才允许纳入该账号现有及新增私聊。产品范围与当前实现开放能力分别核验，撤销或删除排除项不自动恢复。
- 同步仅在 App 运行、开关开启且资格有效时读取；前台视觉仅处理唯一微信窗口的布局和名称区域，原始帧默认不保存或上传。
- 业务资料保存在本机；模型调用会按配置与授权发送必要文字／图片等资料，不能把本机存储等同于没有外发。
- 自动采纳保留来源、标记为自动且可撤销；用户可以查看、修正和删除。删除以实际依赖闭包及复核结果为准，外部原件与供应商副本另有边界。
- 候选带依据、可编辑，最终消息由用户手动发送，产品不提供外部聊天发送 Tool。

完整规则集中在[数据契约](architecture/current/domain-data.md)与[隐私及删除规格](architecture/current/privacy-deletion.md)。

## 开发与文档

| 当前问题 | 入口 |
| --- | --- |
| 开发约定、任务工作流和最小验证 | [AGENTS.md](AGENTS.md)、[工程工作流](docs/agents/engineering.md) |
| 当前产品设计与业务边界 | [架构阅读入口](architecture/README.md)、[领域语言](CONTEXT.md) |
| 桌面运行、设置与原生验收 | [desktop/README.md](desktop/README.md)、[开发指南](docs/guides/README.md) |
| 后台模块、接口与数据库 | [backend-ts/README.md](backend-ts/README.md)、[存储合同](backend-ts/src/storage/sqlite/README.md) |
| 操作、评测、研究与历史记录 | [文档索引](docs/README.md) |
| 官网预览 | [website/README.md](website/README.md) |

产品规则以 `architecture/current/` 为现行入口；工程 README 负责实际命令和模块导航。历史 ADR、实验和旧验收按追溯需要读取，不能冒充当前实现或新任务要求。

## 命令与验证

根目录提供以下命令；先执行受影响的单用例或模块检查，再按影响范围扩大，具体要求见[工程工作流](docs/agents/engineering.md#测试与验证)。

```bash
pnpm typecheck
pnpm test:backend
pnpm test:desktop
```

`pnpm test` 串行执行两端测试，`pnpm run build` 仅构建开发代码；构建和自动测试不替代实际 App、微信或真实模型验收。历史 Python 对照只从[历史测试说明](backend-ts/test/HISTORICAL.md)显式进入，不属于正常后台运行。

首次克隆可启用本地推送前隐私检查：

```bash
node scripts/install_git_hooks.mjs
```

它配置 `.githooks`；已有自定义钩子目录时停止，避免覆盖。检查只在本机读取待公开提交及可达历史，不联网，也不保证发现所有隐私。公开前核查、命中归属和远端操作授权见[工程工作流](docs/agents/engineering.md#公开前检查)。
