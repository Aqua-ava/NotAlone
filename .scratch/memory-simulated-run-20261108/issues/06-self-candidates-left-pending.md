# 06 联系人处理产出的本人候选全部停在待决定，run 停在 incomplete

Triage: needs-triage
State: open

## 现象
A 的 run 提取完成后：联系人范围候选 16 条自动采纳（记忆 16 条），1 条停在 `pending`；本人（`self`）范围候选 33 条全部 `pending`；run 里的本人任务为 `awaiting_decision`，run 状态 `incomplete`，原因 `later_stages_pending`，操作列表为空。

## 待查
- 本人候选为何不自动裁决，是否符合「本人资料使用独立 owner 范围」的规格；需要用户在哪里决定。
- 联系人那 1 条 `pending` 候选停住的原因。
- `incomplete / later_stages_pending` 对用户的含义：L2（1 小时窗口）和 L3 尚未执行，页面上应如何说明。

## Comments
