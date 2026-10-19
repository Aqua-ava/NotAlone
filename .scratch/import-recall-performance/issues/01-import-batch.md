# 01：导入追踪批量核验与分块写入
Triage: ready-for-agent
State: open

## What to build
在原事务中减少长历史导入追踪查写，保持完整来源收据、顺序、撤销和删除安全；交付真实 PostgreSQL 前后对照数据。

## Blocked by
None (can start immediately)。

## Acceptance criteria
- [ ] 同范围捕获 UUID 分块查墓碑，多行参数化写入；普通 1000 条保存路径目标 2001→4 条业务 SQL，额外锁/来源 SQL 另计。
- [ ] 顺序、收据优先级、重复 locator、重复导入、空批次、大单条及规则读取合同保持。
- [ ] 后续块/序列化失败整批回滚；双连接写入与删除/撤销交错不恢复旧正文，必要锁修正有真实证据。
- [ ] 相关导入/同步/追踪/来源删除回归通过；原始与实现相同 100/1000/10000 负载报告 SQL、耗时、内存及同步/往返的真实测量边界。

## Comments
用户已授权实施。责任代码：source_processing、必要 postgres_repository/observation/删除及绑定锁边界和相关测试。规则摘要不缓存，跨范围先报告；不得修改协调 main 或原工作区。最终追加 Answer、真实命令/数据影响/风险，验证后本地提交并标记 resolved，不 push。
