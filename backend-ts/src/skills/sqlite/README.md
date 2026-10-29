# SQLite Skill 最小关联（实施14）

仅接回官方 DSH Skill provider、包／修订身份和业务查询；不创建学习、审核发布或方法级策略表。原 Skill 目录始终只读。默认 PG 宿主尚未切换；本票生产 HTTP 适配器等待共用 SQLite 认证入口串行接线及界面复核，未完成前任务保持 claimed；05/11/12真实链另行组合验收。

## 迁移与查询

`storage.ts` 导出 `skillSchemaSql` 和 `skillActions`，集成方在02的 `owner(owner_id)` 建好后给 SQL 分配连续版本并注册动作，不改已发布 SQL。仅建立 `skill_package`、`skill_package_revision` 两张表；测试夹具的 owner、scope、input 表不进入生产。包复合主键和修订复合外键隔离 owner，revision 锚点字段有不可变触发器。公开调用只有固定动作，不接受 SQL。

`SqliteSkillLibrary(storage, runtimeOwnerId, authorizedRoot)` 的 owner 和目录由已认证宿主配置提供，不能取自模型、任意 HTTP 请求或 Skill 文本。`discover(directoryName)` 仅处理明确指定的直接子目录，首次为 `unknown`；不查旧 PG、不从 `.versions` 猜审核或启用历史，不批量扫描真实目录作为测试。

- `list/get` 查询已记录状态；`inspect` 作为管理业务查询重验文件现状，显示 unknown/enabled/disabled 与 verified/pending/missing/conflict/invalid 两组状态。查询不接受新内容为新版本。
- `setEnabled(id, expectedHead, state)` 只供明确用户操作，保留 `user_action` 来历并推进 head；不因技术核验、空库或缺审核自动启停。
- `verify(id, expectedHead)` 显式核验目录及内容，以 CAS 提交当前修订。目录身份为规范化物理定位和 dev/ino，拒绝任何路径段的符号链接；替换身份保持 conflict，不猜测关联。
- `requireVerification(id, expectedHead)` 供来源资格失效时封禁，标为 pending、撤销当前指针和旧修订可用性，但保留启停和原目录。此状态不允许只凭相同字节 `verify` 恢复；真实来源恢复合同待05接入。

每个修订保存清单 SHA-256、原始 SKILL.md 与全部资源的内容 SHA-256、source_kind=user_directory、核验时间及可用性。摘要不等于审核或用户授权。正文和资源不在两张业务表复制，也不创建文件历史库；旧修订 unavailable 即使后来字节相同也不恢复。重新核验建立新修订，历史正文只可从仍合法的实际调用载荷查回。

## 正常业务 HTTP 适配

`SqliteSkillHttp(library, authorize).handle(req,res)` 由共用宿主装配，复用原 `/api/skills` 路径；authorize必须注入宿主唯一 Bearer/Origin 认证，owner和目录根不接受请求传入。GET返回含中文state_label的最小状态投影，不含物理路径。POST `/api/skills/discover` 明确确认配置根内的目录名；`/:id/verify|enable|disable` 以十进制expected_head_revision做CAS，均要求confirmed=true。未知字段、跨owner参数和SQL被拒绝；旧删除、回滚和学习入口返回不可用，不能回落PG或触碰原目录。适配器已通过正式profile与隔离HTTP验证，共享宿主/现有界面接线另记真实验收。

## 官方加载与实际输入

`openSqliteSkillRun(library, {contactId,callId}, protection, selectedPackageId?, signal?)` 冻结 owner/contact/call、目录修订及明确选择。未知、停用、未核验或来源失效不进入可加载目录。`run.mount(scopedContext)` 只接受官方独占 scope，调用现有 profile 中的 `ctx.skills.registerProvider`；宿主全局目录为空。每轮零或一个 Skill，正文经官方 `ctx.skills.get` 读取；资源只能经 `run.readResource(anchor, relativePath)` 读取本修订清单内路径，正文成功前不能读资源。只显示虚拟路径，不暴露物理文件能力。

必需的 `SkillRunProtection` 是05/11/12受信任宿主边界，缺失时拒绝打开：

1. `assertCurrent(scope, signal)` 复验已确认联系人、调用、读取／资料／来源／删除代次、模型用途和出站范围；Skill不能赋予这些资格。
2. `recordSelection(scope, selected)` 分别记显式选择或 null；此事件不表示已加载或模型已使用。
3. `recordInput(input, signal)` 保存实际返回的正文或资源文字、payloadDigest、selected/loaded 精确包修订、相对路径及 scope，登记来源与受管副本删除关系。写入事务必须复验上述业务资格，并调用导出的 `requireSkillRevision(tx, ownerId, input.loaded)`。单独事务外检查不够。

12必须在物理模型发送和业务提交前再次 `run.validate()`，记录真正发出的完整模型输入和模型回执。本票的读取事件仅证明官方provider读取了该正文，不能当作模型实际发送或成功回复的证据。DSH目录缓存不能替代业务与文件核验；每次读取及返回前均重验，启停或核验变更、来源失效、scope释放及AbortSignal会拒绝迟到结果。

## 删除接入边界

本模块没有文件删除、清理器、目录覆盖或孤儿扫描代码。空库缺引用、旧 PG 行缺失和任何管理状态都不构成原目录删除授权。原 Skill 目录不得登记成05的受管文件删除目标。

05/11/12需要登记含实际 Skill 输入的追踪行与 runtime 副本；由追踪／副本领域负责 collect、fence、clear、verify。包来源资格变化则调用 `requireVerification`；包不复制成新独立来源。`requireSkillRevision` 应和02的 `assertReadEligibility`、05的删除资格检查处于调用追踪写入的同一短事务。14不导入未集成的并行票模块，不提供恒真的生产替身，不把缺域注册当作删除完成。测试夹具显式提供 `fixture_scope`／`fixture_input` 与撤销擦除，仅证明合同要求；真实删除注册与运行副本清理必须在后续接入窗口复核。

## 当前版本依据

声明、pnpm锁和本工作树安装的 `@deepseek-ai/dsh-skill` 均为 `0.2.1-rc.2`，Cordis为 `4.0.5`。安装包公开 `exports['.']` 指向 `lib/index.js` 和 `lib/types/index.d.ts`。已核验：

- [固定源码的 SkillProvider / SkillProviderControl / registerProvider / get](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill/src/index.ts#L247)：provider工厂同步注册，list/get异步；scope限定、控制器失效与释放；本地源码HEAD不同，使用 `git show` 固定提交阅读。
- 锁定安装制品 `lib/types/index.d.ts:188,247,280` 和 `lib/index.js:147,250`：registerProvider生命周期、缓存失效、官方get调用provider、调用方取消。
- 正式 `profile/host.patch.yml` 已启用官方registry；本票不修改DSH核心或profile，也不启用filesystem插件、通用读文件、Shell、网络下载或任意插件安装。

安装包无gitHead，未完成固定源码树对npm制品的全量可复现构建比对；本次只核验所用公开合同及实际安装行为。`sqlite-skill-profile.test.mjs` 复用正式patch，通过官方CLI启动隔离profile，仅替换业务宿主认证／追踪和模型配置（本机环回假地址，无模型请求）。不是生产宿主、真实模型、微信或App整体验收。
