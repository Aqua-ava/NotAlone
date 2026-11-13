# 回复生成租约与模型超时矛盾：长生成结果必然被丢弃

Triage: wontfix
State: resolved

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

## Answer

2026-09-18 核实为非 bug，不修。原判断遗漏了 runtime 级硬上限：`LangChainReplyRuntime` 构造校验 `0 < timeout_seconds <= 20`（现提取为 `MAX_GENERATION_TIMEOUT_SECONDS` 类常量），整个生成（含工具循环与结构化输出轮）被 `run_with_timeout` 包住；取消后 `future.result(timeout=seconds + 2)` 兜底，生成墙钟 ≈ ≤22s < 30s 租约。模型层 60s 超时和 2 次重试永远不会成为单次 generate 的墙钟上限。

已补跨模块不变量测试 `test_default_reply_lease_exceeds_generation_cap_with_margin`（tests/unit/reply/test_runtime_limits.py）：默认租约必须大于生成时限上限 + 2s 余量。任一侧调整都会被该测试拦下并要求同步复核另一方。

验证：`python -m unittest tests.unit.reply.test_runtime_limits` 通过。

## Comments
