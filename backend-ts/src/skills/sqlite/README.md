# SQLite Skill 自动发现与受控读取

产品合同以[Skill 生命周期与授权](../../../../architecture/current/skill-library.md)、[外部原包与受管副本删除](../../../../architecture/current/privacy-deletion.md)为准；本页只保留本模块的接口、装配和故障处理。

使用官方 DSH Skill provider、包／修订身份和业务查询，不创建学习、审核发布或方法级策略表。应用在授权根自动发现 Skill，核验成功后默认启用；用户可明确启用或停用。正常候选由已安装的官方 `dsh-tool-skill` 先发布可用范围内的名称与简介，模型需要哪个再通过 `skill` 工具加载哪个的全文；每包使用本轮固定的当前修订，资源仍按需读取。管理页不提供手动添加、填写目录名或安装路径；原 Skill 目录始终只读。

## 迁移与查询

`storage.ts` 导出 `skillSchemaSql` 和 `skillActions`，公共 registry 在身份迁移后追加版本4并注册动作，不改已发布 SQL；后续版本23用 default_enabled 字段独立记录默认启用，版本24补充其已核验修订与来源资格约束。仅建立 `skill_package`、`skill_package_revision` 两张表；测试夹具的 owner、scope、input 表不进入生产。包复合主键和修订复合外键隔离 owner，revision 锚点字段有不可变触发器。公开调用只有固定动作，不接受 SQL。

`SqliteSkillLibrary(storage, runtimeOwnerId, authorizedRoot)` 的 owner 和目录由已认证宿主配置提供，不能取自模型、任意 HTTP 请求或 Skill 文本。`refresh`/`inspect` 自动发现授权根中的直接子目录；内部 `discover(directoryName)` 仅供这一受控流程登记目录身份，不是用户管理、IPC 或 HTTP 添加入口。新包首次登记 `unknown + pending`、零可用修订，随后在同一受控刷新中完整核验，通过后以 `default` 来历启用；既有未知项也适用。显式停用和来源失效不恢复，不查旧 PG，也不从 `.versions` 猜审核或启用历史。

- `list/get` 查询已记录状态；`refresh`/`inspect` 自动发现并核验已启用包的有效更新，显示 unknown/enabled/disabled 与 verified/pending/missing/conflict/invalid 两组状态。停用包只检查目录身份，不读取正文；未知项通过完整核验后默认启用。
- `setEnabled(id, expectedHead, state)` 只供明确用户操作，保留 `user_action` 来历并推进 head；显式停用优先于默认启用，来源资格失效不因技术核验恢复。
- `verify(id, expectedHead)` 显式核验目录及内容，以 CAS 提交当前修订。目录身份为当前物理定位和 dev/ino，拒绝任何路径段的符号链接；物理标记变化按下述完整核验恢复，不凭同名关联。
- 目录标记变化或既有 conflict 在已授权根中重新安全读取完整快照。只有正文及全部资源的双摘要与最新历史修订一致时，`skills.rebindDirectory` 才在单个 CAS 事务中重建定位和新修订；保留包 ID、启停与来历，旧修订、旧运行锚点和迟到结果保持失效。停用项到显式重新启用时才读正文，来源撤销不可恢复；无核验历史、内容不符和历史降级仍拒绝。规则见 [ADR-157](../../../../architecture/adr/157-portable-skill-directory-identity.md)。
- `requireVerification(id, expectedHead)` 在来源资格失效时以 CAS 标为 pending，撤销当前指针与旧修订可用性，保留启停状态和原目录。扫描或字节相同不能恢复来源授权；当前普通 SQLite 管理入口没有绕过来源失效的恢复动作。

刷新在开始和返回前读取权威状态，目录发现复用本轮清单；已启用包的一次原生快照同时核对目录身份和全部内容，摘要未变化时不重复提交观察。停用或来源失效项目仍只检查目录身份。同一库实例只共享在途核验，不缓存已完成结果；显式管理操作开始与完成后均脱离旧一轮刷新，避免操作后的读取复用写入前状态。实际运行的版本、来源和输入核验保持独立执行。

每个修订保存清单 SHA-256、原始 SKILL.md 与全部资源的内容 SHA-256、source_kind=user_directory、核验时间及可用性。摘要不等于审核或用户授权。正文和资源不在两张业务表复制，也不创建文件历史库；旧修订 unavailable 即使后来字节相同也不恢复。重新核验建立新修订，历史正文只可从仍合法的实际调用载荷查回。

