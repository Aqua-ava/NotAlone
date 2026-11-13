# 空抓取不再逐页落行

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: none

按 [spec](../spec.md) 处理 `sync_capture` 中约 96% 的空抓取（没有任何 `capture_record` 的已接受页）。需用户先确认 spec 中的行为变化。

## 范围

1. 先核实：逐一列出读取 `sync_capture` 的路径（`history/sqlite/ingest.ts`、`legacy-terminal-proof.ts`、`contacts/sqlite/actions.ts`、`reply/sqlite/actions.ts`、`actions.ts` 的重放判断与 `acceptance_no` 排序），写明空抓取是否被任何一处依赖；有依赖则缩小范围或停止。
2. 若无依赖：增量页没有记录时只更新目标游标与覆盖状态，必要时记一个计数，不再插入 `sync_capture`；仍保证相同 `captureId` 重放幂等。
3. 存量空抓取由迁移一次性清理，保留每个目标最新的游标证明所需内容。

## 验收

- 依赖核实结论写入本文件 `## Answer`。
- 增量续读、重复页幂等、游标恢复、删除链与来源追溯测试全部通过；有记录的页行为不变。
- 合成数据迁移后空抓取清除，结构基线与删除注册测试通过。
- 不引入新的读取旁路；用相同合成工作负载报告表与索引大小前后对比。

## Answer

提交 `df643ec52`。核实结论与原假设不同：

- 依赖核实：几乎所有读取 `sync_capture` 的路径都是从 `capture_record` JOIN 过来，空页不被引用；直接数行数的只有历史目标的 `pageCount` 与重新认证页数，不涉及增量目标；增量页数使用 `read_goal.pages_accepted`。
- **游标每次都推进**：开发库约 34.8 万行增量空页的 `cursor_in` 与 `cursor_out` 全部不同，所以不能完全不落行；同一响应重放幂等需要最新一条，故改为“每个增量目标只保留最新一条空页”。
- 历史目标另有约 18.7 万行空页（含 4.9 万首页 `cursor_in` 为空），因 `pageCount` 依赖，本任务不动。
- `sync_capture` 此前没有 `(owner_id, goal_id)` 索引，新增迁移 40 建立该索引（副本上约 0.3 秒）。
- **存量没有批量清理**：在 1.9GB 真实库副本上一次性删除约 33 万行，默认缓存下 953 秒、512MB 缓存下 340 秒，不能阻塞启动。副本上清理后库由约 1.98GB 降到约 1.64GB（含 VACUUM），`quick_check` 约 2.0 秒、`integrity_check` 约 3.5 秒。
- 存量改为：目标下一次收到空页时顺带清除其旧空页；其余随任务 03 的终态目标保留策略分批处理（需有界批次，不进启动迁移）。
- 测试：新增 3 项，撤掉压缩后全部失败；结构基线只多一个索引。

## Comments
