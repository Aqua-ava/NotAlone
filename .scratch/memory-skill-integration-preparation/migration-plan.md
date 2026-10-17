# 迁移兼容、资料影响与恢复提案

> 本页保留首轮M1/S迁移分析。M2未改变迁移链，059–068映射仍成立；现行决定是保留main前缀，并保留S分叉库、不迁移清理。下文可丢弃/接管路线只是历史选项，当前没有相应执行任务。最新规格见[spec.md](spec.md)。

本页只分析固定M/S，不执行SQL，不判断任何实际业务库处于哪个版本。迁移和业务资料升级是两件事，不能用工程签收代替目标库授权。

## 当前迁移合同

M与S的 `backend/database/migrations/001–057` 文件名及原始字节相同。`database_migrations.py`、`database_baseline.py`、`database_adoption.py`、`startup_diagnostics.py`两侧也相同。全部SQL身份见[migration-index.tsv](migration-index.tsv)，没有单独的最终schema.sql可代替迁移历史。

`S:backend/src/notalone/database_migrations.py:32–50`要求从001起连续且每号唯一，并对原始字节计算SHA-256；`:96–106`核对已执行完整前缀的文件名及checksum；`:112–127`使每份SQL及其账本同事务。失败只回滚当前版本，之前成功版本保留。当前工具不支持合并分叉迁移历史，也不提供整批down。

M `058_assistant_prepared_context.sql:3–13`新增 `assistant_session_turn.prepared_context jsonb`，输入清空或state变为redacted/unavailable时触发清空。S另有 `058_memory_correction_protection.sql` 并延续至067。两个058放进同目录将被loader拒绝为 `migration_files_invalid`；单纯给S移号会让已应用S067的账本出现 `migration_history_mismatch`。即使SQL字节不变，文件名和编号仍不匹配。

## 建议canonical目录

建议保留M001–058原字节，把S新增SQL按原顺序追加059–068。下表仅为提案，文件尚未改名；真正集成时若main增加新迁移，需要重新冻结并分配连续末号。

| S源文件 | 提议文件 | 结构/资料影响及真实依赖 |
| --- | --- | --- |
| `058_memory_correction_protection.sql` | `059_memory_correction_protection.sql` | 纠错决定表、候选证据与无正文erased_guard；依赖既有owner/contact/candidate；后续概览触发器引用它 |
| `059_memory_events_and_version_evidence.sql` | `060_memory_events_and_version_evidence.sql` | candidate/confirmed/owner的event、后两者version_evidence；旧NULL不回填；与新版本原子写入及独立事件核验一起交付 |
| `060_relationship_overview_projection.sql` | `061_relationship_overview_projection.sql` | 无正文scope/manifest/摘要/修订及失效trigger；直接依赖源058纠错表，语义依赖源059事件/版本 |
| `061_owner_memory_revision.sql` | `062_owner_memory_revision.sql` | owner_memory_state、既有owner修订初值0及写入触发器；0不代表资料数量或真实性 |
| `062_expression_preferences.sql` | `063_expression_preferences.sql` | 显式偏好、动作回执、回复/样本依赖及request修订；来源/偏好删除闭包必须同批可用 |
| `063_skill_learning_drafts.sql` | `064_skill_learning_drafts.sql` | 授权、草稿、批次/消费回执、方法身份、新任务/步骤及task复合唯一键；默认学习关闭 |
| `064_memory_upgrade_batches.sql` | `065_memory_upgrade_batches.sql` | 升级工作/批次/操作及约束；直接依赖源063提供的task复合父键/步骤集合，并有trace复合外键 |
| `065_skill_review_publication.sql` | `066_skill_review_publication.sql` | 对照、审核操作、调用台账关联、发布范围及方法；直接依赖源063草稿；旧Skill `review_origin=false` |
| `066_skill_history_operations.sql` | `067_skill_history_operations.sql` | Skill/版本复合唯一键及范围化历史操作回执；供下一份政策表使用 |
| `067_skill_scope_policies.sql` | `068_skill_scope_policies.sql` | owner/contact/scene停用政策、revision及回执；直接依赖源066的Skill复合唯一键 |

SQL定位：S058:19–55；S059:110–119；S060:73–91、130–159；S061:2–33；S062:4–70；S063:3–23、47–105；S064:4–22、43–86；S065:2–3、10–96；S066:4–18；S067:4–31。完整路径均在 `backend/database/migrations/`。

两侧058未发现同名数据库对象冲突；编号/账本冲突与组合运行时语义需要分别处理。不能因为SQL对象不冲突就绕过历史校验。

移号还影响硬编码测试前缀、末号、文件名及说明：`test_database_migrations.py:80–119`、`test_database_adoption.py:314–346`、`test_expression_preferences_upgrade.py`、`test_skill_learning_upgrade.py`、`test_memory_upgrade_migrations.py:19–55`、`test_skill_review_upgrade.py:18–25`、`test_owner_overview_upgrade.py`、`test_relationship_overview_upgrade.py`。需逐个核对其历史边界意图，不能机械加1后宣布M058前向已覆盖。源验证记录保留原编号，另附canonical映射，不能改写成原轮执行了新编号。

## 不同数据库起点

