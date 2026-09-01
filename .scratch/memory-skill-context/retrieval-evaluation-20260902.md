# issue 07 检索评测报告

## 范围与数据

本次评测使用 `synthetic-contact-retrieval-v1`，共 6 条合成用例，覆盖：同义表达、确切短语、时间
条件、无结果、冲突和跨联系人。所有 owner、contact、source 和 message ID 均为随机或固定的合成
标识；报告只保留 case、分类、状态和计数，不保留聊天正文、Prompt 或 Skill 内容。

## PostgreSQL SQL/全文路径结果

执行命令：

```bash
source /Users/local-user/miniconda3/etc/profile.d/conda.sh
conda activate NotAlone
python -m unittest tests.integration.persistence.test_retrieval_evaluation
```

测试会在名称以 `_test` 结尾的 PostgreSQL 数据库中创建随机 owner、联系人、来源和消息，评测后
删除该合成 owner。实际单次运行结果如下：

| 指标 | 结果 |
| --- | --- |
| 用例数 | 6 |
| 空结果率 | 2/6（33.3%） |
| 降级率 | 0/6（0.0%） |
| Top-K 命中率 | 5/6（83.3%） |
| 跨联系人命中 | 0 |
| 检索延迟 | avg 3.7 ms；p50 3.5 ms；p95 5.0 ms（单次样本） |
| 估算检索 query Token | 10 |
| Tool 次数 | 0 |
| 引用纠错率 | N/A：本次只跑 RetrievalPort，未运行模型候选 |
| 候选拒绝率 | N/A：本次只跑 RetrievalPort，未运行模型候选 |

两个空结果中，一个是预期的“无结果”，另一个是纯同义表达 `聚餐` 对消息 `吃饭` 的漏检。确切
短语、时间边界、冲突双命中和跨联系人硬隔离均通过。评测代码还支持注入匿名的回复运行观察值，
用于记录引用纠错、候选拒绝、回复延迟、模型 Token 和 Tool 次数；没有观察值时明确报告 `N/A`。

## 向量决策

本次结果记录为 `re_evaluate_before_vector`，而不是直接启用向量：合成集暴露了同义表达的复评
信号，但当前只有一次合成运行，没有持续异常指标和真实用户反馈，未达到 ADR-005 的升级条件。
因此保留 PostgreSQL SQL/全文路径，不引入 embedding、独立向量库或 reranker。

向量开关默认关闭，并且只有“请求开启 + provider 已配置 + 隐私评审通过”同时满足时才会被视为可用；
当前没有向量 provider 实现，故生产代码不会读取或生成向量。未来若触发复评，向量只能作为 SQL/全文
结果的补充候选，先按相同 `owner_id + contact_id` 和来源状态硬过滤，再回到权威 `message` /
`confirmed_memory` 行；Embedding、删除和索引重建不得修改 L0/Message。接入前还必须完成供应商、
留存、删除和级联清理评审。

## 可重复验证

```bash
source /Users/local-user/miniconda3/etc/profile.d/conda.sh
conda activate NotAlone
python -m unittest tests.unit.retrieval.test_evaluation
python -m unittest tests.integration.persistence.test_retrieval_evaluation
python -c 'from notalone.retrieval.evaluation import main; raise SystemExit(main(["--json"]))'
```

默认评测命令只在内存中运行合成夹具；PostgreSQL 集成命令才验证实际 SQL/全文适配器。没有执行
真实聊天读取、真实模型调用、外部发送或生产数据库操作。
