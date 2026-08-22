# 02 — 自动采纳与重复抑制

**What to build:** 通过校验的事实候选经既有 MemoryPort 自动落库：写入 `memory_candidate` 并自动确认为 `confirmed_memory`（采纳方式标 `auto`），带有效期的事实写入 valid_at/invalid_at；与该联系人已有 active 记忆文本重复（规范化比较）的候选跳过；返回提取统计（采纳、跳过、拒绝计数）。

**Triage:** ready-for-agent
**State:** open
**Blocked by:** 01（提取接缝与证据契约校验）

- [ ] 合法候选经 MemoryPort 写入并自动确认，采纳方式为 auto，来源消息引用保留
- [ ] 带有效期候选的 valid_at/invalid_at 正确落库，过期后不再被既有检索返回
- [ ] 同文本重复候选被跳过，二次提取不产生重复 active 记忆（集成测试验证）
- [ ] 自动采纳的记忆可经既有撤销/删除路径移除，移除后检索不可见
- [ ] 提取统计返回采纳/跳过/拒绝计数
- [ ] PostgreSQL 集成测试沿用隔离测试库、随机 owner 与合成数据惯例

## Comments
