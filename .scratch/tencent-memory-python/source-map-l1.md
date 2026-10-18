# L1 源码对应与产品适配

腾讯只读基线：`/Users/local-user/learn/open_learn/TencentDB-Agent-Memory`，commit `e9a8293`。下列腾讯路径均相对 `MemoryCore/src/`。本任务自行实现 Python，不引入腾讯运行时、服务或 Node sidecar。

| 腾讯源码 | 本地实现 | 对应行为 |
| --- | --- | --- |
| `core/record/l1-extractor.ts:149–179` | `memory_extraction/command.py` | 默认每批新消息10条、前置背景5条；本地继续按水位遍历所有新消息，不只截取最近消息；显式诊断仍可选择最多20条目标。 |
| `core/prompts/l1-extraction.ts:15–89` | `memory_extraction/direct_adapter.py` | 按情境提取完整叙述、忽略寒暄与一次性指令；保留已实现的独立事实和背景来源约束。 |
| `core/record/l1-dedup.ts:119–136,253–290`、`core/tools/l1-candidate-recall.ts:84–121,154–172` | `memory_extraction/recall.py` | 对已隔离当前记忆执行本地BM25与语义余弦召回，RRF常数60，每候选top5；不再以类别/主题或字符相似度硬筛正式默认路径。 |
| `core/prompts/l1-dedup.ts:20–60,156–185` | `memory_extraction/batch_adjudication.py` | 同范围统一已有候选池、一次批量store/skip/update/merge，多目标去重和纠错；逐候选校验目标集合，禁止多决策重复消耗父版本。 |
| `core/record/l1-writer.ts:192–240,275–339` | `memory_extraction/adoption.py`、`merge.py`及既有事务版本写入 | store→ADD、skip→NOOP；单父update/merge使用现有UPDATE版本事务，多父update/merge使用现有合并父版本事务。 |

## 明确保留的产品差异

- 腾讯以用户/AI及session为主；NotAlone保持用户本人/联系人/共同事实主体和owner＋contact隔离。本人候选池按owner分组，不与联系人池混批。合并只能使用本次授权窗口可回溯的原始消息，来源缺失不扩大读取权限。
- E后保留独立来源V。D改写后的正文重新经过V，保持新旧来源并集；直接采用已核验的新正文的单父更新沿既有来源版本事务。人工决定、有效期、事件以及变动来源保护不因跨类别召回解除。
- 不照搬腾讯D失败默认store、先删除旧检索记录再写入。解析/目标/本地embedding失败均保留候选待处理；多父写入复验全部父版本并在同一数据库事务内完成，不丢旧审计。
- 腾讯优先级及persona分类不替代本产品的分类、风险、置信度与语用字段。跨类别召回支持不同提取类别表达同一事实；最终仍以通过V的候选字段落库，不让D任意改写未核验字段。
- 每次批量D上限60000字符，top5每候选，最多8个替换父版本；超出不截正文、不静默新增。不同事件/期限不自动压平合并。明确旧逐维诊断策略仍可使用旧单条协议，生产默认verified_sources走批量协议。

## 本地向量模型

`fastembed==0.9.0`，`BAAI/bge-small-zh-v1.5`，模型仓库 `Qdrant/bge-small-zh-v1.5` 固定 revision `46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59`，512维。缓存默认 `~/.cache/notalone/memory-embedding`，可用 `NOTALONE_MEMORY_EMBEDDING_CACHE`指定。运行时只读 `specific_model_path`、`local_files_only=True`；只缓存模型实例，不保存聊天、向量或跨范围原文缓存。模型准备脚本由集成任务提供，不在记忆运行时自动联网下载。

## 验证记录

- 首个公开HTTP红测：跨类别/主题更新后旧新两项仍active；接通混合召回与批量D后只保留新版本。
- 第二个公开HTTP红测：单父merge触发原多父数据库CHECK；映射到单父UPDATE事务并重核最终正文后通过。
- 公开接口回归覆盖多候选更新、多父merge/update、skip、目标越界、人工修正保护、本人隔离和来源删除。外部模型与embedding边界使用合成输出；原始导入、任务、V契约、存储及读取均真实执行。
- 本机真实离线模型自检：2段合成文字返回2×512维；未调用真实外部生成模型。
