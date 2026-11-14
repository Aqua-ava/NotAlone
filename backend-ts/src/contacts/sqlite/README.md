# SQLite 联系人、身份与读取授权

产品合同以[身份与授权](../../../../architecture/current/domain-data.md)、[同步范围](../../../../architecture/current/wechat-sync.md)、[隐私与删除](../../../../architecture/current/privacy-deletion.md)为准；本页只保留本模块的接口、装配和故障处理。

此模块拥有 owner、contact、channel_account、channel_conversation、conversation_binding、binding_verification、read_grant、manual_confirmation。领域迁移由 `identityMigration(version)` 生成，注册版本由集成顺序确定；已集成 SQL 不重写。下游模块引用这些主键，不重复建身份表。

`SqliteContactService` 的 metadata port 提供账号、来源代次、私聊身份及本地头像位图。`createWechatContactMetadata` 经窄客户端读取账号证据；新增微信资料读取要求当前证据为 `verified` 且与先前固定账号一致，否则拒绝。元数据资格不能替代历史正文读取支持，也不能独立证明前台登录账号。

联系人头像随历史／增量同步的启停与调度周期从微信本地 `head_image` 库定向读取；整个头像路径禁止网络请求。原始位图限制 256 KiB，实际解码后重编码为 96×96 PNG，按 `owner_id + contact_id` 存在 `contact_avatar`，来源缺图或失败保留旧副本。页面 GET 只读已保存的本地图片，不要求微信在线或读取开关开启；目录提供内容摘要 `avatar_revision`，同步状态提供 `contact_avatar_revision`，用于落图后的定向刷新。联系人与账户删除显式清理图片，聊天历史清空保留独立头像；在途写入仍在同一短事务复验读取资格及删除代次。

名单须明确同意；快照短时驻内存，确认再次核对账号/名单。保存只含稳定身份、名称和最小证明，丢弃上游摘要。快照 token 和勾选时的 selection_generation 一起提交，不能在提交前刷新时自动换成新代次。重复同快照确认幂等；撤销过的快照不能恢复。

每次取消撤销有效 grant 并递增 contact.selection_generation；不改 binding 身份、不删合法资料、不改 conversation.barrier_generation。重选同一仍核验的会话复用 binding，新建 verification/grant，旧grant永不重开。账号/连续性失效、名单冲突或低置信时先持久失效旧资格再返回拒绝。名单整体无法核验时当前账号暂停；重新确认不会复活旧grant。名称不唯一且不作为连接键。

`ReadEligibility` 见 contracts.ts。下游在外部读取前及期间核验真实渠道账号、有效支持档、开关和范围；每次接受写入的**同一个短事务**调用 `assertReadEligibility(tx,token)`。令牌包含 owner/contact/account/conversation/binding/grant/verification 身份、read_epoch、selection_generation、data_generation、identity_generation、scope_revision、barrier_generation 和 source_generation。存储实例租约由外层 Worker 独立核验。此函数只验证持久领域资格，不能认证当前外部账号、正文协议或来源完整性，也不代替各域自己的删除/处理代次。

主键供下游引用：`owner(owner_id)`；`contact(owner_id,id)`；`channel_account(owner_id,id)`；`channel_conversation(owner_id,id)`；`conversation_binding(owner_id,id)` 及 `(owner_id,contact_id,id)`；`binding_verification(owner_id,id)` 及 `(owner_id,binding_id,id)`；`read_grant(owner_id,id)` 及 `(owner_id,contact_id,binding_id,id)`。联系人范围子表应以完整 owner/contact/binding 组校验，不能只核 owner。

`owner/contact.current_publication_id` 由记忆文档发布域管理，同 owner/self 或同 contact 的 publication 外键与触发器在其迁移中建立；联系人模块不写发布内容。删除组合须先清下游引用，再处理身份控制行。

HTTP 由 `SqliteContactHttp.handle` 投影既有联系人/同步/账号页面合同，必须先使用宿主 `authorizeSqliteRequest` 的唯一 Bearer、无 Origin 认证。列表另需固定 `X-NotAlone-Metadata-Consent: selected-list`。拒绝任意 owner、SQL 或模块路径。此 SQLite HTTP 实现当前只开放逐会话授权，不接受全部私聊授权请求；全部私聊的已采纳产品合同见现行同步规格，不把实现入口限制写成产品永久限制。`identity_protocol:sqlite-selected-v1` 让桌面保持原始快照及代次。manual-confirmation 路由仅为已存在联系人保存独立手动归属，不增加 binding/grant。

正常 SQLite 宿主通过 `launchDsh`、`profile/sqlite.patch.yml` 和 `sqlite-host-plugin.ts` 装配本服务；能力、数据库身份和路径来自受信任启动配置。启动路径、运行模式与验证边界见[后台入口](../../../README.md)，不通过页面或请求选择另一套数据库。

删除接入导出 `identityDeletionAuthority` 与 `identityDeletionDomain`（deletion.ts），按统一删除的结构接口接受实际 StorageTransaction：联系人范围推进 data_generation/source_revision；contact 删除另撤 grant、推进 selection_generation 并标 deleting；account 关闭读取、推进 read_epoch、撤销账号与所有 grant。联系人聊天清空不取消同步，只使清空前令牌失效；消息域仍须核验清空边界、排除及新消息资格。verify 对缺失、回退或未知身份的控制行返回 blocked；单调增加的更高代次仍证明旧 writer 已失效，但清理只能命中操作已固定的旧目标。history 的手动确认只清理 accepted_data_generation 小于该操作 acceptedGeneration 的记录，不触及后续合法确认。

`identity` Domain 清除相应身份核验证明、grant、manual_confirmation 和展示名称，保留无名称/正文的 owner/contact/binding/channel 最小控制墓碑以维持撤销和删除排除；owner.state 防止账号删除期间重新连接或开启读取。联系人删除在 plan 事务把 contact 置为 `deleting` 后，目录、持久绑定、资格与前台快照即按 active 截断，名单服务可只读重建，但身份写入、名单预览及账户删除仍关闭到完成。contact_history 仅清除本次手动确认，不删除 grant。来源、消息、记忆、媒体和运行时副本不属于身份清理闭包；存在这些消费者时，统一删除与宿主必须先注册并清理全部关联域，外键阻止提前删除被引用的证明。集成显式加入 `identity` 至 requiredDomains，不能仅凭本域通过宣称完整删除完成。
