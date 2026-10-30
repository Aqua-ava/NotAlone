# 05：统一来源删除与清理流程

Triage: ready-for-agent
State: resolved
Type: task
Parent: [SQLite 数据库重建规格](../../sqlite-database-rebuild/spec.md)
Blocked by: [01 SQLite 基础与生命周期](01-sqlite-runtime-lifecycle.md)

> 2026-10-29已领取实施。[任务索引与共同约定](../planning.md)。

## 交付行为

通过现有来源删除操作立即阻止已失效资料被检索或写回，再按同一删除操作清理并复核数据库、追踪和受管文件。后续记忆、助手和媒体票各自把真实依赖接入这套流程。

## 验收条件

- [x] 共用统一删除操作、明确类型的目标及分面复核，不另造删除平台；请求幂等并持久保存控制代次、计划修订和重试进度。
- [x] 先推进范围代次、撤销旧写入和派生使用资格；在途模型、CLI页或文件即使迟到也不得凭旧资格写回；删除本身不隐式调用模型或读取新微信。
- [x] 来源闭包覆盖实际参与上下文、追踪输入输出、候选/版本/文档/回复依据及本人跨联系人贡献，不只沿展示citation清理。
- [x] 同一消息或事实另有合法来源时可按规则复验保留，但不能把旧执行的真实来源换指其他记录以保住旧证明、追踪或媒体副本；需模型核验者先撤下资格并等待用户手动处理。
- [x] DSH等受管副本先封禁和排空持有者，等待公开dispose/close及末次写入结束，再精确清自有文件和活动引用；未确认释放不伪报完成。
- [x] 清理包括当前、退役、暂存、在途文件与敏感定位/证明；只处理可核验归属的应用副本，保留微信原件、用户外部原文件、模型密钥和受保护Skill目录。
- [x] 真实含正文追踪随实际参与来源清理；无正文回执与请求墓碑按具体删除范围保留或清除，不把无正文call记录冒充完整过程。
- [x] 删除行后继续复核SQLite空闲页、WAL/SHM、临时文件及活动读取引用；维护有界排空并核验，失败保持未完成，不承诺SSD或外部备份法证擦除。
- [x] 发现新目标先更新计划修订并重新复核；全部本次必需存储面通过且无未处置迟到写入才完成，不将DB行已删当跨存储原子成功。
- [x] 本票通过合成来源、受管文件和可控持有者验证正常/部分失败/重启重试/错误归属；后续每个写者在自己的票内完成删除接入与页面不可读验证。
- [x] 实施时核对来源、联系人和账号删除的台账保留差异及ADR-031/094等相关约束；不因统一删除而合并不同范围授权。

## 验证与证据

使用临时SQLite、受管目录和确定性活动持有者，先验证单来源清理及幂等，再验证跨联系人贡献、文件失败与晚到写入。通过业务删除入口和公开状态确认结果，不只检查文件或表行是否存在。

依据[统一数据库设计](../../sqlite-database-rebuild/greenfield-design.md)和父规格实施；历史研究票、骨架或已知合成探针不能标为本票已完成。真实门槛见[定稿验证记录](../../../research/wechat-spec-finalization-validation.md)。

## 范围与执行门禁

可按已定模型与合成来源独立验证，不以等待真实微信作为本地清理前置。它只提供已确认共用合同；各新领域写者必须随票注册清理闭包，20切换前再验完整清单，不能到21才补基础保护。

当前已按明确分配领取实施；不自动领取其他任务。`ready-for-agent`只描述任务可执行性，不能据此扩大微信读取或模型调用范围。

后续开发及桌面验收只用`pnpm run dev`，先`dev:status`核验并复用热更新实例；不得自行打包、运行打包版、改发布门禁、push或创建PR。只处理必要的合成或已获准资料，不提交私人聊天、身份、凭据、截图或真实媒体。App首次使用继续搁置，迁移／恢复实验不纳入本轮。

