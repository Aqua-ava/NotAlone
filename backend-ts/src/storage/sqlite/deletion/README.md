# 统一来源删除合同（实施05）

本模块提供统一删除账本、受控执行和领域接入合同。默认业务仍为PG；显式SQLite开发分支已在正常DSH宿主接通02身份域及14 Skill元数据域的联系人/账号删除。来源、聊天清空、讨论和媒体缺少完整处理器时明确拒绝`deletion_scope_unavailable`。记忆、非空DSH副本和媒体的真实删除由各写者接入，20切换前必须复核完整清单。

## 注册与短事务

- `schema.ts`导出`deletionMigration(version)`，由集成registry赋连续版本；不要修改已集成SQL。本域已集成版本为2，身份和Skill迁移分别追加为3和4。
- `contracts.ts`的`DeletionRegistration`包含真实`authority`、全部领域`domains`和显式`requiredDomains`清单。缺失处理器拒绝执行；清理期间注册清单变化也拒绝，不能用更小的闭包完成旧操作。02/16分别提供相应范围的`DeletionAuthority.fence/verify`，复用自己的资料/媒体代次，不新建第二套权限表。
- `actions.ts`导出`createDeletionActions(registration)`，替换默认未接线的`deletion.*`动作。宿主仅装配受版本管理的回调；HTTP、renderer和Tool不得传入SQL、回调、模块路径或内部证明。05不增加任意SQL Tool或第二套后台。
- `registration.ts`当前固定`identity + skill_metadata`及完整`requiredDomains`，只放行联系人/账号范围；不把discussion/media扩成联系人data_generation。新增写者必须随票补完整闭包、精确authority和范围放行，不能只改能力标志。正常DSH `/api/runtime/status`的`deletion_scopes`公开实际支持范围，不扩大contacts配置权限。
- `planDeletion(tx,lease,registration,{ownerId,requestKey,scope})`可被可信领域动作组合调用，例如媒体原子发布旧文件清理意图。同事务先推进并撤销旧写入/使用资格，再固定闭包和幂等键；事务不得等待模型、CLI、SDK或文件I/O。
- 范围包括`source/contact/contact_history/account/discussion/media_result_clear/media_result_replace`，有限字段形状见类型及DDL。同一实例、owner、固定删除namespace和requestKey只能指向同一范围；重复请求不再次推进代次。媒体clear/replace互不混用namespace。

## 07/11/14/16等写者的必需接入

每个`DeletionDomain`注册以下同步回调，均在专用Worker短事务内执行：

统一模块对领域及authority回调的Promise返回作运行时拒绝；即使TypeScript的void回调允许误传async函数，也不能提前提交目标清理进度。此检查不撤回回调已经发起的外部动作，可信注册代码仍不得在这些回调内调用文件/模型/CLI。

1. `fence(tx,operation)`：撤销派生检索、恢复、生成及旧请求资格，返回需要墓碑的`{namespace,key}`。必须幂等。命名空间为固定业务名，如`media.extract`，模块自动加databaseId前缀。
2. `collect(tx,operation)`：沿实际输入反查完整删除闭包，包括只作上下文的来源、输入输出追踪、全部状态的候选/版本/文档/回复、本人跨联系人贡献，以及当前/退役/暂存/在途副本。展示citation不能替代真实依赖。不要把已删输入换指另一条记录来保住旧证明。
3. `rowKinds`声明每种行的真实复合主键及`ownerKey`；`clearRow`执行本领域清理及范围复验。统一模块拒绝未知行种、主键缺项、多项和跨owner目标，不拼接业务SQL。
4. `authorizeFile`在文件I/O前复验目标归属、代次、cleanup_pending和仍必需的父件；被登记清理的fileId不可重新发布为current。`fileCleared`只在文件删除及父目录fsync后清理领域文件定位/证明，不能提前丢掉唯一恢复凭据。媒体replace只能枚举旧fileId，不能整消息目录删除；仍必需的SILK父件必须保留。
5. `verify`逐项提供`database_rows/derived_eligibility/trace_payloads/request_replay/scope_suppression`复核。结果为passed、blocked或有明确机器原因码的not_applicable；证明不得含正文、名称或私人路径。需模型复验者先撤下资格，等待用户手动处理；删除不能触发模型或新微信读取。

合法来源的替代关系由领域处理器复验：正文必需消息之间为AND，同消息的合法出现为OR。另一合法来源可支持事实保留，但不得恢复旧实际输入、追踪、证明或媒体。单来源删除保留ADR-031允许的最小无正文调用记录；整联系人/账户按ADR-094清除对应调用记录。无正文调用记录不能冒充含正文完整追踪。

`requestAllowed(tx,lease,ownerId,namespace,key)`用于业务请求首次接受及提交前复验；`tombstoneRequest(tx,lease,{ownerId,namespace,key,generation,operationId?})`用于同事务失效。墓碑不随live请求删除，不提供普通剪枝/恢复动作。联系人/账户删除清除调用台账，不意味着删除防旧请求重放的墓碑或渠道抑制决定；这些最小控制记录不保存调用元数据、正文或文件名。

## 活动持有者与受管文件

宿主创建一个共享`ActiveHolders`和`ManagedFiles(userData)`，传入`DeletionService`。`plan/status/advance`是本票业务入口；后续认证HTTP接线调用此服务，不能直接暴露内部claim/clear/verify/compact动作。

