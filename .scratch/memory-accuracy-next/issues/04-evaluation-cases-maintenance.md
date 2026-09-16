# 04 — 评测用例文件维护

**What to build:** 把 `evaluation_cases.py` 按维度拆分（每维度一个模块，聚合成一个元组导出），期望去向复用领域枚举或等价常量，去掉重复用例句子；不改用例语义与期望。

**Triage:** ready-for-agent
**State:** open
**Blocked by:** 无（01 已结）

- [ ] 按维度拆分并保持 `CASES` 导出兼容
- [ ] 期望去向不再使用裸字符串
- [ ] 去重重复用例句子，语义不变
- [ ] 全量测试与一次真实模型回归通过

## Comments
