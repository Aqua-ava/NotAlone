# 06 旧写入口移交草案

现存文件接线草案只生成在scratch；不改共享文件，不激活移交。新增责任门和RPC客户端已实现于backend/src/notalone/persistence，尚未接宿主。基线SHA256见legacy-write-handoff-base.json，精确diff见legacy-write-handoff.patch。适用性须在18释放后重查。

## 精确补丁覆盖

- 已实现persistence/skill_management_handoff.py（无需补丁重复创建）：普通管理同线程可重入租约、stop/drain、排空后一次性activate同步回调；远端错误不回退，未接通时失败关闭。
- skill_library.py的_connect改为带租约contextmanager，覆盖旧普通import/update/list/preview/versions/status/delete/rollback/export及文件管理调用，租约持续到commit/rollback/connection.close。
- skill_directory.py的synchronize_skill_library经中央门分发，prepare_skill_directory也使用此入口；直接synchronize_skill_directory的写模式必须持本地租约。check_only保留纯读取，不增加同步或迁移。
- server/reply_wiring.py现有中央同步调用无需重复改写；skill_history.read的prepare调用、skill_review._synchronize_files的中央调用同样被覆盖。它们分别在业务事务开始前／提交后运行，不能把远端同步移入持owner锁事务，否则会自锁。
- 15的publish_reviewed(connection,...)、rollback_locked(connection,...)继续是审核发布／带operation_key历史回滚的唯一写者；二者用调用方事务，不经过_connect。不得替成06普通import/rollback，不能禁用共享_insert_version_and_resources。
- 排空只统计06旧入口，不等价于暂停15；TS与15仍须持同一owner advisory锁、原revision检查，并共用原文件队列。不能宣称所有Skill表已无Python写入。

## 主会话共享装配待补，未包含在此diff

1. server/app.py私有控制端点接stop/status/activate；activate安装固定owner的远端客户端回调，不允许请求正文指定任意URL或跨owner同步。端点不得经公开legacyRoute代理暴露。
2. 远端客户端仅允许宿主预先配置的127.0.0.1端口与独立内部凭据，硬超时、响应体预算、无重定向；网络及协议失败转SkillManagementUnavailable。不转发数据库URL、真实路径或聊天数据。客户端已实现为RemoteSkillManagement(port=...,internal_token=...,owner_id=...)；不接受URL，synchronize()不接受参数。排空后调用gate.activate(owner_id=owner,synchronize=remote.synchronize)。不能将Python callable接口直接暴露为JSON。
3. host-plugin/legacy-backend停止旧公开请求，调用stop，有限等待active_requests=0；核对TS依赖就绪及owner后配置客户端/activate，再宣告ownership.skills=typescript。失败保持关闭，不逐请求fallback；进程退出先停止内部RPC/排空再关闭storage。
4. 内部同步调用SkillLibrary.synchronize(owner,assertCurrent)并返回整数revision；旧库列为integer，响应严格0..2147483647。独立凭据只允许该端点；公开凭据不接受。
5. 公开/api/skills改走SkillLibrary.handle，正文上限1MiB，runtime健康投影调用fileHealth。未完成上述闭包前ownership保持python；不删除skill-http.test.mjs中的ownership断言。
6. 启动原Python回复构建可能调用同步；默认python gate允许原初始化。必须完成停收排空再开启TS写路由，不能启动即双写。15审核提交后的同步失败仍沿原领域错误路径，不撤销已提交审核事务。

## 真实依赖适配（详见port-integration-status.md）

- deleteSourceReplies: `(c,i)=>deleteSourceReplies(c,i.ownerId,i.removedIds,i.contactId,i.revokeRunningScope)`，导出自preference-erasure.ts；06调用前已持owner锁，沿同client递归05助手／09记忆／06Skill撤销。
- eraseManagedBackups: `c=>eraseManagedUpdateBackups(c,storage.runtimeEnvironment())`，导出自preference-files.ts。使用真实环境与同client；磁盘unlink无法被PG回滚恢复，不能称物理原子。
- requireDiscussionDependencies: 调用已装配实例`assistant.requireReplyDiscussionById(c,{owner_id:o,contact_id:k},id)`，null抛SkillPortError，否则返回依赖ID。ReplyAssistantGuards实例十个必需端口须完整接通，特别是历史政策requireSavedSkillPolicy；不能用本轮缓存冒充。当前尚无完整宿主实例。

## 验证与限制

已用固定NotAlone Python运行build_patch.py：两份现存文件AST通过；git apply --check通过；最初独立责任门五项通过（后已移至正式测试并扩充），覆盖排空嵌套租约、停收拒绝、异常释放、单次激活、远端失败不回退和revision协议。最初裸python不存在，后改用固定解释器运行成功。
这些只证明草案门与补丁可解析，未运行应用后的Python回归、RPC鉴权／超时、正式profile HTTP或App验收。59项已通过模块测试保持原证据；HTTP仍RED。没有使用真实联系人、微信、模型、外部连接或备份删除；未git add/commit。桌面只能npm run dev，当前09独占宿主/App，06等待下一时段及主会话App租约，禁止打包或推送。

## 正式新增模块验证

已新增skill_management_remote.py、skill_management_handoff.py及同名unit/persistence测试。客户端内部路径固定/api/runtime/skill-management/synchronize，只POST固定owner；响应必须200 application/json且仅含integer revision。正文4096字节、头字段总量8192字节（HTTP标准解析器后检查）；硬总超时默认10秒、配置上限30秒，不使用环境代理，不跟随重定向，不自动重试。close打断在途并永久拒绝新请求。独立token由宿主生成并与公开token分离，这一服务端鉴权责任仍待共享接线验收。
