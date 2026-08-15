# 实现来源级删除与不可检索验证

Type: task

Triage: ready-for-agent

State: open

## Problem

数据库允许来源进入 `deleted`，但当前代码没有保证关联消息和派生资料已经删除，也没有不可检索验证。

## Acceptance criteria

- 删除请求、执行中、失败和删除完成使用不同状态。
- 只有关联消息及当前已实现的派生数据清除后，来源才能进入 `deleted`。
- 删除操作幂等；失败不留下看似完成的状态。
- 集成测试证明删除后按 `owner_id + contact_id`、来源 ID 和消息 ID 均无法检索对应内容。
- 再次导入同一文件时重新预览、确认并创建新来源，不恢复旧来源内容。

## Comments
