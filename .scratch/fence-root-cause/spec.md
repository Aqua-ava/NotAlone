# 来源连续性围栏反复出现：查根因并修复（2026-11-07）

状态：ready-for-agent。性质：Bug 诊断 + 修复。先诊断；根因明确后再改代码。

## 用户要的结果
正常使用中围栏不应反复出现。退出应用再进入后，联系人应自动重验、续读、同步好，不需要手动“修复同步”（修复同步会全量重读并新建绑定，代价很大）。

## 已证实的事实（真实库及备份只读核对，数字可复核）
备份目录 `~/Library/Application Support/NotAloneDesktop/backups/sqlite/`，用普通路径 `sqlite3 <文件>` 只读查询（不要加 `?mode=ro` URI，含空格路径会打不开）。

| 时点 | 文件 | 围栏 | 守卫租约 | 活跃联系人 | 最后读取目标 |
| --- | --- | ---: | --- | ---: | --- |
| 11-06 20:55 | `before-fence-restart-fix-20261106.sqlite` | 278 | 全 lost | 280 | 11-06 19:25:59 |
| 11-07 00:05 | `before-migration-43-20261107.sqlite` | **59** | 全 lost | 280 | 11-07 00:04:43 |
| 11-07 11:03 | `before-bulk-contact-delete-20261107.sqlite` | **278** | 全 lost | 280 | 11-07 00:04:43 |
| 11-07 14:03 | `before-migration-45-20261107.sqlite` | 15 | 15 lost + 1 active | 16 | 11-07 13:00:32 |

关键结论：
1. **00:05→11:03 之间新增 219 条围栏，且 219 位全部是 00:05 前已“修复同步”成功（`history_source_recertification.state='completed'`）的联系人。** 这段时间 `database_instance.epoch` 从 1215 到 1219（4 次重启）。
2. 这段时间 **没有任何新的 `read_goal`、`sync_capture`，没有新的修复**；`history_continuity_scope`（280 行）、`history_guard_lease`（280 行）与 00:05 逐行相同（binding、source_generation、guard_id、runtime_id、state 均未变）。即：围栏是在**不读正文、不改租约和范围**的路径里写入的。
3. 现在仍被围栏的 15 位，在 00:05 时都没被围栏，11:03 时都被围栏。
4. 同一份历史：11-06 19:25:59 一次 278 位同时被围栏，已定因为“共享读取器整体停止时错误码被广播给所有守卫”，11-06 21:52 修复（`72bb5c474`），验收记录 `docs/verification/fenced-contact-recall-coverage-and-shared-reader-fence-20261106.md`。**这次的 219 条发生在该修复之后，是另一条路径。**
5. 11-06 21:23 有一次真机对照：修复 1 位后干净重启，守卫自动续租到新运行代次。说明“修复后重启”并非必然围栏；需要找出 219 位与那 1 位的差异。

## 已排除（不要重复）
- 共享读取器放大（已修，见上）。
- 11-07 12:24 的合成夹具复现：0/100 未命中，仅覆盖“空探针轮 + 瞬时错误码”，与上面这次（重启后、零读取）形态不同。报告 `docs/verification/fence-origin-attribution-20261107.md` 的 20 个 `fenceContinuity` 调用点表可直接复用。
- 重启本身一定围栏（11-06 21:23 对照否定）。

