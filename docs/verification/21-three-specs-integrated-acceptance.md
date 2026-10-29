# 21 三份规格组合验收记录

日期：2026-10-30。执行会话：`t21-integrated-acceptance`（共享任务 task-7）。验收基线：`codex/sqlite-rebuild-integration`@`d1068fbf`（初稿基于 `d8c55619`；随后票20 跨重启回归 `b8577686` 与跨重启联系人目录失效修复 `154ac9e2`（05×06 交互）经 `d1068fbf` 集成，本票已合并复核），本票工作树 `sqlite-rebuild-21`（同名分支，仅本地提交，不 push/PR）。

本记录只做组合验收与证据收口，不补实现、不改其他票状态。已 resolved 票引用其既有有效证据并按未变化条件复用，未重跑其整套；本轮实际执行的组合批次与 App 交互单独记录。合成、实际开发 App、真实模型、真实微信分列记账；未认证项不得解释为通过。

## 0. 结论摘要

- **17 项有效范围**（01–12、14、16、17、20、21）中，01、02、05、07、08、09、11、12、14、16、17 已 resolved 且实现/结构已进集成基线；03、04、06、10、20 实现已进基线但 State 保持 claimed，其真实渠道/清理门槛未认证。
- 本轮实测的集成组合回归：7 个批次 **592/592 通过**（A 同步/清空/删除 125、B 记忆/文档/控制 145、C 媒体 68、D 切换/回复/讨论/Skill 94、E Electron 宿主 30、F 桌面模块 56、G 裁决/迁移/共享结构 74），两端 typecheck 结果见 §3/§9。
- 基线复核追加：票20 跨重启宿主回归与「跨重启 UI 复核限制」（20 verification §13）；本票在修复基线 `d1068fbf` 上复跑批 H **25/25**（含 restart-host 1/1），并跑修复回归批 I **45/45**（含新增 `sqlite-deletion-metadata-restart` 2 项）、批 J **21/21**（Electron 宿主）、批 K **27/27**（Electron 下 restart 回归 + 批 H 复跑）。
- 本票报告的「重启后联系人同步状态/目录读取失败」已由 t20 定位为 **05×06 交互缺陷**（`deletion.metadataAvailable` 把清空内容类未完成删除误当身份删除），修复源 `154ac9e2` 经 `d1068fbf` 集成；本票用同构根按原顺序（source DELETE completed → 清空 boundary_pending → 正常退出 → 同根重启）完成 **App 级闭环复验**：`/api/contacts`、`/api/sync/cli-bindings`、`/api/sync/status`、`/api/setup/status`、`/api/deletions`、清空状态均 200，联系人页无读取失败（§4.5）。该修复不改变真实微信/真实模型门槛，相关列仍按未认证记录。
- 实际开发 App（热更新 dev，隔离合成 userData）完成：默认 SQLite 自动创建（manifest `completed`，8/8 checks passed）、记忆/文档状态展示、认证来源删除后旧资料实际撤下、联系人清空进入 `boundary_pending` 且无成功文案、正常退出 `stopped/pids[]`、重开同 `databaseId`/结构 15/`integrity=ok`/`foreignKeys=ok`；重开后联系人目录与授权读取正常（原 05×06 缺陷修复后 App 闭环复验，§4.5）。
- **未通过/受阻（关键）**：03 真实普通历史、状态语义与来源生命周期、跨启动连续性；04 真实增量尾部（重选/断线/微信非前台 CLI 同步未认证）；06 真实 observer/reader 边界协议与最终只读制品（生产保持 `boundary_pending`）；20 真实旧业务库/副本清理（对象归属不明，实际清理未执行）；19 真实媒体唯一关联用户暂缓。真实模型仅 07/11 两次用户另行授权的受限真实调用，其余未测。
- 因此本票**保持 claimed 并报告受阻**，不以已提交代码或已发布任务关闭规格；即使全部合成与 App 交互通过，也不能替代 03/04/06/20 的真实渠道/清理认证。
- 17 项矩阵见 §1；四项用户暂缓见 §2；组合实测见 §3；App 证据见 §4；未通过项与所需授权见 §7。

## 1. 17 项有效范围验收矩阵

列含义：**实现**＝本轮代码交付存在；**集成**＝实现已进本验收基线；**合成验证**＝隔离合成库/替身证据；**实际 App**＝热更新开发 App 的实际界面交互；**真实模型**＝真实供应商调用；**真实微信**＝真实微信本机读取/来源认证。状态：通过 / 部分 / 未认证 / 受阻 / 暂缓 / 不适用。

