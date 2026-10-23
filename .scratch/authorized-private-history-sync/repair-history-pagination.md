# 08 验收阻碍修复：历史分页位置与写入失败退避

日期：2026-10-23。此记录只描述合成回归与实现核验，不代替真实微信验收。

## 问题与修复

- 历史页按微信排序位置续读，跨页 `local_id` 可以回落。历史引擎误传 `cursor_ordered=False`，使存储入口把有效后页当成倒退水位拒绝；改为与不透明分页位置一致的校验，仍不直接推进增量游标。
- 写入失败保留 `syncing`，但原退避判断只覆盖 `incomplete`，当前联系人优先排队可以绕过退避；现对所有未完成历史状态检查退避，成功提交一页后解除该绑定的退避。
- 不修改既有迁移、账本、业务资料或检查点，不改变授权范围，不发送消息。

## TDD 与验证

统一使用 `PATH="$HOME/miniconda3/envs/NotAlone/bin:$PATH"`。集成验证指定 `NOTALONE_TEST_DATABASE_URL=postgresql:///notalone_08_history_test`，由本次创建并执行正常迁移，未使用共享 `notalone_test`。

1. 在 `backend/` 执行 `python -m unittest tests.integration.persistence.test_cli_history_sync.HistorySyncPersistenceTest.test_restart_continues_history_when_next_page_local_ids_are_lower -v`：红阶段第二页实际提交 0、预期 50；修复后通过。场景为首个检查点 `local_id:149`，重启后后页到 `local_id:50`，最终 100 条、2 页且完整。
2. 在 `backend/` 执行 `python -m unittest tests.unit.front_sync.test_cli_history_sync.HistorySyncEngineTest.test_history_write_failure_keeps_backoff_when_priority_requeues_it -v`：红阶段一秒后又读取（调用 2 次、预期 1 次）；修复后通过，退避到期恢复并继续后页。
3. `python -m unittest tests.unit.front_sync.test_cli_history_sync tests.integration.persistence.test_cli_history_sync -v`：36 tests 通过。
4. `python -m unittest discover -s tests/unit/front_sync -t . -v`：253 tests 通过。
5. 仓库根执行 `perl -e 'alarm 600; exec @ARGV' -- python -m unittest discover -s backend/tests -t backend`：600 秒触发上限，退出码 142；过程中已有 `F/E`，未取得最终摘要，不宣称全量通过。日志保留在临时目录，未重复全量。
6. `git diff --check` 通过；`node scripts/check_public_history.mjs --ref HEAD --working-tree` 检查 `issues=0`。
7. 全量退出后删除本次独立 `notalone_08_history_test`，查询确认已不存在。

## 两轴审查

- Standards：独立审查未发现仓库硬规则违反或可行动的设计问题。
- Spec：独立审查未发现排序游标、退避及此修复范围的缺失、越界或实现错误。

## 真实证据边界

真实环境有 71 个 `syncing` 绑定停滞，其中 17 个已有历史页、54 个尚无已提交页。本修复证明跨页编号回落是一处确定错误，不能据此断言已解释所有真实停滞。独立诊断对一个已确认私聊的零页绑定读取、规范化和参数校验均成功；随后在隔离库复现该页实际事务，遇到 `message_source_ref_observation_locator_unique` 冲突并整页回滚。该来源定位冲突另行修复；真实全历史、重启恢复与删除后不恢复仍由票 08 单独记录。
