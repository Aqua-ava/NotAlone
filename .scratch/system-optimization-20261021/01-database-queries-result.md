# 01 数据库分页与进度查询结果

State: resolved

## 交付与范围

- 基线：`681fcc38eab77c8fe149b76705419971f3750a86`（产品为 `abd65e6c`，前者只补规划）。分支：`codex/database-query-optimization`；受管工作树名称 `database-query-optimization/NotAlone`，未修改共享主仓。
- 首个产品提交：`e56bb6fb6247e199f65560ed45b9110fe34517fe`；重号排序、最终证据及状态在同分支后继提交中。目标工具已真实建立无预算目标，并核验为 active；全部完成后才置 complete。
- 新迁移 `099_message_page_indexes.sql` 新增消息 `occurred_at DESC NULLS LAST, id DESC` 索引及同 owner/contact 的引用 server ID 索引，保留旧时间索引。只在合成库执行，未迁移业务库。
- 进度读取将逐任务来源 SELECT 合入 CASE/EXISTS；与提取和恢复共用来源规则。无效来源仍占原分页位置、返回 `source_unavailable` 且不可恢复；没有过滤后补位，没有新增正文读取、缓存或后台工作。
- 独立审查发现旧 SQL 对 server ID 重号目标没有 tie 次序，索引变化会改变展开顺序，重号多于页长时甚至改变目标子集。已新增外层 `target.id ASC NULLS LAST`，仍保留全部联接目标和外层 `limit+1`。这是对旧任意次序的确定化，不能宣称原主线重号顺序原样保持；现在相同完整 SQL 在无／有索引时逐行、同序相等。

## 对照方法与原始结果

- [正式原始样本与计划](database-comparison.json)；[实现前复现](database-baseline.json)。源码、输入、SQL、基准脚本 SHA-256 均在正式结果中；基准脚本为 `backend/benchmarks/database_queries.py`，候选索引定义读取实际迁移后的 `pg_indexes`。
- PostgreSQL 临时实例采用独立 Unix socket、空库和完整 099 迁移；120000 条全合成消息、5 联系人、101 任务，含 NULL、同时间与三重号目标。无业务库、外部模型或私人夹具。
- 共享 `fcntl` 锁 `/tmp/notalone-optimization-benchmark.lock` 串行计时；13 轮、每模式先预热，前后交错，DDL 不计入时间。消息按同一完整 SQL 只切索引；进度加载固定基线源码与候选源码。
- 进度数据 SELECT **101 → 1**（不含只读事务 SET；contact 入口仍另有联系人存在性查询）。这是查询数，下面另列真实 PG 读取耗时。
- 表内为 **p50 / p95**；单机热缓存局部结果，无显著性检验，不代表 HTTP 或桌面延迟。

| 指标 | 基线 | 候选 |
| --- | ---: | ---: |
| 完整分页 SQL（ms） | 33.980 / 37.216 | 0.824 / 1.140 |
| 进度 store.read（ms） | 7.990 / 8.641 | 5.448 / 5.825 |
| ASC 排序探针（ms） | 0.233 / 0.370 | 0.132 / 0.236 |
| 1000 条正式新导入（ms） | 224.374 / 234.420 | 225.583 / 242.637 |
| 1000 条同文件重复导入（ms） | 178.068 / 190.902 | 182.145 / 187.858 |
| 新导入 WAL（字节） | 4157632 / 5985504 | 4469160 / 5022640 |
| 重复导入 WAL（字节） | 2260312 / 2294384 | 2276824 / 2312040 |

- 两索引合计 **15.656 MiB**（9306112 + 7110656 字节）。完整新导入 p50 **+0.54%**、重复导入 **+2.29%**；新导入 WAL 中位 **+7.49%**、重复 **+0.73%**。WAL 保留原始离散样本，不将它冒充延迟或 RSS；空间数字只针对该合成规模。
- 完整 `import_file` 包含 JSONL 读取、规范化、来源追踪、COPY、约束和触发器；新／重复导入都通过真实入口，断言 imported/already_imported、数量和有序内容摘要。为逐轮回滚借用同一连接，**不计事务提交／fsync**，不覆盖新建连接、HTTP、模型或桌面完整路径。
- 全 SQL、首次／同时间／NULL 游标页、limit 1/2/3 的三重号页均在无／有索引时相等。旧任意次序 SQL 的重号结果集合相同但顺序不等，正式 JSON 明确记录该负结果；不靠集合比较掩盖排序变化。