| 项 | 实现 | 集成 | 合成验证 | 实际 App | 真实模型 | 真实微信 | 证据指针（节选） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 SQLite 底座与生命周期 | 通过 | 通过 | 通过 | 通过 | 不适用 | 不适用 | 票 Answer：`.scratch/sqlite-rebuild-implementation/issues/01-sqlite-runtime-lifecycle.md:42`；`backend-ts/test/sqlite-storage.test.mjs`（本轮复跑 10/10）；迁移 1–15、82 表/252 CHECK/92 触发器 body：`docs/verification/20-sqlite-cutover-and-legacy-cleanup.md:17-27,42`；ADR-109 |
| 02 联系人绑定与同步授权 | 通过 | 通过 | 通过 | 通过（重开后联系人目录与授权读取正常；原 05×06 缺陷已修复并 App 闭环复验，见 §4.5） | 不适用 | 未认证（真实逐人确认/范围） | 票 Answer：`02-contact-binding-and-read-grants.md:43`；`sqlite-contact-binding.test.mjs`、`sqlite-contact-close.test.mjs`（批 A 125/125 内含）；ADR-110 |
| 03 首次历史同步与消息展示 | 通过 | 通过 | 通过 | 部分（合成 App 展示/覆盖/删除撤下） | 不适用 | **受阻**（第 1/2 条真实未过） | 12 条逐条判定与缺口：`docs/verification/sqlite-private-history-support-03.md:198-215,217-225`；票 Comments/Answer：`03-private-history-sync.md:46,54`；真实 metadata 仅受控只读观察（5/7 类型，无正文），普通 target/page 全拒绝 |
| 04 增量同步与读取控制 | 通过 | 通过 | 通过 | 部分（总开关/授权/阶段/取消/覆盖；重选/断线/非前台 CLI 未过） | 不适用 | **未认证** | 票与验证记录：`docs/verification/sqlite-incremental-sync-04.md:39-53,80-84`；t04 实机部分通过：`planning.md:209`；批 A 内增量/控制/HTTP 用例通过 |
| 05 统一来源删除与清理 | 通过 | 通过 | 通过 | 通过 | 不适用 | 不适用（真实删除链依赖 03/06 捕获） | 票 Answer：`05-source-deletion-and-cleanup.md:43`；`sqlite-deletion*.test.mjs`（批 A）、Electron 宿主删除 E 30/30；本轮实际 App 认证 source DELETE 202→completed 并撤下旧资料（§4） |
| 06 清空聊天与明确重读历史 | 通过 | 通过 | 通过 | 通过（仅 boundary_pending 行为与合成清空） | 不适用 | **未认证**（observer/reader + 最终制品） | `docs/verification/sqlite-clear-and-resync-06.md:21-37,74-80`；批 A `sqlite-clear-resync`/`sqlite-clear-http` 通过；本轮 App `boundary_pending` + `exact_channel_cutoff_required`（§4）；t06 实机 pending 复核：`planning.md:205` |
| 07 固定范围的记忆提取与核验 | 通过 | 通过 | 通过 | 通过 | 受限真实调用成功（2 目标合成文本；语义质量未认证） | 不适用 | 票 Answer/最终核对表：`07-fixed-scope-memory-extraction.md:47` 起；真实供应商合成复测：`07-...:171`；批 B 145/145 内含 extraction 相关；本轮 App 记忆页 1/1、候选与自动采纳显示（§4） |
| 08 记忆候选、版本与修正 | 通过 | 通过 | 通过 | 通过 | 未测（环回合成供应商） | 不适用 | 票 Answer：`08-memory-candidates-and-versions.md:48` 起（70/70、迁移 11/11、profile 1/1、桌面 17/17）；批 G 补充裁决/删除/迁移；t08 实际 App 复验：`planning.md:187` |
| 09 主题资料与长期概览 | 通过 | 通过 | 通过 | 通过 | 未测（环回供应商） | 不适用 | 票 Answer：`09-memory-documents-publication.md:50`；09 集成与复验：`planning.md:213,219`；批 B 内 documents 8 文件 145/145 的一部分；本轮 App 文档区状态可见（§4） |
| 10 记忆处理控制与恢复 | 通过 | 通过 | 通过 | 部分（固定面板/暂停继续/退出重开；模型相关子项未在 App 构造） | 未测 | 不适用 | t10 实机修正与验收边界：`planning.md:199`；控制/记忆测试批 B；票 State claimed、无 Answer（未 resolved） |
| 11 助手讨论与 DSH 副本 | 通过 | 通过 | 通过 | 通过 | 受限真实调用成功（1 次，重开不重复；质量未认证） | 不适用 | 票 Answer 12 条表：`11-assistant-discussions-and-runtime.md:51` 起；真实供应商复测：`11-...:95`；批 D 讨论/DSH 通过 |
| 12 候选回复与依据 | 通过 | 通过 | 通过 | 通过 | 未测（合成供应商） | 不适用 | 票 Answer：`12-reply-candidates-and-basis.md:53` 起；批 D reply 候选/知识集成 + 桌面 F；t12 实际 App 生成/编辑/选稿/来源失效撤下（票内） |
| 14 官方 Skill 加载接回 | 通过 | 通过 | 通过 | 通过 | 不适用（隔离加载无模型请求） | 不适用 | 票 Answer：`14-official-skill-loading.md:49` 起；批 D skill/host 通过；空库 Skill 安全：`docs/verification/20-...:164` |
| 16 单条媒体保存与清除 | 通过 | 通过 | 通过 | 通过（四类删除/预览，条件未变复用） | 不适用（不调模型） | 未认证（真实类型未安装，入口拒绝） | 票 Answer：`16-single-message-media-lifecycle.md:49` 起；批 C `sqlite-media*` 68/68、E `media-host`、F 桌面 message-media 56/56 |
| 17 图片与视频提取 | 通过 | 通过 | 通过 | 通过（PNG/视频/清除/来源删除，复用） | 不适用 | 未认证（19 暂缓，真实关联入口关闭） | 票 Answer 含支持矩阵：`17-image-video-extraction.md:47` 起；批 C visual/DAT、F 桌面；原生 helper 合成证据按其票内声明范围复用 |
| 20 默认切换 SQLite 与旧业务清理 | 通过 | 通过 | 通过（隔离演练） | 通过（默认入口实测；本轮空根复验） | 不适用 | 不适用；**真实旧业务清理受阻** | 12 条判定：`docs/verification/20-sqlite-cutover-and-legacy-cleanup.md:151-166`；真实归属受阻：同文件 `:105-113`；跨重启宿主回归与限制：同文件 `:197-205`（本票复跑批 H 25/25、修复后批 K 27/27）；t20 集成记录：`planning.md:193`；本轮空根 manifest 8/8 checks（§4） |
| 21 三份规格组合验收 | 本记录 | 本记录 | 本轮 592/592（A–G） | 本轮完成（§4） | 仅 07/11 受限 | 未认证（仅 03 受控 metadata 观察，无正文） | 本文档；未通过项 §7；四项暂缓 §2 |

