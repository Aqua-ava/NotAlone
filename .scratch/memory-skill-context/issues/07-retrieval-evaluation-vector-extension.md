# 07 — 检索评测与向量补充

**What to build:** 用户和维护者能够用合成或匿名化数据评估当前 SQL/全文检索的命中、引用、延迟和 Token 表现；只有评测证明全文不足时，才启用可回退的向量候选路径，并保持相同的联系人隔离和删除语义。

**Blocked by:** 06 — 完整候选回复链路和安全追踪必须先可验证。

**Status:** ready-for-agent
**State:** resolved
**Triage:** ready-for-agent

- [x] 建立覆盖同义表达、确切短语、时间条件、无结果、冲突和跨联系人的合成评测集。
- [x] 记录空结果率、降级率、Top-K 命中、引用纠错率、候选拒绝率、延迟、Token 和 Tool 次数。
- [x] 先评估 PostgreSQL SQL/全文路径；评测结果能明确说明是否需要向量补充。
- [x] 如果评测不证明需要向量，任务可以以评测报告和保留现有路径结束，不强行增加向量服务。
- [x] 如果评测证明需要，向量只作为全文结果的补充候选，由程序合并、去重和排序。
- [x] 向量不可用时回退到 SQL/全文；Embedding 生成、删除和索引重建不改变原始 L0/Message。
- [x] 向量数据遵守与文字相同的 Owner/联系人隔离、供应商审查、留存和级联删除规则。
- [x] 向量能力通过 feature flag 控制，未完成隐私与数据处理评审前不得进入生产。

## Answer

已新增可重复的联系人范围检索评测模块、合成六类用例、PostgreSQL 集成评测和 JSON/Markdown
报告。评测会记录空结果、降级、Top-K、延迟、估算 query Token 和 Tool 次数，并通过匿名回复观察
值记录引用纠错、候选拒绝、回复 Token、回复延迟和 Tool 次数；未运行候选层时报告为 `N/A`。

PostgreSQL SQL/全文路径的 6 条合成用例实际通过：空结果 2/6、Top-K 命中 5/6、降级 0/6、跨
联系人命中 0。纯同义词漏检被标为复评信号，但单次合成结果尚不满足 ADR-005 所需的持续异常指标、
真实反馈和隐私评审，因此不引入向量服务。向量能力默认关闭，开关还要求 provider 配置和隐私评审；
当前无向量 provider，生产仍只走 SQL/全文路径，也没有改变 L0/Message 或删除语义。

详细结果见 `retrieval-evaluation-20260902.md`。验证：`python -m compileall -q src tests`、
`python -m unittest tests.unit.retrieval.test_evaluation tests.integration.persistence.test_retrieval_evaluation`
和既有 `tests.integration.persistence.test_postgres_retrieval` 均通过；测试只使用合成数据，未执行
真实聊天读取、模型调用、外部发送或生产数据库操作。