| 起点 | 可行路径提案 | 必须拒绝的捷径 |
| --- | --- | --- |
| 新空库 | 最终canonical 001–068全量建立，再重复无新增；逐表/约束/trigger验证 | 双058、跳号、手工只执行个别SQL |
| 受管M058库 | 先确认确为M原前缀，再经单独目标范围授权、停App/Worker/同步写入、受限备份及恢复演练后追加059–068 | 覆盖M058、修改旧checksum、只按结构猜已执行历史 |
| 已应用S067的合成开发库 | 若明确可丢弃，另建canonical合成库；旧库保留，清理另按实际归属处理 | 未确认资料可丢弃就drop；重放S全部SQL或改账本 |
| 已应用S058–067且资料必须留存 | 单独设计分叉历史审计接管/差异转换；保留原文件清单与历史凭证，验证实际结构/资料/来源合同与恢复 | `UPDATE notalone_schema_migration`伪装canonical已执行；套用035 adoption |
| 现行035审计基线库 | 保留原035基线manifest，实际账本仍从036起；后续只追加canonical真实SQL | 补造001–035执行记录；把035审计凭证当作S分叉转换凭证 |

当前 `database_baseline.py:10,54–79`的接管只接受固定035基线，不能接管S067。若选择反向canonical（保留S058–067，把main准备SQL追加068），只是换成main既有058库不兼容，并不能同时兼容两种账本。

本轮未查实际业务库版本，也未调查S库是否可丢弃；这是下一轮真实数据操作前必须明确的信息，不影响先在新合成库验证集成。

## 新资料和删除闭包

新增SQL主要建立结构和初始目录，不会重提取历史消息或执行用户资料升级。旧event/version_evidence为NULL保持未知；旧Skill不补成已审核；学习默认关闭；升级工作不会自行移动提取水位。开关默认与实际运行配置仍要分开核验。

必须随对应写入路径交付的删除链包括：

| 固定S实现证据 | 删除与恢复要求 |
| --- | --- |
| `persistence/source_memory_erasure.py:25–78`、`memory_correction.py:767–790` | 清纠错正文、证据及快照；只有仍有效规范消息需要时才保留无正文erased_guard；派生版本不能借另一来源保留被删正文 |
| `persistence/skill_learning.py:323–365` | 草稿策略、私人依据、世代、批次摘要和回执digest一起擦除，取消相关任务 |
| `persistence/skill_review.py:342–392` | 清对照输入/结果；禁用受影响发布版本，清策略/资源/方法正文，递增目录修订并清跨联系人广范围使用副本 |
| `persistence/memory_upgrade.py:435–452` | 同删除事务清比较、提取、批准应用回执及追踪，重启后旧apply不能复活 |
| `persistence/contact_deletion.py:19–39`、`assistant_session_deletion.py:44–45` | 先清跨范围工作副本及偏好闭包；会话删除清学习副本；主动保存样本按ADR-044独立留存。源分支尚无联系人整体删除HTTP入口，不能把helper测试称作该端点验收 |
| M `assistant_prepared_context.py:48–92`、M058清空trigger | 新偏好/导航/历史/政策依赖必须覆盖固定JSON，准备后执行前删除仍清除。仅有trigger不能证明新闭包完整 |

上述persistence路径均位于 `backend/src/notalone/persistence/`。来源世代还涉及 `correction_evidence.py:18–98`、`skill_learning_generation.py:13–60`、`memory_upgrade_generation.py:10–42,66–129`，应复验message/ref/source、原窗口、已参与记忆/样本/偏好和trace，不能只检查UUID存在。

注意 `startup_diagnostics.py:14–36,106–119`的必要表/列清单未覆盖本批所有新增结构；`ready`只证明它实际检查的门禁及历史前缀，不能替代新表/外键/trigger/数据合同验收。

## 回退、恢复与业务撤销

1. **迁移失败**：当前版本SQL与账本同回滚，之前成功版本保留；查明失败后前向续跑。不存在自动整批down，不手删表/约束/账本来制造回退。
2. **尚无新资料写入**：只有经过隔离验证并确认删除与旧代码兼容，才可能讨论配套二进制回退；不能仅看新增列向后兼容就判断安全。
3. **已经产生新草稿/审核/偏好/升级副本**：不默认允许回退到M旧程序。旧删除路径不认识这些副本，可能绕过新政策或留下应删内容；优先保持新删除闭包并修复前向版本。
4. **完整备份恢复**：单独明确停写、备份时间点、配套代码、允许损失范围和恢复后验证。恢复旧备份可能带回已删资料，需处理备份后的删除决定/凭证与重放策略；本轮没有设计或执行业务恢复。
5. **业务升级撤销**：S `memory_upgrade_apply.py:114–163`只撤销本批实际自动写入且当前digest/revision仍一致的资料，不覆盖后续人工决定；这是产品动作，不是schema降级。Skill合法回滚也仍受来源删除和停用约束。

下一轮至少验证新库、固定M058合成前向、重复/故障恢复、S分叉拒绝、035基线保留及新闭包并发删除。完整标准见[验证矩阵](validation-matrix.md)。这些均为待执行项，本轮没有迁移测试或恢复演练结果。