## 2. 四项用户暂缓（不启用、不补验收、不计通过）

| 项 | 用户决定 | 当前入口状态 | 证据 |
| --- | --- | --- | --- |
| 13 表达偏好接回 | 本轮暂缓（wontfix/open） | 未实现；旧回复生成路由在 SQLite 宿主返回 503/不可用，无旧 PG 回退 | `docs/verification/20-...:81,156`；`sqlite-cutover-disabled-capabilities.test.mjs`（批 D） |
| 15 纠错与诊断改接 | 本轮暂缓（wontfix/open） | 未实现；旧 Skill 学习/纠错/诊断路由不可用，无旧 PG 回退 | 同上；目标表 6 张不建：`docs/verification/20-...:268-273` |
| 18 语音保存与转换 | 本轮暂缓；历史实现与证据保留，最小停用 | `media adapters=[]`、`mediaExtraction` ownership unavailable，新语音保存/转换入口关闭；既有数据访问/隔离/删除保护保留 | `planning.md:10`；`docs/verification/20-...:81`；16/18 既有证据不重复执行 |
| 19 媒体真实关联与组合验收 | 本轮暂缓（wontfix/open） | 真实媒体唯一关联未认证，入口保持关闭；未读取真实媒体 | `planning.md:10,117`；媒体规格验收仍待 19 单独授权 |

本轮未启用上述任何入口，未以其他票证据转填 13/15/18/19 为通过。

## 3. 组合行为实测

执行环境：Node `/tmp/t09-node/bin/node` v24.21.0；Electron 44.7.0（44.7.0 / Node 24.21.0）；SQLite 3.53.4；锁定 TypeScript 7.0.2；隔离临时 SQLite `role=test` 与合成身份/消息，不读取真实微信、不调用真实模型、不发送外部消息、不打包。日志位于 `/tmp/t21-batch-*.log`、`/tmp/t21-typecheck.log`。两端 `pnpm run typecheck`（backend/desktop）均 0 错误。基线复核后新增批 H（票20 跨重启宿主回归 25/25，`/tmp/t21-batch-h-restart.log`）、批 I（修复回归 45/45，`/tmp/t21-batch-i-restartfix.log`）、批 J（Electron 宿主 21/21，`/tmp/t21-batch-j-host-fix.log`）、批 K（Electron 下 restart 回归 + 批 H 复跑 27/27，`/tmp/t21-batch-k-fix-verify.log`）。

### 3.1 关闭读取、取消单人、独立暂停、来源删除的四种语义

- **关闭读取与记忆处理分离**：关闭总开关后仍可手动处理已勾选联系人已保存文字，且不触发 CLI 补读/自动模型/媒体；覆盖于批 B 记忆控制与提取用例、批 A 增量控制（关闭后 `read_enabled=0` 但绑定、grant、已保存消息保留），以及本轮 App 记忆页常驻文案「关闭微信读取后仍可手动处理」（§4）。
- **取消单人**：只停该人新读并撤销提交资格，其他联系人继续；重选不复活旧执行、不清除旧排除（批 A `sqlite-incremental-controls`/`handoff`、`sqlite-clear-resync`；t04 实机 active 2→1 资料保留，`planning.md:209`）。
- **独立暂停（普通暂停）**：暂停后不启动新小批，当前合法小批可收尾提交；取消/删除立即失效；退出后保持暂停、手动继续复用成功步骤（批 B 控制/恢复与 09 文档用例；t09 暂停边界修复 0f16b89d + 集成 b2a4f0f1，`planning.md:207`；t10 实机，`planning.md:199`）。
- **来源删除**：05 统一账本先推进代次并 fence，再按真实来源闭包清理并分面复核；其他合法来源可复验保留；本轮实际 App 用认证 HTTP 删除合成来源，删除操作 `completed` 且 UI 旧候选/正式记忆/主题资料撤下（§4.3）。
- 四者互不等同：关闭读取不删资料、不暂停已启动处理；取消勾选不是删除来源；暂停不改变读取资格；来源删除不恢复旧执行、不自动调用模型。

### 3.2 历史未完成清空、B 后新消息、旧页迟到、显式重新同步

- 清空覆盖该联系人全部已保存文字/占位/来源/派生资料并保留联系人与同步选择；05 推进单调代次封禁旧历史目标、处理与文件结果，不以普通暂停小批规则放行旧写入（`docs/verification/sqlite-clear-and-resync-06.md:21-37`；批 A `sqlite-clear-resync`、`sqlite-clear-http`）。
- 合成证据覆盖：首次历史未完成即清空、从未读入旧页、同秒/乱序、清空中新消息、候选取消/中断、已接受 B 后重启/慢清理、v12→15 升级；B 接受原子、不可后移，B 后合法新消息按新资格进入，旧成员在历史与增量两条接受路径按身份排除（同上 `:25-31`）。
- 显式重新同步：重新核验账号/身份后建立新 verification/grant 与独立请求键，幂等处理重叠消息；不恢复旧记忆、助手会话、媒体、旧证明或旧执行，不自动触发记忆/媒体（同上 `:33-34`）。
- **真实边界**：生产 `wechat-channel` 不提供 `boundarySnapshot`，真实清空只封禁+清理并显示 `boundary_pending`，不显示成功；真实 observer/reader 协议、完整分片/命名空间连续性与最终只读制品未认证（同上 `:74-80`）。本轮 App 复验到该 pending 行为（§4.4）。

