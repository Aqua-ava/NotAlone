# 06 — 实现按联系人切换、补读和恢复的 tail 生命周期

Type: task
Triage: ready-for-agent
State: resolved
Blocked by: 02, 03, 04, 05

## What to build

实现当前前台联系人对应的 `tail --follow` 生命周期：启动、停止、切换、切回补读、同步暂停、CLI 失败重试和应用异常恢复。任何时刻只允许当前唯一联系人拥有有效读取任务。

## Acceptance criteria

- [x] display name/选中行元数据变化时先停止旧联系人，再启动新联系人。
- [x] 每个联系人使用自己的 cursor；切回时只补读该联系人并标记 `cli_catchup`。
- [x] 同步关闭、微信非前台、定位失败或 CLI 不可用时停止读取，不退回 OCR 正文。
- [x] 应用重启且同步仍开启时从当前联系人的 cursor 恢复。
- [x] tail 进程退出、超时、重复事件和并发启动都有稳定状态，不创建重复消息。

## Verification

- A -> B -> A 切换隔离测试。
- A 离开期间来消息、切回补读、暂停期间不补读、进程崩溃恢复测试。

## Out of scope

- 不监听所有联系人，不自动滚动或控制微信，不发送消息。

## Answer

已实现当前前台联系人的 tail 生命周期（启动、停止、切换、切回补读、
同步暂停、CLI 失败重试与重启恢复），任何时刻只有当前唯一联系人拥有有效读取任务：

1、新增迁移 022 与 `front_sync_state`：按 owner 持久化用户手动开关；最近一次关闭与开启的
时间戳共同界定关闭窗口，重新开启后任何联系人读到的窗口内消息只前移水位、不写入（对每个联系人
独立生效，修复了单一标记被首个联系人消费后其他联系人误补读的问题）；重启后开关状态可恢复。
2、新增 `src/notalone/front_sync/tail_lifecycle.py`：`TailLifecycle` 由 `observe_front_session`
（同步开关/前台/匹配门禁，只在 CONFIRMED 绑定时启动，先停旧再启新）与 `poll`（一次性增量读取）
驱动；切回从联系人独立水位补读并标记 `cli_catchup`，后续批次回到 `live`；CLI 失败进入带指数退避的
`failed` 状态重试，不退回 OCR；重复启动同一联系人、重复事件由会话幂等与存储层批次唯一索引/稳定消息
身份去重保证不产生重复消息。
3、存储与适配器配套扩展：`observation_store` 新增同事务的 `record_batch_with_messages`（来源、水位与消息
原子写入，崩溃重试幂等）并抽取共享校验与消息写入循环；`LocalWechatCli` 新增 `version()`，`tail` 空输出改为
“无新消息”空结果，`TailResult` 增加含非文字事件的最大 `last_local_id` 以保证水位前移。
4、设计偏差（如实记录）：生命周期采用一次性 `tail` 轮询而非 `--follow` 常驻进程（spec Decision 28 允许
第一阶段先用一次性 `tail`）；进程退出/超时因此表现为每轮读取的稳定错误与退避重试。`--follow` 长进程的
真实行为验证留给 07 端到端接线时评估。

验证结果：

- `conda run -n NotAlone python -m unittest tests.integration.front_sync.test_tail_lifecycle -v`：
  13/13 通过，覆盖 A→B→A 切换隔离、切回补读标记、关闭停读与关闭窗口按时间对两个联系人都跳过、
  非前台停读与回前台补读、重启恢复（开启/关闭两种）、重复事件去重、CLI 失败退避重试、
  无法定位/未绑定停读、重复启动幂等、空轮询保持状态。
- `conda run -n NotAlone python -m unittest tests.integration.persistence.test_front_sync_state
  tests.integration.persistence.test_observation_store tests.unit.wechat_cli -v`：全部通过（含同事务批次幂等、
  开关时间戳语义、适配器新契约）。
- `conda run -n NotAlone python -m unittest discover -s tests -q`：367 通过，2 跳过；
  `compileall` 通过；迁移 022 在 `notalone_dev` 与 `notalone_test` 重复执行幂等。
- 真实 `wechat-cli` v1.6.20 只跑 `--version` 冒烟，未读取聊天内容。

剩余风险：

- 全部验证基于脚本化 fake CLI 与合成数据；真实微信的前台观察驱动（探针证据输入）与 `--follow`
  长进程评估由 07 端到端接线完成。
- 关闭窗口过滤依赖消息原始时间；缺失时间的窗口内消息被保守丢弃，不会误写但也不可见。
