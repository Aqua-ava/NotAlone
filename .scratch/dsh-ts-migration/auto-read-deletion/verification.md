# 正式工作树合成验收
- 根已统一应用候选109、Python生产者/消费者、TS消费、cli_sync计数、隐私文档及严格门禁。
- migration109、四个Python存储文件和维护版测试与冻结草案逐字一致。
- 单用例：`PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH" python .scratch/dsh-ts-migration/auto-read-deletion/verify-live.py tests.integration.persistence.test_auto_read_suppression.AutoReadSuppressionTest.test_history_checkpoint_counts_only_accepted_messages`：1/1。
- 聚焦：同runner传 `tests.integration.persistence.test_auto_read_suppression.AutoReadSuppressionTest tests.integration.front_sync.test_cli_sync_accepted_count.CliSyncAcceptedCountTest`：16/16，0失败/错误/跳过，0.76秒。
- 相关：同runner传 `tests.integration.persistence.test_observation_store.PostgresObservationStoreTest tests.integration.persistence.test_source_deletion.PostgresSourceDeletionRepositoryTest tests.integration.persistence.test_managed_update_backup_deletion.ManagedUpdateBackupDeletionTest`：50/50，0失败/错误/跳过，10.62秒。
- 关键行为：排队即抑制、新capture/历史/重绑不复活、多来源保留、失败原子回滚、并发实际等锁、原始与独立收据清除、混合页事件位置/时间、历史与增量接受计数、显式导入独立新来源、contact/owner级联、受管备份门禁。
- 每次自建随机notalone_guard_live_*_test库，finally删除本库；临时managed目录自动清理。备份测试自有合成库由原fixture收尾。无真实.env、私人资料、模型或微信调用。
- 双轴与最后历史计数窄复核见review.md；DSH依据见dsh-verification.md。
- 数据影响：新增最小无正文稳定身份表；仍属私密范围数据。不回填已经丢失稳定身份的历史删除，不清理用户外置副本；不新增恢复历史能力。
- 未执行App/打包/push；正式升级门禁由根16/16验证，TS最终消费由19完成5+23项、tsc0及官方profile4项验证。本票产品已分别以7f4a1729、998ec226本地归档。

- 本地提交：根已创建`7f4a1729`，包括109/Python保护/严格门禁/12+4测试及cli_sync三处计数和fake。根导出完整暂存树后独立16/16通过，证明该提交不依赖19未提交移交代码；首次runner缺managed目录被门禁拒绝，补齐临时目录后通过，产品门禁未放宽。TS消费已以998ec226归档；其独立暂存树验证、tsc和公开扫描通过。19整票共享接线及App不由本票签收。