### 3.3 固定轮次、有限前文、本人跨联系人贡献、文档基线发布、暂停小批、单人/共用故障、unknown

- 批 B 145/145 + 补充批 G：固定范围/目标、成功步骤复用、无产出成功记账且不重复提取、失败与 unknown 区分、unknown 不盲目重发、来源删除后候选/过程撤下。
- 本人跨联系人贡献与混合失效：07/08 使用 `task_contribution` 完整 M:N 复验授权/冻结代次；07 重开审计发现并修复的跨窗口误删（ea05a1f42，`07-...:169`）已进基线，批 B/G 覆盖。
- 有限前文：runs 冻结点击前已保存的少量前文，前文不重复登记为目标，仍纳入来源/删除依赖（07 票内；批 B extraction/owner-contribution）。
- 文档基线发布：09 同发布集合两篇文档、阶段序列 extraction_verification→document_scene→document_profile→completed、普通暂停不启动后阶段小批（0f16b89d），实际 App 复验见 `planning.md:213`；本轮 App 文档区显示「本轮处理中，尚无可用的发布集合」（§4.2）。
- 单人失败/共用故障：控制测试 15/15（t10 记录 `planning.md:199`）；合成 App 内未构造真实模型故障，如实按边界记录，不以控制测试代签真实模型。
- 成功目标不重复、unknown 不盲发：批 B/G 与 07/10/11 既有证据；本轮不新增真实模型调用。

### 3.4 删除与模型/DSH 末写/文件发布/替换/新代次写入并发

- 批 A（删除/元数据/关闭）、批 C（媒体删除）、批 D（讨论删除）、批 G（裁决删除、共享执行删除）覆盖删除闭包、计划修订、SQLite 页/WAL、活动引用与跨存储重启恢复；16/18 既有证据覆盖媒体文件发布/替换待清理、迟到发布与删除晚到。
- 合法新代次资料不被旧清理误删：`sqlite-clear-resync`（慢清理只清旧代次、新消息保留）、05 新目标修订使用旧复核失效；07 跨窗口来源归属修复后独立未参与结果保留、实际参与的正文/追踪/晚到资格清理。
- 重启恢复：本轮 App 退出后重开同 `databaseId`、结构 15、`integrity=ok`、`foreignKeys=ok`，删除与清空决定持久（§4.5）；**观察边界**：重开后联系人目录读取失败，已交 t20 诊断（待结论，暂按未认证/待诊断，不写成产品缺陷或通过）。

### 3.5 16/17 媒体机制复用与最小补充

- 复用 16/17 已验证的合成图片/视频正常、有限结果（缩略图/原图未取得）、未知质量、清除、来源/联系人删除、CSP/预览与独立文件副本证据；本轮批 C 68/68（`sqlite-media`、`sqlite-media-deletion`、`sqlite-visual-media`、`sqlite-voice` 机制、`visual-dat`）、批 E `sqlite-media-host`、批 F 桌面 message-media 相关。
- 不同消息独立副本、不跨联系人串读、原微信及外部文件不变由 16/17 票内证据与结构约束覆盖；本轮不新增真实媒体读取。空间不足为合成 ENOSPC 注入，未制造真实磁盘耗尽；中断/显式重提/删除组合按 16/17 既有证据复用。
- **18/19 不执行**：语音真实关联与真实媒体组合验收均未执行；16 的语音有限结果机制与 18 历史实现仅作机制证据，不计当前交付。

## 4. 实际开发 App 交互验收（本轮）

入口：`/tmp/t09-node/bin/node desktop/scripts/dev.mjs --user-data-dir <隔离合成根>`（等价 `pnpm run dev` 入口，热更新开发模式；`NOTALONE_DEV_CDP=1` 仅用于只读 CDP 核验）；隔离最终 model env 为空（空根）或合成环回供应商，**未配置真实模型 key、未操作微信、未打包**。用户目录均为系统临时根并经 realpath 传入。

### 4.1 默认 SQLite 启动（空隔离根）

- 启动后 `database-cutover/manifest.json`：`phase=completed`、`targetOrigin=created`、8 项 checks 全 `passed`（target_identity、storage_integrity、structure、media_closure、skill_empty_safe、deletion_registration、writer_fence、legacy_cleanup）；目标 `managed/sqlite/notalone.sqlite`，新 `databaseId`/`ownerId`，`role=test`。
- UI：`SQLite 联系人与历史消息存储已就绪`、`结构版本 15 · SQLite 3.53.4`；5 个管理页（Skill/联系人/记忆/同步设置/设置）与侧栏分组标签「关系与表达」可达，渲染无空白、console 无异常；联系人目录为空态提示正常。
- 证据：`/tmp/t21-evidence/manifest-empty-root.json`、`/tmp/t21-evidence/t21-app-empty-pages2.png`、`/tmp/t21-evidence/empty-root.sqlite`。
- 环境注记：首次用 `/tmp/...`（非 realpath）路径启动得到 `cutover_storage_failed(unsafe_storage_path)`——存储路径校验要求 realpath；worktree 需补根 `node_modules` 软链，否则 dev server `@fs` 请求 403。均为工作树环境差异，非主干产品缺陷，已在 §8 记录。

### 4.2 合成数据（两位联系人、读取关闭、无真实模型）

