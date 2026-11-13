# SQLite 重建批次验收报告（2026-10-30，本地协调稿，不发布）

分支：codex/sqlite-rebuild-integration（仅本地，无远端、无 push/PR）
批次基线：33e7dedc → 最终 HEAD：2197731a（共 96 个本地提交）
改动规模：221 files changed, +27637 / −4530
迁移账本：1..15（13=memoryDocumentsMigration、14=historyIncrementalMigration、15=historyClearMigration；1..12 原文未改）
唯一任务索引：planning.md（本报告不替代索引）

## 1. 任务状态表（17 项有效范围 + 4 项暂缓）

| # | 票 | Triage | State | 集成 | 真实渠道结论 |
| --- | --- | --- | --- | --- | --- |
| 01 | SQLite 底座与生命周期 | ready-for-agent | resolved | 批次前已集成 | 既有证据复用 |
| 02 | 联系人绑定与同步授权 | ready-for-agent | resolved | 批次前已集成 | 真实逐人确认/范围未认证（03 阻塞） |
| 03 | 首次历史同步与消息展示 | needs-info | claimed | 7b934d73（文档复核） | **受阻**：真实普通历史/状态语义/来源生命周期/跨重启连续性未认证；真实 target/page 全拒绝 |
| 04 | 增量同步与读取控制 | ready-for-agent | claimed | 3ba737fc | 受控 dev 实机部分通过；真实增量/重选/断线/微信不在前台 CLI 同步未认证 |
| 05 | 统一来源删除与清理 | ready-for-agent | resolved | 批次前已集成 | 真实删除链需真实捕获（依赖 03/06） |
| 06 | 清空聊天与明确重读历史 | ready-for-agent | claimed | 2fdde8e2 | 存储侧原子接受真实验证；真实 observer/reader 边界协议与最终只读制品未认证（生产 boundary_pending） |
| 07 | 固定范围记忆提取与核验 | ready-for-agent | resolved | 批次前已集成 | 真实模型仅 07/11 既有受限调用 |
| 08 | 记忆候选、版本与修正 | ready-for-agent | resolved | 批次前已集成 | 合成+App 证据 |
| 09 | 主题资料与长期概览 | ready-for-agent | resolved | 5551aa5e / 13a33b18 / b2a4f0f1 | 合成+实际 App a–d 通过；真实模型语义质量未认证 |
| 10 | 记忆处理控制与恢复 | ready-for-agent | claimed | b5241920 / 66ab0fec | 后端+headless+App 可安全范围通过；模型相关控制状态未在 App 内构造 |
| 11 | 助手讨论与 DSH 副本 | ready-for-agent | resolved | 批次前已集成 | — |
| 12 | 候选回复与依据 | ready-for-agent | resolved | 批次前已集成 | — |
| 14 | 官方 Skill 加载接回 | ready-for-agent | resolved | 批次前已集成 | 本机官方 profile 启动用例超时（33e7dedc 同样失败，属环境） |
| 16 | 单条媒体保存与清除 | ready-for-agent | resolved | 批次前已集成 | 真实媒体类型关联未认证（19 暂缓） |
| 17 | 图片与视频提取 | ready-for-agent | resolved | 批次前已集成 | 真实资源入口保持关闭 |
| 20 | 默认切换 SQLite 与旧业务清理 | ready-for-agent | claimed | 312c7bec / b8577686 / d1068fbf / efa6c10a | 默认入口切换、结构审计、旧路径退役、隔离演练通过；**真实旧业务清理受阻未执行**（本机无 PG、旧对象归属不明） |
| 21 | 三份规格组合验收 | ready-for-agent | claimed | 2bdec8c6 | 17 项矩阵+四项暂缓+组合 592/592+App 闭环已交付；真实门槛未过，票保持受阻 |

暂缓（wontfix，不计通过、未启用）：13 表达偏好（入口 unavailable）、15 纠错诊断（入口 unavailable）、18 语音保存转换（历史实现保留、最小停用、voice adapters[] 隐藏）、19 真实媒体组合（未认证、入口关闭）。
App 首次使用/首用向导/安装包/发布继续排除。

## 2. 本批关键提交

