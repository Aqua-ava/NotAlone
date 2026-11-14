# SQLite 单条媒体保存与预览

产品合同以[媒体来源与同步](../../../../architecture/current/wechat-sync.md)、[图文处理](../../../../architecture/current/memory-processing.md)、[媒体删除](../../../../architecture/current/privacy-deletion.md)为准；本页只保留本模块的接口、装配和故障处理。

`contracts.ts` 是图片和语音适配器的窄入口。`MediaAdapter.execute(context)` 仅处理明确指定的一条消息。新读取分支拿到固定 `HistorySource`（`recordId` 是 capture_record.id）及当前读取资格；本地重转分支只拿同消息合法 `audio_source`，不要求微信读取开关。适配器每段前后调用 `checkpoint()`，以 `save()` 提交独立文件流、预期字节数/摘要和实际类型校验回调；返回窄资源关联证明。不传任意SQL，不从HTTP接受路径、字节、适配器或关联证明。

`save`先持久登记随机不可复用定位，再排他创建、登记真实文件及父目录身份，随后分段写入、sync、完整性和类型复核；发布在短事务复验所有资格。类型校验必须分别报告容器、可查看/播放及图片质量；合成校验器只认证生命周期，不能放行真实类型。保存操作不调用模型；发布后的 changed 回调按宿主运行模式唤醒既有记忆调度。图文输入、来源复验及清除／替换的派生依赖由现行记忆与删除合同维护。

三实体迁移导出 `mediaMigration(version)`，正式registry已分配版本6。删除复用统一账本；安装时使用 `composeMediaDeletionRegistration(base)`，media域在history/identity前，requiredDomains显式包含media；media独立清除只推进自身代次。正式宿主、桌面桥和聊天行使用同一服务；实际提取／预览能力取决于已安装的类型适配器与当前来源资格。

已实现HTTP：GET/POST/DELETE `/api/contacts/:contactId/messages/:messageId/media`；POST只接受 `{request_key,goal}`，DELETE要求 `Idempotency-Key`。预览POST `.../media/files/:fileId/preview`；GET/DELETE `/api/media/previews/:sessionId` 观察撤下并确认释放。活动预览被删除封禁后须端侧撤下实际对象再释放；未确认释放保持删除未完成。文件路径不出站，不跨消息共享。

文件实现使用 Node 24 的 `open(O_EXCL/O_NOFOLLOW)`、`FileHandle` 写入／同步和不跟随链接的身份检查；具体边界由 `files.ts`、受管文件与删除服务共同实现。修改第三方 API 前按[DSH 与依赖查证流程](../../../../docs/agents/dsh-development.md)核对实际安装版本。

## 已实现的装配入口

`schema.ts:mediaMigration(version)`、`actions.ts:createMediaActions(registration)`、`deletion.ts:composeMediaDeletionRegistration(base)` 与 `service.ts:SqliteMediaService` 独立导出。全宿主只维护一份完整 registration，包含当前已安装的 history / identity / skill_metadata 等域，然后经 compose 加入 media；registry 的删除动作与媒体动作使用同一个对象。不要将未安装域写进 requiredDomains，也不要省略已有写者。

服务使用 `MediaContactPort` 和 `MediaSourcePort` 窄接口；联系人资格应代理当前统一删除生命周期持有的联系人服务，不能另造元数据缓存，也不能在联系人删除后重新装载旧对象。`initialize()` 只中断旧runtime未完成尝试并恢复已登记本地清理；GET不会领取提取。`stop(contactId?)` 用于取消选中并排空全部在途分支；关闭读取总开关使用 `stop(undefined, 'wechat')`，保留仍合法的本地转换，每段及发布事务仍独立复验。所有领域服务及删除协调器必须共享一个 `ActiveHolders`。

正常宿主将 `SqliteMediaHttp.handle` 放在Bearer/无Origin认证之后。未认证真实类型时传 `adapters:[]`，页面明确不可用。桌面桥 `installMessageMediaBridge` 与 `createMessageMediaBridge` 使用固定方法；联系人历史中的图片由 `HistoryImageBubble` 查看，表达工作区不再单独展示聊天媒体面板。连接准备与退出必须等待 `invalidateAndDrain` / `prepareClosing`；来源或联系人删除开始撤下旧快照。前端撤下DOM/blob后才 `releasePreview`；后端 `close` 也不把仅取消视为释放。

创建后、身份登记前崩溃会保留未知身份阻塞；不会据随机文件名猜测归属或删除。容量/类型/文件写入故障只清本次安全目标，旧合法结果保留。当前单文件保存及可撤销预览统一上限32MiB；超过时在读取字节前拒绝本次新增，不谎报可在App内播放。上述限制是本模块有界资源合同，类型能力与真实播放仍由对应类型适配器验收。

`requestedAttempt` 在明确提取/同键重查响应中固定原操作回执；`latestAttempt` 仍反映当前最新尝试，二者不互换。服务独立跟踪所有启动中的请求、文件保存Promise与类型探针，适配器遗漏await不构成提前释放理由。启动后台串行核验已存文件（不阻塞宿主握手，`startupVerification` 仅供测试等待），查看时再逐文件核验；缺失/损坏撤下可用声明并标记失效，不自动新读微信，只有明确清除或新发布才执行对应清理。

`context.retainReader(close)`：外部资源打开后立即登记幂等排空回调；关闭失败保留同一 `mediaAttempt` holder，删除不能completed，沿原删除重试实际关闭成功才释放。适配器自身也须等待全部执行和未释放读者，不以抛异常代表读者已经结算。此钩子不新增持久迁移、删除域或HTTP字段。


阶段实现和旧验收记录已移至[开发历史](../../../../docs/history/backend-development-history.md)；历史数字不表示当前版本通过。
