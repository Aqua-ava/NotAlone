# DSH 插件开发与源码查证

涉及 DSH 启动、插件装配、模型、Agent、Tool、Skill、会话生命周期或依赖升级时使用本文。架构依据是 [ADR-102](../../architecture/adr/102-dsh-typescript-backend-migration.md)；本文把既有要求落实为开发步骤，不重新决定框架选型。

## 扩展边界

NotAlone 通过 DSH 官方 profile 和薄插件装配普通 TypeScript 业务模块。通用执行机制优先复用官方插件；权限、联系人隔离、来源、事务、预算和删除由业务代码负责。普通业务模块无需全部插件化，产品回复 Skill 也不等同于 DSH 运行时插件。

按任务只接入所需能力，并核对最终启用的插件树；依赖已安装不代表允许启用。版本固定要求沿用 ADR-102；候选回复助手会话按 [ADR-106](../../architecture/adr/106-persistent-assistant-conversations.md)保存受控持久运行记录，其他后台任务保持临时执行，范围与删除见[现行隐私规格](../../architecture/current/privacy-deletion.md#dsh-迁移的数据边界)。采用 DSH 不扩大数据、工具或外部发送权限。若公开扩展接口不足，先给出源码证据和最小复现，再按仓库决策流程讨论；不得静默改 DSH 核心、维护分叉或另造绕过官方启动机制的 Harness。

## 每次开发的步骤

1. **核对版本**：查看 [依赖声明](../../backend-ts/package.json)、[安装锁](../../pnpm-lock.yaml) 和实际解析到的包路径及版本。以当前任务的版本为准；声明、锁和安装不一致时先定位差异，不拿最新版文档补猜旧版接口。依赖升级同时核验插件组合、导出路径和兼容性。
2. **定位源码**：从下方导航找到官方文档、源码、类型定义及相关示例或测试，再核对已安装制品的 `package.json` 及其 `exports`／`types` 指向的实现与类型文件。记录官方源码 commit 与安装制品的对应依据；仅版本字符串相同不足以证明二者逐字一致。
3. **确认调用合同**：阅读本次使用的符号及必要调用链，确认参数、返回值、服务注入、配置生效位置、生命周期和错误处理。涉及会话、工具或取消时，额外核对作用域、释放及迟到结果处理。实现中存在但未公开导出的能力，不默认作为可依赖的扩展接口。
4. **通过插件接入**：复用正式 profile 和业务适配层，说明为何选择该扩展点。文档与源码不一致时，以锁定制品核验实际行为，记录差异；尚无证据的接口标为待确认，不能写成可用能力。
5. **验证并留证据**：按工程工作流先跑最小相关验证，再按影响范围扩大。接线修改使用正式 profile 的合成回归，记录测试替身与正常入口的差异。仅实际跑过的范围可写为验证通过；源码阅读、类型检查和合成测试不能替代真实模型或 App 验收。

完成条件：每个新增或改变的 DSH 调用、配置及生命周期假设，都有当前版本的可定位依据和对应验证结果；未解决的能力缺口已明确列出。

## 当前源码导航

导航用于定位，执行前仍需按上述步骤核对当前版本；它不是能力验收证明。

2026-10-26 查证：本项目直接 DSH 依赖及本机已核对的核心包为 `0.2.1-rc.2`，Cordis 声明为 `4.0.5`；[后台说明](../../backend-ts/README.md)指定源码参考 commit `687f282e8625c6b8d11ff58211a90524be2e4317`。本轮核对了相关公开声明，未完成整个 npm 制品与该源码树的可复现构建比对。

若本机有相邻的 `../dsh` 仓库，先核对它的 HEAD；本轮该 HEAD 与上述 commit 不同。用 `git show` 读取固定版本，不切换用户工作树。没有该仓库时，使用下面的固定提交链接，并对照实际安装包。

```sh
# 在 NotAlone 仓库根目录执行；此 SHA 是本次参考基线，升级时重新核验。
git -C ../dsh rev-parse HEAD
git -C ../dsh show 687f282e8625c6b8d11ff58211a90524be2e4317:docs/cordis-primer.md
node -p "JSON.stringify({version: require('./backend-ts/node_modules/@deepseek-ai/dsh/package.json').version, path: require.resolve('./backend-ts/node_modules/@deepseek-ai/dsh/package.json')})"
```

其他包也从 `backend-ts` 的依赖上下文解析；传递依赖沿实际安装图查找，不能假定都能从根目录直接导入。

| 需要核对的内容 | 固定版本的官方入口 | 本项目入口 |
| --- | --- | --- |
| profile 分层和启动 | [architecture](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md#L13)、[profile.ts](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/profile.ts#L1) | [launch.ts](../../backend-ts/src/launch.ts) 的 `--profile notalone` 启动与 [sqlite.patch.yml](../../backend-ts/profile/sqlite.patch.yml) 装配 |
| 插件声明、注入和退出清理 | [Cordis primer](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/cordis-primer.md#L7)：`inject`、`apply`、`ctx.effect` | [sqlite-host-plugin.ts](../../backend-ts/src/sqlite-host-plugin.ts) 的 `name`、`inject`、`apply`、`ctx.effect` |
| Agent 创建与取消释放 | [CreateAgentOptions](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/index.ts#L95)、[agent-loop 释放实现](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/index.ts#L550) | [generation.ts](../../backend-ts/src/reply/sqlite/generation.ts)：`setup`、`followup`、`whenIdle`、`cancel`、`dispose` |
| 会话创建与状态 | [SessionStore.create](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/index.ts#L1111) | [正式 profile](../../backend-ts/profile/sqlite.patch.yml) 的 session/projection 装配；候选回复持久化边界按 ADR-106，其他后台任务按 ADR-102 |
| Tool 注册、范围与守卫 | [tools/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L1071)：`register`、`restrict`、`guard` | [generation.ts](../../backend-ts/src/reply/sqlite/generation.ts) 的 scoped 工具装配 |
| 单次模型调用 | [llm/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/index.ts#L956)：`prepareCall` | [模型运行时](../../backend-ts/src/host/sqlite-model-runtime.ts)及其调用的适配层 |
| Skill provider | [skill/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill/src/index.ts#L390)：`registerProvider` | [provider.ts](../../backend-ts/src/skills/sqlite/provider.ts)、[library.ts](../../backend-ts/src/skills/sqlite/library.ts) |

正式产品插件是 `src/sqlite-host-plugin.ts`，由 `profile/sqlite.patch.yml` 装配。合成测试通过同一 SQLite 插件和隔离数据库核验宿主行为，模型、凭据和外部渠道使用明确的测试替身；旧 PostgreSQL 插件与测试入口只保留于固定 Git 历史。

按改动选取 [sqlite-host-launch.test.mjs](../../backend-ts/test/sqlite-host-launch.test.mjs)、[sqlite-discussion-host.test.mjs](../../backend-ts/test/sqlite-discussion-host.test.mjs)、[sqlite-reply-candidates-profile.test.mjs](../../backend-ts/test/sqlite-reply-candidates-profile.test.mjs)、[sqlite-skill-profile.test.mjs](../../backend-ts/test/sqlite-skill-profile.test.mjs)，先阅读夹具和运行要求，再按工程工作流执行。这些是验证入口，不是本轮已通过的运行测试清单。

## 证据记录

小任务在现有任务记录或交付说明中记录即可；需要保留阅读结论时放 `research/`。该目录被 Git 忽略，长期开发规则和必需导航必须保存在受版本控制的文档中，不能只依赖本机笔记或临时源码目录。

每项证据包含：

- 版本：依赖声明、锁文件、实际解析版本及官方源码 commit；不能证明的制品对应关系明确标为未验证。
- 接口：源码文件与符号，必要时附行号；官方链接固定到 commit，不以可变分支作为唯一依据。
- 接入：本项目调用位置、所选扩展点及适配理由。
- 验证：实际命令、结果、替身或配置差异，以及尚未覆盖的行为。

升级依赖或改变接线时，同步更新受影响的导航和证据；旧笔记只证明当时读过的版本。