- 03：34a6f98b（仅文档 +103 行）→ 7b934d73
- 09：e0f51331、8c7a66b5、fc5b2c54、e7df7dcd（迁移 13）→ 5551aa5e；回归修复 d5f3ee55 → 13a33b18；文档暂停边界 0f16b89d → b2a4f0f1
- 04：36470ec4、b9bf30a9、03d29a15、24e34a95、60ca9212、7075a55a、45086f26、bf0a1a6e、bad4c4ef（迁移 14）→ 3ba737fc
- 06：2376c1c5、2c838aef、f2d6a3ed、3ae18254、601f22fd、0e9f51d3、a2e6862d（迁移 15）→ 2fdde8e2
- 10：5121328a、7ccb026e、2051219b、b5cb9eaf、fe0d3d3f、3716a317、1fbdaade、1f798662、432fb4e4 → b5241920、66ab0fec
- 20：6c8c184f、52ab1a6f、8efbabfd、4f782e12、ad44bafa、38ddd016、ed4bce2c、154ac9e2、d74a9b2c → 312c7bec、b8577686、d1068fbf、efa6c10a
- 21：9ba6e733、567a81c0、ea1f45ed、02c3c063、abb9d36a、541119e7 → 6f13fd9b → 2bdec8c6
- 跨票缺陷修复：154ac9e2（05 删除门禁 × 06 清空边界交互：内容类未完成删除不再关闭联系人名单服务；contact/account 删除仍关闭）

## 3. 改动摘要

- 历史/增量/清空：history/sqlite 增 cursor/ingest/suppression/incremental-schema/incremental-coordinator/boundary/clear*/resync，宿主协调器与 /api/sync/status 增量投影，桌面同步状态与清空/重读面板。
- 记忆/文档/控制：迁移 13 documents 合同（版本/依据/发布集合/CAS/范围）、迁移 14 增量游标与 message status、控制状态投影/CAS/租约/unknown 防护、09 暂停边界。
- 切换与退役：platform/cutover 控制面（独立 database_id/owner/账本、维护态、原子切配置、清理演练与授权门禁）、旧 PG 启动路径与手动文件导入退役、结构审计（82 表/814 列/252 CHECK/92 触发器/views/FK action）与 77/778/215/115 逐项 disposition、ADR-089/100/101/102/107/108/109 修订。
- 桌面：默认 SQLite 入口、同步/清空/记忆/文档/启动诊断页面与桥；测试清单登记。
- 文档：docs/verification 下 03/04/06/20/21 等验证记录。

## 4. 数据处理影响

- 全部开发与验收仅使用隔离合成 SQLite（role=test）、合成联系人/消息/候选/记忆与受管临时目录；未读取真实微信正文/名单/媒体，未调用真实模型（本轮 0 次），未迁移/恢复实验，未执行真实切库/drop/真实旧业务清理，未打包/运行打包版，未 push/PR。
- 真实旧业务库/含内容助手会话/缓存/派生文件因本机无 PG、归属无法确认，按裁决保持未清理并如实记录。
- 主仓用户原有 .gitignore 修改与未跟踪资料未触碰；未提交任何私人聊天、身份、凭据、截图或真实媒体。

## 5. 验证命令与结果（代表性）

- 两端锁定 TypeScript 7.0.2（backend-ts/node_modules/.bin/tsc 7.0.2）：backend/desktop typecheck 均 0 错误（多次复跑）。
- 票 09：sqlite-memory-documents* 10 文件 90/90（Electron Node）、sqlite-memory-extraction 10/10、桌面 46/46。
- 票 04：增量 4 文件 25/25、宿主 12/12（Electron Node）、desktop 21/21。
- 票 06：清空/重读 17/17、清空 HTTP 4/4、宿主 28/28、桌面契约 2/2。
- 票 10：sqlite-memory-control 15/15、记忆+清空+删除+文档+管理 108/108、桌面 23/23。
- 票 20：cutover 七文件+删除门禁重启 29/29、run-current 最终 1540/950/589（相对 15ac355a 无新增失败文件；非 PG 失败仅 2 项 memory-profile 既有）、默认入口 App 实测（8 项 checks、5 页、关停、重开同 database_id/owner）。
- 票 21：组合 A–G 592/592 + H 25/25 + I 45/45 + J 21/21 + K 27/27；App 五项+跨重启修复闭环。
- 公开检查：已提交树（各工作树/固定 ref）issues 0；主仓 working-tree 扫描 15 项为本机既有私有未跟踪资料与本地协调文件（未提交、不发布）。