`http.ts`导出生产`SqliteDeletionHttp(service,ownerId).handle(req,res):Promise<boolean>`，未匹配时返回false。必须置于02共用的唯一Bearer/Origin认证后；无需新后端。沿用`DELETE /api/contacts/:contact/sources/:source`（空正文）、讨论删除（confirmed）、联系人删除（confirmed及confirm_contact_id）、账户删除（confirmed及confirm_scope=account）、`GET /api/deletions[/:id]`、`POST /api/deletions/:id/retry`和来源`GET /api/tasks/status?contact_id=...&task_id=...`。请求不能提供owner、目标SQL或内部复核；公开状态只返回最小进度，完成后不返回目标身份。source删除回task_id，状态符合现有来源控制器；后续来源目录仍由实际写者提供。没有新的媒体泛化HTTP范围，媒体16继续自己的明确操作。隔离HTTP测试复用生产适配器与真实临时SQLite，外围仅替换为固定合成认证；未据此认证正式宿主聚合或真实App。

HTTP支持`Idempotency-Key`标识一次明确请求，账户删除必须提供，新独立删除使用新key。账户scope不能永久充当请求身份，否则新增资料后会重放旧完成结果。旧来源/讨论/联系人空key调用只在其内部ID删除后永久失效、不复用的条件下按固定目标去重；新业务调用应传明确请求key。来源回执包含实际`status`，普通非删除task_id返回false交给既有处理器。

共用宿主仅对`GET /api/deletions?contact_id=...&scope_kind=discussion`及`GET /api/tasks/status?contact_id=...&task_id=...`放行严格查询形状，其他查询继续拒绝。公开操作状态的checks只包含种类、领域、结果和有限机器证明，不返回路径、文件身份或正文。正常DSH握手位于`managed/sqlite-backend.info`，不放进数据库辅助文件目录；运行中的账号删除已验证实际checkpoint/VACUUM及公开页/WAL复核，未知文件检查没有放宽。

`ActiveHolders.register({key,ownerId,contactId?,generation,close})`必须在首次读写前执行。key为`domain:稳定副本ID`；generation为对应资料资格快照。业务仍须在DB动作内复验02/16资格，内存持有者登记不授予权限。返回的释放函数会等待close；不能手工移除尚未关闭的引用。close回调必须等待官方AgentHandle.dispose、读写handle.close、业务finally、预览/播放释放及末次写入。只有cancel不构成释放证明；超时/异常保持blocked，不能因此删文件。不同owner同名key不互相封禁；新的合法资料代次可登记新副本，不复活已封禁的旧key。

`ManagedFiles`只允许`managed/runtime-copies`、`managed/media`、`managed/cache`三个固定区。`prepareArea`只建空私有区；`capture(area,locator,kind)`取得实际dev/ino/birthtimeNs/uid与每级父目录身份。locator是受限相对定位，不能是绝对路径、点段或符号链接。文件必须为当前用户拥有、私有权限且nlink=1；目录目标只用rmdir删除空目录。数据库、Skill原目录、模型密钥、微信原件和用户外部原文件不属于这些可删区。

写者先登记创建意图，以排他方式创建空暂存对象，保存真实文件身份后才能写正文/交给SDK。尚不能证明归属的preparing副本必须由领域verify保持blocked；不能伪造inode、扫描猜测目录或把未知文件当已清理。DSH整副本须由11枚举已登记的文件与目录目标，不能只删猜测的一个JSONL。删除器在受控宿主命名空间内串行复验身份并删除，不能对抗同一系统用户恶意并发替换路径；所有合作写者必须经过代次与持有者门禁。

## 完成、重试与存储面

`advance`领取绑定当前runtime的runner及planRevision，排空持有者，在事务外逐文件复验/精确删除，再短事务确认进度。任何迟到确认使用旧runner、实例或修订都拒绝。当前runtime重复领取返回busy；重开同实例可接管旧runtime未完成操作，不自动调用模型。

行/文件失败保留同一操作及逐目标尝试进度。清理完后先确认文件及活动引用，再清除账本中的敏感定位/文件证明，最后执行checkpoint → VACUUM → checkpoint → integrity/FK及维护inspect。维护结果包含空闲页、WAL/SHM/journal大小、内存临时存储、secure_delete与未知辅助文件计数；WAL未截断、checkpoint busy或未知文件均不能完成。当前连接仍存活时SHM为SQLite共享索引元数据，记录大小并核归属，不在活动连接下强删SHM。inspect快照不替代领域/SDK/长读者排空，相关持有者必须另证；长读者实际阻塞checkpoint的反例已覆盖。

所有当前计划的必需面通过、目标清除且闭包复查无新增后才completed。新目标先推进planRevision，旧检查失效，调用方沿同操作再次advance。维护中断或失败保持未完成；重试再次维护，不能仅凭DB行已删宣告跨存储原子成功。本合同不承诺SSD底层、外部备份或模型服务商副本的法证擦除。

## API依据与验收边界

Node v24.19.0实际运行，fs的lstat/unlink/rmdir/fsync与SQLite维护参照[Node24官方fs文档](https://nodejs.org/docs/latest-v24.x/api/fs.html)及底座01合同。声明、锁定及本工作树安装的DSH agent/agent-loop/session-persistence为0.2.1-rc.2；已核对公开AgentHandle.dispose、SessionHandle.close及安装agent-loop实现1703–1730行的cancel/whenIdle/scope.dispose/handle.close顺序，固定官方源码依据为仓库DSH流程所列687f282e8625c6b8d11ff58211a90524be2e4317。不声称npm制品与源码逐字对应。05没有新增DSH调用或改官方profile；合成close替身仅验证持有者协议，真实非空DSH副本接入由11验收。