## 联系人分组

依据 [ADR-178](../../../../architecture/adr/178-contact-skill-groups.md)。`groups.ts` 导出迁移51 `skillGroupMigration(51)`（`skill_group`、`skill_group_package`、`contact_skill_group`，联系人／包／分组删除级联清除绑定）、`skillGroupActions`（`skillGroups.list|create|update|delete|assign|scope`）以及运行共用的 `inSkillGroup`／`skillRunGroup`。联系人至多一个分组；未分组联系人范围为空，因此首次模型请求不提供 Skill 工具。

- 运行：`openSqliteSkillRun` 的目录、显式 `selectedPackageId`、预加载和 `eligible()` 都先按 `library.groupScope(contactId)` 过滤；冻结的 `SkillRunRevision.group` 带联系人、分组标识和分组修订。回复模块（`reply/sqlite/turns.ts`、`candidates/turns.ts`）用同一函数生成修订，字节须与运行一致。
- 资格：`requireSkillRun` 同事务调用 `requireSkillGroupScope`——分配或分组修订变化、可用包越出分组绑定都拒绝；修订缺少 `group` 且 `eligible` 非空同样拒绝（失败即关闭）。无实际变化的 `update` 不推进分组修订。
- 删除：`skill_metadata` 域在联系人范围收集并清除该联系人的分配，账号范围清除全部分组；原 Skill 目录不受影响。
- HTTP：`GET /api/skills/groups`；`POST /api/skills/groups`（创建）、`/groups/:id/update`、`/groups/:id/delete`、`/contacts/:contactId/group`，均要求 `confirmed:true` 与预期修订／当前分组，非法请求 400，冲突 409。
- 测试夹具：隔离 Skill 夹具的 `fixture.scope` 默认把联系人放入包含全部 Skill 的 `fixture-all` 分组，保持既有机制测试；分组门禁见 `test/sqlite-skill-groups.test.mjs`，传 `noGroup:true` 可关闭。

## 正常业务 HTTP 适配

`SqliteSkillHttp(library, authorize).handle(req,res)` 已由 `sqlite-host-plugin.ts` 装配，复用原 `/api/skills` 路径；authorize注入宿主唯一 Bearer/Origin 认证，owner由身份域解析，目录根由受信任启动配置指定，两者不接受请求传入。GET 自动刷新发现，返回含中文 title、场景 tags 与 state_label 的最小状态投影，不含物理路径。`/:id/verify|enable|disable` 对已自动发现的项目以十进制expected_head_revision做CAS，均要求confirmed=true。管理接口不接收手动新增目录或安装路径。未知字段、跨owner参数和SQL被拒绝；旧删除、回滚和学习入口返回不可用，不能回落PG或触碰原目录。现有SkillLearningPage提供最小DTO分支和manager具名桥接，以精确CAS管理中文状态。

正常 `launchDsh` 使用 `profile/sqlite.patch.yml` 的官方 registry 和薄宿主；仅显式 `capabilities: [contacts, skills]` 配合宿主配置的 `skillPackageRoot` 开放管理，缺失或无效配置拒绝启动。Skill 根可位于 App 的 `userData` 之外，须为规范化绝对路径；仍拒绝将 App 数据根及其 `managed` 受管区作为 Skill 根。桌面启动探针与后台共用这一校验，不由模型或管理 HTTP 请求指定路径。握手位于 `managed/sqlite-backend.info`，与数据库维护目录分开。管理能力本身不产生模型请求，管理页状态不宣称回复已经加载 Skill。

日常开发 App 的新实例默认直接读取仓库 `reply-skills/romance`，不再创建 App 数据目录里的内容副本；已有显式配置仍优先。已登记包切换根目录时，通过宿主维护入口 `prepareSkillRootRelocation` 核对目标安全快照与数据库最新历史摘要；旧根可读时额外比较两处内容，旧根已不存在时不阻断有完整基线的迁移。`recoverSkillRootRelocation` 以单事务更新定位和 head，保留包 ID、启停、修订及来源撤销。迁移意图保存在私有控制目录，正常启动先恢复未完成切换再发现 Skill；意图发布后目标磁盘标记变化时重新核验内容，完成配置后由正常刷新重建当前定位。不提供模型、HTTP 或通用文件管理入口。

## 官方加载与实际输入