## 6. 真实渠道状态（分别记账）

- 合成测试：通过（上述数字）。
- 实际开发 App（pnpm run dev，隔离合成根/CDP/环回供应商，不打包）：多票通过（09 文档阶段、10 统一状态、06 清空 pending、04 同步控制部分、20 默认 SQLite、21 组合 App 五项）。
- 真实模型：本批 0 调用；真实语义质量未认证（仅参考 07/11 此前受限调用记录）。
- 真实微信：本批 0 正文读取；仅 03 此前受控 metadata 观察；真实普通历史/状态语义/来源连续性未认证，真实 target/page 保持拒绝。
- 真实旧业务清理：未执行（归属不明受阻）。

## 7. 剩余风险与未通过项

1. 03 第 1/2 条：需正式 narrowing CLI/支持档与用户授权（真实逐人确认、固定文本发送+仅撤回一次；撤回测试用户已跳过）；正式安装 CLI 无 metadata 窄操作。
2. 04：真实增量能力（支持档 incrementalTail）、重选（需微信会话元数据）、断线实机、微信不在前台 CLI 同步。
3. 06：真实 WCDB observer/reader 协议、分片/命名空间连续性、最终只读制品；真实清除依赖 03 门禁。
4. 10：模型相关控制状态（暂停小批/继续复用/unknown/租约/取消清空后不恢复）不在 App 内构造，转由后端真实 service/actions+桌面 headless 覆盖；真实模型语义未认证。
5. 20：真实旧业务对象归属与清理未执行；本机无 PG、旧 backend-launch.json 外部项目未读。
6. 21：因 03/04/06/20 真实门槛未过而保持受阻（矩阵与缺口已交付）。
7. 本机环境限制：DSH runtime node 无法加载 pnpm 原生绑定，宿主类测试需 Electron Node（44.7.0 自带 Node 24.21.0）；默认 shim node 启动 dev 因 rolldown Team ID 不匹配失败，需 /tmp/t09-node/bin/node；sqlite-skill-profile 官方 profile 启动用例在 33e7dedc/15ac355a/最终树均 10s 超时（环境性，非本批引入）；92 个需 PG 的 current 测试为既有基线红。

## 8. 桌面与资源清理

- 桌面为单串行资源，按 03→09→04→06→10→t20→21 顺序分配，每次用完 Cmd+Q/正常退出并核验。
- 最终 dev:status = {"mode":"stopped","pids":[]}；无 dev 监督器/App/DSH/供应商残留；CDP 与后端端口关闭；隔离合成根、临时脚本、/tmp 审查归档已删除；WeChat 保持原运行状态；未强杀/接管未知进程。
- 各工作树保留（bbec/b1f3/sqlite-rebuild-04/06/10/20/21），分支仅本地。

## 9. Git 与工作区

- 集成分支 codex/sqlite-rebuild-integration @ 2197731a；96 个本地提交；无 push、无远端分支、无 PR、无打包产物。
- 工作区仅保留：用户原有 ` M .gitignore` 与既有未跟踪资料；本批新增本地协调文件（commander-handoff-20261030.local.md、本报告）为未跟踪、不发布。
- 目标达成情况：完成定义未全部满足（03/04/06/20 真实渠道与真实清理门槛未过），Goal 不标 complete，按阻塞如实收口。

