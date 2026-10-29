# SQLite 联系人身份与逐人授权合同（实施 02）

此模块拥有 owner、contact、channel_account、channel_conversation、conversation_binding、binding_verification、read_grant、manual_confirmation。领域迁移由 `identityMigration(version)` 生成，注册版本由集成顺序确定；已集成 SQL 不重写。其他票引用这些主键，不重复建身份表。

`SqliteContactService` 的 metadata port 只提供经支持档核验的账号/来源代次及私聊身份元数据。真实适配器 `createWechatContactMetadata` 当前只允许只读 status 检测候选，因来源连续性支持档未认证而返回 unverified；不读取名单、正文或媒体，不以 status 就绪伪造身份认证。合成端口替换该外部边界，不替换业务服务或数据库。

名单须明确同意；快照短时驻内存，确认再次核对账号/名单。保存只含稳定身份、名称和最小证明，丢弃上游摘要。快照 token 和勾选时的 selection_generation 一起提交，不能在提交前刷新时自动换成新代次。重复同快照确认幂等；撤销过的快照不能恢复。

每次取消撤销有效 grant 并递增 contact.selection_generation；不改 binding 身份、不删合法资料、不改 conversation.barrier_generation。重选同一仍核验的会话复用 binding，新建 verification/grant，旧grant永不重开。账号/连续性失效、名单冲突或低置信时先持久失效旧资格再返回拒绝。名单整体无法核验时当前账号暂停；重新确认不会复活旧grant。名称不唯一且不作为连接键。

`ReadEligibility` 见 contracts.ts。下游在外部读取前及期间核验真实渠道账号、有效支持档、开关和范围；每次接受写入的**同一个短事务**调用 `assertReadEligibility(tx,token)`。令牌包含 owner/contact/account/conversation/binding/grant/verification 身份、read_epoch、selection_generation、data_generation、identity_generation、scope_revision、barrier_generation 和 source_generation。存储实例租约由外层 Worker 独立核验。此函数只验证持久领域资格，不能认证当前外部账号、正文协议或来源完整性，也不代替各域自己的删除/处理代次。

主键供下游引用：`owner(owner_id)`；`contact(owner_id,id)`；`channel_account(owner_id,id)`；`channel_conversation(owner_id,id)`；`conversation_binding(owner_id,id)` 及 `(owner_id,contact_id,id)`；`binding_verification(owner_id,id)` 及 `(owner_id,binding_id,id)`；`read_grant(owner_id,id)` 及 `(owner_id,contact_id,binding_id,id)`。联系人范围子表应以完整 owner/contact/binding 组校验，不能只核 owner。

owner/contact 的 current_publication_id 当前始终 NULL；文档发布域接入时必须添加同 owner/self 或同 contact 的约束触发器后才能写非空值。本票不创建尚未实现的文档父表。05 应在自身删除 fence 中推进 owner.read_epoch/contact.data_generation/conversation.barrier_generation 等适用控制并撤销 grant；后续各域清理独立注册，未注册完整清理闭包时不得宣称删除完成。取消授权不等于删除操作。

HTTP 由 `SqliteContactHttp.handle` 投影既有联系人/同步/账号页面合同，必须先使用宿主 `authorizeSqliteRequest` 的唯一 Bearer、无 Origin 认证。列表另需固定 `X-NotAlone-Metadata-Consent: selected-list`。拒绝任意 owner、SQL、模块路径及全部私聊授权。`identity_protocol:sqlite-selected-v1` 让桌面保持原始快照及代次。manual-confirmation 路由仅为已存在联系人保存独立手动归属，不增加 binding/grant。

共用开发入口：显式 `sqlite-development.json` 的 `capabilities:['contacts']`；Main 核验后产生内存 `LaunchConfiguration.sqlite`，沿 `launchDsh` 和 `profile/sqlite.patch.yml` 装配薄插件。默认 PG 不切换；未实现业务返回 503。后续域提供独立服务/HTTP处理器并由集成方串行扩充能力清单、路由及生命周期，不另起后台或伪装 PG。schemaVersion 不作为领域验收固定值。

删除接入导出 `identityDeletionAuthority` 与 `identityDeletionDomain`（deletion.ts），按05的结构接口接受实际 StorageTransaction：联系人范围推进 data_generation/source_revision；contact 删除另撤 grant、推进 selection_generation 并标 deleting；account 关闭读取、推进 read_epoch、撤销账号与所有 grant。联系人聊天清空不取消同步，只使清空前令牌失效；消息域仍须核验清空边界、排除及新消息资格。verify 对缺失、回退或未知身份的控制行返回 blocked；单调增加的更高代次仍证明旧 writer 已失效，但清理只能命中操作已固定的旧目标。history 的手动确认只清理 accepted_data_generation 小于该操作 acceptedGeneration 的记录，不触及后续合法确认。

`identity` Domain 清除相应身份核验证明、grant、manual_confirmation 和展示名称，保留无名称/正文的 owner/contact/binding/channel 最小控制墓碑以维持撤销和删除排除；owner.state 防止账号删除期间重新连接或开启读取。contact_history 仅清除本次手动确认，不删除 grant。来源、消息、记忆、媒体和运行时副本不属于身份清理闭包；存在这些消费者时，05/20必须先注册并清理全部关联域，外键阻止提前删除被引用的证明。集成显式加入 `identity` 至 requiredDomains，不能仅凭本域通过宣称完整删除完成。
