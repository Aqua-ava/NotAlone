# 06 端口装配现状（2026-10-24，只读核对）

## C 来源：已有类方法，尚非可直接使用的完整宿主实例
- 实现：`reply-assistant-guards.ts:151`，`ReplyAssistantGuards.requireReplyDiscussionById(client:pg.Client,scope:{owner_id:string;contact_id:string},requestId:string):Promise<string[]|null>`。
- 按原身份快照、捕获父边、anchor、依赖与原来源使用表复验；无快照返回null；非独立导出函数，不启动事务、不自行持owner锁。
- 06适配草案：`async(c,o,k,id)=>{const ids=await assistant.requireReplyDiscussionById(c,{owner_id:o,contact_id:k},id);if(ids===null)throw new SkillPortError();return ids;}`。06仅在已发现C快照时调用，不能把null静默转空集合。
- 构造必须提供10个真实端口，见同文件:23-33、:53；构造器缺任一即`reply_guards_unavailable`。
- 当前源码未发现`new ReplyAssistantGuards(...)`宿主装配；`requireSavedSkillPolicy`和`requireActiveBinding`目前只见必需接口/调用，未见同名实现。前者不能用06本轮Map凭证冒充历史候选方法政策核验。
- 已有`reply-source-guards.ts:32`的`requireReplySourcesCurrent(client,scope,requestId,historical,discussion?):Promise<string[]>`可做循环装配基础；其AsyncLocalStorage同client/owner防环，不得跨事务缓存或丢掉discussion回调。
- `captureReplyDiscussion`(:189)是写准备快照/来源表的入口，不能用作06只读来源校验。只读来源用上述ById历史方法。

## 回复删除：实际入口在09共享删除模块，助手闭包由05实现
- `preference-erasure.ts:16`已实现导出`deleteSourceReplies(client:pg.Client,owner:string,removedIds:string[],contactId:string|null=null,revokeRunningScope=false,ports?:Partial<ErasurePorts>):Promise<void>`。
- 06 `DeleteSkillReplies`适配草案：`(c,i)=>deleteSourceReplies(c,i.ownerId,i.removedIds,i.contactId,i.revokeRunningScope)`；原字段固定contactId=null、revokeRunningScope=false。
- `ErasurePorts`(:5)三个函数：`eraseAssistantDependencies(c,o,ids,requestIds):Promise<string[]>`、`eraseSkillLearning(c,o,ids):Promise<void>`、`eraseMemoryUpgrades(c,o,ids):Promise<void>`。
- 当前默认实现已实接：createAssistantErasure、06 eraseSkillLearning递归回调、动态导入eraseMemoryUpgrades；不是integration-request中旧“计划接口”。
- `reply-assistant-erasure.ts:185`已实现`createAssistantErasure({eraseSkillLearning})`，返回上述四参函数，:189取得owner advisory xact lock，捕获carry/C父边后先递归Skill再擦助手输入/turn，返回受影响request IDs。
- deleteSourceReplies自身不BEGIN/COMMIT，且在助手函数拿锁前已做selector；调用方必须从入口先持`owner:${owner}`锁、全链共用同client。06管理transaction已持该锁，不另开事务。
- 该删除入口随后写invalidated key并删除reply_request；源身份必须先被助手闭包捕获，不能调换执行次序。

## 托管更新备份：实际模块名为preference-files.ts
- 未发现`managed-update-backups.ts`；已实现`preference-files.ts:26`导出`eraseManagedUpdateBackups(client:pg.Client,environment:NodeJS.ProcessEnv):Promise<void>`。
- 06 `eraseManagedBackups`适配草案：`c=>eraseManagedUpdateBackups(c,storage.runtimeEnvironment())`；不传猜测目录，不另读.env。
- 仅读传入NOTALONE_MANAGED_USER_DATA；未配置/无updates返回。核private权限、NOFOLLOW、当前PG系统/库指纹与完成/恢复/连接门，所有档案先核验再unlink database.dump并fsync；失败统一`update_backup_cleanup_required`。
- :39在调用方事务中取得`pg_try_advisory_xact_lock(1852798049,1)`，不自行BEGIN/COMMIT。文件删除不可由PG回滚恢复，禁止将其描述为跨PG/FS物理原子事务。
- `cleanupPreferenceFiles(storage,owner):Promise<void>`(:72)另外开启businessTransaction并持owner锁，消费Skill清理队列；只作提交后清理，不能塞进上述同client撤资格事务。
- `SkillLibraryOptions`当前已含三个注入槽；`host-plugin.ts`尚未发现对应SkillLibrary/C/备份/删除装配。本核对没有执行测试或修改产品代码。
