# 回复生成租约与模型超时矛盾：长生成结果必然被丢弃

Triage: needs-triage
State: open

## 问题

`PostgresReplyStore` 默认 `lease_duration=30s`（`src/notalone/persistence/reply_store.py:70`，start 时写入 `now+30s`），而 `ReplyGenerator.generate` 在 `store.start` 与 `store.save` 之间执行模型调用，全程没有任何租约续期。DeepSeek 模型层单次超时 60s、`max_retries=2`（`src/notalone/reply/adapters/deepseek_provider.py:13,69`），生成超过 30s 时 `save()` 判定租约过期，抛 `ReplyStoreInvariantError("回复请求租约已过期。")`，已生成并通过校验的候选全部丢弃。

## 触发条件

DeepSeek 响应超过 30s（工具调用/长回复场景常见）。

## 现象

- 可用性缺陷：长回复稳定失败、重复计费、用户需手动重试。
- 生产装配 `src/notalone/server/reply_wiring.py:62` 使用默认租约值。

## 为什么测试没抓到

所有测试用瞬时 fake runtime；`InMemoryReplyStore` 租约同为 30s 但生成是同步瞬时的，永远不会跨过租约。

## 候选方向（需要设计决策）

1. 生成期间续期租约（类似 tasks/worker 的 `_LeaseHeartbeat`）。
2. 对齐租约时长与模型超时上限（60s×重试 + 余量）。
3. start 时按请求预算动态计算租约。

涉及回复存储生命周期契约与并发语义，需先定方案再实现。

## Comments
