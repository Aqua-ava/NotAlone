# 06 清空聊天与明确重读历史：实施与验证记录

日期：2026-10-30。工作树 `sqlite-rebuild-06`，分支 `sqlite-rebuild-06`，已合并集成分支（迁移 13=memoryDocuments、14=historyIncremental、15=historyClear）。本票完成清空/边界/显式重读的存储与产品接线、合成验证与桌面状态投影；真实微信 observer/reader 协议与最终制品仍未认证，生产适配器继续拒绝并按 `boundary_pending` 展示。

## 交付范围

| 文件 | 职责 |
| --- | --- |
| `backend-ts/src/history/sqlite/boundary.ts` | S(B) 候选合同与校验：完整目标分片、每分片 pre/post 短获取窗口相等、实例/命名空间连续性、完整 manifest 与精确成员、每分片成员数=实际成员、有界重试分类、不读旧正文/媒体 |
| `backend-ts/src/history/sqlite/clear-schema.ts` | 迁移 15：`history_cutoff`（pending/verified/blocked，B 固定不可后移）、`history_cutoff_member`、`history_restore`（显式重读独立授权） |
| `backend-ts/src/history/sqlite/clear-actions.ts` | `history.clearBegin/boundaryPersist/boundaryAccept/boundaryInvalidate/clearRequest/clearStatus/cutoffStatus/restoreBegin/restoreAttach/restoreComplete/restoreStatus`；屏障、接受页排除、重读授权接缝 |
| `backend-ts/src/history/sqlite/clear.ts` | 清空编排：05 plan 立即推进代次与写者 fence → 只读边界 → 完整候选持久化后原子接受 B → 05 清理；取消/中断/失败调用 `boundaryInvalidate`，缺边界保持 `boundary_pending` |
| `backend-ts/src/history/sqlite/resync.ts` | 显式重读：重新核验账号/身份 → 新 verification/grant 与独立请求键 → 独立目标 → 幂等读取重叠消息；不恢复旧记忆/会话/媒体/证明，不触发模型或媒体 |
| `backend-ts/src/history/sqlite/clear-http.ts` | `POST/GET /api/contacts/:id/history/clear`、`.../history/resync`，严格请求形状与脱敏投影；`clearQueryAllowed` 宿主查询门 |
| `history/sqlite/suppression.ts`（04 落地的固定接缝） | 函数体接入 06：barrier=0 沿用联系人级 fence；barrier>0 必须有该会话该代次且同 source generation 的 verified B；候选 pending/blocked 继续拒绝 |
| `history/sqlite/actions.ts`（04 落地的两处 accept） | 历史与增量接受页都把 B 成员排除作为 `ingest` 的 `exclude` 回调（`clear_excluded`），06 来源删除仍为 `source_excluded`；显式重读授权可绕过本联系人的清空排除 |
| `sqlite-host-plugin.ts` / `storage/sqlite/registry.ts` | 清空/重读服务与 HTTP 路由接线、迁移 15、宿主资源关闭；04 的增量协调器与状态投影保持 |
| `desktop/src/**` + `desktop/tests/**` | 联系人页“清空聊天与重新同步历史”面板、IPC 桥、控制器与真实 SQLite HTTP 契约测试；状态只含原因码与计数 |
| `backend-ts/test/sqlite-clear-*` | 合成验收（见下），含 v12→15 升级、来源代次变化、取消 abort、慢清理等 |

## 验收对照（票内 12 条勾选项）

