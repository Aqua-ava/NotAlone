# 03 — 自动采纳、置信度门槛与删除指纹

**What to build:** 落库层闭环：通过校验的候选按主体分流（self 入 owner 级、contact/shared 入联系人级）经 MemoryPort 自动采纳标 `auto`；低置信（低于 0.7）候选以 pending 保留不自动入库；入库前查询删除指纹，用户删过的文本永不自动复活；提供消息水位记录以支撑断点重跑；返回提取统计。

**Triage:** ready-for-agent
**State:** open
**Blocked by:** 01（提取接缝与证据契约）、02（owner 级存储与删除指纹字段）

- [ ] 主体分流：self → owner 级，contact/shared → 联系人级，均标 `auto` 带来源
- [ ] 置信度门槛：低于阈值候选 pending 保留，可后续确认或丢弃，不自动采纳
- [ ] 删除指纹：命中已删除文本的候选跳过并计入统计；手动录入不受限
- [ ] 消息水位记录：按联系人保存已提取消息水位，重跑从水位继续
- [ ] 有效期落库：带 valid_at/invalid_at 的事实过期后不被检索返回
- [ ] 提取统计返回提取/采纳/待定/跳过/拒绝计数
- [ ] 集成测试：撤销 auto 记忆后检索不可见；重复提取不产生重复 active 记忆

## Comments