## Answer

2026-10-29 完成本票共用删除合同、当前 identity/Skill 写者的正式开发宿主接线及必要验收，State 为 resolved。前期统一基线阻塞已解除；本票没有领取其他领域任务。上述验收勾选针对本票共用合同、非空合成来源和已安装写者；后续每个真实写者仍须随自己的票注册完整闭包并验收页面不可读，20 切换前复核完整清单。

实现与合同：

- `backend-ts/src/storage/sqlite/deletion/` 提供 `deletion_operation/target/check`、`request_tombstone`、具名短事务动作、`DeletionService`、活动持有者及精确受管文件清理。已发布删除迁移 v2 未改写；当前统一底座含 identity v3、Skill v4。接入规范见该目录 README、`contracts.ts` 与 `registration.ts`。
- 删除先推进范围代次并撤销旧写入/派生资格；请求墓碑防旧请求重放，runner 绑定实例和计划修订，闭包新目标推进修订并使旧复核失效。来源闭包按真实参与输入、跨联系人本人贡献和原证明清理；另有合法来源的业务事实可复验，旧执行证明不改指其他来源。意外返回 Promise 的领域回调在提交前拒绝并回滚。
- 持有者先封禁并等待公开关闭、在途读取与末次写入；超时或明确关闭失败保留原操作，只有明确失败允许再次 close，未决 close 不并发重发。文件 I/O 前复验领域归属/代次/保留资格，按 dev/ino/birthtime/uid 和父目录身份删除自有副本。错误归属、替换文件、链接、未知辅助文件均保持未完成；微信原件、外部原文件、密钥和 Skill 原目录不纳入删除。
- 文件及引用排空后，先封存并清除账本敏感定位/文件身份，再执行 checkpoint → VACUUM → checkpoint、完整性/FK 和页/WAL/SHM/临时文件复核。活动连接下不强删 SHM；长读者阻塞或维护失败不能 completed。无正文台账按来源/联系人/账号的既定范围区别保留，墓碑不作为完整过程。
- 正常认证 DSH 宿主已装配 identity 与 skill_metadata，`requiredDomains` 完整登记当前写者；真实支持联系人/账号删除，`/api/runtime/status` 公开相同范围。缺少 source/discussion/media 实际写者时返回 `deletion_scope_unavailable`，不将空闭包成功作为能力。来源 DELETE/任务回执继续适配现有桌面读取器，普通非删除任务透传；账号每次独立请求要求新的 Idempotency-Key。
- `ContactMetadataLifetime` 登记真实账号候选和跨联系人预览。联系人服务关闭时清空候选/快照并等待 metadata.close 与所有在途读取结算，迟到结果不能回填；联系人删除后仅按持久资格重建空服务，账号删除后不重新装载。账号范围排空 owner 全部资源，不混比联系人代次和账号 epoch。
- 实际 App 发现并修复 Skill 页读取拒绝后仍展示旧资料的问题：失败撤下父子快照并提供显式重读；卸载后的成功、失败和 finally 均受挂载状态保护，旧连接请求不再清掉新连接资料。

实际验证：

