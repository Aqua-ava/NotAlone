# 02 — 出站台账 port 与 PostgreSQL 持久化

**What to build:** 系统具备记录外部模型调用的出站台账：每次真实调用写入一条仅含元数据的记录（时间、供应商标识、模型名、owner/contact 范围、输入与输出 token 数、延迟、结果状态），持久化在 PostgreSQL 并按 owner 隔离可查；台账永不包含消息正文、候选正文或联系人名称。

**Triage:** ready-for-agent
**State:** open
**Blocked by:** None — can start immediately

- [ ] 台账 port 接口定义，附带进程内 adapter 供单元测试使用
- [ ] PostgreSQL 迁移新增台账表，跟随现有迁移序列
- [ ] 写入与按 owner 查询的 PostgreSQL adapter，集成测试使用隔离测试库与随机 owner 惯例
- [ ] 集成测试断言：字段完整、跨 owner 不可见、任何正文类文本字段不存在
- [ ] 台账条目定义为最小操作记录：联系人或来源删除时不级联清除，但保留范围字段供审计（与删除凭证同类的处理）
- [ ] 全部测试使用合成数据

## Comments
