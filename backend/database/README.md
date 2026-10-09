# 数据库迁移

NotAlone 使用 PostgreSQL 作为权威业务库。安装脚本统一调用逐版本迁移命令，不允许只在图形客户端中手工修改正式表结构。

## App 启动前只读检查

轻量入口只判断机器级条件，不装配业务运行时，不查询联系人或聊天正文。使用所选 Python、项目和明确配置文件执行：

```bash
conda activate NotAlone
NOTALONE_ENV_FILE='/绝对路径/受控配置.env' \
  python -m notalone.startup_diagnostics --migrations database/migrations
```

入口只返回固定 JSON 状态，例如 `{"code":"ready"}`，不回显连接串或底层异常；`ready` 的退出码为 0，其余为 1。数据库连接有界且事务为 READ ONLY，只读必要系统目录、既有审计基线和迁移账本，核对连续迁移文件、checksum 与必要表/列类型。它不调用迁移或旧库接管、不创建参考库、不创建账本，也不检查业务资料完整性、本人身份或模型可用性。

空库或有后续版本返回 `migration_pending`；已有结构缺账本返回 `baseline_missing`，无效审计凭证返回 `baseline_invalid`；基线文件或账本漂移返回 `migration_history_mismatch`；必要结构缺失返回 `schema_incomplete`。这些结果只提供恢复依据，不能授权自动升级现有业务库。App 在首次连接、复用与受控重启前使用该门禁，只有修正条件并明确重试后才连接。

## 执行与恢复

本页命令从 `backend/` 目录执行（从仓库根目录先 `cd backend`）；连接串由环境变量提供，迁移命令不会读取 `.env`：

```bash
conda activate NotAlone
export NOTALONE_DATABASE_URL='postgresql:///notalone_dev'
python -m notalone.database_migrations --migrations database/migrations
```

- 迁移目录只接受受信任的仓库 SQL，按 `001_name.sql` 起连续编号，不接受重复版本。新变更增加新文件，已执行文件不得修改。
- `public.notalone_schema_migration` 保存文件名、SHA-256 和执行时间。一个迁移的 SQL 与版本记录在同一事务提交；失败回滚当前版本，成功版本保留。中断后执行相同命令即可续跑。
- 已记录版本的文件缺失、内容或顺序变化时拒绝执行。并发命令返回 `migration_busy`，连接中断后锁自动释放。
- 历史 SQL 大多带最外层 `BEGIN;` / `COMMIT;`，命令去除该封装后统一管理事务；025 无封装也受同样保护。正文在动态 SQL 块内执行，额外事务控制会被 PostgreSQL 拒绝，不能提前提交。未来迁移沿用现有文件格式，不包含自行提交或必须在事务外执行的操作。
- 本命令不保证跨多个版本整体回滚；已成功版本不会撤销。没有有损的反向迁移，业务库升级前仍需核验数据范围与备份。

## 没有版本记录的旧库

旧安装或曾手工执行 SQL 的库会返回 `legacy_database_untracked`，在创建账本或执行业务 SQL 前停止。仅凭 `owner` 存在无法区分完整安装和中断安装；当前命令不提供自动猜基线或强制跳过校验。

接管旧库必须先核对系统目录、约束、现存资料的来源与隔离契约，并确定备份与恢复方案。不要通过手写一批成功记录、重放 001–035 或删除业务库绕过检查。特别是 003 仅允许空业务表，021 会搬迁数据并删除旧列，不能通用重跑。当前提供下述受限的显式接管入口，不自动猜测其他历史版本。

## 显式接管 035 旧库

只支持 PostgreSQL 16、本机专用业务库，以及固定 001–035 文件清单对应的完整结构。唯一允许的结构差异是 `source_document_source_type_check` 仍只允许 `wechat_jsonl`；该差异在接管事务中补齐为 `wechat_jsonl/manual`。额外对象、其他结构或权限差异、无有效来源消息、跨范围引用、异常记忆证据及绑定/观察范围不一致均拒绝。

默认命令只读核验目标库；参考结构在命令自己创建的空 `_test` 库执行固定前缀后生成，不在旧库重放历史 SQL：

```bash
python -m notalone.database_adoption --migrations database/migrations
```

用户明确批准升级及私人备份后，退出 App、停止同步/Worker 和其他目标库连接，保留总开关与暂停设置，再执行：

```bash
python -m notalone.database_adoption --migrations database/migrations \
  --adopt --backup-dir "$HOME/.notalone/backups/legacy-035-20261001"
python -m notalone.database_migrations --migrations database/migrations
```

