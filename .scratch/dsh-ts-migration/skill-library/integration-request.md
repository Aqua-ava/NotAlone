# 06 集成请求（实现中）

## 需要主会话串行添加的依赖

- `@deepseek-ai/dsh-skill` 精确 `0.2.1-rc.2`：官方 registry，薄 provider 绑定获准目录；不启用 filesystem/tool-skill 的默认扫描或不受控加载。
- `yaml`：文件层需要完整 YAML frontmatter 解析（含重复键拒绝），请串行安装精确版本并告知；文件层将核对锁版官方接口。不能用手写子集冒充旧 PyYAML 合同。

## 预计装配接口（尚未就绪，不先切换）

`SkillLibrary(storage: HostStorage, files: SkillFiles)` 普通业务类，`handle(method: string, url: URL, body?: unknown, assertCurrent?: () => void): Promise<unknown>`；`skillLibraryRoute(method, pathname): boolean`，`SkillLibraryError extends HostStorageError {status:number; reason?:string}`。
`SkillFiles(root)` 来自 `skill-files.ts`；root 使用原配置 NOTALONE_SKILLS_DIR 或原默认 ~/.notalone/skills，禁止替代目录。
无独立初始化/常驻后台；事务使用宿主 businessTransaction。处理完成/提交前 assertCurrent；HostStorage.close 排空事务后才释放资源。运行读取 scope 取消及 revision 复验由独立 skill-runtime/skill-port 提供，稍后补准确导出。

## 原 HTTP 合同

- GET `/api/skills`：明确同步目录后返回 `{skills:[...]}`。
- POST `/api/skills/import`：JSON `{package_path:string}`，这是本地路径而非上传包；旧 HTTP body 上限须按 server 原实现核定，不能把资源包4MiB额度误当此 JSON 限额。
- GET `/api/skills/<uuid>/preview|versions`。
- POST `/api/skills/<uuid>/enable|disable|delete`：旧空body语义。
- POST `/api/skills/<uuid>/rollback`：JSON `{version_id:uuid}`。
- 成功200；参数400 skill_request_invalid；不存在404 skill_not_found/skill_version_not_found（含同名reason）；删除态409 skill_deleted；导入拒绝409 skill_import_rejected + reason=package_invalid；缺服务503 skill_unavailable；持久层500 skill_persistence_failed。不透传路径/SQL/正文。

## 移交约束

尚未达到切换条件。必须先停止旧 `/api/skills` 接收并排空；Python 的目录发现/同步也会写Skill版本，05开始TS回复前必须将其改为TS唯一管理端口，不能仅移交HTTP后仍让旧回复同步双写。15未迁的审核发布暂保留明确所有权，需协调共享owner锁与文件任务，不能把普通导入冒充审核发布。
需要主会话列明旧公开及内部调用移交清单，06补具体函数指针及测试后再启用。无逐请求fallback。

## 验证

先本票合成PG与文件读写测试，再主会话真实官方profile HTTP验证，最后分配 npm run dev 实际App独占。当前未申请Git/App独占。

## 已确定的读取、删除及只读事务端口

- `SkillReadPort` / `SkillScope` / `SkillRuntime` 已导出于 `backend-ts/src/skill-runtime.ts`。scope固定 `{ownerId,contactId,scene}`；`SkillRuntime.open(port,scope,signal)` 冻结目录；`readFile(path,offset,limit,signal)` / `validate(signal)` / `cancel()`；`usedVersionId`为实际读取回执。05在每次物理模型请求前及提交前validate，结束/取消/切换dispose provider并cancel，不能只在首轮验证。
- `skill-provider.ts`提供官方registry薄适配（准确导出见该文件）。依赖主会话已添加，尚需真实profile业务集成验证。
- 请求 HostStorage 新增 `businessReadTransaction<T>(operation:(client:pg.Client)=>Promise<T>):Promise<T>`，沿原withClient关闭屏障与requireReady，使用 REPEATABLE READ READ ONLY。SkillPort不能用写事务偷偷迁移/同步文件；`businessTransaction`继续供变更与提交内复验。
- 删除端口由06独占 `skill-cleanup.ts`：`eraseSkillLearning(client,ownerId,removedIds)`、`queueSkillFileCleanup(client,skillId,versionIds?)`，二者仅在调用方事务内撤资格、擦除学习/审核业务资料、登记文件清理，不提前擦磁盘；`cleanupSkillFiles(client,ownerId,files)`在业务提交之后独立事务消费可重试清理。失败不得恢复目录资格或宣称磁盘删除成功。
- 来源撤销影响已发布Skill时，旧 `erase_review_artifacts`还调用`delete_source_replies(owner,contact=None,versions,revoke_running_scope=False)`。此回复清理归05，需要05提供同事务完整端口，06不能静默遗漏跨联系人已使用广范围策略的候选/讨论派生。09应复用06的eraseSkillLearning，并在提交后调用清理，勿另写Skill表结构。

