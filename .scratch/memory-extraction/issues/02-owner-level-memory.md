# 02 — owner 级自我记忆存储与拼接检索

**What to build:** 用户自身事实的独立归属层：新增 owner 级记忆存储（无联系人归属，PostgreSQL 迁移跟随现有序列），主体为 self 的事实写入 owner 级；检索时 owner 级与联系人级两路合并拼接（借鉴 Claude Code 双层拼接，互不覆盖）；来源、采纳标记、删除路径与联系人级记忆同等约束。

**Triage:** ready-for-agent
**State:** open
**Blocked by:** None — can start immediately（与 01 并行）

- [ ] 迁移新增 owner 级记忆表，含来源、分类、主体、采纳方式、有效期、状态与软删除字段
- [ ] owner 级记忆 port 扩展：写入、列出、修正、删除与软删除指纹
- [ ] 检索拼接：同一查询合并 owner 级 self 记忆与联系人级关系记忆，各自带范围与来源
- [ ] 跨 owner 隔离：owner 级记忆按 owner 隔离，集成测试验证不可串读
- [ ] 软删除保留文本指纹，删除后不可检索
- [ ] PostgreSQL 集成测试沿用隔离测试库与合成数据惯例

## Comments