- 接管与普通迁移共用 advisory lock；开始、锁表后、恢复核验后和提交前重新核对其他目标库连接，存在时拒绝接管，事务内锁住全部业务表阻止写入。目录复核使用新快照，期间已提交的新对象也会导致回滚。操作期间持续保持 App/Worker 停止。异常后不能在写入已恢复时直接覆盖旧备份，应先评估新资料。
- 备份目录必须在仓库外、为空且权限 0700；`database.dump` 与 `verification.json` 为 0600。使用 PostgreSQL 16 的 `pg_dump` 导出一致快照，再以 `pg_restore --single-transaction --exit-on-error` 恢复到命令拥有的专用受限副本。连接凭据和底层错误不会回显。
- 恢复副本与升级前的完整结构、全部业务表内容 SHA-256 比较通过后才接管；私人行只在本机进程中流式计算，不写日志、不进入模型。恢复副本含私人资料，不能作为合成行为测试库；核验后自动清理该副本，原备份继续保留。目录约束对 PostgreSQL 重建后的规范化输出比对，不依赖原始括号格式。
- `notalone_schema_baseline` 单独记录 035 审计基线、固定文件清单及摘要、前后结构摘要、实际补齐 SQL 摘要和备份恢复凭证。补齐与基线在同一事务提交，业务内容摘要必须保持一致；基线不表示历史 SQL 曾成功执行，也不证明过去的聊天覆盖完整。
- 接管创建空的 `notalone_schema_migration`。普通迁移先验证基线前缀文件未改变，再执行 036 及后续版本；账本只记录这些实际执行的 SQL。混入 001–035 假成功记录或丢失基线凭证都会拒绝继续。重复接管有效基线不再备份或补齐，重复迁移不重放成功版本。
- 备份或接管失败时保留已生成的备份供检查；确认目标库仍未接管后，重试使用新的空受限目录。036 中断只回滚 036，可使用相同原始文件续跑。重新启动 App 前核验身份、资料、绑定和暂停状态均保留；升级不授权删除真实来源。

## 隔离验证

```bash
conda activate NotAlone
python -m unittest tests.integration.persistence.test_database_migrations \
  tests.integration.persistence.test_database_adoption -v
```

测试通过本机 PostgreSQL 创建随机名称且以 `_test` 结尾的专用库，只清理自己创建的库，不接触 `notalone_dev` 或共享测试库。需要本机用户拥有建库权限；用例覆盖全量仓库迁移、重复执行、失败恢复、历史校验、并发互斥和无记录旧库拒绝。

## 历史迁移内容参考

下列内容解释各迁移的作用；旧的逐文件命令已由上述统一入口替代，不能绕过版本账本单独执行。

本地开发数据库：

```text
数据库：notalone_dev
所有者：wy
schema：public
```

首个迁移：

`database/migrations/001_initial_ingest.sql`

第二个迁移：

`database/migrations/002_reject_overlapping_messages.sql`

联系人、来源和消息表为空时，对应联系人身份分离迁移：

`database/migrations/003_separate_contact_identity.sql`

第三个迁移会在旧联系人、来源或消息存在时拒绝执行，不会把旧微信标识静默转换为
NotAlone 内部联系人。执行前必须确认数据范围和备份；本地空开发库可按全部迁移重建。

联系人身份迁移完成后，继续把微信专属消息字段移出通用消息表：

`database/migrations/004_separate_wechat_message_metadata.sql`

第四个迁移会保留已有消息，把微信 local/server id、talker、来源时间和原始 JSON 搬到
`wechat_message_metadata`，再从 `message` 删除这些微信专属列。整个搬迁位于一个事务中；
任一步失败都会回滚到迁移前结构和数据。

增加来源删除状态和最小删除凭证约束：

`database/migrations/005_source_deletion_state.sql`

第五个迁移区分 `delete_requested`、`deleting`、`delete_failed` 和 `deleted`。只有文件名、
SHA 和消息数量已经清空且写入删除时间时，数据库才允许状态为 `deleted`；只改状态会被约束拒绝。

建立已确认桌面会话的持久化绑定：

`database/migrations/006_conversation_binding.sql`

第六个迁移保存稳定绑定 UUID、`owner_id + contact_id`、渠道账号范围、会话定位线索、状态和
最近验证时间。定位线索不能使用昵称或聊天正文替代；绑定撤销后，验证适配器不会再返回
`Ready`。迁移只建立表和约束，不读取桌面会话。

建立候选回复的 PostgreSQL 持久化边界：

`database/migrations/007_reply_store.sql`

第七个迁移保存已验证联系人范围内的 `reply_request`、运行尝试、上下文证据快照、候选、
引用和实际使用的 Skill 版本摘要。幂等键只在 `owner_id + contact_id` 范围内生效；同一请求
的候选和引用在同一事务中写入。迁移不实现 Context、Memory、Skill 目录或外部发送，也不预设
来源删除对回复快照的清理级联。

建立只读 PostgreSQL SkillPort 的目录、版本和修订数据结构：

