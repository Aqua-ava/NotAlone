# 06 清空聊天与明确重读历史：实施与验证记录

日期：2026-10-30。工作树 `sqlite-rebuild-06`，基线 `codex/sqlite-rebuild-integration`。本轮只完成票 06 范围内实现与合成验证；真实微信边界协议未认证，生产适配器继续拒绝，桌面实际 App 验收待串行窗口。

## 交付范围

新增独立模块（共享 history 写入路径等 04 进入基线后再按 t04 接缝接线）：

| 文件 | 职责 |
| --- | --- |
| `backend-ts/src/history/sqlite/boundary.ts` | S(B) 候选合同与校验：完整目标分片、pre/post 短获取窗口相等、实例/命名空间连续性、完整 manifest 与精确成员、有界重试分类、不读旧正文/媒体 |
| `backend-ts/src/history/sqlite/clear-schema.ts` | 独立迁移函数：`history_cutoff`（pending/verified/blocked，B 固定不可后移）、`history_cutoff_member`、`history_restore`（显式重读独立授权） |
| `backend-ts/src/history/sqlite/clear-actions.ts` | `history.clearBegin/boundaryPersist/boundaryAccept/boundaryInvalidate/clearRequest/clearStatus/cutoffStatus/restoreBegin/restoreAttach/restoreComplete/restoreStatus`；`history.begin` 屏障、接受页排除、重读授权的接缝函数 |
| `backend-ts/src/history/sqlite/clear.ts` | 清空编排：先经 05 plan 立即推进删除代次和写者 fence，再尝试只读边界，完整候选持久化后原子接受 B，随后推进 05 清理；缺能力/关闭/撤销时明确 `boundary_pending` 且不显示成功 |
| `backend-ts/src/history/sqlite/resync.ts` | 显式重读：重新核验账号/身份 → 撤销旧许可并建立新核验/新 `read_grant` → 独立 `read_goal` 目标 → 幂等读取重叠消息；只写历史来源，不恢复旧记忆/会话/媒体/证明，不触发模型或媒体 |
| `backend-ts/src/history/sqlite/clear-http.ts` | 固定路由 `POST/GET /api/contacts/:id/history/clear`、`.../history/resync`，严格请求形状与脱敏投影；宿主查询门 `clearQueryAllowed` |
| `desktop/src/{shared,main/preload,main/history-clear,renderer}` | 联系人页“清空聊天与重新同步历史”面板、IPC 桥与状态投影；只展示原因码与计数，不含正文/渠道键/边界证明 |
| `backend-ts/test/sqlite-clear-resync.test.mjs`、`sqlite-clear-http.test.mjs` | 合成验收（见下） |

## 验收对照

| 票内验收 | 实现与合成证据（`sqlite-clear-resync.test.mjs` / `sqlite-clear-http.test.mjs`） |
| --- | --- |
| 清空覆盖全部已存文字/占位/来源及派生资料，保留联系人与同步选择；05 推进单调代次封禁旧历史目标/处理/文件结果，不按普通暂停小批规则放行旧写入 | `清空覆盖该联系人全部已存消息/来源/目标…`：05 `contact_history` scope 完成、全部检查无 blocked、两联系人隔离、联系人/选择保留；`清空期间在途旧页被05排空…`：在途旧读者被 fence，迟到页按旧资格拒绝（非普通暂停收尾） |
| 已授权且允许读取时持有完整相关分片只读连接，仅枚举必要身份元数据 S(B)，含本机已有而从未读过的旧页；不读旧正文/媒体、不整库备份 | `S(B)覆盖本机已有而应用从未读过的旧页…`：先入库 2 条，边界集合 5 条（含 3 条从未读入）；边界阶段 `pageCalls` 不变（不读正文页）；`late page identities never resurrect…` 断言候选成员仅含 `partition/localId` |
| 每分片独立 observer/reader：全部 pre → reader 读固定快照 → 原 observer post；短获取窗口相等并核验实例/完整命名空间连续性；reader 枚举期间允许源正常提交 | `boundary.ts` 校验 `preSample===postSample`、`readerCompleted`、目标分片全覆盖、`instanceContinuity`/`namespaceContinuity`；获取窗口变化重试用例证明只有该原因重试。真实 observer/reader 原生协议属于未认证适配器能力，生产 `wechat-channel` 不实现 |
| 获取窗口变化仅接受前有界重试；不能给微信加写锁/暂停/改日志模式；分片变化、实例替换、取消或无法证明连续性时候选失效 | `获取窗口变化仅接受前有界重试；实例或命名空间不连续立即失效`：3 次上限、实例/命名空间 1 次即失效且 `boundary_pending` |
| 完整 manifest 与精确成员持久化后原子接受 B；分段候选不提前生效，不覆盖/撤销旧有效排除；不只存最大号/时间/摘要 | `分段候选在原子接受前不生效…`：persist 后 `state=pending`，`history.begin` 仍被拒；接受后 `verified`。manifest 由完整成员集合 + 目标描述哈希，成员逐行持久化；`二次清空…` 证明旧 B 不被覆盖 |
| B 是源快照切面，接受后的重试/重启/慢清理不得后移；B 后合法新消息必须能在新资格下进入，不把旧 writer 拒绝当丢弃新消息的理由 | `已接受B后重启只沿用固定切面…`：重启后 barrier/manifest 不变；`S(B)…` 与 `二次清空…`：B 后新消息进入、旧成员按身份排除；05 清理只处理 `accepted_data_generation < 新代次` 的目标 |
| 读取前、分段、接受前复验账号/联系人/开关/授权/代次；关闭或撤销后不偷读元数据，缺边界明确 boundary_pending，不显示成功 | `关闭读取或撤销后不为边界偷读元数据…`：关闭/撤销时边界调用 0 次、`boundary_pending`、`completed=false`；分段中撤销拒绝接受；`边界能力未认证时…`：先清理已保存资料并保持 pending |
| 清理按 05 覆盖实际来源闭包（本人资料、记忆、助手副本、追踪及媒体当前/旧/暂存件）；合法新代次消息不被旧清理误删，完成须分面复核 | 05 注册域全部执行且无 blocked（`清空覆盖…` 断言）；`history` 域 `scope_suppression` 仅在该操作自己的 verified B 后通过（`history.ts` verify）；新代次消息不被收集由 `contact_history` 的 `accepted_data_generation <` 条件和 B 后新消息用例覆盖。非空记忆/媒体闭包的端到端组合仍由 20/21 复核（05 已完成各域自身验收） |
| 只有用户明确选择该联系人重新同步全部本机可读历史，重新核验账号/身份后创建独立操作和新授权；普通重启/重选/后台重试不解除历史抑制，不清零全部排除 | `普通重启/重选/后台重试不解除历史抑制…`：重启、重选、重复同步均不恢复；`显式重读创建全新授权…`：新 `verification` + 新 `grant` + `history_restore` 独立请求键 |
| 显式重读创建新来源并幂等处理重叠消息，不恢复旧记忆/会话/媒体/旧证明/旧执行，不自动触发记忆/媒体处理，微信与外部原件不变 | `显式重读…`：重复相同请求键不重读、不重复建消息；来源删除排除仍保持（旧来源不恢复）；只调用历史渠道，模型/媒体端口未接入该路径 |
| 验证首次历史未完、从未读入旧页、同秒/乱序、清空中来新消息、候选中断、已接受 B 后崩溃与关停；全部拒绝不能算通过 | 首次历史未完 → 清空：`S(B)…`（先只同步 2 条后清空）；从未读入旧页同上；同秒/乱序：`二次清空…`；清空中来新消息：`清空期间在途…`；候选中断：`分段候选…`（重启后 pending 续做）；已接受 B 后崩溃/关停：`已接受B后重启…`。全部用例均验证正向可完成路径 |
| 真实支持档与最终制品须认证；复用研究库机制不认证当前微信；未知回填类别不得猜新消息，旧排除保护仍保持 | 生产 `createWechatHistoryChannel` 不提供 `boundarySnapshot`（`sqlite-clear-http.test.mjs` 断言 absent + unverified），真实清空只能封禁+清理并保持 `boundary_pending`；自动同步在已接受 B 后仍按 B 成员身份排除旧出现，05 来源删除排除永久保持；未把合成 observer/reader 当真实 WAL/分片认证 |