- 合成根由 07 的 `prepare-memory-management-desktop.mjs` 准备：联系人甲 3 条消息、乙 2 条消息，读取关闭，合成供应商 0 请求。
- 联系人页：结构版本 15；两位联系人同步状态与「已授权 · 正文同步尚未开放」；联系人甲详情「本机历史已读完 · 已保存 3 条文字消息、0 条非文字占位」「新消息同步不可用 · 已跟进 0 次」「当前微信读取能力尚未核验，增量读取保持关闭」；清空/重读面板可见。
- 记忆页：固定处理面板「提取核验已结束、已处理 1 / 1 条文字目标、主题整理、长期概览尚未全部完成」；候选「联系人现在长期住在台南」；正式记忆 v2·自动采纳·来源已核验；文档区「本轮处理中，尚无可用的发布集合」。
- 证据：`/tmp/t21-evidence/t21-prepared-contactA-clear-panel.png`、`/tmp/t21-evidence/t21-prepared-contacts.png`。

### 4.3 认证来源删除后旧资料撤下

- 通过 App 内认证宿主 DELETE `/api/contacts/<甲>/sources/<合成来源>`：cURL `-w '%{http_code}'` 实测 HTTP 202（状态码为终端输出、未落盘），响应体 `{"status":"succeeded"}` 见 `t21-delete-source.json`；`GET /api/deletions` 显示 operation `completed`，各域 checks `passed`（discussion/discussion_calls/history 等，见 `t21-deletions.json`）。
- 刷新记忆页后：候选「当前范围没有可展示的候选」；正式记忆「已失效 · 当前无可引用版本」；「有 1 条目标因取消勾选或来源删除失效，不计入待处理」；主题资料「当前尚无已发布的主题资料」。旧资料实际撤下，不是仅隐藏按钮。
- 证据：`/tmp/t21-evidence/t21-delete-source.json`、`/tmp/t21-evidence/t21-deletions.json`、`/tmp/t21-evidence/t21-prepared-memory-after-delete.png`。

### 4.4 清空聊天 pending 可见性

- 联系人页对合成甲点击「清空聊天」→「确认清空聊天」后显示：「已停止清空前旧历史的写入并清理已保存的聊天。本机历史边界尚未建立（同步读取已关闭或授权已撤销，未读取边界元数据。），因此不会显示为清空完成。」；最近一次未完成原因 `exact_channel_cutoff_required`；无成功文案；联系人与同步选择保留，面板仍可刷新/重读。
- 与 06 生产语义一致：真实边界未认证时只封禁+清理并保持 `boundary_pending`，不伪报完成。
- 证据：`/tmp/t21-evidence/t21-prepared-clear-pending.png`。

### 4.5 退出、重开与跨存储持久

- 正常退出（监督器 INT→IPC `notalone-dev-quit`→`app.quit`）后同 scope `dev:status` 返回 `{"mode":"stopped","pids":[]}`，端口/环回供应商/App 进程退出。
- 同根重开：`database-cutover/manifest.json` 仍 `completed`、同一 `databaseId=216a44ab-…`、`ownerId=00000000-0000-4000-8000-000000000001`；离线 `SqliteStorage.open` 复核 `schemaVersion=15`、`integrity=ok`、`foreignKeys=ok`；删除与清空决定持久。
- **首轮观察与修复闭环**：初稿复验时（基线 `d8c55619`）重开后联系人页显示「联系人同步状态读取失败…当前不能确认授权范围」；t20 按本票回传的差异（首轮 source DELETE completed + 清空 boundary_pending）复现并定位为 `deletion.metadataAvailable` 在内容类未完成删除时误关闭名单服务（`/api/contacts`、`/api/sync/cli-bindings` 409 `identity_closed`、`/api/sync/status` 503），修复源 `154ac9e2` 经 `d1068fbf` 集成。本票在修复基线用同构根按原顺序重跑：认证 source DELETE 202→`completed`、清空进入 `boundary_pending`（`deletion_state=blocked`、`exact_channel_cutoff_required`）→ 正常退出（`dev:status stopped/pids[]`）→ 同根重启后 `/api/contacts`、`/api/sync/cli-bindings`、`/api/sync/status`、`/api/setup/status`、`/api/deletions`、清空状态均为 **200**；CDP 联系人页无读取失败、两位联系人可见（合成乙 2 条消息、合成甲 0 条消息 + 清空 pending），清空状态仍为 `boundary_pending`/blocked。隔离根无真实 CLI 时微信会话名单 `sessionIssue=unavailable` 属预期环境限制，不影响联系人目录/绑定/授权/删除进度读取。
- 证据：`/tmp/t21-evidence/restart-fix-*.json|png`（删除 202、清空 pending 截图、重启后 6 个 API 响应、联系人页截图、最终 `stopped/pids[]`；`restart-fix-restart-contacts.png` 经 `file` 确认为 PNG image data，`read_image` 预览可能以 JPEG 归一化显示）。

### 4.6 清理

合成根（初稿与修复闭环复验各一）、空根均已按精确 realpath 删除；环回供应商停止；无残留开发 App/监督器/端口；`pids=[]`。原始截图/JSON/manifest 仅保留在 `/tmp/t21-evidence/`（不含私人数据），提交中只保留本验收记录。

## 5. 三份规格覆盖对照

| 规格 | 覆盖条目 | 本轮证据与限制 |
| --- | --- | --- |
| SQLite 数据库重建（`spec.md:38-91`） | 01、02、05、09、14、16、20、21（结构/事务/实例生命周期/切换清理） | 82 表实际 DDL、迁移 1–15、252 CHECK/92 触发器 body、隔离切换演练 11 项（`docs/verification/20-...:19-113`）；真实旧库清理受阻 |
| 同步、聊天清空与记忆处理（`sync-memory-behavior/spec.md:77-209`） | 02、03、04、06、07、08、09、10、11、12（逐人授权/历史增量/清空重读/手动记忆全阶段） | 批 A/B/D/G 合计 364+ 项、03/04/06 真实渠道门槛未认证；10 模型相关控制状态未在 App 内构造 |
| 微信媒体提取（`wechat-media-extraction/spec.md:50-97`） | 16、17（单条图片/视频/语音机制）；18、19 暂缓 | 批 C/E/F 媒体机制通过；真实微信媒体唯一关联（19）未认证且入口关闭；18 最小停用 |
| 统一结构依据（`greenfield-design.md`） | 表/键/状态/事务 | 设计目录 77 表逐一 disposition 见 `docs/verification/20-...` 附录 A–C；不宣称 DDL 外行为已通过 |

