# SQLite Skill 自动发现与受控读取

使用官方 DSH Skill provider、包／修订身份和业务查询，不创建学习、审核发布或方法级策略表。应用在授权根自动发现 Skill，核验成功后默认启用；用户可明确启用或停用，回复时在可用范围内按需组合零个或多个相关版本；每包使用本轮固定的当前修订。管理页不提供手动添加、填写目录名或安装路径；原 Skill 目录始终只读。

## 迁移与查询

`storage.ts` 导出 `skillSchemaSql` 和 `skillActions`，公共 registry 在02身份迁移后追加版本4并注册动作，不改已发布 SQL；后续版本23用 default_enabled 字段独立记录默认启用，版本24补充其已核验修订与来源资格约束。仅建立 `skill_package`、`skill_package_revision` 两张表；测试夹具的 owner、scope、input 表不进入生产。包复合主键和修订复合外键隔离 owner，revision 锚点字段有不可变触发器。公开调用只有固定动作，不接受 SQL。

`SqliteSkillLibrary(storage, runtimeOwnerId, authorizedRoot)` 的 owner 和目录由已认证宿主配置提供，不能取自模型、任意 HTTP 请求或 Skill 文本。`refresh`/`inspect` 自动发现授权根中的直接子目录；内部 `discover(directoryName)` 仅供这一受控流程登记目录身份，不是用户管理、IPC 或 HTTP 添加入口。新包首次登记 `unknown + pending`、零可用修订，随后在同一受控刷新中完整核验，通过后以 `default` 来历启用；既有未知项也适用。显式停用和来源失效不恢复，不查旧 PG，也不从 `.versions` 猜审核或启用历史。

- `list/get` 查询已记录状态；`refresh`/`inspect` 自动发现并核验已启用包的有效更新，显示 unknown/enabled/disabled 与 verified/pending/missing/conflict/invalid 两组状态。停用包只检查目录身份，不读取正文；未知项通过完整核验后默认启用。
- `setEnabled(id, expectedHead, state)` 只供明确用户操作，保留 `user_action` 来历并推进 head；显式停用优先于默认启用，来源资格失效不因技术核验恢复。
- `verify(id, expectedHead)` 显式核验目录及内容，以 CAS 提交当前修订。目录身份为规范化物理定位和 dev/ino，拒绝任何路径段的符号链接；替换身份保持 conflict，不猜测关联。
- `requireVerification(id, expectedHead)` 供来源资格失效时封禁，标为 pending、撤销当前指针和旧修订可用性，但保留启停和原目录。此状态不允许只凭相同字节 `verify` 恢复；真实来源恢复合同待05接入。

每个修订保存清单 SHA-256、原始 SKILL.md 与全部资源的内容 SHA-256、source_kind=user_directory、核验时间及可用性。摘要不等于审核或用户授权。正文和资源不在两张业务表复制，也不创建文件历史库；旧修订 unavailable 即使后来字节相同也不恢复。重新核验建立新修订，历史正文只可从仍合法的实际调用载荷查回。

## 正常业务 HTTP 适配

`SqliteSkillHttp(library, authorize).handle(req,res)` 已由 `sqlite-host-plugin.ts` 装配，复用原 `/api/skills` 路径；authorize注入宿主唯一 Bearer/Origin 认证，owner由身份域解析，目录根由显式 test 配置指定，两者不接受请求传入。GET 自动刷新发现，返回含中文 title、场景 tags 与 state_label 的最小状态投影，不含物理路径。`/:id/verify|enable|disable` 对已自动发现的项目以十进制expected_head_revision做CAS，均要求confirmed=true。管理接口不接收手动新增目录或安装路径。未知字段、跨owner参数和SQL被拒绝；旧删除、回滚和学习入口返回不可用，不能回落PG或触碰原目录。现有SkillLearningPage提供最小DTO分支和manager具名桥接，以精确CAS管理中文状态。

正常 `launchDsh` 使用 `profile/sqlite.patch.yml` 的官方 registry 和薄宿主；仅显式 `capabilities: [contacts, skills]` 配合宿主配置的 `skillPackageRoot` 开放管理，缺失或无效配置拒绝启动。Skill 根可位于 App 的 `userData` 之外，须为规范化绝对路径；仍拒绝将 App 数据根及其 `managed` 受管区作为 Skill 根。桌面启动探针与后台共用这一校验，不由模型或管理 HTTP 请求指定路径。握手位于 `managed/sqlite-backend.info`，与数据库维护目录分开。管理能力本身不产生模型请求，管理页状态不宣称回复已经加载 Skill。