## 行为回归与真实命令

所有 Python 命令均用 NotAlone Conda Python 3.12，且显式 `PYTHONPATH` 指向本工作树，避免 editable 安装读到共享主仓。

```bash
PYTHONPATH=backend/src python backend/benchmarks/database_queries.py --samples 13 --verify --output .scratch/system-optimization-20261021/database-comparison.json
PYTHONPATH=backend/src python .scratch/system-optimization-20261021/database-duplicate-validation.py
cd backend
PYTHONPATH=src python -m unittest tests.integration.persistence.test_memory_processing_read -v
PYTHONPATH=src perl -e 'alarm 180; exec @ARGV' -- python -m unittest tests.integration.server.test_memory_processing_progress tests.integration.server.test_memory_processing_guards -v
```

- 最小进度测试先红：12 项任务产生 13 个数据 SELECT；新测试最终包含 15 个 import/observation 混合任务且仅 1 个数据 SELECT。完整新进度模块 **8/8** 通过。
- 重号排序测试乱序插入 103/101/102，limit=2：先红 `[103,101]`，修正后绿 `[101,102]`；保留原 outer limit、next_cursor、缺失引用与跨 owner/contact 检查。
- 在另一个尚未 ANALYZE 的自有库跑消息 API + 新进度模块 **20/20**，避免把已分析性能库用于无统计回归的错误前提。
- 最终版本相关 **75/75** 通过，包含上述 20 项及 merged migration history、import statement migration、database migrations、Postgres ingest repository、retrieval、CLI pagination sync。统一由临时实例提供显式 `NOTALONE_TEST_DATABASE_URL`，180 秒有界入口；耗时 14.498 秒。
- HTTP 进度和 guards 模块 **10/11** 通过；`test_completed_batches_survive_failure_and_resume_keeps_context` 断言期望 `(20,42)`、实际 `(10,42)`。固定基线 git archive 独立临时源码也同样失败，未修改旧断言，未放宽来源检查。本 issue 不接管原提取批次规格调整；最终集成应保留此已知失败。
- 已覆盖来源 active/delete_requested/deleting/delete_failed/deleted、观察已入队/未入队、撤销/错 owner/contact 的绑定、100/101 上限、状态优先/时间/UUID 排序、租约、来源删除后重读、真实计划/结果计数与读取不写入。

## 独立审查

### Standards

硬性违反 0。初次非阻断建议为基准复制索引 DDL，已改读真实迁移定义；末尾空行已清理。重号排序及证据修正后复查仍为 0，`git diff --check` 通过。

### Spec

初次发现 1 项 P2：重号目标顺序／子集受索引影响。已按独立复现增加确定排序与逐行对照，最终复查 **0 项**；[76 重号复验原始证据](database-duplicate-validation.json)与[复验脚本](database-duplicate-validation.py)保留旧 SQL 在页长 1/2/3/10/50 下顺序和子集均变化的负结果。新 SQL 在五种页长均通过完整 SQL 同序、API 页面（含游标）、目标顺序和集合等价，且为 UUID 升序前缀；未扩张查询范围或跳过来源复核。

## 数据影响、限制与清理

仅新增物理索引及同范围只读查询改写；没有重写消息、来源、记忆、auto/manual、时间／条件、删除路径或追踪记录。联系人确认、隔离及人工发送边界保持。

未运行真实 App／微信，未创建浏览器页或开发服务；按统一规格交最终集成协调。工作树 `npm run dev:status` 为 stopped，没有启动第二个 App。未 push、远端分支、PR、发布或业务迁移。

所有自有临时 PostgreSQL 实例正常停止、目录删除，随机自有测试库由夹具删除；独立基线 archive 已删除。共享计时锁文件保留供其他聊天使用，不持锁。工作树和合成结果保留供集成复核，不归档仍需集成的工作树。

提交后执行 `node scripts/check_public_history.mjs --ref HEAD --working-tree`；最终结果以本地提交后的再次检查为准。完整 Python 全量、最终合并版以及真实桌面／微信验收由 05 统一执行。
