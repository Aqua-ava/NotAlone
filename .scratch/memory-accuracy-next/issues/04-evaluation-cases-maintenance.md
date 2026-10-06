# 04 — 评测用例文件维护

**What to build:** 把 `evaluation_cases.py` 按维度拆分（每维度一个模块，聚合成一个元组导出），期望去向复用领域枚举或等价常量，去掉重复用例句子；不改用例语义与期望。

**Triage:** ready-for-agent
**State:** resolved
**Blocked by:** 无（01 已结）

- [x] 按维度拆分并保持 `CASES` 导出兼容
- [x] 期望去向不再使用裸字符串
- [x] 去重重复用例句子，语义不变（核对结论：无完全重复用例；media 的两条同句用例属必要的发送者对照，保留）
- [x] 全量测试通过；真实模型回归归入票 03 的评测预算（本轮未运行，不冒充已通过）

## Comments

- 2026-10-06：按票面完成拆分与枚举化，提交 `1a2a10e`；依据见下方 Answer。第 4 条验收的真实模型回归并入票 03 已批准的评测预算（档 B′，先跑档 A），不在本票单独跑，避免同一批用例被两处口径统计。

## Answer

**已完成**（提交 `1a2a10e`，本地，无远端推送）：

1. **按维度拆分**：新增 `src/notalone/memory_extraction/cases/` 子包，拆成 `reference`／`subject`／`truth_intent`／`paraphrase`／`time`／`reported`／`media` 七个模块（共 123 条用例），类型定义集中到 `cases/types.py`；`cases/__init__.py` 按拆分前的源码顺序聚合出 `CASES`，**下标与顺序不变**。原 `evaluation_cases.py` 缩为兼容入口，重导出同一批对象；`tests/unit/memory_extraction/test_cases_structure.py` 断言兼容入口与子包导出的是同一对象，避免两处真相。
2. **期望去向不再使用裸字符串**：`EvaluationCase.expect` 与 `ClaimExpectation.destination` 改用新增的评测层枚举 `ExpectedDestination`（`auto`／`pending`／`none`）。**没有**套用 `MemoryDisposition`——后者描述语用分流（`confirmable`／`pending`／`none`），与评测层去向不是同一层：期望去向还叠加了置信度门槛、风险白名单与按维度放行门，硬套会让「能自动采纳」与「实际去向」混为一谈。两者关系写在枚举文档串里。`semantic_evaluation_cases.py`（16 处）与 `replica_experiment.py`（1 处）同步迁移。
3. **拆分是机械搬运，不是重写**：用 AST 定位每条用例并按源码顺序搬运，随后逐字段核对——新旧 123 条用例的 `dataclasses.asdict` 比对**差异为 0**、名称顺序一致、期望命题 19 条不变、维度分布一致（reference 16／subject 19／truth_intent 20／paraphrase 17／time 20／reported 15／media 16）。只有排版从多行手工缩进改为规范化输出，用例正文、期望与严格命题 oracle 均未改动。
4. **去重核对结论（如实记录，不虚构删减）**：不存在完全重复的用例签名；同维度内只有 media 的「占位：单图」（发送者 `contact`）与「占位：用户发图」（发送者 `self`）共用同一句 `[图片]`，两条覆盖不同的发送者路径，属有意保留。因此本票去重项为「核对后无需删除」。
5. **新增 5 项结构回归**：`CASES` 恰好由各维度模块组成、去向必须是枚举成员、每条用例落在与自身 `dimension` 一致的模块、用例名唯一（严格命题 oracle 按名索引，重名会静默错位）、兼容入口导出同一对象。

**验证**：`python -m unittest discover -s tests/unit -t .` **936 项通过**（原 931 ＋ 新增 5）；`python -m mypy src/notalone/memory_extraction` **34 个文件 0 问题**（迁移前该目录有 44 项类型错误，全部由本次字面量迁移消除）；`tests/integration/memory_extraction` 2 项按「未提供专用评测凭据」跳过，**未联网**。

**限制（如实保留）**：① 真实模型回归未在本票运行——它并入票 03 已批准的评测预算（档 B′，先跑档 A），用例集本身在评测前不再改动；② 用例数量、维度名与期望命题数未变，因此**已有放行结论不因本票失效**（放行台账当前为空集，无历史结论需要标注「用例集版本已变化」）；③ 结构测试依赖各维度模块的 `CASES` 导出，新增维度时必须同时更新 `DIMENSION_MODULES` 映射。

**数据影响**：只改仓库内的合成用例组织方式与类型标注；未连接数据库、未读取 `.env` 或真实聊天、未运行真实模型、未写入业务记忆与水位。
