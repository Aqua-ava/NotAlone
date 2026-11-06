# 被围栏联系人覆盖映射与共享读取器失证修复验收记录（2026-11-06）

> 本记录只含计数、耗时、阶段、原因码与代码位置；不含联系人名称、明文联系人 ID、聊天正文或账号目录。
> 对应问题：库内 280 位活跃联系人中 278 位带来源连续性围栏、280 条守卫全部 `lost` 且不属于当前运行代次；其中 275 位曾在 01:55 批量修复成功，3 位因旧来源撤回记录无法映射而失败；20:06 重启后同步捕获为 0。

## 1. 结论

| 项 | 结果 | 说明 |
| --- | --- | --- |
| 根因：重启导致全体围栏 | **否定** | 围栏发生在 19:25:59 一轮同步中途（该批 goal 在 235/280 处停止，之后 0 新 goal），早于 19:31/20:06 任何重启；20:06 后捕获为 0 是因为围栏已存在而读取被停，不是重启造成。 |
| 根因：共享读取器失证放大 | **确认（机制层）** | 共享 wx-cli 进程因任一读取收到来源连续性错误码而整体停止时，同一 `failureCode` 被广播给所有共享该进程的守卫；旧实现把该码记到每个守卫的 `sourceLost`，同时 `markContinuityLost` + `guardRelease(sourceLost)`，一次事件把当时已持守卫的联系人批量围栏、lease 置 lost 且不建 goal。可解释 237 条（e45076cd 运行期，19:25:59）与 38 条（9d06c4ed 运行期，12:06-12:10，同期有 WeChat 12:10:58 崩溃报告）。 |
| 根因：重启后的 normal-use 重验 | **正常** | 在真实库只读副本上按 `continuity.ts` 逐条复算：忽略既有 fence 时 278/278 满足 `normalUseRevalidationCandidate=true`；真机对照实验（21:22 修复 1 位后 21:23 干净重启）显示该联系人 guard 自动续租到新运行代次、21:23:59 新建 history goal、captures 继续，**没有重新围栏**。 |
| 修复 A：旧代次撤回覆盖映射 | **通过** | 旧 `source_recalled` 键仅当当前代次在同一[分片,表实例,本地行号]独立记录为撤回、且读取契约/账号/会话/目标物理位置一致时才映射；覆盖写入独立 `covered_terminal_mapping` 审计，不冒充 ADR-161 双读取器证明；未覆盖仍 `history_recertify_suppression_unmapped`。3 位失败联系人在真实库只读 dry-run 11/11 命中，真机重新认证全部通过。 |
| 修复 B：共享读取器整体停止不放大围栏 | **通过（自动测试+真机重启对照）** | 只有正在读取且自身操作实际收到来源错误码的联系人按失证围栏；空闲/停车守卫只降级 `lost` 并 `deferVerification`，下一次读取仍须完整重验，真实变化/重验不可用仍围栏。 |
| 3 位失败联系人修复 | **通过** | 围栏 278→275；每位重新认证 `completed`，guard 续租，`model_call` 保持 1370；2 位在开发 App 联系人页“处理同步问题→修复同步”真实点击确认，1 位在根因对照实验中经同一后端 recertify 路径完成。 |
| 恢复其余被围栏联系人 | **进行中（本记录时点）** | 本记录时点 fences 236、批量已处理 21/257 位（快照 257 位）；串行调用与联系人页“修复同步”相同的后端路径，后台继续。剩余约 236 位、约 20 万条消息需重新读取。 |
| 无模型调用、无外部消息 | **通过** | 全部修复与批量过程 `model_call` 保持 1370；未发送任何外部消息；未打包、未运行打包版。 |
| 数据保留 | **通过** | 重新认证/修复只新增绑定与重新读取数据，不删除旧资料；备份保留于任务开始前。 |

## 2. 前置与备份

- 开发实例：`pnpm run dev`（`dev:status` 为 development）；读取程序与微信版本沿用 2026-11-06 既有验收记录。
- 任务开始前在线备份：`~/Library/Application Support/NotAloneDesktop/backups/sqlite/before-fence-restart-fix-20261106.sqlite`（3,199,328,256 字节，非仓库）；`immutable=1` 打开 `quick_check=ok`；备份上围栏 278、`lost` 守卫 280、活跃联系人 280。
- 基线（21:19）：围栏 278；活跃联系人 280；`model_call` 1370；`message` 294,387；`media_file` 3,267；`deletion_check` 2,640；读取总开关开启；当前运行代次随 App 重启多次变化。

## 3. 根因与修复

### 3.1 为什么不是重启

- 真实库：18:24–19:25 每 30 秒一批约 235–270 个 goal（280 位轮转）；**19:25:30–19:25:59 这批只写到 235 个就停在 19:25:59.660**，此后直到 19:31 重启前 0 新 goal、0 新 capture。
- 真实库：278 条 fence 与 280 条 lease 全 `lost`，lease 保留旧运行代次（237×e45076cd、38×9d06c4ed、3×d5de0c12、2×4d0b0307），与“先批量围栏、之后读取全部停读”一致。
- 只读副本逐条复算：忽略既有 fence 时 278/278 满足 normal-use 重验条件（lease lost、绑定/会话/来源代次匹配、scope 非空且 accountKey 匹配、最新 goal continuity=same-source-instances-normal-use-v1、scope target 与最新 goal target 全为 `same`）；任何一次真实读取都会走 `prepareNormalUseTarget` 的 revalidated 分支。堵住恢复的是已存在的 fence 行，不是运行代次变化。
- 真机对照：21:22 修复 1 位后 21:23 菜单退出并 `nohup pnpm run dev` 正常重启；新运行代次下该联系人 guard 变为 active，21:23:59 新建 history goal、21:24:02 complete、incremental running，captures 继续，无新围栏。