## 6. 数据影响

**合成侧（本轮实际执行）**：
- 创建/删除隔离临时用户目录：空根（默认 SQLite 自动创建，databaseId `6540d866-…`）与合成记忆根（databaseId `216a44ab-…`，两位合成联系人/5 条合成文字/候选/正式记忆 v2/主题文档状态）。
- 修复闭环复验另建/删除一个同构合成根（databaseId `4252b707-…`）：认证 source DELETE（completed）+ 清空（boundary_pending/blocked）→ 正常退出 → 同根重启，接口与 UI 读取正常；根已删除，证据在 `/tmp/t21-evidence/restart-fix-*`。
- 实际执行认证删除 1 个合成来源（operation completed、3 域 checks passed）、清空 1 位合成联系人聊天（boundary_pending，已存聊天清理）、退出/重开同一 SQLite 实例。
- 轮次合成库仅在系统临时根，`role=test`；经 realpath 精确核验后删除，无进程/文件引用残留。

**真实侧（本轮未触碰）**：
- 未读取真实微信正文/名单/媒体/密钥；未调用真实模型；未发送或撤回外部消息；未清理/切换/迁移真实业务库或应用副本；未操作真实联系人数据；未打包或运行打包版。真实旧业务对象归属与清理仍受阻（`docs/verification/20-...:105-113`）。

## 7. 未通过项、所需授权/制品与保留状态

| 项 | 结论 | 缺什么（所需授权/制品） |
| --- | --- | --- |
| 03 第 1 条 真实普通历史 | 未通过 | 用户按 02 对真实私聊完成逐人确认与读取授权；支持档 `status=supported` 的正式制品（正式安装 CLI `d566d4…` 无 metadata/history 窄操作；开发制品为 ad-hoc、`realWechatVerified=false`，不能冒充） |
| 03 第 2 条 真实状态语义与来源生命周期 | 未通过 | 固定两条文字「发送后保留 / 仅撤回一次」的人类操作与可操作撤回归口（用户已跳过撤回；CUA 点击消息气泡返回 `AXError.notImplemented`）；pending/server 别名补齐需可捕获窗口 |
| 03 跨启动/实例连续性 | 未通过 | 架构决策与实现授权、真实重启观察协议；`sourceGeneration` 不含消息分片实例、`data_version` 仅同连接可比；持久失证围栏仍是待实现合同 |
| 04 真实增量/重选/断线/微信非前台 CLI | 未认证 | 真实支持档声明 `incrementalTail=supported` 与最终读取制品；受控真实重选（需读微信会话元数据）、断线实机构造与真实前台授权 |
| 06 真实边界 observer/reader | 未认证 | 真实 WCDB observer/reader 协议、完整分片/命名空间连续性与最终只读制品；生产保持 `boundary_pending` |
| 02 真实逐人确认与读取范围 | 未认证 | 用户在真实私聊完成逐人选择/确认，真实账号、名单与支持档 metadata 核验；当前真实 target/page 门禁拒绝 |
| 05 真实来源删除链 | 未认证（依赖 03/06 真实捕获） | 真实来源捕获后按 05 账本执行真实删除；当前无真实捕获，只有合成来源与正式 HTTP 合成删除证据 |
| 16/17 真实媒体类型关联 | 未认证（19 暂缓） | 真实微信媒体唯一关联与质量证明；用户暂缓不读取，入口保持关闭 |
| 10 App 内模型相关控制状态 | 未在 App 构造 | 真实模型供应商/预算授权与可捕获窗口；本轮以控制测试 + 桌面 headless 覆盖，不冒充真实模型通过 |
| 重启后联系人 UI 读取（本票观察项，已修复） | **已定位并修复**（App 级闭环复验通过） | 05×06 交互：`deletion.metadataAvailable` 把清空内容类未完成删除误当身份删除，修复源 `154ac9e2` 经 `d1068fbf` 集成；新增 `sqlite-deletion-metadata-restart` 回归（批 I/K 通过），本票同构根 App 复验 contacts/cli-bindings/sync/setup/deletions/清空状态均 200 且 UI 无读取失败（§4.5）；20 切库路径无缺陷 |
| 20 真实旧业务清理 | **受阻** | 精确旧对象归属确认（本机无 PG socket；默认 userData 旧启动配置指向外部项目/握手，内容未读、归属未确认）、停止旧写入者、逐目标清理授权；未执行真实切库/drop/清理 |
| 19 真实媒体唯一关联 | 用户暂缓 | 本轮不读取；保持未验证且入口不放行 |
| 真实模型总体 | 仅 07/11 受限 | 其余无本轮真实调用授权；真实语义质量未认证；07/11 复测仅合成文本/固定范围 |

**票与任务状态**：本票保持 **claimed**，不 resolved、不宣称三份规格已整体通过；共享任务 task-7 的“本票交付”完成≠票结论通过。最终 State/Triage 由 Lead 维护。

## 8. 遗留问题与剩余风险