| 票内验收 | 实现与合成证据 |
| --- | --- |
| 清空覆盖全部已存文字/占位/来源及派生资料，保留联系人与同步选择；05 推进单调代次封禁旧历史目标/处理/文件结果，不按普通暂停小批规则放行旧写入 | `清空覆盖该联系人全部已存消息/来源/目标…`：05 `contact_history` scope 完成、全部检查无 blocked、联系人隔离与选择保留；`清空期间在途旧页被05排空…`：在途旧读者被 fence、迟到页按旧资格拒绝 |
| 已授权且允许读取时持有完整相关分片只读连接，仅枚举必要身份元数据 S(B)，含本机已有而从未读过的旧页；不读旧正文/媒体、不整库备份 | `S(B)覆盖本机已有而应用从未读过的旧页…`：先入库 2 条、边界集合 5 条（含 3 条从未读入）；边界阶段 `pageCalls` 不变；候选成员仅含 `partition/localId`。真实 observer/reader 协议未实现（B2，见剩余风险） |
| 每分片独立 observer/reader：全部 pre → reader 读固定快照 → 原 observer post；短获取窗口相等并核验实例/完整命名空间连续性；reader 枚举期间允许源正常提交 | `prepareBoundaryCandidate` 校验 `preSample===postSample`、`readerCompleted`、每分片成员数=实际成员、目标分片全覆盖、实例/命名空间连续；窗口变化重试用例证明只有该原因重试。真实原生协议属未认证适配器能力 |
| 获取窗口变化仅接受前有界重试；不能给微信加写锁/暂停/改日志模式；分片变化、实例替换、取消或无法证明连续性时候选失效 | `获取窗口变化…`：3 次上限、实例/命名空间 1 次即失效；`取消/中断使S(B)候选失效…`：stop 后候选 `blocked`、未 verified、`completed=false` |
| 完整 manifest 与精确成员持久化后原子接受 B；分段候选不提前生效，不覆盖/撤销旧有效排除；不只存最大号/时间/摘要 | `分段候选在原子接受前不生效…`：persist 后 pending，`history.begin` 仍拒绝；accept 同事务重算 manifest；`二次清空…` 旧 B 不变 |
| B 是源快照切面，接受后的重试/重启/慢清理不得后移；B 后合法新消息必须能在新资格下进入，不把旧 writer 拒绝当丢弃新消息的理由 | `已接受B后重启只沿用固定切面…`、`已接受B但清理未完成时新消息保留…`（重启 `cleaning`→沿同一 B 清理完成、不重读边界）；`S(B)…`/`二次清空…` 新消息进入、旧成员排除 |
| 读取前、分段和接受前复验账号/联系人/开关/授权和代次；关闭或撤销后不偷读元数据，缺边界明确 boundary_pending，不显示成功 | `关闭读取或撤销后不为边界偷读元数据…`：零边界调用、`boundary_pending`、`completed=false`；分段中撤销拒绝接受；`边界能力未认证时…` 保持 pending |
| 清理按照 05 覆盖实际来源闭包；合法新代次消息不得被旧清理误删，完成须分面复核 | 05 注册域全部执行且无 blocked；`contact_history` 的 `scope_suppression` 仅在本操作 verified B 后通过；慢清理只清旧代次（`accepted_data_generation <`）并保留新消息 |
| 只有用户明确选择该联系人重新同步全部本机可读历史，重新核验账号/身份后创建独立操作和新授权；普通重启/重选/后台重试不解除历史抑制，不把全部排除记录清零 | `普通重启/重选/后台重试不解除历史抑制…`；`显式重读创建全新授权…`：新 verification/grant/selection_generation、独立请求键 |
| 显式重读创建新来源并幂等处理重叠消息，不恢复旧记忆、助手会话、媒体、旧证明或旧执行，不自动触发记忆/媒体处理，微信与外部原件不变 | `显式重读…`：同请求键不重读不重建、来源删除排除保持；只调用历史渠道，模型/媒体端口未接入 |
| 验证首次历史未完、从未读入旧页、同秒/乱序、清空中来新消息、候选中断、已接受B后崩溃与关停；全部拒绝不能算通过 | 首次历史未完→清空、从未读入旧页、同秒/乱序、清空中新消息、候选中断/取消、已接受 B 后重启/崩溃、v12→15 升级均有正向完成用例 |
| 真实支持档与最终读取制品须认证；复用研究库机制不认证当前微信；未知回填类别不得猜新消息，旧排除保护仍保持 | 生产 `createWechatHistoryChannel` 不提供 `boundarySnapshot`（测试断言 absent + unverified），真实清空只封禁+清理并 `boundary_pending`；来源删除排除永久保持；来源代次变化时旧 B 被拒（`来源代次变化后旧B不放行普通读取…`） |