`openSqliteSkillRun(library, {contactId,callId}, protection, selectedPackageId?, signal?)` 冻结 owner/contact/call、目录修订及明确选择；正常候选不传预加载 options 对象，保留官方按需加载路径。未知、停用、未核验或来源失效不进入可加载目录。`run.mount(scopedContext)` 只接受官方独占 scope，调用现有 profile 中的 `ctx.skills.registerProvider`；宿主全局目录为空。已挂载的 `@deepseek-ai/dsh-tool-skill` 负责名称与简介目录及 `skill` 加载工具，工具经官方 `ctx.skills.get` 读取所选正文，可在一轮中按需读取多个 Skill；每个包固定一个当时当前的不可变修订。目录发布本身不生成正文输入记录。

兼容的多 anchor 预加载辅助入口为 `openSqliteSkillRun(library, request, protection, {selectedPackageId?|preloadPackageIds?, signal?})`（等价导出 `openSqliteSkillPreload`），正常自动候选不使用该入口。显式 `selectedPackageId` 仍通过该入口定向预加载一个包（来源 `explicit`）；`planSkillPreload` 也保留供内部受信任调用方使用的批量模式，从冻结目录中选择 `enabled + verified + current`。批量辅助入口仍以 `skills.assertRevisions` 在短事务中复验全部 anchor 的 package、修订、目录身份、manifest digest 与 content digest，再一次性读取所选正文，并经 `recordPreload`/`discussion.skillPreload` 原子记录全部选择／实际输入。任一失败整体拒绝并关闭运行，不保留部分正文。其 `run.preloadOrigin`、`run.preloadSelection` 和 `run.preloadedSkills` 保留可追溯输入，不把兼容预加载投影当作正常按需目录的读取证据。

正常路径仅在官方 `skill` 工具成功加载正文后记录实际读取；对应的辅助资源通过 `skill_resource` 按准确 Skill 名称和相对路径读取本修订清单内路径。一轮回复总计最多读取两份静态辅助资源，只显示虚拟路径，不暴露物理文件能力。

必需的 `SkillRunProtection` 是删除／讨论／候选域共同的受信任宿主边界，缺失时拒绝打开：

1. `assertCurrent(scope, frozenRevision|null, signal)` 在同一短事务调用 `requireSkillRun(tx, scope.ownerId, frozenRevision)`（非null时）并复验已确认联系人、调用、读取／资料／来源／删除代次、模型用途和出站范围；Skill不能赋予这些资格。
2. `recordSelection(scope, selected, signal?, trace?)` 记录每次实际选中的包修订；自动模式对各包分别记录，显式定向预加载则记录其指定修订。`trace` 记录读取时冻结的 Skill 名称、`origin` 与目录快照；事件本身不表示正文已读取或内容已进入模型。
3. `recordInput(input, signal)` 保存正常按需正文及后续资源读取；`recordPreload(input, signal)` 保留兼容预加载路径的原子追踪，在一次事务中保存所选包的全部 selection/input、payloadDigest、精确包修订、名称、相对路径、预加载来源与目录快照。两者都登记来源与受管副本删除关系。写入事务必须复验上述业务资格，并调用导出的 `requireSkillRun(tx, ownerId, input.runRevision)` 与 `requireSkillRevision(tx, ownerId, input.loaded)`。SkillRunRevision带本轮全部包head及可载入锚点；最后一面不能单独异步检查，避免检查另一面时被撤销。单独事务外检查不够。

正常候选首次物理模型请求只包含官方 Skill 简介目录，不附带目录中全部正文；后续工具结果只加入模型实际请求的正文与资源。端侧发现及安全核验仍可读取完整包，不等于正文已发送。正常目录按最终序列化请求的完整输入预算约束，不设置 256 包数量门槛，也不截取部分目录；兼容批量预加载辅助入口仍保留 256 包上限及 `skill_preload_limit` 整体无 Skill 降级。每次物理模型发送和业务提交前继续 `run.validate()`：以冻结修订的 `assertCurrent` 前后夹住对全部可载入锚点的目录字节读取，不再另读目录列表或重复分离的 anchor 复验（`assertCurrent` 已在同一短事务核验包集合、head 与全部 anchor）。打开运行、列目录、加载正文和读取资源前使用只做数据库资格复验的 `run.validateQualification()`；正文与资源字节仍在读取时由 `assertAnchor` 对该包复验，输入记录与选择事件在各自写事务内复验。记录真正发出的完整模型输入和模型回执。本模块的读取事件仅证明官方 provider 读取了该正文，不能当作模型实际发送或成功回复的证据。DSH 目录缓存不能替代业务与文件核验；每次读取及返回前均重验，启停或核验变更、来源失效、scope释放及AbortSignal会拒绝迟到结果。

