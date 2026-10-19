# 01：导入追踪批量核验与分块写入
Triage: ready-for-agent
State: resolved

## What to build
在原事务中减少长历史导入追踪查写，保持完整来源收据、顺序、撤销和删除安全；交付真实 PostgreSQL 前后对照数据。

## Blocked by
None (can start immediately)。

## Acceptance criteria
- [x] 同范围捕获 UUID 分块查墓碑，多行参数化写入；普通 1000 条保存路径目标 2001→4 条业务 SQL，额外锁/来源 SQL 另计。
- [x] 顺序、收据优先级、重复 locator、重复导入、空批次、大单条及规则读取合同保持。
- [x] 后续块/序列化失败整批回滚；双连接写入与删除/撤销交错不恢复旧正文，必要锁修正有真实证据。
- [x] 相关导入/同步/追踪/来源删除回归通过；原始与实现相同 100/1000/10000 负载报告 SQL、耗时、内存及同步/往返的真实测量边界。

## Comments
用户已授权实施。责任代码：source_processing、必要 postgres_repository/observation/删除及绑定锁边界和相关测试。规则摘要不缓存，跨范围先报告；不得修改协调 main 或原工作区。最终追加 Answer、真实命令/数据影响/风险，验证后本地提交并标记 resolved，不 push。

2026-10-19：功能已实施，真实 PostgreSQL 相关回归 108 项、导入单元测试 44 项通过；1000 条普通导入追踪实测 2001→4 条业务 SQL。撤销与观察共用联系人锁，并在锁内复验；双连接覆盖观察先持锁、撤销先持锁、撤销回滚和同 owner 不同联系人。历史导入/手动追踪删除交错在原行锁/FK下通过，未扩改导入锁或公共锁文件。正式前后计时、内存及协议消息计数继续单独记录。

## Answer

2026-10-19 完成。实现提交 `20ed6feb2330bbf2c82a30552353840da160cbd7`，性能基线固定为 `746bb40b7a0a90105c39f76d2786c451a55c93f7`。本任务未合并 main、push、创建 PR 或操作桌面。

- 墓碑最多 4096 个捕获 UUID 一块，所有块先检查；任一命中整批失败，追踪记录不去重。
- 参数化 VALUES 最多 500 条、普通参数编码目标 2 MiB；超预算单条完整单独保存。JSON 编码结果供分块计量和驱动复用，不扩大缓存生命周期；位置、捕获身份、收据优先级和规则文件逐次读取保持。
- 不增加数据库迁移，不在块间提交；后续块故障、后续 JSON 无效均回滚消息及追踪，后续同步块故障不推进游标。
- 撤销以取得 contact advisory lock 为串行化界线，观察也在该锁内复验 active。观察先持锁则允许完成；撤销先持锁并提交后，等待中的观察拒绝；撤销回滚则允许继续。同 owner 其他联系人不串行化。本决定不是把请求开始或 BEGIN 当作撤销已生效。
- 双连接还验证来源删除先行时拒绝缓存重放、导入已准备时允许先提交再由删除清除所有关联追踪；原导入行锁/FK在这些交错下通过，未改公共锁或历史导入锁协议。

### 真实验证

最终相关回归 **112 项**、导入单元测试 **45 项**通过；分别含规则文件变更、基准 CLI 五种 hostaddr/service/环境覆盖拒绝案例。测试只使用随机自有 `_test` 库与合成数据。

在 `backend/` 执行，统一前缀为 `PYTHONPATH=src:. NOTALONE_DISABLE_DOTENV=1 PYTHONDONTWRITEBYTECODE=1`；下列 `python` 均指工程工作流指定的固定 Conda 解释器，本轮版本为 3.12.13：

```bash
python -m unittest tests.integration.ingest.test_source_processing_trace tests.integration.ingest.test_import_command tests.integration.persistence.test_postgres_repository tests.integration.persistence.test_observation_store tests.integration.persistence.test_source_deletion tests.unit.ingest.test_rule_capture tests.unit.ingest.test_source_processing_benchmark -v
python -m unittest discover -s tests/unit/ingest -t . -v
```

相关回归命令另以 `perl -e 'alarm 600; exec @ARGV' --` 包裹，并显式提供本轮随机 `NOTALONE_TEST_DATABASE_URL`。日志分别保留 `/tmp/notalone-import-batch-final-related.log`、`/tmp/notalone-import-batch-final-unit.log`。

扩大验证曾在 `test_contact_deletion.py` 加载阶段因 `ManagedUpdateBackupDeletionTest._fixture` 不存在而失败。已从基线提交提取这两个测试文件，动态加载复现同一 AttributeError；未修弱旧断言，不宣称全量通过。公开历史检查仍有 26 处既有命中，完整日志 `/tmp/notalone-import-batch-public-history.log`。

### 可复现基准与原始数据

脚本：`backend/benchmarks/source_processing_batch.py`。从指定提交归档源码和迁移，避免 editable 安装误载；只创建并迁移自己的随机测试库，结束删除并核验。显式拒绝 hostaddr/service 及 PGHOSTADDR/PGSERVICE/PGSERVICEFILE 覆盖。全序、捕获身份及原始/规范化正文校验位于测量区外；补强后两版本各用 1000 条 count 模式重验通过。

