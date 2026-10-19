# 01: 完整导入业务批写与概览失效

Triage: ready-for-agent
State: resolved

## What to build
交付有界业务批写及语句级 INSERT 概览失效；导入的新增、复用、范围隔离、来源删除与概览一致性保持。

- [x] 新增与重复导入的公开结果正确，跨批及超大行不丢失
- [x] 概览在导入、更新、删除与回滚后正确，必要并发测试通过
- [x] 批量 SQL 保留约束及事务，不使用冲突跳过
- [x] 相关测试、验证命令和本地提交有记录

## Blocked by
None（两路独立，根负责人负责最终集成验证）

## Answer
- 消息、微信元数据、来源引用改为每语句最多 500 行／约 2 MiB 的多行 INSERT；超大单行单独写入，原始内容与事务约束不变，无冲突跳过。迭代构造参数，避免保留三份整批参数列表。
- 新增 089：仅 message/ref 的 INSERT 使用 transition table，按 owner 升序获取既有 owner 锁；保留 owner 全失效、联系人范围及消息/ref/来源/观察 ID 的跨联系人依赖。UPDATE/DELETE 沿用 063 逐行函数。
- 新增 5 个公开行为用例：跨批与 2.25 MB 单行、完整回执和重复导入；后续 ref 失败后业务全部回滚并保留安全失败追踪；概览回滚、跨联系人依赖和无关范围；ref ID/message ID/source ID 闭包；并发概览先提交后被等待写入失效。
- 实际新建隔离库运行 001–088，保留 063 的旧触发器并种入消息/ref/概览。089 故障模拟后 DDL 和账本均回滚；正式升级及重复迁移通过，既有消息与概览逐值不变；临时库精确清理核验通过。
- 验证：从 backend 执行 `PYTHONPATH=src:. NOTALONE_DISABLE_DOTENV=1 PYTHONDONTWRITEBYTECODE=1 perl -e 'alarm 180; exec @ARGV' -- <Conda Python> /tmp/notalone-import-recall-isolated.py`，依次传入 integration.ingest 的 test_import_business_batch、test_source_processing_trace、test_import_command，以及 integration.persistence.test_import_statement_migration、integration.server 的 test_relationship_overview_lifecycle、test_owner_overview_lifecycle（均带 tests. 前缀）。74 项通过，51.461 秒；自有核心库精确清理核验通过。`git diff --check` 通过。
- 性能 red 由统筹版本化完整导入基准固定：1000 条原本 3019 条 SQL、2001 次概览失效。完整性能 green、两路集成、独立双轴审查及真实 dev App 验收由根负责人统一执行；本票不以微基准宣称最终耗时收益。
- 数据影响：只修改导入的语句形态及可重建投影失效方式，不改变来源、正文、回执和删除路径。迁移仅在随机自有测试库验证，未操作业务库；未打包、push 或创建 PR。
