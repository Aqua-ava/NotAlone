# 删除身份哈希收敛（refactor/hash-helpers）收尾与存量失败审计交接

## 本任务状态（分支 refactor/hash-helpers @ NotAlone-wt/hash-helpers，未 push）
- `230c1b72f` test(deletion-hash): 8 个删除身份调用点特征测试 + 85 条期望值（fixtures/hash-profile）。
- `e89399830` refactor(deletion-hash): 收敛到 `src/platform/stable-json.ts`（sha256StableJson/sortedKeyJson/sortedEntries），输出逐字节不变；特征测试一字不改全过；tsc 通过；18 文件删除批 92/100。
- 8 个失败均为存量，与本重构无关（下述）。boundary.ts canonicalJson 未动（域外）。

## 存量失败簇 1（7 例）：test/sqlite-adjudication-deletion.test.mjs
- 症状：StorageFailure `storage_invalid`（storage worker 把 ERR_SQLITE_ERROR 压成 code）。
- 根因（/tmp 诊断树探针实证）：`src/contacts/sqlite/actions.ts:14` `visibleMessageCounts` 经 `currentSourceScopeCTE`（`src/history/sqlite/current-scope.ts:1-40`，06 系列 `adfdaa388` 引入合并来源证明）反查 `source_proof`；该测试的旧升级 fixture `test/fixtures/memory-management/adjudication-upgrade-registry.mjs?mode=upgrade` 没有 `source_proof` 表。守卫只检查 `message/capture_record`（actions.ts:13），未覆盖 CTE 依赖的表。
- 下一步（属同步/联系人域）：给该守卫补 `source_proof`（含 CTE 依赖的 `read_goal/conversation_binding`）或让升级 fixture 补充等价历史表；两方案取舍归联系人/历史接线 Agent。

## 存量失败簇 2（1 例）：test/sqlite-memory-unknown-deletion.test.mjs:13
- 症状：两次 synchronize 后 `message.sourceRecordIds.length` 实际 1、期望 2；夹具 `support.mjs:27` 恒定 `sourceGeneration:'source-1'`。
- 语义：期望"同代两轮同步各记一条来源"是旧同步行为；06 保留语义/引用复用后不再复制来源。失败在 a59a00f65 与再早约 25 个提交均复现，且在 f687753be、7b113b6ba、d18a1cb4b 上同样失败——与 `.scratch/sync-simplification/handoff-20261108-session2-retention.md` 在册的 48 例 f687 基线失败存量相符，属"待决策旧断言 vs 保留语义"族。
- 下一步（属同步减负 Agent）：按 06 待决策流程裁决改断言（1 条来源）或恢复重复来源记录语义。

## 参考
- 06 移交基线：f687 全量 2214/2165 pass/48 fail 档案（remaining-handoff.md:22）；final-current-failures.json 未在仓库内找到。
- 关键文件：src/contacts/sqlite/actions.ts:13-16；src/history/sqlite/current-scope.ts:1-40；fixtures/memory-management/adjudication-upgrade-registry.mjs；fixtures/memory-sqlite/support.mjs:27。