## 待验证的假设（按可能性）
写入围栏而不改租约/范围、且零读取的候选路径，来自 `backend-ts/src/history/sqlite/` 的 `fenceContinuity` 调用点：
- H1 `history.readPreflight → preflightGeneration`（`continuity.ts` 约 L91-99）：租约存在且 `state!=='active'` 或归属/代次不匹配，且 `metadataRevalidation=false` 时围栏。重启后租约是 `lost`，若某个入口（前台名单读取、状态查询、记忆/图片补取、删除流程）以 `metadataRevalidation=false` 调用，就会直接围栏。**最优先排查哪些入口会在重启后、真正重验之前先走到这里。**
- H2 `history.guardAcquire` 无 proof arm（`actions.ts` 约 L122-125）：租约陈旧而走了无 proof 分支。
- H3 `prepareNormalUseTarget`（`continuity.ts` 约 L170-191）：`storedTransition===null`（微信侧新增分片/表，目标过渡不是 same/growth/legacy-exact-upgrade）、`previousWasNormal` 为假（`priorNormalUse` 对“修复同步后写入的 scope”判定失败）、accountKey 不一致。**重点验证：recertify 的 `Activate` 写入的 `history_continuity_scope.tables_json` 能否通过之后的 `priorNormalUse`/`normalUseRevalidationCandidate`。** 这最能解释“只有修复过的联系人被围栏”。
- H4 `guardRelease` 带 `sourceLost`、`markContinuityLost`（`actions.ts` 约 L143-148）：重启/退出时的释放被误判为来源失证。
- H5 其他入口：前台名单读取（`b232d0af0`）、删除流程、迁移 43 应用时的重启。

## 调查步骤
1. **复现用副本，不碰真实库。** 复制 `before-migration-43-20261107.sqlite`（00:05：59 围栏，其余为“修复后、租约 lost”）到 scratchpad；用 `git log` 找出 11-07 00:05 对应的提交，在独立 worktree 里检出，用该 DB 副本启动 backend（`backend-ts`），按正常入口走一遍：启动、前台名单读取、触发一次同步 / 读取。观察哪些联系人在什么入口被围栏。成功复现 = 围栏数增长且无 `read_goal`。
2. 复现不了就加只读诊断：在 `fenceContinuity` 调用前记录 **调用栈入口名 + contact 前 8 位 + 条件分支编号**（临时、不进正式日志，用后撤销），再对副本跑。对照 `docs/verification/fence-origin-attribution-20261107.md` 的 20 点表归因。
3. 对比差异：219 位围栏 vs 11-06 21:23 对照里 1 位续租成功的联系人，比较它们的 `history_continuity_scope.tables_json`、`history_guard_lease`、最近一次 `history_source_recertification` 的 `support_json/target_json`、是否经过 `Activate` 后的 `Finalize`。
4. 确认是否与 WeChat 侧变化有关：对比 `tables_json` 与当时 wx-cli 返回的实际目标（分片/表实例是否增长）。
5. 找到根因后，用合成库写**失败用例**（recertify 完成 → 干净重启 → 首次入口 → 期望自动重验成功、无围栏），先红再绿。

## 修复要求
- 重启/退出后，已修复联系人必须自动重验续读，不围栏；真正的来源变化（账号、会话、代次、目标不可证）仍必须围栏并停读。
- 不得用“清库、改身份、直接删围栏”代替认证。
- 不放宽 ADR-127/133/144 的认证规则；若必须改规则，按领域文档写“与 ADR-XXX 冲突；重新讨论的原因是……”。用户已授权：与 ADR 冲突时可直接覆盖，但要新增 ADR 并补回链。

## 约束
- 真实库 `~/Library/Application Support/NotAloneDesktop/managed/sqlite/notalone.sqlite` 只读，不写；备份只读。
- 开发 App 在运行（`pnpm run dev` 热更新）：改源码会触发它重启，所以改代码、跑测试请在独立 worktree 里，合并前不要动主工作区的源码。
- 不要点任何“修复同步”；另外 15 位暂时保持围栏作为现场。
- 报告和提交里不出现联系人姓名、聊天内容；联系人用编号或 contact_id 前 8 位。

## 验收
- 一句话根因 + 证据（复现步骤或栈归因）。
- 失败用例先红后绿；`cd backend-ts && node --test` 相关文件通过；全量对照基线无新增失败。
- 在 00:05 备份副本上重跑同一流程：围栏不再新增。
- 文档：验证记录写入 `docs/verification/`；现行规格（`architecture/current/wechat-sync.md`）如有出入同步。
- 本地提交（Conventional Commits，中文，不加署名行），不 push。

## 不在范围
- 修复同步改增量读取（第二阶段，等本任务结论决定是否需要）。
- 存量旧副本清理的执行（已有 ADR-175 与离线工具，待用户确认）。
