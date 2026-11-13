# 01 行为与数据基线交付

本轮固定旧实现 `3c168296e9e8edaa43b8b323ff693e790e709069`，先读取 DSH 官方文档、源码及示例，再建立迁移对照材料。这里只验收基线；产品仍运行原 Python／LangChain／LangGraph 后台，DSH 运行可行性属于02。

## 交付物

| 材料 | 用途 |
| --- | --- |
| [官方证据](dsh-official-evidence.md) | 固定 DSH 候选 commit、profile／生命周期／工具／Skill／模型／出站行为的源码依据及02实验清单 |
| [行为矩阵](behavior-matrix.md) | 桌面→HTTP／事件→业务→数据及错误、现有测试、26票承接和原票缺口 |
| [合成数据基线](data-baseline.md) | 多用户多联系人、来源、记忆、Skill、讨论、授权与任务的生成及恢复说明 |
| [快照证据](snapshot-evidence.json) | 完整行哈希、合成身份、文件摘要及清理结果 |
| [运行清单](runtime-inventory.md) | Python入口、CLI、Worker、探针、锁文件、本地向量及旧评测的逐项处置 |
| [比较协议](evaluation-protocol.md) | 迁移前确定样本、模型配置等价要求、重复次数、质量／延迟／费用门槛与未知处理 |
| [材料manifest](material-manifest.json) | 合成材料case ID、文件摘要及版本冻结 |
| [新增整理与学习案例](organization-learning-cases.json) | L2、L3、Skill学习的36例合成输入和预期业务断言，尚未运行模型 |
| [材料独立复核](material-review.md) | 主会话核对36例范围、来源、删除、取消、草稿规则与给定语义；不冒充模型质量评分 |

## 本轮实际验证

主会话使用项目 Python 环境运行：

```sh
cd backend
NOTALONE_DISABLE_DOTENV=1 PYTHON_DOTENV_DISABLED=1 python -m unittest tests.integration.server.test_core_business_flow.CoreBusinessFlowHttpTest.test_import_reply_replay_isolation_and_source_deletion -v
```

通过1例（2.753秒），覆盖合成导入→提取→回复→来源证据→换实例重放→范围拒绝→来源删除。其预期跨联系人拒绝日志不是测试失败。

从仓库根执行 `python .scratch/dsh-ts-migration/baseline/build_synthetic_snapshot.py .scratch/dsh-ts-migration/baseline/generated/verified`，通过1例（2.182秒）：103表、462行恢复前后哈希一致，9个Skill文件保留，两座自有数据库清理后不存在。另对生成器做 Python 语法检查及旧版 `backend/` 差异检查；首次夹具命名冲突及修正见数据基线。

并行评测会话在 `backend/` 执行 `python -m unittest tests.unit.retrieval.test_recall_evaluation -v`，8测试通过，覆盖109例召回门槛；还运行比较协议内两条离线评测CLI：6例内存检索命中5/6，同义表达漏检被保留；16例故意坏输出的保真评分器报告14语义失败、2合同失败，`quality_verified=false`。它们分别是检索合同和评分器自检，不是真实模型质量达标。内存CLI输出的0毫秒是固定值，不是性能测量。

## 责任、数据影响与交接

主会话负责01合并验收与本地提交；三个目标会话分别负责官方查证、行为矩阵、运行清单及协议材料。只对独立交付并行，没有同时接管同一产品写入路径。未查明负责人姓名的旧票明确留空；后续票认领时登记唯一实施责任方，不能用推测的人名替代。

读取公开DSH源码和本仓代码，合成数据仅写入独立测试库及本机忽略目录。没有读取真实业务库、私人聊天或凭据，没有调用真实模型、启动App／微信、安装DSH依赖、打包、发送消息或推送。保留一份约763KB合成dump及对应Skill文件供迁移使用；废弃本轮生成目录已清理，公开DSH源码暂留供02复核。忽略的研究原稿没有被强制纳入Git。

02需首先核验候选 `687f282e8625c6b8d11ff58211a90524be2e4317` 与发行制品的对应关系，再用官方profile实际验证结构化结果、取消、临时会话、作用域、请求计数以及无额外日志落盘／上报。官方minimal默认带这些额外组件，不能原样作为产品最小配置。安装包大小没有作为本轮否决条件；结构化输出和生命周期未经实测，不能据本票宣称迁移已经可行。

现有首用、微信真实验收和管理入口缺口保留原票状态，见行为矩阵。真实模型比较、TS成对runner、性能费用实测和原生桌面验收均由对应后续票承担；不以本轮合成恢复通过代替。
