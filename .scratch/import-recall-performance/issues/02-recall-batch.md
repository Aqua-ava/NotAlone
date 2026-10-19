# 02：后台召回单批预计算复用
Triage: ready-for-agent
State: open

## What to build
减少同批候选反复分词、统计和范数计算，保持公开召回与逐条采纳的数值、顺序和来源合同；交付前后对照数据。

## Blocked by
None (can start immediately)。

## Acceptance criteria
- [ ] 保持公开函数签名及算术/RRF/决胜规则；只在单次调用预计算语料统计和记忆向量范数。
- [ ] 固定 20×1000 负载 tokenize/sqrt 各 20020→1020，embedding 输入仍为 1020；不改 adoption 动态池，不增加跨批缓存。
- [ ] 固定结果、数值、排序、错误、空输入、不同 top-k 等公开接口回归与既有来源/纠错/隔离链路通过。
- [ ] 原始基线与实现相同输入报告独立计数、重复计时和内存，若模型预置补真实本地编码，不能只给假向量整体加速比。

## Comments
用户已授权实施。独占 recall.py 与对应新增合成测试/本任务单；必要跨范围先报告。不得修改持久化、adoption、协调 main 或原工作区。最终追加 Answer、真实命令/数据影响/风险，验证后本地提交并标记 resolved，不 push。
