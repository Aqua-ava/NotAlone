# 08 验收阻碍修复：同页消息编号重复时保留独立来源

日期：2026-10-23。合成测试与真实微信证据分别记录；本修复期间真实同步保持关闭。

## 根因与修复

真实只读首批取回后，在独立库中的持久化复现出现 `23505 / message_source_ref_observation_locator_unique`。规范消息已按联系人范围、`external_local_id` 和 `source_create_time` 区分身份，但来源引用仅用 `cli:<local_id>`：同一页内编号相同、时间不同的两条消息因此发生定位冲突，整页及检查点回滚。

新的来源引用使用 `cli:v2:<local_id>:<create_time 或 -1>`；已有来源按 `owner_id + contact_id + observation_id + message_id` 复用，保留原引用 ID、定位及原始资料。缺失时间仍沿用既有 `-1` 去重规则；不吞掉冲突消息，不改账本、迁移或历史来源。处理记录继续按采集 UUID 关联，保留采集定位，另记录实际 `source_ref_locator`，避免同编号的两条采集记录串线。

兼容变更集中在 `observation_store.py` 的内部来源引用写入。四个既有后台来源处理测试补上唯一私聊的合成 `resolve-chat` 响应，以继续验证解析、规范化、持久化失败和来源删除路径。

## 红绿与实际验证

Python 模块命令均在 `backend/`，使用 `PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH"`。本次独立库为 `NOTALONE_TEST_DATABASE_URL=postgresql:///notalone_08_locator_test`；并行测试作者使用单独的 `notalone_08_locator_behavior_test`，没有共用清理事务或接触 `notalone_test`。

- 红阶段：`python -m unittest tests.integration.persistence.test_cli_source_locator_identity.CliSourceLocatorIdentityTest.test_same_local_id_with_distinct_times_keeps_both_messages_and_refs`，报 `ObservationPersistenceError`；独立异常链确认与真实复现同为唯一定位约束冲突。未知时间、已知时间和未知时间重复的批次也复现同类错误。
- 绿阶段：新模块 8 例覆盖同编号不同时间、完全重复身份、未知时间、旧来源重放与新来源复用、采集记录逐条关联、完整历史检查点提交、逐来源删除与联系人隔离、处理记录失败整事务回滚。
- `python -m unittest discover -s tests/unit/ingest -t .`：52 tests 通过。
- 以下有界跨模块命令：129 tests 通过，7.785 秒。

```sh
perl -e 'alarm 120; exec @ARGV' -- python -m unittest \
  tests.integration.persistence.test_cli_source_locator_identity \
  tests.integration.persistence.test_observation_store \
  tests.integration.persistence.test_cli_history_sync \
  tests.integration.persistence.test_cli_pagination_sync \
  tests.integration.ingest.test_source_processing_trace \
  tests.integration.persistence.test_observation_opaque_cursor \
  tests.integration.persistence.test_observation_reply_deletion \
  tests.integration.persistence.test_source_deletion
```

首次四模块 89 例中，五处失败来自合成 CLI 缺少私聊复验候选，单例补齐后恢复通过，最终包含在上面的 129 例中。

扩大到 `tests.integration.memory_extraction.test_extraction_trace` 的一轮共 142 例，出现四个失败断言，集中于三个既有记忆失效/更新用例：`test_committed_invalidation_is_reconciled_after_receipt_fault_and_retry`（两个 subject）、`test_invalidation_plan_does_not_claim_commit_just_because_old_row_exists`、`test_source_of_old_memory_used_by_update_erases_trace_even_outside_new_window`。在单独 Python 进程中用 `git show 337894a7:backend/src/notalone/persistence/observation_store.py` 的原实现替换模块后，仅跑这三个用例仍有完全相同的四个失败；这三项不属于本次来源定位改动引入，未扩大修复范围。该实验不修改工作树或业务库。

本票此前完整 Python 验证已于 600 秒退出 142，过程中有 F/E、没有最终摘要；本修复没有重复整套长等待，也不宣称全量通过。上述合成结果不代表真实微信全历史已经完整。

## 审查与收尾

Standards 独立审查：0 个硬违规、0 个可行动 smell。另一位未参与实现或测试编写的 Agent 完成 Spec 独立审查：0 个可操作问题。两轴范围均为上述生产文件、两个测试文件与本记录，基点为 `337894a7`。

`git diff --check` 通过，`node scripts/check_public_history.mjs --ref HEAD --working-tree` 返回 0 个问题。`notalone_08_locator_test` 和 `notalone_08_locator_behavior_test` 均已删除并确认不存在。真实同步由主 Agent 在本修复提交后继续验收。源代码、合成测试和本记录单独提交，不含主 Agent 的真实验收草稿。