## 验证命令与结果

```
cd backend-ts
node --test test/sqlite-clear-resync.test.mjs          # 12/12
node --test test/sqlite-clear-http.test.mjs            # 4/4
node --test test/sqlite-private-history.test.mjs test/sqlite-history-http.test.mjs \
  test/sqlite-first-history-coordinator.test.mjs test/sqlite-history-sync-status.test.mjs \
  test/sqlite-history-hooks.test.mjs test/sqlite-deletion.test.mjs test/sqlite-deletion-metadata.test.mjs \
  test/sqlite-contact-binding.test.mjs test/sqlite-media.test.mjs test/sqlite-media-deletion.test.mjs \
  test/sqlite-memory-deletion.test.mjs test/sqlite-shared-execution-deletion.test.mjs \
  test/sqlite-discussion-deletion.test.mjs              # 118/118
ELECTRON_RUN_AS_NODE=1 <Electron> --test test/sqlite-history-startup-host.test.mjs \
  test/sqlite-history-host.test.mjs                     # 11/11（环境：仓库 Electron Node v24.21.0）
pnpm run typecheck（backend-ts、desktop）               # 通过
```

全量后端套件与桌面套件结果见集成回报。普通 `node` 运行宿主类测试会因 `node-addon-require-builtin` 原生绑定不可用而失败，已按 Lead 说明改用 Electron 自带 Node，未误判为代码回归。

## 数据影响

- 只使用隔离临时 SQLite（`role=test`）和合成身份/消息/边界身份集合；未读取真实微信正文/媒体，未调用模型，未发送或撤回消息。
- 合成清空会实际删除测试库中的历史行/来源并执行 05 检查点/VACUUM 复核。
- 未修改用户业务库、未提交私人聊天/身份/凭据。

## 剩余风险与依赖

1. 真实 WCDB observer/reader 协议与完整分片/命名空间连续性认证仍是 03/06 共同真实门槛；生产必须保持 `boundary_pending`，不能把合成协议当真实通过。
2. 与 04 的共享 history 写入路径（`suppression.ts`/`ingest.ts`/`contracts.ts`/`service/http`/`sqlite-host-plugin`/desktop sync 状态）尚未接线：本分支为独立实现，按 Lead 约定在 04 进入基线后 rebase 并只做最小接线；当前迁移版本在本分支为 13 占位，合入时改为 15。
3. 05 的非空记忆/助手/媒体闭包由各域自票验收；06 只验证 `contact_history` scope 经 05 注册域执行且无 blocked，端到端组合留 20/21。
4. 桌面面板已实现并通过类型检查，实际热更新 App 的清空/重读交互验收待 Lead 分配串行桌面窗口；当前未启动 App、未占用桌面。
5. 全量套件中历史归档/真实宿主测试依赖环境（Electron Node），报告按实际命令与差异记账。