## 10. Round 1–2 增补（Goal 自动续跑期间，2026-10-30）
- **票 20 resolved**：真实清理重评 N/A（只读证据：本机无 PG 进程/数据目录、无旧业务 SQLite/含内容助手会话/旧媒体副本；`~/.notalone` 仅 270 个 Skill 原目录 5.2M；默认 userData 仅 Chromium 缓存+wechat-tool 开发制品+配置），12/12＝11 通过+第 8 条 N/A。提交 aff0366d → 集成 3bae162a。
- **票 10 resolved**：App 级环回供应商实机 14/14（开始/处理中/暂停小批收尾/继续复用成功步骤/退出重开保持暂停/单人失败/共用故障固定原因/unknown 不继续不重发），实机修复在途 sending 误投影 unknown 与共用故障原因固定展示（sharedFaultCode）并补回归。提交 0fac4ada → 集成 a731d471。
- **票 21 矩阵增补**：row 10/20 改 resolved，§11 增补记录，仍 claimed/受阻。c8be50d5 → 集成 86db8e01。
- 当前 resolved **13 项**（01/02/05/07/08/09/10/11/12/14/16/17/20）；03/04/06/21 claimed（03/04/06 真实渠道门槛、21 依赖 06；19 暂缓不计）。集成 HEAD **bcf5671b**（round2 收口）。
- 增补后验证：sqlite-memory-control 16/16、桌面固定处理 23/23、两端 typecheck 0、public check（committed ref）issues 0；无 push/PR/打包；桌面 dev:status stopped/pids[]。
- 仍未满足完成定义：03 真实普通历史/状态语义/来源生命周期/跨重启连续性、04 真实增量/重选/断线/非前台 CLI、06 真实 observer/reader 与最终只读制品；21 因此保持受阻。
- Round2 资源清理：清理 t10 场景遗留 dev App 主进程与 20 个 `notalone-dsh-host-*` 临时目录、t10 seed 供应商孤儿进程；复检无 `--notalone-dev`/dev supervisor/供应商残留；dev:status stopped/pids[]；WeChat(PID 892) 与 DSH Harness(PID 99096) 保持原样；证据目录 /tmp/t04-shots、t09-app-shots、t10-app-shots、t21-evidence 保留。

## 11. Round2 最终独立验证（t03，只读）
- **票10 双轴审查（fixed 0fac4ada）：通过、无阻断**。两端锁定 TS 7.0.2 0/0；迁移 1..15 未改；t10 源码仅 8 文件；复跑 sqlite-memory-control 16/16、桌面固定处理 23/23、07/08/09 相关 48/48；在途 sending 修正正确（unknown 由 fail/recover/租约接替/超时四路径保证）。
- **最终集成树（HEAD bcf5671b）一致性 PASS**：两端 tsc 0/0；test-inventory 通过；`check_public_history --ref HEAD` issues 0；代表性组合 64/64；7 个票分支均为 HEAD 祖先；工作区仅用户 `.gitignore`+174 个未跟踪 `.scratch` 资料；dev:status stopped/pids[]。
- 非阻断残留（未冒充已修）：① t10 shared 故障同屏重复/措辞矛盾（`FixedMemoryProcessingPanel.tsx:26-32/135`），桌面无非空 sharedFaultCode 断言；② 09 文档阶段 `document_model_*` 共用故障未并入 sharedFailureCodes（只显示 later_stages_failed）；③ 建议补 sending 后崩溃重启→unknown 测试。
- 资源：清理批次遗留挂起测试进程 3 个（worktree-10/backend-ts、worktree-20/desktop ×2，含 52403 端口监听）；复检无 dev/供应商/测试残留。

## 12. 票10 审查后补丁（1c02305b → 集成 4a6d8930）
t03 审查提出的 4 项非阻断全部闭环：① 发送中崩溃→重启 `blocked/model_receipt_unknown` 无继续、迟到可验证回执只结算、旧租约不提交、载荷未归档允许各补一次不重放未知；② 共用故障展示去重并统一「修复后可继续原任务」，新增非空 `sharedFaultCode` 展示与非法原因码拒绝回归；③ `document_model_*` 四码纳入 `sharedFailureCodes`（budget/unknown/in_progress/closed 仍按各域）；④ 遗留进程核实清理、票面/边界记录。
验证：control 18/18、文档/管理 37/37、桌面固定处理 25/25、两端 typecheck 0、inventory 通过、public check `--ref HEAD` issues 0；无迁移/registry 变更。票10 最终树=1c02305b。

## 13. 票10 补丁独立确认（t03，fixed 1c02305b）
- 结论：**可收、无阻断**。sharedFailureCodes 11 码后端与桌面键完全一致（新增 document_model_* 四码，真实 09 路径会写入 task.error_code）；桌面非空 sharedFaultCode 展示/非法码拒绝断言真实。
- 发送崩溃回归断言：重启 `blocked`/`model_receipt_unknown`/`actions=[]`/`unknown=1`；迟到可验证回执只结算、旧租约不提交；继续后允许各补一次、不重放未知回执。
- delta 仅 7 个预期文件，无迁移/发布面改动；两端锁定 TS 7.0.2 0/0；control 18/18、桌面 25/25、文档/管理子集 33/33、inventory 通过、public check 1c02305b issues 0；App 未构造项未写成通过；遗留 PID 13034 已不存在。
- 非阻断建议：文档阶段共用故障投影可后续补经 09 真实失败路径的端到端断言（当前 fixture 注入与真实合同一致）。