### 最新核实与待协调闭包

- 原HTTP统一正文上限为 **1 MiB**，见 `backend/src/notalone/server/app.py:3487` 的 `_request_body_length`；06管理路由保持此上限，超限413，非法长度400，不沿宿主16KiB通用值。
- 官方scope隔离验收还需精确直接依赖 `@deepseek-ai/dsh-scope@0.2.1-rc.2`（公开createScope）；请主会话串行添加。
- `eraseSkillLearning(client,owner,removedIds,deleteSourceReplies?)`：命中已发布review版本时必须提供05同事务回调 `(client,{ownerId,contactId:null,removedIds:string[],revokeRunningScope:false})=>Promise<void>`；缺失将失败回滚，不能宣称删除完成。管理构造将增加此回调选项。
- 原Skill显式delete还调用`erase_managed_update_backups`，需与09统一复用更新备份清理端口；当前06不拥有共享备份模块，不能遗漏或自行猜目录。请求主会话指定统一TS端口；在其就绪前删除有此闭包阻塞，不切公开入口。

### 05讨论来源依赖

06来源proof v1复用04 `captureSnapshot/validateFrozen`，v2/v3正在完整移植。`expand_learning_provenance`遇 `assistant_discussion_snapshot` 必须按原C协议逐记录当前复验（assistant_discussion_context + reply_sources），不能只从JSON抽候选UUID。请05提供只读 `requireDiscussionDependencies(client,owner,contact,requestId)` 等价端口或指定可复用模块；未接通前此闭包失败关闭，不能称完整迁移。05所需原SkillUse类型及同client验证正在补入skill-port。

## 2026-10-24 当前准确签名

`new SkillLibrary(storage,files,options?:SkillLibraryOptions)`；options为 `{deleteSourceReplies?: DeleteSkillReplies, eraseManagedBackups?:(client:pg.Client)=>Promise<unknown>}`。正式装配必须注入05回复删除及09备份核验；当前缺备份回调的合成无备份场景通过不代表正式删除完整。构造没有异步初始化或常驻资源；不独占连接；关闭通过HostStorage事务屏障。
管理首例、停用/更新/回滚/导出/删除以及清理失败重试已通过合成PG。仍在补目录错误分类、跨owner/取消、公开宿主与桌面验收，不得提前切换。
主会话businessReadTransaction和scope依赖已收到；06仅消费，不提交共享文件。

### 删除依赖失败关闭补充

当storage环境配置`NOTALONE_MANAGED_USER_DATA`时，缺`eraseManagedBackups`回调会409 `update_backup_cleanup_required`且事务回滚，不能正式装配后遗漏09模块。未配置托管目录时沿旧Python无备份路径的no-op语义。实际备份归属测试由09统一模块负责，06还需集成回归。

### 运行回执与辅助资源失败（06 runtime 补充）

