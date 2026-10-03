# Hindsight 合成记忆与词法基线

全部是本任务新建的中文合成内容。没有读取聊天、旧私有评测集、业务数据库或业务 `.env`，没有模型或网络推理调用。夹具直接初始化已采纳快照，不验证自然聊天提取、来源语义核验或采纳准确率。

## 冻结版本与标注

正式版本 `hindsight-synthetic-v2`，种子 `20261004`，名义时间 `2026-10-04T00:00:00+00:00`。对应[资料与 query](v2/dataset.json)、[gold](v2/gold.json)、[摘要清单](v2/dataset-manifest.json)在运行前冻结。重复冻结只能写入完全相同内容，修改必须使用新版本。

[v1](v1/dataset-manifest.json)是语义审查前冻结初稿，未运行 A/B，保留供核对。独立人工审查发现同一联系人 bank 的交通、饮食和运动约束会跨主题相关。v2 明确火车/汽车条件，并补齐饮品花生禁忌、点餐奶不耐受、跑步膝盖恢复及路线限制。修正发生在首次运行 A 前，没有按检索输出修改 gold。近期状态使用稳定合成有效窗口（2020 至 2100 年），不是永久偏好，也不是对真实状态有效期的推断。

gold 表示“可用于回应当前正文的相关本地资料 ID”，不表示现实真值。标注保留条件、否定、主体和时间语境：代购行为不证明本人偏好，家人和同事限制不代表本人限制。同一记录可在不同 query 中成为正例或负例，例如主观影问题不需要影院地图，但明确询问地图时可以召回。逐 query 说明随 gold 保存。

## 数据规模和分层

共 397 条合成快照和 133 条 query。最终主联系人 bank 有 314 条关系记忆：核心 300 条为 20 个主题各 2 条基础相关资料与 13 条同主题记录；另有 8 条生命周期记录和 6 条预算压力记录。314 条中 310 条在静态窗口可检索，另外 4 条分别删除、失效、到期或尚未生效。隔离 bank 共 4 条同文异 ID 资料；本人资料独立为 4 条。

| 分组 | 校准 dev | 最终 final | 用途 |
| --- | ---: | ---: | --- |
| 中文改写 | 15 | 60 | 联系人最终 Context 宏 Recall@5 |
| 直述 | 5 | 20 | 直述诊断 |
| 寒暄/无 token | 10 | 10 | 空结果和无关注入 |
| 同主题定向问题 | 0 | 5 | 负例在其他语境可成为正例 |
| 隔离 | 0 | 1 | 正例可选入，同文外部范围不可选入 |
| 状态/时间 | 0 | 4 | 每组同时有可用正例和不可用资料 |
| 联系人预算压力 | 0 | 1 | 6 条相关资料超过预算 |
| 本人路径/本人预算 | 0 | 2 | 独立 Recall@3 和预算 |

60 条最终改写来自 **20 个独立主题，每个 3 种表达**，不是 60 个独立场景；校准是另外 5 个主题，每个 3 种表达和 75 条资料。dev 与 final 不共享事实实例，直述和改写留在同一 split。校准 bank 是小型调参组；主评测 bank 满足至少 300 条关系记忆的要求。同一主题的三种表达存在相关性，不能按 60 个独立样本外推置信度。全量竞争资料可在 JSON 中逐条核对。

所有主改写 gold 可容纳于 5 条/600 字符；预算无法容纳的组不进入主 Recall 分母。冻结质量组是改写、直述、寒暄和同主题问题，共 95 条；隔离、状态与预算另报。这里只验证静态状态，真实外部索引删除和竞争由后续任务验证。

## 实验接缝与口径

`build_fixture(dataset)` 返回真实 `InMemoryMemoryStore`、真实 `InMemoryRetrieval` 和数据定义。固定 UUID 通过内存存储的合成快照构造入口初始化；后续删除/失效使用公共方法。名称不参与检索，隔离夹具用不同 owner/contact 和相同正文模拟同名联系人不能作为身份依据。

`evaluate_query(fixture, query, retrieval_factory=...)` 默认执行 A；B 可用 factory 包装 local retrieval 并返回既有 `RetrievalPort`。最终选入始终经过真实 `RetrievalReplyContext.build`、双预算和 `validate_current`。`before_validate` 仅供独立故障夹具注入竞争，不作用于产品。实验包装观察公共 Port 异常：即使产品 Context 在初检异常时按现有行为降级，实验仍记失败、最终集合为空并保留 gold 分母。B 不得将外部失败回退后计作成功。

联系人按 `(contact, owner_id, contact_id, memory_id)` 计分；本人按 `(owner, owner_id, None, memory_id)` 计分。同文不同 ID 不合并。Recall 仅对有 gold 的 query 宏平均；Precision 对选入非空的 query 宏平均，并报告其分母。无关注入率对该冻结组全部 query 计算。旧 `hit_rate` 保持其原有用例通过率含义。

query 由现行词法模块完成 NFKC/casefold 和 200 字符头尾有效采样，runner 不复制或调整词法评分。联系人最多 5 条/600 字符，本人最多 3 条/240 字符，按排序前缀选取，不截断单条。报告保留实际本地起止时间；名义 `query_timestamp` 不替代本地有效期复验的墙钟。

## 已运行的 A

[逐 query 结果](v2/baseline-results.json)记录代码提交、参与源码 SHA-256、已跟踪差异摘要和冻结文件摘要。实验源码首次运行时尚未提交，其实际内容以源码摘要核对。这里只运行词法 A，不声称 Hindsight 收益。

| 分组 | 结果 |
| --- | --- |
| 最终 60 条改写宏 Recall@5 | 0.016667（1.67%） |
| 最终改写正例空结果率 | 55/60（91.67%） |
| 最终 20 条直述宏 Recall@5 | 0.941667（94.17%） |
| 最终 95 条质量组无关注入 | 15/95（15.79%），45 个非 gold ID |
| 范围、预算、重复 ID 违规 | 0、0、0 |
| 本人正例 Recall@3 | 1.0；压力组 0.75，仍保持三条预算 |
| 整轮失败 | 0/133 |

改写多采用日常任务表达而不是重复记忆用词，并存在同主题竞争。A 的低覆盖是本合成压力组观测，不能解释为真实用户覆盖率，也不能据此决定生产接入。B 的正式对照现已完成，覆盖、误注入、完整 P95、资源和删除成本见 [COMPARISON.md](COMPARISON.md)；本节保留当时 A 的独立结果，未重写冻结数据、gold 或基线产物。

## 复现与验证

```bash
conda activate NotAlone
PYTHONPATH=src python -m notalone.experiments.hindsight_baseline --freeze-only
PYTHONPATH=src python -m notalone.experiments.hindsight_baseline
PYTHONPATH=src python -m unittest discover -s tests/unit/experiments -v
PYTHONPATH=src python -m unittest tests.unit.retrieval.test_recall_evaluation tests.unit.retrieval.test_lexical tests.unit.reply.test_context_retrieval -v
PYTHONPATH=src python -m mypy src/notalone/experiments --follow-imports=silent
```

实际验证：9 个实验测试和 66 个现有测试通过，后者包含旧 109 条召回评测的原门槛；mypy 对 4 个实验源码文件通过。red → green 包括真实 Context 正例、冻结拒绝错范围 gold、初检超时不能误记成功空结果。没有修改生产默认装配、评分阈值或 feature flag。
