# 数据库迁移

NotAlone 使用 PostgreSQL 作为权威业务库。迁移文件按文件名顺序执行，不允许只在图形客户端中手工修改正式表结构。

本地开发数据库：

```text
数据库：notalone_dev
所有者：wy
schema：public
```

应用首个迁移：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/001_initial_ingest.sql
```

已应用首个迁移的数据库继续执行：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/002_reject_overlapping_messages.sql
```

联系人、来源和消息表为空时，继续执行联系人身份分离迁移：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/003_separate_contact_identity.sql
```

第三个迁移会在旧联系人、来源或消息存在时拒绝执行，不会把旧微信标识静默转换为
NotAlone 内部联系人。执行前必须确认数据范围和备份；本地空开发库可按全部迁移重建。

联系人身份迁移完成后，继续把微信专属消息字段移出通用消息表：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/004_separate_wechat_message_metadata.sql
```

第四个迁移会保留已有消息，把微信 local/server id、talker、来源时间和原始 JSON 搬到
`wechat_message_metadata`，再从 `message` 删除这些微信专属列。整个搬迁位于一个事务中；
任一步失败都会回滚到迁移前结构和数据。

继续增加来源删除状态和最小删除凭证约束：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/005_source_deletion_state.sql
```

第五个迁移区分 `delete_requested`、`deleting`、`delete_failed` 和 `deleted`。只有文件名、
SHA 和消息数量已经清空且写入删除时间时，数据库才允许状态为 `deleted`；只改状态会被约束拒绝。

继续建立已确认桌面会话的持久化绑定：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/006_conversation_binding.sql
```

第六个迁移保存稳定绑定 UUID、`owner_id + contact_id`、渠道账号范围、会话定位线索、状态和
最近验证时间。定位线索不能使用昵称或聊天正文替代；绑定撤销后，验证适配器不会再返回
`Ready`。迁移只建立表和约束，不读取桌面会话。

继续建立候选回复的 PostgreSQL 持久化边界：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/007_reply_store.sql
```

第七个迁移保存已验证联系人范围内的 `reply_request`、运行尝试、上下文证据快照、候选、
引用和实际使用的 Skill 版本摘要。幂等键只在 `owner_id + contact_id` 范围内生效；同一请求
的候选和引用在同一事务中写入。迁移不实现 Context、Memory、Skill 目录或外部发送，也不预设
来源删除对回复快照的清理级联。

继续建立只读 PostgreSQL SkillPort 的目录、版本和修订数据结构：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/008_skill_port.sql
```

第八个迁移建立 owner 级 `skill_library` 修订、`reply_skill` 目录项和
`reply_skill_version` 不可变版本。SkillPort 只返回当前 owner 的全局 Skill 与当前联系人
专属 Skill 的 active/current/enabled 版本；未知、跨范围、禁用、删除和旧版本统一安全失败。
Skill 管理模块必须在同一事务中递增 owner revision；本迁移和只读 adapter 不提供安装、更新、
启用、禁用、删除或网络读取能力。

继续建立关系记忆候选和已确认记忆的持久化边界：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/009_memory_store.sql
```

第九个迁移建立 `memory_candidate` 和 `confirmed_memory`，保存联系人范围、分类、来源 UUID
列表、候选来源链、采纳方式、状态、有效期和 revision。它不建立 `contact_memory_index`，
不执行自动提取，也不把来源删除任务级联清理伪装成已完成。

继续对齐微信消息类型和可循环复用的来源身份：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/014_import_message_identity.sql
```

第十四个迁移允许已明确适配的媒体消息类型写入规范消息，并将微信来源唯一键统一为
`external_local_id + source_create_time`。未知类型仍由输入适配器拒绝，不直接进入规范消息。

继续保存 owner 的微信渠道身份：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/015_owner_channel_identity.sql
```

第十五个迁移新增 `owner_channel_identity`。它保存 owner 的外部渠道 ID、观察到的展示名称、
验证状态和时间；它与联系人的 `channel_identity` 分开，不能用来替代 `owner_id`。

继续建立导入后台任务和固定步骤：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/016_background_task.sql
```

第十六个迁移新增 `background_task` 和 `background_task_step`。导入事务会按
`owner_id + contact_id + source_document_id` 创建唯一的 `import` 任务，并写入
`parse`、`normalize`、`extract_memory`、`index`、`verify` 五个 pending 步骤。任务只保存
范围、状态、计数、时间和错误分类，不保存聊天正文或模型完整输入输出。