1. **重启后联系人目录读取失败（已修复）**：t20 定位为 05×06 交互缺陷（`deletion.metadataAvailable` 误关闭名单服务），修复源 `154ac9e2` 经 `d1068fbf` 集成；新增 `sqlite-deletion-metadata-restart` 回归 2/2（批 I/K 通过）与本票 App 同构根闭环复验（§4.5）。隔离根无真实 CLI 时 `sessionIssue=unavailable` 属预期环境限制，不影响联系人目录/绑定/授权/删除进度读取。
2. **工作树环境差异**：`SqliteStorage` 要求 userData 为 realpath（`/tmp` 符号路径会 `cutover_storage_failed/unsafe_storage_path`）；dev server 的 `@fs` 需要工作树根 `node_modules` 软链，否则前端资源 403。两者均在主仓不成立/由主仓依赖满足，记录为复现条件，不解释为产品缺陷。
3. **真实渠道证据缺口**：03/04/06 真实微信读取、状态语义、来源连续性与精确边界仍无认证；生产入口保持拒绝/`boundary_pending`。不得以“全部拒绝”或合成正例当成正常路径通过。
4. **真实清理缺口**：20 的真实旧业务对象归属不明，实际清理未执行；需用户/架构决策与逐目标授权。
5. **模型质量**：真实供应商语义质量仅 07/11 有限调用，未认证；旧 unknown/失败原因保留，不推断、不重发。
6. **`run-current` 全量 612 失败**：按 t20 §9.2 口径，除 2 项 `sqlite-memory-profile` 既有失败外，其余均为无 PG 环境基线失败；本票不重跑全量，只跑相关组合批次，不把全量失败混入本票结论。

## 9. 复现命令与证据

```bash
# 依赖：工作树内软链主仓依赖（提交前移除）
ln -sfn <main-repo>/backend-ts/node_modules backend-ts/node_modules
ln -sfn <main-repo>/desktop/node_modules desktop/node_modules
ln -sfn <main-repo>/node_modules node_modules

# 组合批次（Node v24.21.0；日志 /tmp/t21-batch-*.log；批 E/H 用 Electron 自带 Node 24.21.0）
cd backend-ts
# 批 A（125/125）
node --test \
  test/sqlite-incremental-handoff.test.mjs test/sqlite-incremental-sync.test.mjs test/sqlite-incremental-controls.test.mjs \
  test/sqlite-first-history-coordinator.test.mjs test/sqlite-history-http.test.mjs test/sqlite-history-hooks.test.mjs \
  test/sqlite-history-source-holder.test.mjs test/sqlite-clear-resync.test.mjs test/sqlite-clear-http.test.mjs \
  test/sqlite-deletion.test.mjs test/sqlite-deletion-metadata.test.mjs test/sqlite-contact-binding.test.mjs \
  test/sqlite-contact-close.test.mjs test/sqlite-private-history.test.mjs
# 批 B（145/145）
node --test \
  test/sqlite-memory-control.test.mjs test/sqlite-memory-extraction.test.mjs \
  test/sqlite-memory-documents.test.mjs test/sqlite-memory-documents-migration.test.mjs \
  test/sqlite-memory-documents-expiry.test.mjs test/sqlite-memory-documents-independent.test.mjs \
  test/sqlite-memory-documents-reply.test.mjs test/sqlite-memory-documents-requalification.test.mjs \
  test/sqlite-memory-documents-retry.test.mjs test/sqlite-memory-documents-unchanged.test.mjs \
  test/sqlite-memory-documents-unknown.test.mjs test/sqlite-owner-contribution.test.mjs \
  test/sqlite-memory-management.test.mjs test/sqlite-memory-management-http.test.mjs \
  test/sqlite-memory-candidate-admission.test.mjs test/sqlite-memory-unknown-deletion.test.mjs \
  test/sqlite-shared-execution-deletion.test.mjs test/sqlite-memory-model-port.test.mjs
# 批 C（68/68）
node --test test/sqlite-media.test.mjs test/sqlite-media-deletion.test.mjs test/sqlite-visual-media.test.mjs test/sqlite-voice.test.mjs test/visual-dat.test.mjs
# 批 D（94/94）
node --test \
  test/sqlite-cutover-audit.test.mjs test/sqlite-cutover-disabled-capabilities.test.mjs test/sqlite-cutover-rehearsal.test.mjs \
  test/sqlite-cutover-retirement.test.mjs test/sqlite-cutover-structure.test.mjs test/sqlite-skills.test.mjs \
  test/sqlite-skill-host.test.mjs test/sqlite-reply-candidates.test.mjs test/sqlite-reply-candidate-input-regressions.test.mjs \
  test/sqlite-reply-knowledge-integration.test.mjs test/sqlite-memory-reply-integration.test.mjs \
  test/sqlite-discussion.test.mjs test/sqlite-discussion-host.test.mjs test/sqlite-discussion-dsh.test.mjs \
  test/sqlite-discussion-integration.test.mjs test/sqlite-discussion-deletion.test.mjs
# 批 E（30/30）
ELECTRON_RUN_AS_NODE=1 <desktop>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test \
  test/sqlite-history-host.test.mjs test/sqlite-history-startup-host.test.mjs test/sqlite-host-launch.test.mjs \
  test/sqlite-host-close.test.mjs test/sqlite-contact-close.test.mjs test/sqlite-history-sync-status.test.mjs test/sqlite-media-host.test.mjs
cd ../desktop
# 批 F（56/56）
node --test \
  tests/sqlite-history-clear-contract.test.mjs tests/fixed-memory-processing-view.test.mjs \
  tests/incremental-sync-status.test.mjs tests/message-media-integration.test.mjs \
  tests/message-media-view.test.mjs tests/message-media-controller.test.mjs \
  tests/sqlite-history-messages.test.mjs tests/sqlite-memory-management-view.test.mjs \
  tests/sync-status-recovery.test.mjs tests/local-history-sync.test.mjs
cd ../backend-ts
# 批 G（74/74）
node --test \
  test/sqlite-memory-adjudication.test.mjs test/sqlite-memory-adjudication-evidence.test.mjs \
  test/sqlite-memory-adjudication-deletion.test.mjs test/sqlite-memory-adjudication-model-port.test.mjs \
  test/sqlite-adjudication-deletion.test.mjs test/sqlite-adjudication-migration.test.mjs \
  test/sqlite-shared-producer-schema.test.mjs test/memory-adjudication-dsh.test.mjs \
  test/sqlite-memory-candidate-admission.test.mjs test/sqlite-memory-management-http.test.mjs
# 批 H（25/25；基线复核追加，Electron 自带 Node）
ELECTRON_RUN_AS_NODE=1 <desktop>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test \
  test/sqlite-cutover-restart-host.test.mjs test/sqlite-cutover-structure.test.mjs test/sqlite-cutover-rehearsal.test.mjs \
  test/sqlite-cutover-audit.test.mjs test/sqlite-cutover-retirement.test.mjs test/sqlite-cutover-disabled-capabilities.test.mjs
# 批 I（45/45；重启修复回归，普通 Node）
node --test test/sqlite-deletion-metadata-restart.test.mjs test/sqlite-deletion-metadata.test.mjs test/sqlite-deletion.test.mjs \
  test/sqlite-clear-resync.test.mjs test/sqlite-clear-http.test.mjs test/sqlite-cutover-launch-sqlite-guard.test.mjs
# 批 J（21/21；Electron 自带 Node）
ELECTRON_RUN_AS_NODE=1 <desktop>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test \
  test/sqlite-cutover-restart-host.test.mjs test/sqlite-history-host.test.mjs test/sqlite-host-launch.test.mjs \
  test/sqlite-host-close.test.mjs test/sqlite-contact-close.test.mjs
# 批 K（27/27；Electron 自带 Node；sqlite-deletion-metadata-restart + 批 H 六文件修复后复跑）
ELECTRON_RUN_AS_NODE=1 <desktop>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test \
  test/sqlite-deletion-metadata-restart.test.mjs test/sqlite-cutover-restart-host.test.mjs \
  test/sqlite-cutover-structure.test.mjs test/sqlite-cutover-rehearsal.test.mjs test/sqlite-cutover-audit.test.mjs \
  test/sqlite-cutover-retirement.test.mjs test/sqlite-cutover-disabled-capabilities.test.mjs
# 两端类型检查（0 错误）：backend/desktop 各 `pnpm run typecheck`（= 锁定 typescript 7.0.2 的 `tsc --noEmit`；`backend-ts/node_modules/typescript/package.json` 实测 version=7.0.2，日志 /tmp/t21-typecheck.log 仅记命令与退出码）

# 实际 App（隔离合成根，realpath；未配置真实模型、未操作微信、未打包）
cd desktop
NOTALONE_DEV_CDP=1 NOTALONE_ENV_FILE=<root>/empty.env node scripts/dev.mjs --user-data-dir <realpath-root>
# 只读 CDP 证据采集：/tmp/t21-cdp.mjs（pages/eval/screenshot）
# 认证删除：DELETE http://<handshake address>/api/contacts/<contact>/sources/<source> -H "Authorization: Bearer <token>"
node scripts/development-status.mjs --user-data-dir <realpath-root>   # 退出后 stopped/pids[]
# 修复闭环复验（二次）：prepare-memory-management-desktop.mjs（backend-only）建同构根 →
#   dev 启动 → 认证 source DELETE（completed）→ 联系人页清空（boundary_pending）→ 正常退出 →
#   同根重启 → 抓 /api/contacts、/api/sync/cli-bindings、/api/sync/status、/api/setup/status、
#   /api/deletions、/api/contacts/<id>/history/clear（均 200）+ CDP 联系人页截图（无读取失败）；
#   证据 /tmp/t21-evidence/restart-fix-*.json|png、restart-fix-status-final.json。
```