`database/migrations/008_skill_port.sql`

第八个迁移建立 owner 级 `skill_library` 修订、`reply_skill` 目录项和
`reply_skill_version` 不可变版本。SkillPort 只返回当前 owner 的全局 Skill 与当前联系人
专属 Skill 的 active/current/enabled 版本；未知、跨范围、禁用、删除和旧版本统一安全失败。
Skill 管理模块必须在同一事务中递增 owner revision；本迁移和只读 adapter 不提供安装、更新、
启用、禁用、删除或网络读取能力。

建立关系记忆候选和已确认记忆的持久化边界：

`database/migrations/009_memory_store.sql`

第九个迁移建立 `memory_candidate` 和 `confirmed_memory`，保存联系人范围、分类、来源 UUID
列表、候选来源链、采纳方式、状态、有效期和 revision。它不建立 `contact_memory_index`，
不执行自动提取，也不把来源删除任务级联清理伪装成已完成。

对齐微信消息类型和可循环复用的来源身份：

`database/migrations/014_import_message_identity.sql`

第十四个迁移允许已明确适配的媒体消息类型写入规范消息，并将微信来源唯一键统一为
`external_local_id + source_create_time`。未知类型仍由输入适配器拒绝，不直接进入规范消息。

保存 owner 的微信渠道身份：

`database/migrations/015_owner_channel_identity.sql`

第十五个迁移新增 `owner_channel_identity`。它保存 owner 的外部渠道 ID、观察到的展示名称、
验证状态和时间；它与联系人的 `channel_identity` 分开，不能用来替代 `owner_id`。

建立导入后台任务和固定步骤：

`database/migrations/016_background_task.sql`

第十六个迁移新增 `background_task` 和 `background_task_step`。导入事务会按
`owner_id + contact_id + source_document_id` 创建唯一的 `import` 任务，并写入
`parse`、`normalize`、`extract_memory`、`index`、`verify` 五个 pending 步骤。任务只保存
范围、状态、计数、时间和错误分类，不保存聊天正文或模型完整输入输出。

建立 Worker 租约和版本元数据：

`database/migrations/017_worker_lease_metadata.sql`

第十七个迁移把步骤租约字段命名为 `worker_id`，并保存任务使用的模型版本和确定性规则版本；
仍不保存模型输入输出或聊天正文。

建立联系人记忆 revision 和确定性目录：

`database/migrations/018_contact_memory_index.sql`

第十八个迁移新增 `contact_memory_state` 和 `contact_memory_index`。目录最多保存 20 个分类/主题
入口及 `confirmed_memory` UUID，不复制记忆正文；目录版本不一致时必须重建。

保存 CLI 会话绑定的匹配证据：

`database/migrations/019_binding_cli_match_metadata.sql`

第十九个迁移为 `conversation_binding` 增加 `display_name` 映射、`metadata_summary` 匹配证据摘要和
`visual_fingerprint` 可选视觉指纹摘要。证据字段只用于定位当前会话与一次性确认，预览只保存摘要哈希，
不保存原文；已有 active 绑定唯一性约束不变。

保存本地微信 CLI 观察来源与联系人级水位：

`database/migrations/020_local_wechat_observation.sql`

第二十个迁移新增 `local_wechat_observation` 和 `wechat_observation_cursor`。前者保存一次 CLI
只读增量读取的来源元数据（CLI 版本、读取时间、水位区间、`live`/`cli_catchup`/`cli_background` 模式和消息计数），
不保存全量导出或消息正文；同一绑定同一水位区间的重复读取由唯一索引保证幂等。后者按
`owner_id + contact_id` 独立保存成功返回的 local_id 与续传 cursor，水位只单调前移，
首次读取没有水位、不使用非法的 `since_local_id=0`。联系人或绑定行删除时按来源级删除路径级联清理。

保存前台同步开关状态：

`database/migrations/022_front_sync_state.sql`

第二十二个迁移新增 `front_sync_state`，按 owner 保存用户手动开启/关闭的前台同步开关。
应用异常重启后仍开启时，生命周期从联系人水位恢复读取；最近一次关闭与开启的时间戳共同界定
手动关闭期间的消息窗口，关闭期间不读取，重新开启后把可检测缺口交给后台补齐。owner 删除时
开关状态级联清理。

建立 Skill Library 的辅助资源和校验结果：

`database/migrations/023_skill_library_resources.sql`

第二十三个迁移保存版本级校验警告和 `references/assets` 的版本绑定内容。资源只能使用包内
相对路径，删除版本时级联清理；Skill 管理适配器负责在完整校验后原子写入这些记录。

保存候选回复实际使用的 Skill 选择与资源加载摘要：

`database/migrations/024_skill_run_record.sql`