- 每轮独占 `PostgresSkillPort` 与 `SkillRuntime`；`run.captureUse({selection_method,selection_reason},signal)` 调用 port 产生完整原 `SkillUse`，仅附上运行中成功读取的去重 `resource_paths`，不能让05拼简化 DTO。无实际正文读取返回null。
- `run.usedVersionId` 是**实际尝试读取过的正文版本**，供模型声明核验；`run.loadState` 区分 `unused` / `loaded` / `resource_failed`。资源失败后 attempted UUID 仍可用于拒绝伪造版本，但 `captureUse` 返回null，最终业务不得标为成功使用Skill；与原 `langchain_runtime.py:1122` 一致。
- 仅已加载正文后的 `SkillFileError` 或非法UTF-8资源，在重新复验目录/资格成功后返回原资源不可用提示并标记 `resource_failed`；资格撤销、取消、未知错误必须终止。资源整份UTF-8返回，不按offset/limit裁切；正文每页与空页都带同一版本UUID回执。
- `run.cancel()` 清空运行读取状态并调用独占 port 的 `dispose()`；调用方完成/切换/取消都释放官方scope及provider。不共享同一port给并行回复。
- `cleanupUnreferencedSkillSnapshots(client,owner,files)` 在owner锁内仅登记隐藏无引用版本及无待办工作副本的staging；调用方提交/协调后沿 `cleanupSkillFiles` 重试擦除。合法历史版本不回收，工作目录不扫描。该函数不替代deleteSourceReplies或更新备份闭包。

### 05必须接通的来源C核验端口

06可接受 `SkillDiscussionValidator=(client,ownerId,contactId,requestId)=>Promise<readonly string[]>`，贯穿v3递归父proof；请05给出实际导出模块/签名，由06接入。当前遇既有assistant_discussion_snapshot会明确`skill_discussion_proof_unavailable`，未以抽UUID假放行；这仍是本票完整验收未完成项。

### 运行状态健康投影

`SkillLibrary.fileHealth(ownerId?)`只读返回 `{state:'ok'|'degraded',pending_working_copies,pending_cleanup_files,failures:[{operation,code,skill_id,occurred_at}]}`，宿主runtime status应替换旧Python `_skill_file_health_payload`聚合。无新HTTP端点；旧原入口见server/app.py:880。

## 旧内部写入口的精确移交位置

- `server/command.py:493-497`构造SkillService(PostgresSkillLibrary)：公开 `/api/skills` stop/drain后TS接管，旧服务须拒绝后续管理调用。
- `server/reply_wiring.py:176,179,373-375`每轮同步：旧回复暂留期间也必须转交TS `SkillLibrary.synchronize(owner,assertCurrent)`，不能只关闭HTTP而保留Python目录版本写入。
- `persistence/skill_history.py:21-22`管理历史刷新调用prepare_skill_directory；`skill_review.py:198-200`审核页同步也需转交同一TS同步端口。15审核publish_reviewed/rollback_locked本身仍归15旧实现，必须保持同一owner锁且不得把审核发布误当06通用导入；这条过渡职责需主会话统一装配。
- `PostgresSkillPort({read:fn=>storage.businessReadTransaction(fn)},root,options)` 每轮独立创建；同一保存client用validateUseInTransaction，不嵌套BEGIN。准确SkillUse见skill-port.ts，不能简化成只一个versionId。
- 目前模块已可供主会话做**合成宿主集成**。完整切换仍需来源C回调、05回复删除及09备份端口齐全；无缺依赖默认放行。

来源C返回值补充：旧`skill_learning_materials.py:75-86`会将讨论展开的依赖再次递归核验，故05回调必须返回完整依赖ID集合，不能只void校验；06做有界合并/递归。正式签名以skill-source-proof.ts为准。

### 官方profile的Skill注册表装配

host.patch.yml需由主会话加入官方`@deepseek-ai/dsh-skill`服务行（锁定0.2.1-rc.2），不要加入默认filesystem/tool-skill。每轮独占DSH scope中使用`registerSkillRuntime(scopedContext.skills,run)`，返回disposer；必须释放scope和run。官方provider测试现包含真实scope同名隔离/释放在途；仍需真实profile业务组合验收。

管理options现另含`requireDiscussionDependencies?:SkillDiscussionValidator`，用于preview/export/rollback的review来源C；与PostgresSkillPort相同回调。准确类型返回`Promise<readonly string[]>`，不是void。
