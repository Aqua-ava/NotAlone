# 图片同步查询线性化

Triage: ready-for-agent
State: open

Blocked by: none

## Goal

把 `image-sync-actions.ts` 中逐行执行的相关 legacy cutoff 子查询提升为一次性 `legacy` CTE，保持图片同步结果、分页顺序、空 cutoff、已有 legacy cutoff 和退避语义不变。

## Acceptance

- [ ] 大联系人合成数据不再出现按消息数 × 尝试数增长的相关扫描。
- [ ] 空 legacy cutoff、多个 legacy attempt 和既有当前版本 attempt 的结果与原实现一致。
- [ ] `media.imageSyncTargets` 与 `media.imageRefreshPending` 的查询参数顺序正确。
- [ ] 同一数据集上记录修复前后耗时和查询计划。
- [ ] 相关图片同步、历史同步和类型检查通过。

## Test seam

公开 `media.imageSyncTargets`／`media.imageRefreshPending` 存储动作及 `SqliteImageSyncCoordinator` 行为；不只断言 SQL 字符串。