日常开发 App 的新实例默认直接读取仓库 `reply-skills/romance`，不再创建 App 数据目录里的内容副本；已有显式配置仍优先。已登记包切换根目录时，通过宿主维护入口 `prepareSkillRootRelocation` 先比较两处全部原生快照，再由 `recoverSkillRootRelocation` 以单事务更新定位和 head，保留包 ID、启停、修订及来源撤销。迁移意图保存在私有控制目录，正常启动会先恢复未完成切换再发现 Skill；不提供模型、HTTP 或通用文件管理入口。

2026-10-29 的合成包管理页 App 验收是历史证据，覆盖启停、核验、目录缺失、身份冲突及重开持久化，不证明当前已取消的手动添加入口仍可用。当前界面与自动发现的验收以本轮任务记录为准；历史验收未读取真实微信或调用模型。

## 官方加载与实际输入

`openSqliteSkillRun(library, {contactId,callId}, protection, selectedPackageId?, signal?)` 冻结 owner/contact/call、目录修订及明确选择。未知、停用、未核验或来源失效不进入可加载目录。`run.mount(scopedContext)` 只接受官方独占 scope，调用现有 profile 中的 `ctx.skills.registerProvider`；宿主全局目录为空。正常自动回复可通过重复的官方 `ctx.skills.get` 按需读取多个 Skill；每个包固定一个当时当前的不可变修订。显式 `selectedPackageId` 兼容入口仍只定向并预加载一个包。辅助资源须在对应 Skill 正文成功读取后，按准确 Skill 名称和相对路径读取本修订清单内路径；一轮回复总计最多读取两份。只显示虚拟路径，不暴露物理文件能力。

必需的 `SkillRunProtection` 是05/11/12受信任宿主边界，缺失时拒绝打开：

1. `assertCurrent(scope, frozenRevision|null, signal)` 在同一短事务调用 `requireSkillRun(tx, scope.ownerId, frozenRevision)`（非null时）并复验已确认联系人、调用、读取／资料／来源／删除代次、模型用途和出站范围；Skill不能赋予这些资格。
2. `recordSelection(scope, selected)` 记录每次实际选中的包修订；自动模式对各包分别记录，显式定向预加载则记录其指定修订。事件本身不表示正文已读取或内容已进入模型。
3. `recordInput(input, signal)` 分别保存每份实际返回的正文或资源文字、payloadDigest、selected/loaded 精确包修订、Skill 名称、相对路径及 scope，登记来源与受管副本删除关系。写入事务必须复验上述业务资格，并调用导出的 `requireSkillRun(tx, ownerId, input.runRevision)` 与 `requireSkillRevision(tx, ownerId, input.loaded)`。SkillRunRevision带本轮全部包head及可载入锚点；最后一面不能单独异步检查，避免检查另一面时被撤销。单独事务外检查不够。

12必须在物理模型发送和业务提交前再次 `run.validate()`，记录真正发出的完整模型输入和模型回执。本票的读取事件仅证明官方provider读取了该正文，不能当作模型实际发送或成功回复的证据。DSH目录缓存不能替代业务与文件核验；每次读取及返回前均重验，启停或核验变更、来源失效、scope释放及AbortSignal会拒绝迟到结果。

## 删除接入边界

本模块没有文件删除、文件清理器、目录覆盖或孤儿扫描代码。空库缺引用、旧 PG 行缺失和任何管理状态都不构成原目录删除授权。原 Skill 目录不得登记成05的受管文件删除目标。

05/11/12需要登记含实际 Skill 输入的追踪行与 runtime 副本；由追踪／副本领域负责 collect、fence、clear、verify。包来源资格变化则调用 `requireVerification`；包不复制成新独立来源。`requireSkillRun`／`requireSkillRevision` 应和02的 `assertReadEligibility`、05的删除资格检查处于调用追踪写入的同一短事务。14不导入未集成的并行票模块，不提供恒真的生产替身，不把缺域注册当作删除完成。测试夹具显式提供 `fixture_scope`／`fixture_input` 与撤销擦除，仅证明合同要求；真实删除注册与运行副本清理必须在后续接入窗口复核。

正常管理动作和 `requireSkillRun`／`requireSkillRevision` 在同一短事务要求 `owner.state=active`；deleting、deleted、missing均拒绝，包括零包目录。

