# 关闭窗口生命周期缺陷族：永不过期、重复 enable 非幂等、绑定重建丢水位

Triage: needs-triage
State: open

## 背景

深度审查发现三个同属"reliable/baseline/窗口恢复语义"家族的边界缺陷（2026-09-18 只读审查，基于 HEAD f3ccca7）。

## 缺陷 1：关闭窗口永不过期，FAILED/INCOMPLETE 补齐被每个安全对账周期强制重置

- `_disabled_window`（`src/notalone/front_sync/cli_sync.py:878-888`）：只要 `enabled_at > disabled_at` 就返回窗口；进程内发生过一次 disable→enable 后，开启的整个生命周期窗口恒存在。
- 防重开守卫（`cli_sync.py:1117-1128`）要求 `disabled_window is None` 才生效，重开一次后永不生效。
- `ensure_started(trigger_at=enabled_at)`（`cli_sync.py:1154-1195`）+ `backfill_state.py:239-245`：trigger_at 相等且 phase ∈ {FAILED, INCOMPLETE} → 重置为 GAP_DETECTED 并清零计数。
- 后果：每 ~15s 安全对账无限循环"重置 GAP→BACKFILLING→拉起 CLI tail→失败→INCOMPLETE"，审计计数每轮清零，状态反复跳变。

## 缺陷 2：重复 enable 不幂等，扩大关闭窗口，旧前台引擎丢弃已开启期间的消息

- `persistence/front_sync_state.py:104-121`：`_set_enabled` 无条件 `enabled_at = now()`，即使本已 enabled。
- `tail_lifecycle.py:660-667,670-687,496`：skip_window=(disabled_at, enabled_at]，窗口内消息永久过滤且水位仍前移（丢弃不可恢复）。
- 触发：T1 enable → T2 disable → T3 enable → T4 再次 enable（双击/冗余调用）→ T3–T4 之间同步已开启时收到的消息被旧前台引擎永久过滤。

## 缺陷 3：绑定重建后 reliable cursor 缺失 → cursor 删除 + 新 baseline=now，两个水位之间的消息永久丢失

- `cli_sync.py:1077-1088`：`revoke_binding` + 重建绑定产生新 binding_id；`read_reliable_cursor` 按 binding_id 过滤查不到旧观察 → reliable=None → `rewind(target=None)` 删除联系人 cursor（`observation_store.py:329-336`）。
- `cli_sync.py:923-935`：随后用新绑定 read_baseline → None → `ensure_baseline(baseline_at=now)`。
- 后果：旧水位与重建时刻之间的消息既不会被读取，水位证据也被销毁。

## 为什么测试没抓到

- 缺陷 1：相关测试在 sync_state 无时间戳（窗口=None）下断言；`test_backfill_failure_is_visible_and_not_complete` 虽设窗口但失败后即结束，没跑下一个 sweep。
- 缺陷 2：`test_repeat_toggle_moves_only_matching_timestamp` 只覆盖重复 disable；无"重复 enable 后 skip_window 推导"用例。
- 缺陷 3：`test_stale_cursor_rewinds_to_last_reliable_position_before_tail` 只覆盖"存在可靠游标"的回退；无绑定重建场景用例。

## 候选方向（需要设计决策）

1. 窗口语义改为"每次 disable→enable 只有一个有限窗口"（disable 后再次 disable 才延长）。
2. `_set_enabled` 已 enabled 时保持原 enabled_at（幂等）。
3. rewind 到 reliable=None 时保留 cursor 或改用旧 baseline 而非 now；或 reliable cursor 查询放宽到 contact 级证据。

## Comments