## 14. 用户恢复后的收尾（2026-10-30 08:1x）
- 用户决定：真实渠道验证留待人工完成，先做不受影响的收尾；Agent 不执行任何真实发送/撤回/真实微信读取。
- 环境核查（距 blocked 3.5h）：仓库无新提交、微信 PID 892 未重启、userData/制品/进程无变化；dev:status stopped/pids[]。
- 最终一致性验证（RC gate，08:18）：backend/desktop 锁定 TS 7.0.2 typecheck 0/0；test-inventory 通过；后端代表性批次 **96/96**（Electron Node：memory-control、documents、documents-migration、clear-resync、clear-http、cutover-structure、cutover-rehearsal、history-http、history-host、incremental-controls、deletion-metadata-restart）；桌面代表性批次 fail 0（fixed-memory-processing、view、sync-status-recovery、history-clear-contract、incremental-sync-status）；public check `--ref HEAD` issues 0。
- 已产出人工验证指南：`.scratch/sqlite-rebuild-implementation/manual-real-channel-verification-20261030.local.md`（03 A/B 人工动作与停止条件、06 制品/构建授权、04 依赖、21 收口口径、证据回传与恢复方式）。
- 03/04/06/21 仍 claimed/受阻；Goal 保持 active。

## 15. 票10 最后一处审查遗留闭环（d2a1aee7 → 1d47dd97）
- 用产品真实形态（`SqliteMemoryDocuments(..., model=undefined)`）经 09 真实 `documents/service.ts port()` 抛 `document_model_unconfigured` → 真实 `noteFailure` 写 `processing_task.error_code`，替代 fixture 手工插值；断言后端 `sharedFaultCode=statusReason=document_model_unconfigured`、`status=blocked`、`actions=[]`、`unknown=0`，桌面同屏只显示一处固定原因且无「继续/重发」错误动作。
- 仅 4 个测试/文档文件，无产品代码变更；d2a1aee7 集成 1d47dd97。主仓复核：两端 typecheck 0、memory-control+documents+management fail 0、桌面固定处理 fail 0、inventory 通过、public `--ref HEAD` issues 0。
- t03 审查提出的唯一非阻断建议至此闭环；票 10 保持 resolved。

## 16. Round4 组合验收后续复跑（t10 补丁后，当前 HEAD）
条件变化：t10 产品补丁 1c02305b/d2a1aee7 在 21 矩阵定稿后进入基线（记忆控制投影、桌面共用故障展示、崩渍 unknown 回归），故按「条件变化扩大验证」在当前集成分支复跑 21 的 A–K 组合批次（文件清单与原批次一致，条件未变不增删）：
- A 125/125、B **148/148**（原 145，t10 新增 3 用例）、C 68/68、D 94/94、E 30/30、F **57/57**（原 56，+1）、G 74/74、H 25/25、I **46/46**（原 45，+1）、J 21/21、K **28/28**（原 27，+1）；**合计 716 pass / 0 fail**。
- 同轮：backend/desktop 锁定 TS 7.0.2 typecheck 0/0；test-inventory 通过；`check_public_history --ref HEAD` issues 0。
- 日志：`/tmp/round4-batch-{a..k}.log`；Node v24.21.0（`/tmp/t09-node/bin/node`）与 Electron 44.7.0 自带 Node（宿主批 E/H/J/K）。
- 21 文档将新增 §12 记录本次后续复跑（t21 提交后集成）。

