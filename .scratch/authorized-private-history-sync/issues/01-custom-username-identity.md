# 修复自定义微信号的身份解析

Triage: ready-for-agent
State: open
Type: task
Blocked by: none

按 [spec](../spec.md) 与 [ADR-100](../../../architecture/adr/100-authorized-private-history-sync.md) 修复 pinned 只读 CLI 对自定义 `username` 的错误处理：会话解析失败时它把非 `wxid_` 的 `username` 当显示名，并要求执行会写入缓存的 `cache refresh`。本票让稳定定位标识贯穿会话发现、单会话读取、全局事件触发与查询，不引入昵称匹配，也不放宽只读边界。

## 验收

- [ ] `sessions --type-filter private` 返回的自定义 `username` 可直接用于 `resolve-chat`、`tail <talker>`、`tail --mode sessions` 事件流与查询，不再要求 `cache refresh`。
- [ ] 显示名缺失时可按既有规则回填联系人或备注，但身份判定只使用稳定定位标识，绝不用昵称、备注或显示名。
- [ ] 只读补丁不新增缓存写入；`--strict-read-only` 下仍无任何写操作。
- [ ] 补丁对应用户提供的 pinned 源重新构建，更新补丁与来源锁记录；合成 fixture 覆盖列表、单读、事件流与查询四条路径。
- [ ] adapter 与 CLI 相关单测通过；记录修复前后的命令输出作为证据，真实 24 个失败会话的验收留给 08。