## 删除接入边界

本模块没有文件删除、文件清理器、目录覆盖或孤儿扫描代码。空库缺引用、旧 PG 行缺失和任何管理状态都不构成原目录删除授权。原 Skill 目录不得登记成统一删除的受管文件删除目标。

实际 Skill 输入由执行追踪和运行副本领域登记、收集、fence、清除并复核。包来源资格变化调用 `requireVerification`，不把包复制成独立来源。`requireSkillRun/requireSkillRevision` 与联系人、来源和删除资格在实际输入写入的同一短事务核验。生产删除组合由公共 registry 安装；`fixture_scope/fixture_input` 仅属合成测试，不能替代真实闭包。

正常管理动作和 `requireSkillRun`／`requireSkillRevision` 在同一短事务要求 `owner.state=active`；deleting、deleted、missing均拒绝，包括零包目录。

`deletion.ts` 导出 `skillMetadataDeletionDomain()`，id为 `skill_metadata`，注册到统一删除的 domains与requiredDomains。仅account范围清除本owner的package/revision行、物理定位和摘要，fence须在身份域将 owner置为deleting/deleted后调用，删除处理器自身允许同操作重试。只产生类型化row目标，authorizeFile/fileCleared始终拒绝，原目录字节保留。其他contact/source范围不清owner包；实际Skill输入与runtime副本继续由对应写入域登记、清理和复核，不能借本域not_applicable隐藏缺域。工厂已对当前 DeletionDomain做独立类型赋值检查；若其他域外键尚未清除，行清理会阻止并等待同操作重试。

## 当前版本依据

声明、pnpm锁和本工作树安装的 `@deepseek-ai/dsh-skill` 均为 `0.2.1-rc.2`，Cordis为 `4.0.5`。安装包公开 `exports['.']` 指向 `lib/index.js` 和 `lib/types/index.d.ts`。已核验：

- [固定源码的 SkillProvider / SkillProviderControl / registerProvider / get](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill/src/index.ts#L247)：provider工厂同步注册，list/get异步；scope限定、控制器失效与释放；本地源码HEAD不同，使用 `git show` 固定提交阅读。
- 锁定安装制品 `lib/types/index.d.ts:188,247,280` 和 `lib/index.js:147,250`：registerProvider生命周期、缓存失效、官方get调用provider、调用方取消。
- 正式 `profile/sqlite.patch.yml` 使用官方 registry；该 profile 仅增加官方registry与薄宿主接线，不修改DSH核心，也不启用filesystem插件、通用读文件、Shell、网络下载或任意插件安装。

所用公开接口依据保留在上节。核对接口或升级依赖时须重查锁文件、安装制品和固定源码，未证明完整可复现构建一致。`sqlite-skill-profile.test.mjs` 与 `sqlite-host-launch.test.mjs` 是隔离 profile／管理回归入口；实际模型加载与回复生命周期由回复模块验证。

## 安全读取与物理身份

默认启用、用户停用和来源失效语义见现行 Skill 合同。目录物理标记变化须以最新完整内容及清单摘要核验，保留包身份、用户决定与来源撤销；不能凭同名目录或旧修订字节恢复。

SQLite 正常读取改用 [原生窄只读器](../../../../native/skill-read/README.md)及 `secure-directory.ts`。根身份在实例构造固定，读取前核包身份，逐段无链接目录 FD 读取和最终快照复验，实际返回字节参与摘要；服务缺失安全拒绝，不回落 Node。原 `skill-package.ts` 继续负责纯格式/大小/安全校验，未改变原目录只读和业务删除边界。

正式产品使用官方 registry 的业务 `registerProvider`，不装配 filesystem/default roots/bundled roots/watcher。官方目录发现及 watcher 可独立接触宿主路径，单凭结果过滤不能满足读取前授权边界；本模块通过原生窄只读器、受控刷新和每次读取前后复验实现该边界。


阶段实现和旧验收记录已移至[开发历史](../../../../docs/history/backend-development-history.md)；历史数字不表示当前版本通过。
