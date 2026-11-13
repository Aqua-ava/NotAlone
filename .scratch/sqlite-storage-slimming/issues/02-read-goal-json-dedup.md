# 读取目标 JSON 按内容去重

Triage: wontfix
State: resolved
Type: task
Blocked by: none

按 [spec](../spec.md) 把 `read_goal` 中大量重复的 `support_json`、`eligibility_json` 改为引用去重表（`target_json` 不同值多，先不动，另评估）。

## 范围

1. 新增按内容摘要寻址的去重表，`read_goal` 保存引用；写入时先查摘要再复用。
2. 读取路径（`actions.ts` 中 `JSON.parse(goal.support_json)` 等）改为通过引用取值，对外语义不变。
3. 迁移把存量行改为引用并回收重复内容；新表按统一删除模块登记，更新结构基线。

## 验收

- 删除某联系人或来源后，不再被任何读取目标引用的去重行也能被回收，不遗留可识别内容。
- 全部读取目标行为不变：增量与历史读取、续读、`history_cursor_scope_changed` 判断结果一致。
- 结构基线、删除注册和 `sqlite-storage` 测试通过；合成数据下报告 `read_goal` 大小前后对比。

## 调研结论（暂缓实现，待用户确认顺序）

- 触点远多于预估：`support_json`／`eligibility_json` 在 `backend-ts/src` 有约 40 处读写，分布在 `history/sqlite`（actions、read、continuity、recertify-*、source-deletion、legacy-*、quote-store、clear-actions）和 `media/sqlite`。其中有 `JSON.parse(goal.support_json)`、`goal.support_json===serializeSupport(report)`、`goal.eligibility_json!==JSON.stringify(token)` 这类**按文本逐字比较**，还有两处 SQL `json_extract(g.support_json, ...)`，以及 `SELECT * FROM read_goal` 把整行传出。去重要么改全部调用点，要么把 `read_goal` 改成视图加触发器，后者会破坏统一删除模块对“表”的假设。
- 迁移成本：存量 11.9 万行要改写；`goal_immutable` 触发器引用了 `eligibility_json`，要先重建；`ALTER TABLE DROP COLUMN` 会重写整表。
- **收益依赖任务 03**：`support_json`＋`eligibility_json` 共约 213MB，其中 126MB 属于已作废目标，这部分任务 03 清理目标时会整行删除。先做 03 之后，去重只剩约 85MB 的潜力，实际可省约 80MB（约 4%）。先做 02 约省 205MB，但其中约 126MB 随后会被 03 删掉，属重复劳动。
- 建议：先做任务 03；03 完成后重新测量，再决定 02 是否还值得做。

## Answer

决定不做（`wontfix`）。任务 03（`0f9d15fab`）清理作废目标后，`support_json`＋`eligibility_json` 只剩约 85MB，去重最多省约 80MB，约占清理后约 1.4GB 库的 5–6%；而改动要触及约 40 处读写，含大量按文本逐字比较，对核心同步与续读的回归风险高。

重开条件：任务 04 的实测显示 `read_goal` 的 JSON 列仍是体积大头，或出现新的重复来源。

## Comments