## 独立审查修复（t03 只读审查，fixed 0e9f51d3）

- B1（阻断）取消/中断不使候选失效：`captureBoundary` 在 boundary 返回后、persist 前、accept 前均检查 `combined.aborted`，非成功路径调用 `history.boundaryInvalidate` 并返回 `history_interrupted`；新增取消用例断言未接受、`completed=false`。
- B3 跨来源代次：verified B 绑定并比对 `source_generation`，代次变化后普通读取直接拒绝；新增来源换代价用例。
- S5：`restoreBegin` 的 `proof.accountKey/conversationKey` 与 live account/conversation external_key 交叉比对。
- S6：`prepareBoundaryCandidate`/`validatePrepared` 增加每分片成员数=实际成员复核。
- S3：`boundaryInvalidate` 已接入取消/失败路径；删除未使用 helper；`history_restore.state='failed'` 不再存在（重读失败保留 active/authorized 供同请求键续跑，不制造死状态）。
- S2：本票迁移已按 Lead 分配定为 15。

## 验证命令与结果

```
cd backend-ts
pnpm run typecheck                                     # 通过（锁定 TS 7.0.2）
node --test test/sqlite-clear-resync.test.mjs          # 17/17
node --test test/sqlite-clear-http.test.mjs            # 4/4
node --test test/sqlite-private-history.test.mjs test/sqlite-history-http.test.mjs \
  test/sqlite-deletion.test.mjs test/sqlite-deletion-metadata.test.mjs \
  test/sqlite-contact-binding.test.mjs test/sqlite-incremental-sync.test.mjs \
  test/sqlite-incremental-handoff.test.mjs test/sqlite-incremental-controls.test.mjs  # 107/107
ELECTRON_RUN_AS_NODE=1 <Electron> --test test/sqlite-history-host.test.mjs \
  test/sqlite-history-startup-host.test.mjs test/sqlite-host-launch.test.mjs \
  test/sqlite-host-close.test.mjs test/sqlite-contact-close.test.mjs \
  test/sqlite-history-sync-status.test.mjs              # 28/28（Electron Node v24.21.0）
cd ../desktop
pnpm run typecheck                                     # 通过
node scripts/test-inventory.mjs                        # 分类登记通过
node --test tests/sqlite-history-clear-contract.test.mjs  # 2/2（真实SQLite+HTTP+桌面控制器投影）
node scripts/check_public_history.mjs --ref HEAD --working-tree  # 0 问题
```

## 数据影响

- 只使用隔离临时 SQLite（`role=test`）、合成身份/消息/边界身份集合与受管测试目录；未读取真实微信正文/媒体，未调用模型，未发送或撤回消息，未启动 App。
- 合成清空会实际删除测试库中的历史行/来源并执行 05 检查点/VACUUM 复核；测试临时目录自动清理。

## 剩余风险与缺口

1. **B2 真实能力未认证**：S(B) 的 observer/reader 真实协议、完整分片/命名空间连续性认证与最终 WCDB 制品仍未实现；生产 `wechat-channel` 无 `boundarySnapshot`，真实清空只做封禁+清理并明确 `boundary_pending`，不显示成功。票第 2/3/4 条的真实渠道部分不能标通过。
2. **非空派生闭包组合**：05 各域自身已验收；本票合成只证明 `contact_history` scope 经 05 注册域执行且无 blocked。非空记忆/助手/媒体闭包与重读不恢复的端到端组合留 20/21 复核。
3. **真实回填类别**：已接受 B 后非成员身份按“同一连续来源的新消息”处理；来源连续性未认证时生产不读取，因此不存在猜新消息的放行。未来其他渠道回填需新支持档，不在本票范围。
4. **桌面实际 App**：面板与控制器契约测试通过；实际热更新 App 的清空/重读交互验收待 Lead 分配串行桌面窗口，本轮未启动 App 或占用桌面。
5. **旧结构升级**：已用 v12 库升级到 15 并重开验证；包含真实历史数据的更老结构升级仍按 09/04 各自迁移测试与后续切换票复核。
