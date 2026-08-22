# 02 — 出站台账 port 与 PostgreSQL 持久化

**What to build:** 系统具备记录外部模型调用的出站台账：每次真实调用写入一条仅含元数据的记录（时间、供应商标识、模型名、owner/contact 范围、输入与输出 token 数、延迟、结果状态），持久化在 PostgreSQL 并按 owner 隔离可查；台账永不包含消息正文、候选正文或联系人名称。

**Triage:** ready-for-agent
**State:** resolved
**Blocked by:** None — can start immediately

- [x] 台账 port 接口定义，附带进程内 adapter 供单元测试使用
- [x] PostgreSQL 迁移新增台账表，跟随现有迁移序列（010_outbound_ledger.sql）
- [x] 写入与按 owner 查询的 PostgreSQL adapter，集成测试使用隔离测试库与随机 owner 惯例
- [x] 集成测试断言：字段完整、跨 owner 不可见、任何正文类文本字段不存在
- [x] 台账条目定义为最小操作记录：联系人或来源删除时不级联清除，但保留范围字段供审计（与删除凭证同类的处理）
- [x] 全部测试使用合成数据

## Comments

- 2026-08-22 完成。实现：`notalone/ledger`（models/ports/adapters）+ `persistence/outbound_ledger.py` + 迁移 010。
- code-review 修复：统一 `list_by_owner` 契约为按调用时间排列（原 port 写"写入顺序"与 PostgreSQL 实现矛盾）；删除不可达异常分支；补齐测试类型标注；新增表列集合断言与"删除联系人后台账存续"测试。
- 设计决定：台账表不与 contact 建外键（最小操作记录语义，删除不级联）；`entry_id` 由领域侧生成。
- 验证：台账单测 7 + 集成 8 全绿；全量 175 测试仅 1 个既有失败（memory validity window，基线复现，与本任务无关）。测试库 notalone_test 因旧 schema（contact.id 为 text）已重建并应用 001–010。
- 剩余：无。接线真实调用属任务 03。