## 17. Round4 21 文档增补集成（4849e12f → 39bc2165）
- 21 文档新增 §12「后续复跑（t10 补丁后）」：A–K 逐批 **716/716（0 fail）**（A125/B148/C68/D94/E30/F57/G74/H25/I46/J21/K28），§0/§3 指向 §12，基线 713c6d5f；矩阵结论、票 State、其他票证据未改。
- 仅文档改动；public check `--ref HEAD` issues 0；同批两端 tsc 0/0、test-inventory 通过。
- 最终集成 HEAD **39bc2165**；本批 117 提交、222 files +27900/−4530；票状态 14 resolved（13 有效+18 历史）/4 claimed（03/04/06/21）/3 open（13/15/19）。
- 21 仍 claimed/受阻：03/04/06 真实渠道门槛、19 暂缓、真实模型语义未认证；等待用户人工验证后收口。

## 18. Round5：人工验证前置准备与全量桌面套件限制
- 环境自 Round4 无变化（仓库无新提交、微信 PID 892 未重启、userData/进程无变化）。
- 尝试 `cd desktop && pnpm test` 作为完整 safe-node 桌面门禁：`test-safe.mjs` 以 `node --test`（无 `--test-force-exit`）在开放句柄上挂起 >10 分钟，已终止并清理 `/tmp/notalone-safe-tests-*`；属测试脚本/环境限制，非产品回归。代表性桌面批次（fixed-memory-processing/view、sync-status-recovery、history-clear-contract、incremental-sync-status）与 A–K 组合 716/716 仍为有效门禁。
- 03 人工验证前置核对：v11 开发窄操作只读制品仍完整——`<bbec>/.scratch/sqlite-history-cli/dev-schema-v11/bin/wechat-cli`，`cliSha256=d555fdce…`（与 manifest 一致）、`wcdbSha256=4f05cafc…`、manifest `kind=notalone-history-cli-development`、`signing=ad-hoc-development`、`realWechatVerified=false`；正式安装 CLI `d566d4…` 无 metadata 窄操作。
- 已更新人工验证指南新增 §7：制品位置/哈希/身份；03 协调协议（先布防观察再执行人工动作；二选一：完整 A/B+仅撤回 B，或仅观察下撤回 B）；若事后告知只能认证事后状态、不能认证转移；Agent 收到消息后的只读核对→arm→next→关闭→更新证据待办。

## 19. Round6：人工验证驱动就绪性核对（只读，未访问微信数据）
- v11 开发窄操作制品可执行性与完整性只读验证：`wechat-cli help`/`version` 正常（2.0.1-rc.5，commit 795071f…，cliSha256 d555fdce… 与 manifest 一致）、`codesign --verify --strict` 退出 0；**未打开微信 DB、未读取任何消息**。
- 定位既有观察驱动 `<bbec>/.scratch/sqlite-history-cli/observe-human-b.mjs`：`NarrowWechatClient`（校验 cli/wcdb 双哈希）→ accountMetadata → resolveSelected('ran') 精确目标 → inspect/support → `observer_open`；stdin 控制 `arm`（lockedCount=0）→ 人工动作 → `next`（直到 lockedCount=1，>1 判身份歧义失败）→ `close`；输出匿名 records（仅 sender/originalType/status/serverIdAssigned/localIdExact/identityStable/serverIdStable/normalHistory，bodyRead:false、rawIdentitiesPersisted:false、无正文/source/XML）。
- 运行环境：Node v24.21.0（`/tmp/t09-node/bin/node`），cwd=bbec 工作树根；脚本 finally 会覆盖 `anonymous-human-b-v11.json`，执行前需复制到 /tmp 并改输出名以保留原证据。
- 人工验证指南已补 §7.5（就绪性、驱动用法、安全边界、收到“准备开始”后的只读流程）。

## 20. Round7：驱动静态就绪与预置（未执行、未访问微信）
- 只读静态核对观察驱动依赖：`NarrowWechatClient` 方法齐全（accountMetadata/resolveSelected/inspectSelected/observeTestMetadataSelected/supportSelected/targetSelected/close）；CLI 以 `spawn(executable, ['notalone-history'], env=HOME/PATH/TMPDIR/LANG/LC_ALL, shell=false)` 经 stdin/stdout JSON envelope 通信，与驱动协议一致。
- 预置 `/tmp/observe-withdraw-dryrun.mjs`（观察驱动副本，输出名改 `anonymous-human-b-v11-withdraw.json`，`node --check` 通过），仅准备、未运行、未访问微信数据。
- 人工验证指南补 §7.6。除用户人工动作与正式制品/授权外，已无 Agent 可执行项。
