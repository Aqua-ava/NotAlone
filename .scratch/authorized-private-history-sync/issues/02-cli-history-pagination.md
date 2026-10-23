# CLI 从最早点分页读取

Triage: ready-for-agent
State: open
Type: task
Blocked by: 01

按 [spec](../spec.md) 与 [ADR-100](../../../architecture/adr/100-authorized-private-history-sync.md)，当前 `tail` 在没有 cursor 时只返回最新 N 条，无法读取完整历史。本票在 pinned 只读 CLI 补丁中增加从最早点开始的有序分页与不透明游标续读，并让 adapter 暴露历史分页结果；实时与增量的现有语义保持不变。

## 验收

- [ ] 同一会话可用历史游标从最早一页连续读到最新；`has_more` 与游标语义支持中断重读，不跳过、不重复。
- [ ] `--limit` 被真正传递给 CLI 且有明确边界；分页不依赖单一全局事务。
- [ ] 等时间戳消息的页内与跨页顺序稳定，沿用现有提交顺序与消息身份规则；非文字事件不阻塞后续文字页。
- [ ] 自定义 `username`（非 `wxid_`）的历史分页可用，且与 01 的身份规则一致。
- [ ] 补丁保持 `--strict-read-only`；scripted CLI 与真实 pinned 构建分别验证，adapter 测试通过。