`deletion.ts` 导出 `skillMetadataDeletionDomain()`，id为 `skill_metadata`，注册到05的domains与requiredDomains。仅account范围清除本owner的package/revision行、物理定位和摘要，fence须在02将owner置为deleting/deleted后调用，删除处理器自身允许同操作重试。只产生类型化row目标，authorizeFile/fileCleared始终拒绝，原目录字节保留。其他contact/source范围不清owner包；实际Skill输入与runtime副本继续由对应写入域登记、清理和复核，不能借本域not_applicable隐藏缺域。工厂已对当前05 DeletionDomain做独立类型赋值检查；若其他域外键尚未清除，行清理会阻止并等待同操作重试。

## 当前版本依据

声明、pnpm锁和本工作树安装的 `@deepseek-ai/dsh-skill` 均为 `0.2.1-rc.2`，Cordis为 `4.0.5`。安装包公开 `exports['.']` 指向 `lib/index.js` 和 `lib/types/index.d.ts`。已核验：

- [固定源码的 SkillProvider / SkillProviderControl / registerProvider / get](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill/src/index.ts#L247)：provider工厂同步注册，list/get异步；scope限定、控制器失效与释放；本地源码HEAD不同，使用 `git show` 固定提交阅读。
- 锁定安装制品 `lib/types/index.d.ts:188,247,280` 和 `lib/index.js:147,250`：registerProvider生命周期、缓存失效、官方get调用provider、调用方取消。
- 正式 `profile/sqlite.patch.yml` 使用官方 registry；该 profile 仅增加官方registry与薄宿主接线，不修改DSH核心，也不启用filesystem插件、通用读文件、Shell、网络下载或任意插件安装。

安装包无gitHead，未完成固定源码树对npm制品的全量可复现构建比对；本次只核验所用公开合同及实际安装行为。`sqlite-skill-profile.test.mjs` 复用正式patch，通过官方CLI启动隔离profile，仅替换业务宿主认证／追踪和模型配置（本机环回假地址，无模型请求）；`sqlite-host-launch.test.mjs` 验证实际 SQLite profile 的认证管理、关闭及重开。实际 App 证据只覆盖上述管理行为，不覆盖真实模型、微信或完整回复链。

## 2026-10-31 受控发现与更新修订

按 [ADR-129](../../../../architecture/adr/129-controlled-dsh-reply-skill-discovery.md)，内部 `discover` 仅由自动刷新登记授权根的直接子目录名/身份，初态为 `unknown + pending`、零可用修订。[ADR-135](../../../../architecture/adr/135-default-enabled-localized-skill-library.md) 修订默认启用：`refresh` 与 `inspect` 自动发现新目录，新包和既有未知项完整核验后默认启用；已启用包核验技术更新，停用项仅查目录身份，用户重新启用时核验最新正文。显式管理 `verify` 不隐式启用，来源撤销/身份冲突不经扫描恢复；应用核验的合法变化建立新修订，保留用户启停决定。

SQLite 正常读取改用 [原生窄只读器](../../../../native/skill-read/README.md)及 `secure-directory.ts`。根身份在实例构造固定，读取前核包身份，逐段无链接目录 FD 读取和最终快照复验，实际返回字节参与摘要；服务缺失安全拒绝，不回落 Node。原 `skill-package.ts` 继续负责纯格式/大小/安全校验，未改变原目录只读和业务删除边界。

本轮核验 `dsh-skill` 声明、安装锁及实际制品均为 `0.2.1-rc.2`，Cordis `4.0.5`；官方参考仍固定 `687f282e8625c6b8d11ff58211a90524be2e4317`，本机相邻源码 HEAD 不同，未完成全量可复现构建比对。官方 filesystem 的发现 `discoverRoot` 会对每个子目录调用 `parseSkillFile`，服务缺失/`trustedHost` 有 Node 分支，watcher 独立接触宿主路径，不能只凭返回目录过滤满足读取前边界。因此正式产品继续使用官方 registry 的业务 `registerProvider`，不装配 filesystem/default roots/bundled roots/watcher；刷新与每次读取复验承接变更处理。本轮测试证明这一替代路径，不宣称已经验证自定义 `ctx.fs` 生产组合。

合成验证命令及边界见任务 01 与原生只读器说明；自动选择、失败降级、资源加载和实际 App 的最终验收由同组任务分别记录。
