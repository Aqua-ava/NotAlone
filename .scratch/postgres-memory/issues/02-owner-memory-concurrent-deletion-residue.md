# 并发来源删除 × 提取 worker：owner 记忆创建绕过来源校验，留下引用已删消息的残留

Triage: needs-triage
State: open

## 问题

来源删除事务只能取消后台任务步骤（`src/notalone/persistence/source_deletion.py:107-112`），停不掉正在运行的提取 worker。删除提交后：

- 联系人级事实写入会在 `create_candidate/confirm` 的 `_ensure_active_sources` 处 `PermissionError`（防线有效，但批次以 `worker_step_failed` 永久失败）。
- **self 事实走 `owner_memory.create`**（`src/notalone/memory_extraction/adoption.py:349-367` → `src/notalone/persistence/owner_memory_store.py:60-91`），只持 owner 锁、完全不校验 `source_ids` 指向的消息/来源是否仍存在。

后果：删除提交后继续批次的 SELF 事实照常落库，`source_ids` 引用已删消息；`cleanup_derived_data` 已经跑完，无人再清理这条新行——留下一条跨联系人可见（`search_owner_memories` 按 owner 检索）、引用已删消息 id 的 active owner 记忆。极端时序下还可能复现用户刚删掉的文本（`deleted_texts` 是批次开始时读取的）。这触碰"来源删除不留残留"的产品硬边界。

## 触发条件

CLI worker 正在提取某联系人时，用户经 server（`delete_source` / `delete_observation`）删除同一联系人的来源/观察。

## 为什么测试没抓到

`tests/integration/persistence/test_source_deletion.py`、`test_source_reply_deletion.py` 全部单线程；没有"删除提交后 worker 继续写 owner 记忆"的并发用例；`PostgresOwnerMemoryStore` 的单测也不校验来源。

## 候选方向（需要设计决策）

1. `PostgresOwnerMemoryStore.create` 在 owner 锁内校验 `source_ids` 全部指向 active 来源，失败抛领域错误（与 `_ensure_active_sources` 对齐）。
2. 提取 runner 在写 self 事实前重读删除状态（双重校验）。
3. owner 记忆创建改为复用 contact 事实路径的来源校验逻辑。

## 关联发现（同次审查，低优先级）

- `_failure_info`（`src/notalone/tasks/worker.py`）未把 `MemoryPersistenceError`/`OwnerMemoryPersistenceError`/`WatermarkPersistenceError`/`LedgerPersistenceError` 及 psycopg `OperationalError` 归类为可重试；提取中一次 DB 抖动即永久 FAILED，自动重试对基础设施故障失效。
- 批次跳过恢复的连续计数只比较 `from_message_id`（`memory_extraction/command.py:184-203`、`recovery.py:64-71`）；批次边界变化后坏批次永不达阈值，提取卡在同一水位。
- `_pending_exists` 要求 source 集完全相等（`adoption.py:316-329`）；相邻批次上下文重叠时同一事实产生重复 pending 候选。
- 裁决返回 `update` 但缺 `replaced_memory_id` 时静默降级为 ADD（`adoption.py:150-158`），被取代的旧记忆保持 active，两条矛盾记忆并存。

## Comments