从仓库根执行下列命令，分别用上述两个完整 SHA 替换 `REV`，每个版本依次运行 `time`、`count`、`memory`：

```bash
PYTHONHASHSEED=0 NOTALONE_DISABLE_DOTENV=1 PYTHONDONTWRITEBYTECODE=1 python backend/benchmarks/source_processing_batch.py --revision REV --mode time --samples 7 --output /tmp/REV-time.json
```

环境：Python 3.12.13、arm64、psycopg 3.3.4、libpq 18.0、PostgreSQL 16.14，本机 Unix socket。每版本每负载一轮预热加七个保留时间样本；计数和内存各另跑一次。两版本逐负载输入 SHA-256 一致。七个样本仅报告中位数与最小/最大值，不报告 P95。

六份正式 JSON 原始数据及日志位于 `/tmp/notalone-import-performance-20ed6feb/`，文件名为完整提交加 `-time.json`、`-count.json`、`-memory.json`；每份 JSON 保留原始样本、输入哈希、驱动/服务端版本及清理结果。另有两份 `-validated-count.json` 记录补强后的全序/正文验证。

| 路径 | 条数 | 原中位数 [最小,最大] ms | 新中位数 [最小,最大] ms |
| --- | ---: | ---: | ---: |
| save | 100 | 11.054 [10.659,12.887] | 12.626 [7.354,28.648] |
| import_file | 100 | 56.683 [50.581,73.068] | 57.253 [51.098,63.652] |
| save | 1000 | 76.495 [73.826,99.410] | 42.883 [36.905,62.243] |
| import_file | 1000 | 449.842 [435.585,534.138] | 441.597 [409.717,667.148] |
| save | 10000 | 839.721 [704.333,1124.405] | 491.415 [472.551,514.072] |
| import_file | 10000 | 4460.351 [4221.245,4577.865] | 4283.280 [3953.690,6246.604] |

`save` 从预构造捕获开始，包含一次范围锁、事务和提交；`import_file` 包含真实合成 JSONL 读取、解析、规范化、规则文件读取及完整导入。小负载未显示稳定提速，完整导入收益远小于保存函数，区间有重叠，不把保存函数收益外推到整体 App。

| 路径 | 条数 | 追踪业务 SQL 原→新 | 全部显式 SQL 原→新 | F.Sync 原→新 | B.ReadyForQuery 原→新 | 驱动 wait 原→新 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| save | 100 | 201→3 | 202→4 | 204→4 | 206→6 | 203→5 |
| import_file | 100 | 201→3 | 516→318 | 217→17 | 219→19 | 224→26 |
| save | 1000 | 2001→4 | 2002→5 | 2004→5 | 2006→7 | 2003→6 |
| import_file | 1000 | 2001→4 | 5016→3019 | 2017→18 | 2019→20 | 2024→27 |
| save | 10000 | 20001→24 | 20002→25 | 20004→26 | 20006→28 | 20003→26 |
| import_file | 10000 | 20001→24 | 50016→30039 | 20017→39 | 20019→41 | 20024→47 |

`save` 额外范围锁 SQL 始终为 1，来源 SQL 为 0；完整导入 advisory lock 为 0，来源 SQL 始终为 102/1002/10002。全部显式 SQL 包括 executemany 的每次真实语句执行；BEGIN/COMMIT 单独由协议观察，每轮 commit 为 1。命令完成数校验为显式 SQL+2，ReadyForQuery 数校验为 F.Sync+F.Query。准备语句和既有 pipeline 会增加或合并同步边界；上述数是实际 libpq 消息及驱动等待，**不是网络往返或 TCP 包数**。macOS binary 包 trace 未开放处使用同一已加载 libpq 的官方 C 接口，原始合成协议日志随临时目录删除，仅保留计数。

| 路径 | 条数 | 原 Python 峰值 bytes | 新 Python 峰值 bytes |
| --- | ---: | ---: | ---: |
| save | 100 | 25362 | 499857 |
| import_file | 100 | 67113990 | 67113990 |
| save | 1000 | 13594 | 2484553 |
| import_file | 1000 | 67114014 | 67114014 |
| save | 10000 | 20284 | 2502103 |
| import_file | 10000 | 116875628 | 120673582 |

内存是独立 tracemalloc 一次测量，非 RSS 或 PostgreSQL 内存。批量保存以约 2.5 MB Python 峰值换取 SQL/同步减少；10000 条完整导入峰值增加约 3.8 MB。2 MiB 参数预算不代表 Python 对象或事务总字节上限；超大单条允许单独超过预算，字节分块证据来自真实集成测试。

### 数据影响与清理

不改变正文、隔离键、来源关联、删除范围或长期留存，不新增模型调用/规则缓存。测试库仅装载合成资料；基准所有随机测试库、源码归档和原始协议临时文件均已清理，功能测试自有库亦在交付前删除并核验。原始聚合 JSON 与测试日志按规格留在 `/tmp`，系统清理后可由入库脚本重跑。没有启动 App、微信或常驻进程，没有下载模型、升级依赖、读取业务 .env 或连接业务库。