第二十四个迁移为 `reply_request` 增加 `skill_selection_method`、
`skill_selection_reason`、`skill_load_state` 和 `skill_loaded_resources` 四列。
它们只记录一次回复实际使用的 Skill 版本之外的非正文审计信息（选择方式、选择原因、
加载状态和已读取的辅助资源路径），不保存 Skill 正文、完整 Prompt 或聊天原文；
约束校验字段取值并禁止在没有 Skill 时填写选择元数据。

记录 CLI 后台补齐的可靠位置与覆盖状态：

`database/migrations/029_cli_backfill_state.sql`
`database/migrations/030_cli_observation_reliability_and_progress.sql`
`database/migrations/031_cli_backfill_scheduler.sql`
`database/migrations/032_memory_candidate_subject.sql`
`database/migrations/033_owner_memory_evidence_kind.sql`
`database/migrations/034_extraction_failure_recovery.sql`
`database/migrations/035_extraction_watermark_cascade.sql`
`database/migrations/036_source_deletion_tasks.sql`
`database/migrations/037_pending_candidate_evidence_kind.sql`
`database/migrations/038_memory_candidate_interpretation.sql`

第二十九个迁移新增 `cli_backfill_state`，按 owner、联系人和 active 绑定保存补齐触发、阶段、
计数、可靠游标和失败原因等元数据，不保存聊天正文；绑定或联系人删除时级联清理。第三十个迁移
把观察来源的事件总数、非文字计数和“来源、消息、游标同一事务提交”的可靠标记补入已有观察表，
历史观察默认按不可靠位置恢复。第三十一个迁移增加可持久化的 `paused` 阶段；暂停、失败和无法
确认完整都不能被当作覆盖完成，恢复由用户明确触发。第三十二个迁移让待确认候选持久化
`self/contact/shared` 主体，并为 owner 记忆记录来源候选，保证 self 候选人工确认后进入
owner 级记忆且重复确认保持幂等。第三十三个迁移放宽回复证据表的 `kind` 约束，允许
`owner_memory` 作为独立证据类型进入回复上下文快照。第三十四个迁移为提取水位增加失败
恢复状态：同一失败区间的连续计数、达阈值后跳过的最近区间记录；水位在首次成功推进前
允许为空。第三十五个迁移先清理孤儿水位，再给 `memory_extraction_watermark` 补上随
owner 与联系人级联删除的外键，与 `contact_memory_state`／`contact_memory_index` 的
级联契约对齐。第三十六个迁移给来源删除任务放宽 `background_task` 的任务类型与步骤
约束，允许 `delete` 类型复用固定的删除步骤（标记删除、清理派生数据、清理索引、清缓存、
确认不可检索）。第三十七个迁移放宽回复证据表的 `kind` 约束，允许 `pending_candidate`
作为独立证据类型进入回复上下文快照：它只能带强制未确认标注作为参考，不得当作确定事实，
也不得混入已确认记忆集合；该 SQL 列表与 `src/notalone/reply/context.py` 的
`EVIDENCE_KINDS` 保持一致。

任务终态清理使用：

```bash
notalone-task-cleanup
```

默认只清理超过 90 天的终态任务和步骤元数据；活动任务、来源、消息、记忆和删除凭证不受影响。

迁移会调整结构及已有数据（例如 021 来源回填、035 清理孤儿水位），不读取 `chat_exports/` 或导入外部聊天。

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

## 分支汇总后的迁移顺序

2026-10-09 汇总记忆追踪与桌面分支时，保留记忆分支的 037–043 顺序，将桌面分支原 `037_owner_memory_versioning.sql` 调整为 `044_owner_memory_versioning.sql`，避免同号文件。只在新建随机测试库验证安装与重复执行，没有升级业务库。曾单独应用桌面原 037 的数据库不能直接沿用该版本账本；升级前必须核对实际结构、备份和已执行文件，不得修改账本绕过历史校验。

增量观察任务分支原 `037_observation_background_task.sql` 同样顺延为 `045_observation_background_task.sql`；未执行任何既有业务库升级，曾单独应用原编号的环境需另行核对迁移历史。

`046_background_step_lease_generation.sql` 为任务步骤增加不随重排清零的领取代次，
防止同一 Worker 的旧结果在观察任务下一轮误写。续期保持同一代次；领取递增，
尝试次数及三次失败预算仍独立计算。升级需先停止旧后端／Worker，再按迁移流程应用，
避免旧程序不校验领取代次；本次仅验证随机 `_test` 库，没有升级既有业务库。

`047_observation_memory_enqueue_receipt.sql` 在观察来源增加可空的 `memory_enqueued_at`，
与联系人任务排队在同一事务登记，用于批次去重和运行中新批次的失败恢复。凭证无正文、
不回填旧批次，随观察来源删除；不会扫描存量观察触发提取。本次仅迁移随机测试库。
