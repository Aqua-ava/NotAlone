# 证据 01：独立关系证据覆盖误拦的离线重放（只读，不调用模型）

日期：2026-11-06。方法：读取两份隔离副本内已存档的模型裁决输出（`adjudication_basis` / `adjudication_output`），按 `adjudication-actions.ts` 修改前后的 `relationCovered` 规则用真实业务代码（`adjudication-dsh.ts` 的解析器）重算原因；不调用模型、不改副本。明细（含候选 UUID 与分页页码）与脚本在仓库外私有目录的 `replay-relation-coverage.mjs` / `replay-summary.json`，此处只留计数。

## RX 副本（03-30 10:22–10:42 文字窗口，本轮）

| 项 | 数量 |
| --- | --- |
| 本轮 run 候选总数 | 18 |
| 当前 pending | 17 |
| 有存档裁决结果的候选 | 4（1 条已自动采纳 + 3 条 `memory_relation_pending`） |
| 3 条 `memory_relation_pending` 按新规则改判 | 3 → 全部自动采纳（均为 `add`） |
| 其余 14 条pending 无存档裁决结果 | 与 spec 2.2 吻合（8 条未发裁决 + 6 条 `alternatives` 前置拦截，不在本重放范围） |

## 3M 副本（3 月下旬，含图片，run 917f1f6c…）

| 项 | 数量 |
| --- | --- |
| 本轮 run 候选总数 | 19 |
| 当前 pending | 16 |
| 有存档裁决结果的候选 | 13（3 条自动采纳 + 9 条 `memory_relation_pending` + 1 条 `memory_media_relation_pending`） |
| 9 条 `memory_relation_pending` 按新规则改判 | 9 → 全部自动采纳（`add` 6 条，`keep` 3 条；两者关系 kind 均为 `independent`） |
| `memory_media_relation_pending` | 维持待确认（符合预期：候选或比较池受图片规则约束） |

## 结论

1. spec 2.4 预估「约 7 条关系核验类」实际为 9 条；两类样本共 12 条关系覆盖误拦全部在修复后转为自动采纳，无新增被拦条目，`memory_media_relation_pending` 等其余原因分布不变。
2. 3 条 `keep` 动作也一并解封（其关系 kind 为 `independent`）；任务 02 若进一步允许 `keep` 的 `supplement | historical_supplement`，是在此基础上扩大收益，不在本次计数内。
