# 01 — 共享中文词法评分模块

**What to build:** 一个无 I/O 的纯函数评分模块，供 PostgreSQL 与内存检索适配器共用。它把 query 与记忆正文按同一规则切分：CJK 连续段取 unigram（权重 0.5）与 bigram（权重 1.0），拉丁字母与数字按小写词（权重 1.0），标点与空白只作分隔；query 去重并截取前 200 字符；分数为命中 token 权重占 query 总权重的比例，同时返回命中的 token 列表供入选原因使用。阈值、权重与长度上限作为模块常量固化，不做运行时配置。

**Triage:** ready-for-agent
**State:** resolved
**Blocked by:** 无，可立即开始

- [x] 分词覆盖中文、英文、数字、中英混排、标点、空白与 emoji，均有单元测试
- [x] 评分边界：无 token 返回无候选、无命中为 0、全命中为 1、大小写与全半角归一
- [x] query 超过 200 字符时只取前 200 字符参与评分
- [x] 命中判定要求 token 完全相等，英文不误命中更长单词
- [x] 返回分值与命中 token，常量固化在模块内
- [x] 模块无数据库、无网络、无文件 I/O；相关 `unittest` 全部通过

## Comments

## Answer

- 实现：新增纯函数评分模块，提供分词、query 构建、按预构建 token 评分与一次性评分入口。规则为 NFKC 归一化 + casefold；CJK 连续段取 unigram（0.5）与 bigram（1.0），覆盖 BMP 与扩展区；拉丁字母（含重音）与数字按小写词（1.0）；命中要求 token 完全相等；query 去重并截取前 200 字符；分数为命中权重占 query 总权重的比例。阈值、权重、长度上限以模块常量固化，阈值待票 02 消费。
- 测试基建：发现 `tests/unit/retrieval/` 缺少 `__init__.py`，该目录既有 9 条检索测试也不被默认套件发现；补齐后连同新测试一起进入默认发现（全量 810 → 847）。
- 验证：`python -m unittest tests.unit.retrieval.test_lexical` 28 项通过；`python -m unittest discover -s tests` 847 项通过、3 项跳过；`python -m mypy --follow-imports=silent` 对实现与测试文件无问题。
- 审查：两轴 code review。Standards 无硬性违规，采纳并修复分词范围重复、非 BMP CJK 与重音拉丁词被截断、token 权重不变量缺失、命名漂移；Spec 修复数字与重音用例缺口。保留判断项：tuple-only 输入契约、运行时类型守卫（沿用仓库风格）、归一化后截断（文档已标明顺序）。
- 数据影响：纯函数模块，无 I/O、无数据库、无真实数据；测试全部合成。
- 剩余风险：同义改写漏检规模未知，由票 04 的改写维度度量；阈值实际效果需票 02 接入后由票 05 标定。
