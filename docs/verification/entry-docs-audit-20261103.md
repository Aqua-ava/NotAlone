# 文档入口全量核查（2026-11-03）

本轮核查根入口、仓库内全部 README／Agent 开发规则、操作指南，以及关联的非 README 开发说明，共 **68 份 Markdown**；另核对 **2 份冻结来源元数据**。其中包括对工作区已有生命周期指南的只读检查。检查覆盖各文件的当前说明、实现入口、历史用途和引用。

历史 ADR、已归档方案、产品 Skill 正文、评测结果及任务证据不作为当前要求重写；相应入口说明其地位。Hindsight 的四份记录和原生 wheel 通知另检查了历史定位并保持原文。旧产品设计的整理见现行规格，本轮不作新的产品决策。

## 结果与边界

- README、AGENTS、领域词汇和开发指南先指向 `architecture/current/`；模块 README 说明实际接口与装配，不再用旧票号或历史验收代替当前状态。
- 纠正旧 PG／Python 默认路径、文件导入已开放、普通页面测试可运行、语音已接入、单 Skill 上限和旧候选等待等表述；保留当前源码和配置可支持的操作。
- 日期操作与阶段验收归入[历史开发目录](../history/README.md)，保留原文、失败与限制；现行指南不再累积日期补丁。保留原入口被引用的章节锚点或指向历史章节。
- 联系人隔离、读取授权、来源与删除、端侧视觉处理、人工发送以及日常开发／发布门禁保持原边界。本轮未读取业务资料、调用模型、操作 App、改系统权限或运行构建／打包。
- 冻结提案正文及摘要未改。其 7 处旧路径引用涉及 5 个文件，现位置见[来源核验索引](../evaluations/memory/source-verification/README.md#固定路径提案)，不以改写冻结证据消除旧引用。

## 逐项覆盖

“保留”表示已检查后无需改正文；“只读”表示不属于本次可提交变更。

| 文件 | 处置 |
| --- | --- |
| [AGENTS.md](../../AGENTS.md) | 改：硬边界直接指向现行规格，保持授权、人工发送、开发和 Git 约束。 |
| [CONTEXT.md](../../CONTEXT.md) | 改：统一待确认候选、图文记忆、资料目录与 Skill 术语；定义不代表入口开放。 |
| [README.md](../../README.md) | 改：按当前 SQLite／DSH 开发入口说明使用、能力限制、命令和阅读路由。 |
| [architecture/README.md](../../architecture/README.md) | 保留：上轮已收敛为现行主题路由或明确的按需历史目录；链接核验有效。 |
| [architecture/adr/README.md](../../architecture/adr/README.md) | 保留：上轮已收敛为现行主题路由或明确的按需历史目录；链接核验有效。 |
| [architecture/drafts/archive/README.md](../../architecture/drafts/archive/README.md) | 保留：上轮已收敛为现行主题路由或明确的按需历史目录；链接核验有效。 |
| [architecture/history/README.md](../../architecture/history/README.md) | 保留：上轮已收敛为现行主题路由或明确的按需历史目录；链接核验有效。 |
| [backend-ts/README.md](../../backend-ts/README.md) | 改：修正正常开发命令、当前能力说明；产品合同改链接，迁移/会话/全量历史验收归档。 |
| [backend-ts/diagnostic-problem-budget.md](../../backend-ts/diagnostic-problem-budget.md) | 改：保留累计预算与历史Python管理工具，改正把现行账本统称PG和未接入的旧描述。 |
| [backend-ts/src/README.md](../../backend-ts/src/README.md) | 改：删除旧任务编号与笼统暂缓声明，指向真实宿主装配。 |
| [backend-ts/src/contacts/sqlite/README.md](../../backend-ts/src/contacts/sqlite/README.md) | 改：核实已实现的元数据核验/名单读取和发布父表，去掉 PG 默认及分票集成状态。 |
| [backend-ts/src/history/sqlite/README.md](../../backend-ts/src/history/sqlite/README.md) | 改：去掉实施编号与过去接线验收；区分协调器并发与 CLI 串行，保留消息身份/游标/持有者接口。 |
| [backend-ts/src/media/sqlite/README.md](../../backend-ts/src/media/sqlite/README.md) | 改：保留保存/预览/关闭接口和容量边界，移出旧 Node/DSH 阶段证明并去掉票号。 |
| [backend-ts/src/media/visual/README.md](../../backend-ts/src/media/visual/README.md) | 改：区分通用适配器与当前 OriginalImage 装配，修正旧图片不补查的过时结论。 |
| [backend-ts/src/media/voice/README.md](../../backend-ts/src/media/voice/README.md) | 改：保留语音格式/预算/WASM/关闭合同，明确已有模块并未被正常宿主装配。 |
| [backend-ts/src/media/voice/notices/README.md](../../backend-ts/src/media/voice/notices/README.md) | 保留：固定版本、下载来源和许可说明属于依赖来源证据。 |
| [backend-ts/src/memory/README.md](../../backend-ts/src/memory/README.md) | 改：补唯一产品合同入口，保留源码职责导航。 |
| [backend-ts/src/memory/content/README.md](../../backend-ts/src/memory/content/README.md) | 改：保留插件接口和同批可用性缓存约束，去除会话时态。 |
| [backend-ts/src/memory/processing/README.md](../../backend-ts/src/memory/processing/README.md) | 改：核对该目录仅有 README，改为兼容导航，不再声称存在阻碍映射实现。 |
| [backend-ts/src/memory/sqlite/README.md](../../backend-ts/src/memory/sqlite/README.md) | 改：修正暂停/继续 API、当前阶段组合与内容拒绝语义；保留共享调用/删除/调度接口。 |
| [backend-ts/src/memory/sqlite/documents/README.md](../../backend-ts/src/memory/sqlite/documents/README.md) | 改：保留文档写者与消费者接口，产品规则链接当前规格，移除票号。 |
| [backend-ts/src/memory/sqlite/management/README.md](../../backend-ts/src/memory/sqlite/management/README.md) | 改：保留当前管理/裁决接口与语义来源区分，移走旧合成验证状态；不描述并行代码改动。 |
| [backend-ts/src/reply/sqlite/DSH.md](../../backend-ts/src/reply/sqlite/DSH.md) | 改：保留官方固定版本接口与释放依据，删去未链接的本票/实际App结论并指向现行行为合同。 |
| [backend-ts/src/reply/sqlite/README.md](../../backend-ts/src/reply/sqlite/README.md) | 改：删除默认未集成与过时材料集合，保留运行副本/幂等/排空接口；Skill 单包旧验收归档。 |
| [backend-ts/src/reply/sqlite/candidates/README.md](../../backend-ts/src/reply/sqlite/candidates/README.md) | 改：按当前立即生成路径移除15秒来源恢复等待；准确记忆/文档消费者与精确依赖。 |
| [backend-ts/src/skills/sqlite/README.md](../../backend-ts/src/skills/sqlite/README.md) | 改：保留当前只读包/迁移/provider接口，消除旧票号与尚未接线说法、去重默认启用。 |
| [backend-ts/src/storage/sqlite/README.md](../../backend-ts/src/storage/sqlite/README.md) | 改：修正正常 registry 已组合领域，保留事务/迁移/BigInt与故障合同；历史环境证明归档。 |
| [backend-ts/src/storage/sqlite/deletion/README.md](../../backend-ts/src/storage/sqlite/deletion/README.md) | 改：去掉默认 PG/仅身份Skill/待HTTP的旧集成状态，保留删除账本/持有者/受管文件执行合同。 |
| [backend-ts/test/HISTORICAL.md](../../backend-ts/test/HISTORICAL.md) | 改：保留固定历史树/前置限制与显式恢复方式，统一pnpm命令和日常桌面门禁。 |
| [desktop/README.md](../../desktop/README.md) | 改：核对实际接口、当前规格和正常开发入口，旧阶段说明移至历史目录。 |
| [desktop/prototype/README.md](../../desktop/prototype/README.md) | 改：核对实际接口、当前规格和正常开发入口，旧阶段说明移至历史目录。 |
| [desktop/scripts/runtime/NATIVE-WHEEL-NOTICES.md](../../desktop/scripts/runtime/NATIVE-WHEEL-NOTICES.md) | 保留：已明确退役的来源／法律核验记录，不改许可与历史证据。 |
| [desktop/tests/README.md](../../desktop/tests/README.md) | 改：核对实际接口、当前规格和正常开发入口，旧阶段说明移至历史目录。 |
| [desktop/wechat-history/README.md](../../desktop/wechat-history/README.md) | 改：核对实际接口、当前规格和正常开发入口，旧阶段说明移至历史目录。 |
| [desktop/wechat-history/prototypes/fsevents-replay-notes.md](../../desktop/wechat-history/prototypes/fsevents-replay-notes.md) | 改：核对实际接口、当前规格和正常开发入口，旧阶段说明移至历史目录。 |
| [desktop/wechat-history/state-quarantine-prototype.md](../../desktop/wechat-history/state-quarantine-prototype.md) | 改：核对实际接口、当前规格和正常开发入口，旧阶段说明移至历史目录。 |
| [docs/README.md](../../docs/README.md) | 改：分离当前操作指南和历史开发记录。 |
| [docs/agents/domain.md](../../docs/agents/domain.md) | 改：明确当前规格优先，两个历史目录仅按需追溯。 |
| [docs/agents/dsh-development.md](../../docs/agents/dsh-development.md) | 改：先定位现行回复与隐私合同；保留锁定源码核验步骤。 |
| [docs/agents/engineering.md](../../docs/agents/engineering.md) | 改：校正当前能力与 test:pages 状态；日常验收使用开发实例。既有独立修改原样保留。 |
| [docs/agents/issue-tracker.md](../../docs/agents/issue-tracker.md) | 保留：Local Markdown 任务路径与状态约定仍适用。 |
| [docs/agents/quality-diagnosis.md](../../docs/agents/quality-diagnosis.md) | 保留：累计预算、停止规则与现行 provider 一致；固定历史 CLI 的四个模块可恢复。 |
| `docs/agents/scaling-and-data-lifecycle.md` | 只读：检查工作区已有生命周期指南，与现行入口一致；不纳入本次提交。 |
| [docs/agents/triage-labels.md](../../docs/agents/triage-labels.md) | 保留：五个默认标签与工作流一致。 |
| [docs/agents/workflow.md](../../docs/agents/workflow.md) | 保留：模式、协作、决策和规格路由有效；所指本机技能可定位。 |
| [docs/evaluations/README.md](../../docs/evaluations/README.md) | 改：明确现行 memory/reply 入口；保留历史预算与证据边界 |
| [docs/evaluations/authentic-expression/README.md](../../docs/evaluations/authentic-expression/README.md) | 改：接回复生成合同，旧实验不恢复门禁 |
| [docs/evaluations/memory/README.md](../../docs/evaluations/memory/README.md) | 改：现行记忆与数据合同直链 |
| [docs/evaluations/memory/dimension-release/README.md](../../docs/evaluations/memory/dimension-release/README.md) | 改：现行调度合同直链，历史台账不构成新授权 |
| [docs/evaluations/memory/extraction/README.md](../../docs/evaluations/memory/extraction/README.md) | 改：现行图文输入/失败处理直链，旧参数不做入口 |
| [docs/evaluations/memory/model-comparisons/README.md](../../docs/evaluations/memory/model-comparisons/README.md) | 改：现行记忆合同直链，失败与终止保留、预算不复开 |
| [docs/evaluations/memory/source-verification/README.md](../../docs/evaluations/memory/source-verification/README.md) | 改：当前核验合同直链，固定 pilot 历史边界 |
| [docs/guides/README.md](../../docs/guides/README.md) | 改：当前任务路由与按需历史分开 |
| [docs/guides/macos-app-permissions-and-errors.md](../../docs/guides/macos-app-permissions-and-errors.md) | 改：当前开发、权限、启动诊断；日期日志完整移出 |
| [docs/guides/new-environment-hot-start.md](../../docs/guides/new-environment-hot-start.md) | 改：现行 Node/pnpm/SQLite 启动；旧现场移出 |
| [docs/memory-claim-retention-repetition-pilot-proposal-20261005.md](../../docs/memory-claim-retention-repetition-pilot-proposal-20261005.md) | 保留：正文和路径逐字节不动 |
| [docs/wechat-first-run-troubleshooting-20261023.md](../../docs/wechat-first-run-troubleshooting-20261023.md) | 改：当前接入路由；唯一历史过程移出 |
| [experiments/hindsight/COMPARISON.md](../../experiments/hindsight/COMPARISON.md) | 保留：冻结实验数据、结果或审查证据；从已标历史的实验入口按需追溯。 |
| [experiments/hindsight/DATASET.md](../../experiments/hindsight/DATASET.md) | 保留：冻结实验数据、结果或审查证据；从已标历史的实验入口按需追溯。 |
| [experiments/hindsight/README.md](../../experiments/hindsight/README.md) | 保留：已明确历史研究入口、不接入产品且不代表当前验收。 |
| [experiments/hindsight/lifecycle.md](../../experiments/hindsight/lifecycle.md) | 保留：冻结实验数据、结果或审查证据；从已标历史的实验入口按需追溯。 |
| [experiments/hindsight/review.md](../../experiments/hindsight/review.md) | 保留：冻结实验数据、结果或审查证据；从已标历史的实验入口按需追溯。 |
| [native/macos/README.md](../../native/macos/README.md) | 改：核对实际接口、当前规格和正常开发入口，旧阶段说明移至历史目录。 |
| [native/media-validation/README.md](../../native/media-validation/README.md) | 改：核对实际接口、当前规格和正常开发入口，旧阶段说明移至历史目录。 |
| [native/skill-read/README.md](../../native/skill-read/README.md) | 改：核对实际接口、当前规格和正常开发入口，旧阶段说明移至历史目录。 |
| [reply-skills/romance-sources/D/README.md.json](../../reply-skills/romance-sources/D/README.md.json) | 保留：来源冻结元数据，逐字节未变。 |
| [reply-skills/romance-sources/README.md](../../reply-skills/romance-sources/README.md) | 改：保留完整源文件锁定表和许可说明，补证据边界；两份README.md.json冻结不变。 |
| [reply-skills/romance-sources/T/README.md.json](../../reply-skills/romance-sources/T/README.md.json) | 保留：来源冻结元数据，逐字节未变。 |
| [reply-skills/romance/README.md](../../reply-skills/romance/README.md) | 改：保留92项来源目录与内容清单，区分只读核验/写入生成；默认启用及多包规则链接当前合同，旧单包验收归档。 |
| [website/README.md](../../website/README.md) | 改：区分静态演示与当前产品，旧浏览器验证归档，保留本地预览和数据边界。 |

## 验证

- 已对照根与子项目 `package.json`、开发及测试脚本、锁定 DSH 安装声明、正式宿主装配及相关模块接口。纯文档变更未运行业务测试，也不补记 App、微信或真实模型验收。
- 对 75 份入口、关联记录及新增文档检查本地链接与章节；除已明确映射的冻结提案旧引用外，无失效目标，既有入链锚点无回归。三份操作档案保持完整正文（只修移动后的相对链接与等价行尾格式），桌面原章节均保留；8 份冻结／历史材料与基线逐字节一致。
- 三组文档交叉审查通过：根入口与 Agent 约束、桌面与历史入口、当前操作指南分别由其他执行者复核。纯文档改动按任务范围执行 `git diff --check`；公开内容检查执行 `node scripts/check_public_history.mjs --ref HEAD --working-tree`，提交前扫描为 0 项，提交后另作复核。