### 3.2 批量围栏机制

- `wechat-channel.ts` 的 `guardSession.failureCode()` 在共享模式下返回同一个共享进程停止码；`native-client.ts` 对任意允许的来源类错误响应（`history_source_changed` / `history_scope_changed` / `history_schema_changed` 等）都会停止整个共享进程。
- 旧 `service.ts` 在守卫丢失时把该错误码直接记为每个守卫的 `sourceLost`；`guardRelease` 对 `sourceLost=true` 执行 `fenceContinuity`，同时 `markContinuityLost`。因此一次读取的来源错误会同时围栏所有已持守卫联系人，并留下“lease lost + 旧运行代次 + 无新 goal”的批量形状。
- 12:06-12:10 的 38 条为同型更早事件，对应 WeChat 12:10:58 崩溃报告；19:25:59 事件未找到崩溃报告（旧 dev 日志已被重启覆盖），但数据形状与代码路径一致。

### 3.3 修复

- 提交 `d04807f27`（任务 A）：`legacy-physical-suppression.ts` / `recertify-actions.ts` 增加窄覆盖规则与独立审计；`completedLegacyPhysicalKeys` 同时识别 ADR-161 证明与覆盖审计；删除任一代次时清理两代来源与终态并保留两代未来排除；新增合成夹具与 7 个用例；更新 ADR-161 与现行规格（domain-data / privacy-deletion / wechat-sync）。
- 提交 `72bb5c474`（任务 B）：`service.ts` 仅对“正在读取且自身操作收到来源错误码”的联系人保留 `sourceLost`，其余共享进程停止只把守卫降级 `lost` 并标记 `deferVerification`；`actions.ts` 对 `deferVerification` 只置 lost、不 fence；下一次读取仍须完整重验账号/会话/来源代次/物理目标/目标转移，真实变化或重验不可用仍围栏。新增 `sqlite-history-shared-process-loss.test.mjs`（9 例）与夹具；更新 parked-sync-handoff、source-ready-wake-controls 期望；`architecture/current/wechat-sync.md` 增加共享读取器失证与跨运行代次重验规则。

### 3.4 验证命令

- 任务 A：新测试 7/7；相关 recertify/legacy 测试 111/111；`pnpm run typecheck` 通过；真实库只读 dry-run 旧键 11/11 命中。
- 任务 B：聚焦 22/22；相关全量 322 例 321 通过，唯一失败 `sqlite-history-startup-host` 的 manual 正式 profile 409（`memory_auto_processing_disabled`，HEAD 纯源码复跑同样失败，属既有失败）；`tsc --noEmit` 通过。
- 真机：3 位失败联系人重新认证全部 `completed`（分别约 7 秒、约 3.5 分钟、约 3.5 分钟；页面数随消息量 41 页 / 2 页 / 约 1,300 页量级），围栏 278→275，`model_call` 1370 不变。

## 4. 恢复执行（本记录时点）

- 修复 3 位后，剩余 275 位仍被围栏；其中 2 位在联系人页“处理同步问题→修复同步”由 Agent 真实点击确认，1 位在根因对照实验中经同一后端 recertify 路径完成。
- 恢复其余联系人的批量入口为设置页“高级→开发者调试→批量修复同步（开发模式）”；开发 App 中曾启动一次该面板批次（快照 257 位），因与并行验证脚本同时驱动后端导致同一时刻出现两个 `running` 认证记录、进度停滞；随后停止脚本并干净重启开发 App，清空在途记录，改由与面板相同的后端 recertify 路径串行恢复（用户已授权在后端同一路径串行恢复）。后台任务继续运行，逐位轮询到终态，App 重启导致连接失败时等待后端恢复后重试。
- 本记录时点进度：fences 236（本次批量已处理 21/257 位，全部 `completed`，无失败码）；`history_guard_lease` active 38 / lost 242；`model_call` 1370；`message` 350,883（增量来自重新认证的新绑定与保留旧绑定并存，符合 ADR-144）；`media_file` 3,603；`deletion_check` 2,640。
- 剩余工作量以消息量计约 20 万条，按已验证吞吐（约 75 条/秒）预计还需约 40 分钟；后台脚本按围栏名单持续处理，完成时围栏应为 0。

## 5. 数据与边界

- 未调用模型（`model_call` 1370 全程不变）；未发送外部消息；未打包或运行打包版；未使用打包版。
- 旧资料保留：重新认证新增绑定与重新读取，旧绑定与旧终态保留；与备份比较未执行逐联系人删除检查（本轮修复只新增读取与绑定，不删除资料）。
- 备份保留在用户目录备份区（非仓库），供复核。
- 仓库提交只含任务代码、测试、文档与本记录；未包含并行会话的未提交改动。

## 6. 限制与未完成

- 19:25:59 共享读取器为何收到来源类错误码的**触发源**未能从日志/崩溃报告定位（旧 dev 日志被覆盖）；修复针对“错误码广播放大成整批围栏”的机制，单次真实来源变化仍会且只会在本人读取处围栏。
- 批量恢复在本记录时点尚未完成；完成后的最终围栏数、重启稳定性与图片后台恢复需在批量结束后复核。
- 批量恢复使用后端同一 recertify 路径串行执行（因并行会话频繁重启开发 App 打断 UI 面板；用户授权）；UI 面板本身的批量验收已在 2026-11-06 01:55 记录中覆盖。
- 本轮未重新执行“候选回复生成”真机核对；回复读取路径与本次同步/认证改动无交集，且全程未发送外部消息。
- 仅在开发宿主验证；打包版不暴露批量入口由自动测试覆盖。
