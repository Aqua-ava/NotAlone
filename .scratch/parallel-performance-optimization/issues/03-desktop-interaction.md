# 03：桌面输入状态减量与非重叠刷新
Triage: ready-for-agent
State: open

## What to build
长会话输入减少完整历史状态往返，Skill慢请求能结算且空闲少刷新。

## Blocked by
None (can start immediately)。

## Acceptance criteria
- [ ] 输入后立即生成与切换联系人不丢输入，迟到事件不能跨范围恢复。
- [ ] 减少输入期间完整历史复制和双窗口无效广播，以合成负载IPC字节/快照次数证明。
- [ ] Skill自动GET单轮在途，结算后调度；隐藏暂停、恢复刷新，POST及失败写不自动重放。
- [ ] 候选编辑、复制、删除、会话恢复和来源失效行为保留；类型检查及相关React/控制器回归通过。

## Comments
用户已授权此拆分。遵循同目录规格；执行会话独占本任务文件与其责任代码，主会话负责集成和真实桌面。
