# 记忆评测

[返回评测索引](../README.md)

| 要核对的问题 | 入口 |
| --- | --- |
| 提取完整性、候选修订、来源片段与分组协议 | [提取评测](extraction/README.md) |
| 固定候选核验、人物归属、事实保留与提示对照 | [来源核验评测](source-verification/README.md) |
| 维度放行、时间、真假与意图的历史评测 | [维度评测](dimension-release/README.md) |
| 不同模型、方法复刻、140 例及腾讯提取层对照 | [模型与方法对照](model-comparisons/README.md) |

## 基线记录

- [记忆提取评测骨架：24 条合成基线](memory-extraction-evaluation-baseline.md)
- [记忆召回第一期评测基线](memory-recall-evaluation-baseline.md)

这些基线保留当时的方法与结果。历史放行台账及旧 Python 命令不构成当前自动维护的准入条件或当前可运行入口；现行处理、调度及失败边界见[记忆处理](../../../architecture/current/memory-processing.md)，数据对象见[数据契约](../../../architecture/current/domain-data.md)，运行入口见[TypeScript 后台说明](../../../backend-ts/README.md)。