继续建立 Worker 租约和版本元数据：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/017_worker_lease_metadata.sql
```

第十七个迁移把步骤租约字段命名为 `worker_id`，并保存任务使用的模型版本和确定性规则版本；
仍不保存模型输入输出或聊天正文。

继续建立联系人记忆 revision 和确定性目录：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/018_contact_memory_index.sql
```

第十八个迁移新增 `contact_memory_state` 和 `contact_memory_index`。目录最多保存 20 个分类/主题
入口及 `confirmed_memory` UUID，不复制记忆正文；目录版本不一致时必须重建。

继续保存 CLI 会话绑定的匹配证据：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/019_binding_cli_match_metadata.sql
```

第十九个迁移为 `conversation_binding` 增加 `display_name` 映射、`metadata_summary` 匹配证据摘要和
`visual_fingerprint` 可选视觉指纹摘要。证据字段只用于定位当前会话与一次性确认，预览只保存摘要哈希，
不保存原文；已有 active 绑定唯一性约束不变。

继续保存本地微信 CLI 观察来源与联系人级水位：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/020_local_wechat_observation.sql
```

第二十个迁移新增 `local_wechat_observation` 和 `wechat_observation_cursor`。前者保存一次 CLI
只读增量读取的来源元数据（CLI 版本、读取时间、水位区间、`live`/`cli_catchup` 模式和消息计数），
不保存全量导出或消息正文；同一绑定同一水位区间的重复读取由唯一索引保证幂等。后者按
`owner_id + contact_id` 独立保存成功返回的 local_id 与续传 cursor，水位只单调前移，
首次读取没有水位、不使用非法的 `since_local_id=0`。联系人或绑定行删除时按来源级删除路径级联清理。

继续保存前台同步开关状态：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/022_front_sync_state.sql
```

第二十二个迁移新增 `front_sync_state`，按 owner 保存用户手动开启/关闭的前台同步开关。
应用异常重启后仍开启时，生命周期从联系人水位恢复读取；最近一次关闭与开启的时间戳共同界定
手动关闭期间的消息窗口，重新开启后任何联系人读到的窗口内消息都只前移水位、不写入。
owner 删除时开关状态级联清理。

继续建立 Skill Library 的辅助资源和校验结果：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/023_skill_library_resources.sql
```

第二十三个迁移保存版本级校验警告和 `references/assets` 的版本绑定内容。资源只能使用包内
相对路径，删除版本时级联清理；Skill 管理适配器负责在完整校验后原子写入这些记录。

继续保存候选回复实际使用的 Skill 选择与资源加载摘要：

```bash
/opt/homebrew/opt/postgresql@16/bin/psql \
  --set ON_ERROR_STOP=1 \
  --dbname notalone_dev \
  --file database/migrations/024_skill_run_record.sql
```

第二十四个迁移为 `reply_request` 增加 `skill_selection_method`、
`skill_selection_reason`、`skill_load_state` 和 `skill_loaded_resources` 四列。
它们只记录一次回复实际使用的 Skill 版本之外的非正文审计信息（选择方式、选择原因、
加载状态和已读取的辅助资源路径），不保存 Skill 正文、完整 Prompt 或聊天原文；
约束校验字段取值并禁止在没有 Skill 时填写选择元数据。

任务终态清理使用：

```bash
notalone-task-cleanup
```

默认只清理超过 90 天的终态任务和步骤元数据；活动任务、来源、消息、记忆和删除凭证不受影响。

迁移仅建立数据结构，不读取 `chat_exports/`，也不导入真实聊天记录。

首个迁移建立旧版 `owner`、`contact`、`source_document` 和 `message`，第三个迁移在空业务
表上把 `contact.id` 改为 NotAlone 内部 UUID，并新增 `channel_identity` 和
`import_confirmation`。微信 `sender_wxid` 保存在渠道身份中，不再充当 `contact.id`；
第四个迁移让 `message` 只保留通用规范字段，原始单行 JSON 和微信 ID 保存在可随消息级联
删除的 `wechat_message_metadata`。同一用户与联系人下，一个微信
`external_local_id + source_create_time` 组合只能归属一个来源；不同 SHA 文件若包含重叠
消息，正式导入会整批回滚，避免同一消息出现两个权威来源。

来源删除完成后，`source_document` 只保留隔离键、内部来源 ID、来源类型、状态和删除时间。
同一文件再次导入会创建新的来源与确认记录，不恢复旧来源内容。

表和字段均通过 PostgreSQL `COMMENT ON` 保存中文说明。注释只描述通用数据契约，
不得包含真实姓名、微信 ID、聊天正文或凭据。
