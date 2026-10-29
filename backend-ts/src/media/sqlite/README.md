# 单条媒体合同（16）

`contracts.ts` 是17/18的窄适配器入口。`MediaAdapter.execute(context)` 仅处理明确指定的一条消息。新读取分支拿到固定 `HistorySource`（`recordId` 是 capture_record.id）及当前读取资格；本地重转分支只拿同消息合法 `audio_source`，不要求微信读取开关。适配器每段前后调用 `checkpoint()`，以 `save()` 提交独立文件流、预期字节数/摘要和实际类型校验回调；返回窄资源关联证明。不传任意SQL，不从HTTP接受路径、字节、适配器或关联证明。

`save`先持久登记随机不可复用定位，再排他创建、登记真实文件及父目录身份，随后分段写入、sync、完整性和类型复核；发布在短事务复验所有资格。类型校验必须分别报告容器、可查看/播放及图片质量；合成校验器只认证生命周期，不能放行真实类型。媒体不转写、OCR、入记忆或调用模型。

三实体迁移导出 `mediaMigration(version)`，集成负责人分配未发布版本。删除复用05同一账本；安装时使用 `composeMediaDeletionRegistration(base)`，media域在history/identity前，requiredDomains显式包含media；media独立清除只推进自身代次。公共装配与页面验收需与总指挥串行协调，单独模块不等于已经接入正常App。

HTTP拟定：GET/POST/DELETE `/api/contacts/:contactId/messages/:messageId/media`；POST只接受 `{request_key,goal}`，DELETE要求 `Idempotency-Key`。预览POST `.../media/files/:fileId/preview`；GET/DELETE `/api/media/previews/:sessionId` 观察撤下并确认释放。活动预览被删除封禁后须端侧撤下实际对象再释放；未确认释放保持删除未完成。文件路径不出站，不跨消息共享。

文件API依据：Node v24官方fs文档 https://nodejs.org/docs/latest-v24.x/api/fs.html ，使用本机v24.19.0的open(O_EXCL/O_NOFOLLOW)、FileHandle.write/sync/stat、statfs及受版本管理的ManagedFiles身份校验。实现与实际验证证据由16任务Answer记录。