1. Node v24.19.0。`cd backend-ts && node --test test/sqlite-deletion-metadata.test.mjs test/sqlite-contact-close.test.mjs test/sqlite-deletion.test.mjs test/sqlite-host-launch.test.mjs test/sqlite-contact-binding.test.mjs test/sqlite-skills.test.mjs`：63/63；`pnpm typecheck` 通过。覆盖非空合成来源、owner/contact 隔离、旧代次/runner/请求、跨联系人贡献、部分失败/重开续跑、错误文件身份、未知临时文件、关闭失败/超时/末次写入、新目标修订、范围台账差异和真实长读者阻塞维护。此前底座 10 项有效结果按未变化条件复用。
2. 正常 DSH 测试使用真正 launchDsh、官方 profile 和生产认证 HTTP，分别验证空账号与非空合成身份/Skill 账号。宿主仍运行时联系人/账号 DELETE 返回完成；公开 sqlite_pages_wal 为 passed、proof 为 checkpoint_vacuum_verified，全部必需分面无 blocked，Skill 原目录保留。握手位于 managed/sqlite-backend.info，SQLite 未知文件检查未放宽。正常退出重开后回执持久，旧读取资格拒绝；没有测试专用 profile 替换或 PG/模型调用。
3. `cd desktop && node --test tests/sqlite-development.test.mjs tests/sqlite-source-deletion-contract.test.mjs`：8/8；来源读取器直接消费生产适配器和真实临时 SQLite。`node --test tests/skill-learning/sqlite-library-view.test.mjs tests/skill-learning/sqlite-library.test.mjs`：3/3；桌面 `pnpm typecheck` 通过。两次新增回归均先 red：读取拒绝后旧卡残留，以及旧页迟到失败撤下新连接快照；对应修复后 green。
4. 串行取得桌面后实际使用 pnpm run dev，dev:status 核对监督器和开发宿主。Computer Use 看到两位合成联系人和已启用 gentle Skill；联系人删除后点“刷新联系人”，只保留另一位，独立 Skill 保留。账号删除后点“刷新 Skill 状态”，旧名称/说明/修订锚点全部退出展示，只显示可重读提示；再次重读仍无旧资料。联系人刷新后目录清空并提示读取不可用，选择器禁用。账号 DELETE 的 15 条领域/协调复核无 blocked，宿主仍 running，原 Skill SHA-256 未变，Skill 后续读/写返回 409。正常菜单退出后 dev:status 为 stopped；重开底座确认 completed 回执、integrity/FK 均 ok。未把来源页面或真实微信尚未实现能力记作通过。
5. 独立 Standards/Spec 审查全部完成。元数据屏障最终 0 发现；页面增量的迟到回调问题已修复并补失败回归，双轴最终 0 发现。`git diff --check` 通过；实现提交逐次公开历史检查均 0 问题（实现末次 2561 提交、1623 当前文件），本记录提交后继续同命令检查。

本地实现提交：恢复异步回调护栏 `d3f4a34f6f7d88ed7424775d59b15993d0e026b0`；正式宿主接线 `62b01b62151ddcf7ffd6b12fd04d9b820bac8fe2`；真实元数据屏障 `bf26b7b3427c345c00d328b7552e0c4ecba1e965`；页面快照失效 `0139e231262222879050038bfe486f9b61a155a6`。14 最终依赖补丁作为独立提交 `c17d0d2d96d39c747b871f42a8aa4ed7262adbd5` 保留，不混为本票修改。总指挥已集成前几项，后续只挑缺失提交，保留其 history 等并行领域迁移。

数据与资源影响：只使用隔离 role=test SQLite、合成身份/资料/Skill 和临时认证；读取开关关闭，未接真实微信、未知 PG 或用户业务库，未读私人聊天、调用模型或外发/撤回消息。App 与监督器正常退出并释放桌面；核对精确归属、无进程引用及未跟踪后，清理本轮两个合成 root 与 3.7 MiB 开发缓存，共回收约 33.89 MiB。保留锁定 Electron 运行时约 307 MiB 和工作树依赖；剩余磁盘约 119 GiB。首次短命令后台监督器未保持的启动失败已用持久会话解决，未改变开发或发布策略。

剩余边界：03/06/07/11/16 等领域按实际写者补闭包、精确 authority、requiredDomains 与范围放行；真实非空 DSH 副本公开 dispose/close、真实聊天过程/媒体清理及相应页面由各领域票验证。本票合成关闭不冒充真实微信或非空 DSH 会话。首次使用、组件安装、新模型设置、干净机器、迁移恢复实验继续搁置；不承诺 SSD、外部备份或供应商副本法证擦除。未 push、创建远端分支或 PR。