证据清单：`/tmp/t21-evidence/`（空根 manifest 与截图、合成根 manifest、联系人/记忆/清空 pending/重开截图、删除 HTTP 响应与删除状态 JSON）；组合日志另含 `/tmp/t21-batch-h-restart.log`（基线复核 25/25，含空隔离根/旧写入者/审计用例）。本文件提交后，历史证据路径不进入 Git。

## 10. 危险项检查与资源清理

- 未新增外部发送能力；未发送/撤回任何外部消息；未读取真实微信正文、名单、媒体或凭据；未调用真实模型；未访问/迁移/恢复真实业务库；未启用 13/15/18/19；未打包、未运行打包版、未改发布门禁；未 push/PR、未创建远端分支。
- 未修改 `planning.md`、其他票文件、State/Triage（本票文件仅追加 Comments）；新增桌面测试 0 个，未改 `desktop/tests/inventory.json`。
- 资源：合成根与空根删除、供应商停止、App/监督器退出、`dev:status stopped/pids[]`、无残留进程/端口；工作树依赖软链与 `.dev` 构建产物在提交前移除/保留为未跟踪且不提交；证据仅留 `/tmp` 与本记录，不含私人数据或可恢复定位。
- 复核：`git status` 仅本任务文档/票 Comments 变更（软链已移除）；`git diff --check` 通过；公开前检查 `node scripts/check_public_history.mjs --ref 9ba6e733` issues 0（t03 只读复核，未带 working-tree，故 currentFiles 为 0）；`--ref abb9d36a --working-tree` issues 0（currentFiles 1970 / historicalCommits 2894）；本可选微调提交后同命令复跑 issues 0（currentFiles 1970 / historicalCommits 见最终回报）。
