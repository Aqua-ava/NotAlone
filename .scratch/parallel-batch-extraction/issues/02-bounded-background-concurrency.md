# 模型优先级控制支持有界后台并发

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: none

按 [spec](../spec.md) 与 [ADR-099](../../../architecture/adr/099-parallel-batch-extraction.md) 把模型优先级控制的后台许可从单一闸门扩展为可配置的有界并发，默认 1 保持现状。前台请求不抢占在途调用，但会阻止新的后台调用；前台结束后后台继续；停止信号唤醒所有等待者。

## 验收

- [ ] 后台并发上限为 3 时，3 个后台调用可同时在途，第 4 个等待。
- [ ] 前台请求到达后不再发起新的后台调用；在途后台调用不被抢占；前台结束后等待者恢复。
- [ ] 停止事件唤醒全部等待者，退出不被卡住；释放许可后不再接受新调用。
- [ ] 默认上限 1 时行为与现状一致；原有优先级与租约复验用例全部通过。

## Comments

## Answer

`ModelPriorityControl` 后台许可由单一布尔改为有界计数：新增 `background_limit` 参数（默认 1，非法值抛错）与只读属性；`background_call()` 在前台等待/活跃或在途数达到上限时等待，退出即释放并唤醒等待者；`foreground()` 仍等所有在途后台调用释放后进入；`wait_for_foreground()`、线程本地租约复验与停止语义不变。

新增 5 个用例：三路在途且第 4 个等待、前台不抢占在途但阻止新后台调用、停止唤醒全部等待者、默认上限 1 保持单许可、非法上限拒绝。

验证：
- `python -m unittest tests.unit.application.test_physical_model_scheduling` → 15 tests OK（原 10 + 新 5），并发用例重复 10 次稳定。
- 全量 `tests/unit` 失败集合与改动前完全一致，本票未新增失败。
- 装配层以 `background_limit=<并发度>` 接入并做 1~4 校验留待 04。

