# 20 默认切换 SQLite 与旧业务清理：验证与审计记录

> 本文件是实施票 20 的端侧验证证据，记录结构核对、消费者改接／退役、切换控制面、隔离演练与真实清理受阻事实。真实切库、drop、真实旧业务清理、打包与远端操作均未执行；不据此宣称真实微信、真实模型或发布包通过验收。
>
> 依据：父规格 `.scratch/sqlite-database-rebuild/spec.md`、结构唯一依据 `.scratch/sqlite-database-rebuild/greenfield-design.md`、旧业务清点工件 `consolidated-legacy-check.*`／`legacy-coverage.*`／`consolidated-schema.json`。数量只是查漏基线，不是建表目标。

## 1. 结论摘要

- 实际 SQLite 结构：迁移 1–15 共创建 **82 表**（67 个本轮实现的逻辑目录表 + 15 个实现关联／账本表），**814 字段**、424 个外键列（149 个复合 FK 组）、60 个显式索引（25 个部分唯一）、252 个 CHECK（71 表含 CHECK）、92 个触发器、全部 82 表 STRICT。
- 77 表逻辑目录逐项分类闭合：67 实现、9 用户暂缓且入口关闭、1 由 06 来源级排除替代；**未为暂缓功能建空表**，也未把骨架当完成。
- 115 个旧 PG 名称逐项分类闭合：80 本轮实现（含 1 项同时落到实现表与替代落点）、1 由来源级排除替代、8 目标表本轮暂缓（13／15 范围）、2 查询派生不建表、1 手动导入入口退役、16 本轮范围外（Skill 学习／审核等）、7 已确认退役。逐项 disposition 已落到提交 fixture 并有覆盖断言。
- 产品运行入口（`sqlite-host-plugin.ts`、`launch.ts`、桌面 main）运行时 import 图 **0 个 pg 值导入**；旧 PG 宿主、managed PostgreSQL、旧 schema 准备与手动文件导入入口不可从产品入口到达。
- 默认开发入口实测：无预置控制文件时自动创建独立 `database_id`／owner／迁移账本，8 项切换核验全通过，正常关停与重开沿用同一实例；维护态与失败重试在隔离演练中覆盖。
- 真实清理：本机无 PostgreSQL socket／进程，默认 App `userData` 未发现受管 PG 集群、旧业务副本目录或 SQLite 控制面；存在旧启动配置指向的外部项目与握手，内容未读取、归属未确认。**真实旧业务库与应用副本无法精确归属，实际清理保持受阻，未执行任何真实删除。**
- 已按本轮范围显式修订 ADR-101／102、089／100、107／108，并补充 ADR-109 的阶段关闭说明。

## 2. 结构与 DDL 核对

### 2.1 77 表分类

| 类别 | 数量 | 说明 |
| --- | ---: | --- |
| 本轮实现 | 67 | 含 `database_instance`、`schema_migration` 两张元数据表；结构测试逐表核对字段／外键／索引／触发器集合 |
| 用户暂缓且入口关闭 | 9 | 13 偏好：`expression_preference`、`expression_preference_version`、`preference_source`；15 纠错／诊断：`organization_feedback`、`feedback_input`、`quality_case`、`quality_case_input`、`quality_run`、`quality_attempt`。不建表，SQLite 宿主相关能力声明 unavailable |
| 已替代 | 1 | `read_exclusion` 的整会话读取排除未实现；06 提供来源级排除 `history_source_exclusion`，只覆盖已确认范围的来源排除，不冒充整会话分支 |

逐表见附录 A。实际实现另含 15 张实现关联／账本表（`document_*`、`history_*`、`message_alias`、`reply_candidate_input/context/request`、`reply_execution_input`、`runtime_file`），均有对应票与真实动作，不冒充逻辑目录之外的领域平台。

### 2.2 字段与约束差异（已确认差异 + 影响）

- 已实现表的逻辑目录字段预期 674 个，实际 726 个；净增 52 个。差异构成为 **49 个目录字段未落为同名列** + **101 个实现补充字段**。
  - 49 个未落字段集中在：暂缓目标的 quality／feedback／preference 分支；发布指针与循环 FK 字段（`owner.current_publication_id`、`contact.current_publication_id`、`processing_task.accepted_publication_id`、`reply_context.owner/contact_publication_id`）；材料／版本分支（`run_input`、`execution_input`、`reply_context_item`、`reply_basis` 等）。影响：这些事实在本轮范围外或由实现子表（`reply_candidate_input*`、`reply_candidate_context`、`reply_execution_input` 等）与 06／07／09／12 的既有合同承载，不能据此声称 77 表逐字段 1:1 兼容。
  - 101 个实现补充字段集中在：运行代次／租约／幂等键、证据与摘要、隔离与清理账本、显式失败原因、`history_*` 成员／fence／restore、`media_file` 发布与清理状态、`runtime_copy` 目录身份与清理意图、Skill 目录身份与启用来历。影响：属于实现必要账本，不新增领域平台；结构基线 fixture 已锁定，后续漂移会使结构审计测试失败。
- 外键：逻辑目录 215 个基础 FK 契约，落到本轮已实现表的 186 组；实际 149 组。**51 个契约组未以 SQL FK 落地**，同时实现新增 14 组实际 FK，净差 37。分类与影响：
  | 类别 | 组数 | 影响与处置 |
  | --- | ---: | --- |
  | 暂缓目标表 | 11 | 目标表不建（13／15），FK 随之不建；入口关闭 |
  | 发布指针／当前版本循环 FK | 5 | 采用延迟 NO ACTION 的循环 FK 未在迁移 1–15 加回；本轮由发布动作事务内同 scope 检查与既有 08／09 回归覆盖，不新增迁移 16 |
  | 范围候选键（`(owner,contact)` 等） | 27 | 复合候选键 FK 未全部声明；由 92 个范围触发器（33 个来源／范围一致性）与具名动作复验共同承担。已确认差异：触发器覆盖不到的分支仍需业务复验，不能只凭同 owner 外键认定权限正确 |
  | 材料／版本分支 | 8 | 指向暂缓表或由实现子表承载的选择／反馈／偏好分支；实际由子表 FK 与动作校验承担 |
- 索引与触发器：60 个显式索引中 25 个部分唯一，覆盖当前版本／发布指针、有效租约、媒体 current/present、消息去重、任务领取、删除重试与来源反查；92 个触发器按类别为范围／来源一致性 33、不可变／终态 35、写入状态迁移 7、其他 17，触发器名称、所属表与归一化后的完整 body 均进入基线逐项比对。
- 事务与约束验证（结构测试）：实际 DDL 与 82 表基线逐表一致，比较范围包含每表归一化 `sqlite_master.sql`（全部 252 条 CHECK 与约束）、列类型／NOT NULL／默认值、外键列组与 `on_update`／`on_delete`／`match`、索引完整定义与 SQL、92 个触发器 body、视图集合；迁移账本 1–15、`user_version=15`；重开后 database_id 与结构视图稳定；5 类真实反例（外键拒绝、CHECK 拒绝、范围触发器拒绝 ×2、事务回滚）均被 SQLite 阻止；`integrity_check` 与 `foreign_key_check` 通过。
- 可复现命令：`cd backend-ts && node test/fixtures/cutover/build-structure-baseline.mjs` 重新生成结构基线；`node test/fixtures/cutover/build-audit-catalog.mjs <consolidated-schema.json> <consolidated-legacy-check.json>` 重新生成 77 表与 115 旧名称的 disposition fixture。fixture 记录来源工件名与 SHA-256，不复制私人明文。

### 2.3 验证方式

- 以同版本 `node:sqlite`（SQLite 3.53.4）在隔离根按迁移 1–15 创建实例，导出实际结构并与固定基线比对；基线由 `backend-ts/test/fixtures/cutover/build-structure-baseline.mjs` 生成，测试 `sqlite-cutover-structure.test.mjs` 逐表锁定，任何 DDL／CHECK／触发器 body／FK action／索引／视图漂移直接失败。
- 逻辑目录与旧名称使用 `logical-catalog.json`、`legacy-disposition.json` 两个可公开提交的 fixture 承载（77 表／778 字段／215 FK 计数、115 项 disposition 与落点），由 `sqlite-cutover-audit.test.mjs` 与代码分类、实际表集合交叉断言；原始设计工件仍在 `.scratch/sqlite-database-rebuild/`，fixture 只保留表名／计数／结论。
- 结构基线同时约束暂缓／替代表不出现，以及危险 DDL 与范围触发器集合不增减。

## 3. 旧 PG 名称映射（115）

- 分类：80 本轮实现（旧事实在新结构有明确落点；其中 1 项同时涉及实现表与 06 来源级排除替代）；1 由 06 来源级排除直接替代；8 目标表本轮暂缓（落到 13／15 暂缓表，入口关闭）；2 查询派生不建持久表；1 旧手动导入入口退役（`import_confirmation`）；7 已确认退役（旧升级／计划／候选流程不复刻、`organization_quality_revocation` 无消费者）；16 本轮范围外（`reply_skill_*`／`skill_learning_*`／`skill_review_*`／`skill_policy_*` 等学习审核平台）。共 115 项，0 未分类。
- 逐项落点与结论见附录 B；`consolidated-legacy-check.json` 的“接线未验证”描述是设计期状态，本票对每个落点补了实现／暂缓／退役分类，但不把分类当作逐条 SQL 兼容或旧数据迁移承诺。

## 4. 消费者映射与改接

### 4.1 产品入口

| 入口 | 结果 |
| --- | --- |
| `backend-ts/src/sqlite-host-plugin.ts`（唯一插件入口） | 运行时可达 128 个源文件，**0 个 pg 值导入**；不触及 `host-plugin.ts`、`managed-postgres.ts`、`schema-prepare-cli.ts`、`platform/database/host-storage.ts` |
| `backend-ts/src/launch.ts` | 只接受 sqlite 配置；无配置时抛 `backend_launch_requires_sqlite`；只读取 `profile/sqlite.patch.yml` 与 `src/sqlite-host-plugin.ts`；不再透传 `PG*` 环境 |
| `desktop/src/main/index.ts` | 运行时 import 图 0 个 pg 值导入；启动诊断只装配 SQLite 切换控制面，managed PG／旧 schema 准备不可达 |

### 4.2 领域改接

| 领域 | SQLite 实现 | 旧 PG 消费者状态 |
| --- | --- | --- |
| 同步／历史／清空重读 | `history/sqlite/{schema,actions,service,http,clear,resync,coordinator,incremental-coordinator,wechat-channel}.ts`（迁移 5／14／15） | 旧 sync／imports 入口退役，不可从产品入口到达 |
| 记忆提取／追踪 | `memory/sqlite/{schema,execution-schema,runs,execution,runtime}.ts`（迁移 8／9） | 旧 memory 处理消费者不可达；13／15 入口关闭 |
| 记忆裁决／管理 | `memory/sqlite/management/**`（迁移 11／12） | 旧 adoption／scoring 消费者不可达 |
| 文档／发布 | `memory/sqlite/documents/**`（迁移 13） | 旧 records/documents 消费者不可达 |
| 回复候选／讨论 | `reply/sqlite/**`（迁移 7／10） | 旧 generation／discussion／runtime 消费者不可达；replies 能力声明 unavailable |
| Skill | `skills/sqlite/**`（迁移 4） | 旧学习审核消费者不可达；skillLearning unavailable |
| 媒体 | `media/sqlite/**`（迁移 6，三实体 + 统一删除扩展） | mediaExtraction unavailable；18 语音最小停用、19 暂缓 |
| 删除／元数据 | `storage/sqlite/**`（迁移 2，统一删除账本，7 个删除 scope） | 旧 cross-domain 消费者不可达 |

- 全仓仍有 129 个源文件引用 pg：仅 **4 个文件存在值导入（4 处语句，其中 1 处为动态 import）**——`platform/database/host-storage.ts`、`reply/discussion/assistant-generation-lifecycle.ts`、`skills/skill-learning-http.ts`、`skills/skill-source-proof.ts`；均不可从三个产品入口运行时可到达，退役回归用精确快照锁定该集合。其余 125 个仅类型导入。它们保留为不可达遗留源码，本票不删除全部旧模块，也不把“文件存在”当作活跃消费者。
- 92 个 current 测试需要本机 PostgreSQL（本机无 PG 时既有基线即为红）：**单列为既有基线，不修、不掩盖**；它们不构成产品入口的活跃消费者，也不作为本票验收依据。
- 13 偏好、15 纠错／诊断、18 语音、19 真实媒体入口：SQLite 宿主 ownership 明确声明 `expressionPreferences`／`replies`／`skillLearning`／`taskApi`／`tasks`／`imports`／`mediaExtraction` 为 unavailable；媒体适配器以空列表装配，语音保存／转换与真实资源关联不开放。行为回归（`sqlite-cutover-disabled-capabilities.test.mjs`）实际启动 SQLite 宿主并断言旧回复生成、Skill 学习、手动导入、媒体提取路由返回 503/404，只开放 contacts／discussions 等本轮已实现能力。13／15 不通过本票补做功能来解除依赖。
- 语义澄清：ownership 的 `replies: 'unavailable'` 指旧 PG 回复生成入口已退役，不代表 12 的候选回复不可用；候选回复由 `discussions` 能力与 `reply/sqlite/**` 承载，`status.ownership.discussions` 为 typescript，旧 `/api/reply/generate` 保持 503。

## 5. 媒体、删除与 Skill 闭包

- 媒体结构：`message_media`／`media_extraction_attempt`／`media_file` 三表及 FK、状态约束、current/present 部分唯一、发布／清理意图字段均在 82 表基线内，结构测试与 16 的既有媒体回归共同覆盖；17 的真实资源入口保持关闭。
- 统一删除：`installedDeletionScopes` 覆盖 source／contact／contact_history／account／media_result_clear／media_result_replace／discussion；媒体三实体注册进统一删除账本，删除复核面含数据库行、derived 资格、trace 载荷、受管文件、活动引用与 SQLite 页／WAL。切换核验读取该静态注册并断言必要 scope 存在。
- 活动引用复核：切换控制面在启动前核验旧写入者握手、launch 锁、旧 PostgreSQL postmaster、外置旧后端握手与当前 SQLite 握手；运行中不启动业务双写；不终止未知进程。
- Skill 空库：目标库 `skill_package`／`skill_package_revision` 为 0 行，切换检查记录 `skill_empty_safe=passed`；用户 Skill 原目录不读取、不删除、不默认停用，官方加载继续由目录与 DSH 官方机制负责，已可证启停／未知状态由既有 Skill 票的独立记录区分，不伪造旧审核或授权。
- 媒体区安全：新库为空但 `managed/media` 仍有文件时，切换检查判 `legacy_media_area_unverified` 并保持维护态，不自动删除无法归属的旧媒体；隔离演练覆盖该拒绝路径与移除后沿用同一实例完成切换。

## 6. 切换控制面、维护态与隔离演练

控制面实现：`backend-ts/src/platform/cutover/`（contracts／control／targets／cleanup／startup／inspect／structure）。

- 控制面位置：`${userData}/database-cutover/manifest.json`（目录 0700、文件 0600、原子写＋目录 fsync），记录目标 `database_id`／owner、阶段、旧目标清单、停写核验、检查面与授权摘要；**不放在待删除的旧 PG 或 SQLite 文件内**，不保存密码、token、正文或可恢复定位。启动配置 `sqlite-development.json` 仅在全部检查通过后原子写入。
- 目标识别：只把 userData 内结构可证明归属的对象标 confirmed（受管 PG 集群、受管状态、runtime.env、受管更新档案、`assistant-runtime` 会话副本、导入标记、生命周期锁、握手）；未知归属、符号链接、越界路径、未预期结构一律阻断。模型密钥、用户 Skill 原目录与外部微信原件从不在清理目标内；`runtime.env` 清理只删旧数据库连接／PG 密码行，保留模型密钥行。
- 授权：真实清理必须有显式 `authorization.json`（目标 id + clean 决定 + 范围标签）；未授权、授权不完整或归属未知均保持维护态，不清理。隔离演练用 `scope: synthetic` 授权。
- 维护态：存在未完成切换时正常入口只发布维护态并在界面显示原因与重试／诊断入口，不启动旧 PG、不启动新业务写入、不创建第二个空库；重试沿用已记录目标身份，已清理目标幂等跳过。清理完成与配置切换之间再次核验旧写入者，若旧进程重新出现则停止在维护态、不写启动配置。
- 切换顺序与失败语义：编排固定为「识别→停写核验→按授权清理→创建／打开目标→目标检查→二次停写核验→原子写配置」。旧业务清理先于新库创建；若清理成功而目标创建／检查失败，保持维护态，不恢复旧 writer、不写配置、不以异常自动换空库；重试从已记录阶段继续，若目标文件已产生但身份未记录则停止并要求人工核验，避免第二次创建空库。
- 新实例：空隔离根创建新 `database_id`、新 owner 与迁移账本 1–15；重试只按 `database_id` 打开，数据库文件存在但身份未记录时停止并保留现场（`cutover_target_unrecorded`），不自动删除重建。
- 隔离合成演练（`sqlite-cutover-rehearsal.test.mjs`，11 项全通过）：空根默认创建；未授权旧目标保持维护态且不删不建；未知归属阻断且不删；旧写入者存活阻断→停写并授权后清理完成、保留模型密钥／Skill／外部原件并切配置；清理失败保留维护态→修复现场同操作重试且不重建空库；创建后异常不以新空库掩盖失败；配置被篡改拒绝、目标缺失不重建；媒体区占用阻断→移除后沿用同一目标实例完成切换；synthetic 授权不得清理非隔离根、真实根必须 confirmed_local；清理完成但目标创建失败保持维护态且不恢复旧 writer／不建第二个空库；清理后配置切换前重新出现旧写入者时停止切换。
- 结构审计（`sqlite-cutover-structure.test.mjs`，4 项全通过）；退役静态回归（`sqlite-cutover-retirement.test.mjs`，5 项全通过，锁定产品入口 import 图、launch 只读 SQLite profile、导入入口移除、13／15／17 能力 unavailable、managed PG 不可达）。

## 7. 真实对象归属与清理状态（受阻）

只读核验事实（未读取业务内容、未创建控制面、未删除任何对象）：

- 本机无 PostgreSQL socket（`/tmp/.s.PGSQL.5432` 不存在），无 postgres 进程；t03 此前亦确认本机无 PG。
- 默认 Electron `userData` 下不存在 `managed/`、`managed/postgres`、`managed/state.json`、`managed/updates`、`managed/runtime.env`、`assistant-runtime`、`sqlite-development.json`、`database-cutover`；因此没有可识别归属的受管旧 PG 集群、旧业务副本或本票控制面。
- 默认 `userData` 存在旧 `backend-launch.json`，指向的外部项目目录与握手内容未读取、归属未确认；未运行真实切换，因此未对其做任何清理或改写。
- `~/.notalone/skills` 存在 270 个用户 Skill 目录（外部 Skill 原目录），按边界保留，未读取、未修改、未删除。
- 结论：**真实旧业务库、含内容助手会话、缓存、派生文件与应用持有的旧业务副本无法精确归属**；本票不执行真实切库、drop、真实清理或真实维护态切换。实际清理状态为受阻，需后续明确授权、停止旧写入者并逐目标确认归属后才可执行；本文件不保存私人数据、凭据或可恢复定位。

## 8. ADR 修订（实施中显式修订，不由文档发布声称已切）

- ADR-101：数据库底座与“保留本机 PostgreSQL”条款由 ADR-109 及本票取代；首用／安装／发布仍搁置，DSH、凭据、Skill、外部原件与删除边界保持。
- ADR-102：保留 PostgreSQL／原 PG 表结构与迁移账本条款被取代；正常入口只有受控 SQLite 宿主，旧 PG 写入者不得在切换后运行；其他 DSH 架构与业务外壳约束保持。
- ADR-089：all_private 表达能力保留，但空库不迁旧全部私聊授权／排除／代次；本轮仅逐人确认，真实渠道入口保持关闭。
- ADR-100：旧 baseline 与手动文件补历史入口退役；按 ADR-113 重新建立读取目标，真实微信未认证不开放正文。
- ADR-107：统一记忆处理行为保留；旧 PG 任务与旧入口退役，空库不继承旧任务进度；SQLite 侧按真实轮次／来源合同重新开始；13／15 入口关闭。
- ADR-108：旧 PG 存量任务隔离只保留为历史合同；不迁旧任务、失败事实或未决回执，不借本决定恢复 13／15。
- ADR-109：阶段条款“默认业务仍为 PG”关闭；默认入口执行 SQLite 切换控制面，真实切库与清理仍未执行。

## 9. 验证命令与结果

| 验证 | 命令（工作树根） | 结果 |
| --- | --- | --- |
| 后端锁定类型 | `cd backend-ts && <主仓>/backend-ts/node_modules/.bin/tsc --noEmit`（TypeScript 7.0.2） | 0 错误 |
| 桌面锁定类型 | `cd desktop && <同一 tsc> --noEmit` | 0 错误 |
| 切换结构／演练／审计／退役／停用 | `cd backend-ts && node --test test/sqlite-cutover-{structure,rehearsal,audit,retirement,disabled-capabilities}.test.mjs` | 24/24 通过（4＋11＋2＋5＋2） |
| 相关后端模块 | 见 §9.1 | 113/113 通过 |
| 桌面启动相关 | `cd desktop && node --test tests/sqlite-development.test.mjs tests/startup-continuity.test.mjs tests/pure-ts-startup.test.mjs` | 16/16 通过 |
| 测试清单 | `cd desktop && node scripts/test-inventory.mjs` | 登记通过 |
| 正常开发入口 | 隔离根 + `/tmp/t09-node/bin/node desktop/scripts/dev.mjs --user-data-dir <root>`（即 `pnpm run dev` 执行的同一脚本） | 默认创建 SQLite（8 项检查全 passed）、5 页 UI 正常、无 console error、正常关停 pids[]、握手删除、重开同 database_id／owner；隔离根已清理 |
| 当前用例实跑对照 | `cd backend-ts && node test/run-current.mjs --test-reporter=spec`（本树 vs 15ac355a 隔离树） | 见 §9.2 |
| 公开前检查 | `node scripts/check_public_history.mjs --ref HEAD --working-tree` | 0 问题（定稿提交时重跑） |

### 9.1 相关后端模块

`node --test test/sqlite-storage.test.mjs test/sqlite-host-*.test.mjs test/sqlite-skill*.test.mjs test/sqlite-history*.test.mjs test/sqlite-clear-http.test.mjs test/sqlite-memory-{control,schema}.test.mjs test/sqlite-media.test.mjs test/sqlite-deletion.test.mjs test/sqlite-shared-producer-schema.test.mjs`：113/113 通过。

### 9.2 当前用例实跑与基线对照

- 本树实跑：`tests 1559 / pass 946 / fail 612`，失败文件集合 108 个；除 `sqlite-memory-profile.test.mjs` 的 2 项断言失败外，全部为「本机无 PostgreSQL」基线（`connect ENOENT /tmp/.s.PGSQL.5432` 或「合成 PG 准备失败」）。
- 15ac355a 隔离基线树实跑：`tests 1506 / pass 928 / fail 577`，失败文件集合 111 个；非 PG 失败同样为 `sqlite-memory-profile.test.mjs` 的 2 项。
- 按失败文件集合对比：本树**无新增失败文件**；相对基线减少/消失的旧文件为 `host-launch.test.mjs`、`python-retirement-host.test.mjs`（已按退役登记删除）与 `host-readiness.test.mjs`。失败计数差异来自 PG 连接失败的子测试数与新增 cutover 测试（新增文件全部通过），不表示新增回归。
- 修复后不再有 `backend_launch_requires_sqlite` 残留失败；`sqlite-history-startup-host.test.mjs` 3 项恢复通过。
- 新增 cutover 测试文件全部纳入 current 执行并通过；不修改需 PG 的既有测试，也不把它们计作本票验收。

## 10. 12 条验收逐条判定

| # | 验收项 | 判定 | 证据／限制 |
| ---: | --- | --- | --- |
| 1 | 77 表／778 字段／215 FK／115 名称逐项核对与 DDL／索引／CHECK／范围触发器／事务验证 | 通过（含已确认差异） | 本文件 §2、§3 与附录 A–C；结构基线逐表锁定完整 SQL／CHECK／触发器 body／FK action／索引／视图；logical-catalog 与 legacy-disposition fixture 覆盖断言；不新增迁移 16 |
| 2 | 活跃 PG 消费者改接或按范围退役；13／15 停用且无旧 PG 回退 | 通过 | 产品入口运行时 import 图 0 pg 值导入；域级改接表；unavailable 声明与无 sqlite 配置失败 |
| 3 | 16 媒体结构／文件登记／发布替换／统一删除／活动引用先通过；17 入口关闭；18／19 暂缓；媒体闭包完整 | 通过（真实资源未认证） | 三实体结构与删除注册在基线；17 real 入口关闭；18／19 不启用；媒体区未知归属阻断 |
| 4 | 隔离合成演练目标识别／停机／清理／失败重试／配置切换；未知不清理 | 通过（隔离） | 11 项演练，含 synthetic 授权隔离根门禁、清理后失败与清理后旧 writer 重现；真实清理对象归属未知，真实对象不清理 |
| 5 | 维护态撤销并核验旧 writer／任务／DSH 停止；不强杀未知进程；未确认停写不双写 | 通过（合同与演练） | 停写核验、配置切换前二次核验与维护态在演练覆盖；真实环境无旧 PG 进程、无受管旧副本；未知写入者阻断不杀 |
| 6 | 新独立 database_id／owner／SQLite 账本；不迁旧业务；不保留旧 PG 备份；重试不造第二个空库 | 通过（隔离与代码合同） | 默认入口实测；重试身份复用与 target_unrecorded 测试 |
| 7 | 切换控制与清理进度位于不随目标删除的控制面；唯一恢复凭据不入待删目标 | 通过 | `database-cutover/manifest.json` 控制面；manifest 仅存固定身份／摘要／进度，不存密码或正文 |
| 8 | 按确认归属清理旧库／会话／缓存／派生文件；保留模型密钥、原 Skill、外部原件 | 隔离演练通过；真实清理受阻 | 演练验证保留与清理边界；真实对象归属未知，保持受阻并记录 |
| 9 | 空库无 Skill 业务行不触发孤儿误删或默认全停用；可证启停／未知分开接回官方加载 | 通过 | 空 Skill 行检查 passed；原目录保留；Skill 票既有 verified/unknown 合同 |
| 10 | 全部必要面核验完成才原子切配置；失败继续维护态不回退旧 writer、不自动空库 | 通过（合同与演练） | 8 项检查、失败注入与重试测试；配置写入失败后目标身份复用 |
| 11 | 按范围退役手动导入与旧 PG 启动路径；显式修订 ADR；不以文档声称已切 | 通过 | 导入与旧 PG 入口退役；6 份 ADR＋ADR-109 修订；真实切库未执行 |
| 12 | 正常开发入口复核默认库身份、关键业务和关停；记录实际归属／清理状态／限制 | 通过（隔离根） | §9 开发入口实测与本文件 §7 真实归属记录 |

## 11. 限制与未认证项

- 未执行真实切库、drop、真实旧业务清理、维护态切换或旧数据迁移；真实旧对象归属不明，实际清理受阻。
- 未操作微信、未发送消息、未调用真实模型、未打包或运行打包版、未 push／PR；发布面（release inventory／打包脚本）未修改。
- `managed-postgres.ts` 与 `schema-prepare-cli.ts` 源文件按裁决保留（已不可从产品入口到达，发布清单引用未改，属发布面范围外），不视为活跃能力。
- 92 个需要 PG 的 current 测试是既有基线红，不在本票修；不作为产品入口可用性的依据。
- 49 个目录字段未同名列落地、51 个 FK 契约组未以 SQL FK 落地为已确认差异，部分由实现子表与范围触发器承担；不能据此宣称 77 表逐字段／逐 FK 1:1 兼容。
- `read_exclusion` 整会话排除分支未实现，只有 06 的来源级排除；本轮不开放未确认的整会话范围。
- 开发入口以 `role: 'test'` 的受控实例复核；App 首次使用、安装向导与发布流程继续搁置，不能把本次开发入口验证当作发布包或真实用户迁移通过。
- 真实微信历史覆盖、媒体唯一关联与模型语义质量仍未认证，相关入口保持关闭。
- 当前用例实跑仍有既有 PG 基线失败（本机无 PG）与 15ac355a 同样存在的 2 项 memory-profile 失败；本票不修、不掩盖，也不据此宣称全量测试全绿。
- `managed-postgres.ts`、`schema-prepare-cli.ts` 源文件按裁决保留且不可从产品入口到达；release inventory／打包脚本未改，属发布面范围外。

## 12. 审查阻断修复复核（final）

| 阻断 | 修复 | 证据 |
| --- | --- | --- |
| S-B1 后端锁定类型 10 errors | 补 `SqliteCapabilitiesConfiguration` 类型导入，收紧 `StartupConfiguration` 的 capabilities 必填与 Skill 根成组 | TypeScript 7.0.2 `tsc --noEmit` 0 错误 |
| S-B2 桌面锁定类型 7 errors＋导入按钮残留 | process.ts 要求 sqlite 配置并固定最小环境；host.ts 删除 managed 分支；BindingConsentPage 删除导入导航；StartupSettings／backend-status 清理 managed 死分支；startup-bridge mode 收紧 | 同一锁定 tsc 0 错误；源码检索无 `navigate('import')`／ImportController |
| S-B3 旧 helper 无 sqlite 调用 | contact-context-support helper 明确装配受控 SQLite；python-retirement-host 移入 historical 登记并删除当前树文件；修复 launch 对 businessHome 的过度相等校验（真实宿主允许 userData 子目录） | `run-current` 实跑：本树 vs 15ac355a 基线无新增失败文件；无 `backend_launch_requires_sqlite` 残留；sqlite-history-startup-host 3 项恢复通过 |
| S1 结构审计未锁 CHECK／trigger body／FK action | 基线改为归一化完整 SQL＋完整 PRAGMA 导出（列默认值、FK action、索引 SQL、92 触发器 body、视图），提交生成脚本与复现命令；反例扩展到 5 类 | `sqlite-cutover-structure.test.mjs` 4/4；基线 metadata 252 CHECK／92 trigger／814 字段／173 FK 组 |
| S2 77/778/215/115 disposition 未落提交 | 提交 `logical-catalog.json`（77／778／215，67 实现／9 暂缓／1 替代）与 `legacy-disposition.json`（115 项、0 未分类）＋生成脚本；审计测试断言计数与落点；verification 引用原始工件 | `sqlite-cutover-audit.test.mjs` 2/2 |
| S3 synthetic 授权可删真实根 | `allowSyntheticAuthorization` 仅在系统临时根下的隔离 userData 由桌面探针传入；真实根必须 `confirmed_local`，否则 blocked 且不删除 | rehearsal「synthetic 授权不得清理非隔离根；真实根必须 confirmed_local」通过 |
| S4 消费者映射不精确／replies 语义 | 退役测试锁定 4 个 pg 值导入文件快照（含动态 import），3 个产品入口 0 可达；verification 澄清 replies 指旧 PG 生成入口，候选回复由 discussions 承载并加行为断言 | `sqlite-cutover-retirement.test.mjs` 5/5；disabled-capabilities 2/2 |
| S5 13/15/18/19 证据偏弱 | 新增行为测试：实际启动 SQLite 宿主校验 ownership unavailable 与旧回复／Skill／导入／媒体路由 503/404 | `sqlite-cutover-disabled-capabilities.test.mjs` 2/2 |
| S6 演练缺口 | 增 synthetic 门禁、清理后创建失败、清理后旧 writer 重现 3 项；媒体非空路径已有用例 | rehearsal 11/11 |
| S7 切换顺序风险 | verification §6 写明清理→建库→检查→二次停写→原子切换及失败保持维护态语义 | 本文 §6、§12 |

## 附录 A：77 表逐项结构核对

| # | 分组 | 表名 | 本轮分类 | 实际列 | FK组 | 索引 | 触发器 | CHECK | 已确认差异 |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 身份与来源 | `owner` | 本轮实现 | 11 | 0 | 1 | 0 | 3 | 增列 state；FK 契约未落 1 组 |
| 2 | 身份与来源 | `contact` | 本轮实现 | 12 | 1 | 1 | 0 | 3 | FK 契约未落 1 组 |
| 3 | 身份与来源 | `channel_account` | 本轮实现 | 10 | 1 | 3 | 0 | 3 | 增列 source_generation |
| 4 | 身份与来源 | `channel_conversation` | 本轮实现 | 7 | 1 | 2 | 0 | 1 | — |
| 5 | 身份与来源 | `conversation_binding` | 本轮实现 | 6 | 2 | 4 | 1 | 2 | — |
| 6 | 身份与来源 | `binding_verification` | 本轮实现 | 8 | 1 | 2 | 1 | 3 | — |
| 7 | 身份与来源 | `read_grant` | 本轮实现 | 9 | 2 | 4 | 3 | 2 | FK 契约未落 1 组 |
| 8 | 身份与来源 | `read_goal` | 本轮实现 | 25 | 2 | 3 | 1 | 2 | 缺列 restore_request_key/restore_confirmed_at；增列 target_json/eligibility_json/support_json/completed_partitions/failure_code/created_at/resume_cursor/cursor_scope_digest/cursor_scheme/handoff_from_goal_id/pages_accepted/last_accepted_at；FK 契约未落 1 组 |
| 9 | 身份与来源 | `history_cutoff` | 本轮实现 | 19 | 3 | 2 | 0 | 4 | 增列 contact_id/source_generation/account_key/conversation_key/target_json/support_json/proof_json/manifest_sha256/member_count/reason/created_at |
| 10 | 身份与来源 | `read_exclusion` | 已替代 | 0 | 0 | 0 | 0 | 0 | 06 来源级排除 history_source_exclusion；未实现整会话分支 |
| 11 | 身份与来源 | `sync_capture` | 本轮实现 | 13 | 1 | 2 | 0 | 1 | 增列 response_digest；FK 契约未落 1 组 |
| 12 | 身份与来源 | `capture_record` | 本轮实现 | 13 | 2 | 5 | 3 | 4 | 增列 availability；FK 契约未落 1 组 |
| 13 | 身份与来源 | `message` | 本轮实现 | 19 | 1 | 6 | 1 | 7 | 增列 display_no/status_code/status_observed_at；FK 契约未落 1 组 |
| 14 | 身份与来源 | `manual_confirmation` | 本轮实现 | 8 | 1 | 3 | 1 | 1 | — |
| 15 | 处理与调用 | `processing_run` | 本轮实现 | 9 | 1 | 2 | 0 | 2 | 缺列 finished_at；增列 policy_config |
| 16 | 处理与调用 | `run_contact` | 本轮实现 | 12 | 3 | 2 | 1 | 1 | 增列 binding_id/accepted_identity_generation/accepted_account_revision/accepted_source_generation |
| 17 | 处理与调用 | `processing_item` | 本轮实现 | 8 | 2 | 3 | 0 | 5 | FK 契约未落 1 组 |
| 18 | 处理与调用 | `run_input` | 本轮实现 | 10 | 3 | 3 | 2 | 3 | 缺列 memory_id/memory_version_no/document_id/document_version_no/feedback_id；FK 契约未落 6 组 |
| 19 | 处理与调用 | `processing_task` | 本轮实现 | 13 | 3 | 4 | 3 | 5 | 增列 error_code；FK 契约未落 1 组 |
| 20 | 处理与调用 | `task_contribution` | 本轮实现 | 4 | 2 | 1 | 0 | 0 | FK 契约未落 2 组 |
| 21 | 处理与调用 | `processing_step` | 本轮实现 | 10 | 2 | 2 | 3 | 6 | 增列 accepted_memory_revision |
| 22 | 处理与调用 | `step_input` | 本轮实现 | 18 | 7 | 6 | 3 | 2 | 缺列 role/feedback_id；增列 accepted_state_revision/accepted_head_revision/source_contact_id/message_id/record_id/accepted_revision/publication_id；FK 契约未落 1 组 |
| 23 | 处理与调用 | `step_attempt` | 本轮实现 | 13 | 1 | 4 | 1 | 1 | 增列 runtime_token |
| 24 | 处理与调用 | `model_operation` | 本轮实现 | 9 | 2 | 3 | 3 | 3 | 缺列 resolution_code/quality_run_id/quality_case_id；FK 契约未落 2 组 |
| 25 | 处理与调用 | `operation_item` | 本轮实现 | 5 | 2 | 2 | 0 | 1 | — |
| 26 | 处理与调用 | `operation_scope` | 本轮实现 | 5 | 2 | 2 | 0 | 1 | 缺列 scope_kind/contact_id；增列 source_contact_id；FK 契约未落 1 组 |
| 27 | 处理与调用 | `model_call` | 本轮实现 | 22 | 4 | 3 | 3 | 8 | 缺列 input_tokens/output_tokens/quality_attempt_id；增列 receipt/model/configuration_id/input_cap/output_cap；FK 契约未落 1 组 |
| 28 | 实际追踪 | `execution_event` | 本轮实现 | 12 | 4 | 3 | 5 | 4 | 缺列 quality_attempt_id；FK 契约未落 1 组 |
| 29 | 实际追踪 | `execution_input` | 本轮实现 | 10 | 4 | 2 | 2 | 1 | 缺列 source_contact_id/message_id/record_id/accepted_revision/candidate_id/memory_id/memory_version_no/document_id/document_version_no/feedback_id/quality_case_id/quality_input_no/kind；增列 producer_event_id；FK 契约未落 8 组 |
| 30 | 实际追踪 | `event_source` | 本轮实现 | 4 | 2 | 2 | 2 | 0 | FK 契约未落 1 组 |
| 31 | 记忆与裁决 | `memory_candidate` | 本轮实现 | 10 | 4 | 5 | 5 | 4 | 增列 event_id |
| 32 | 记忆与裁决 | `memory` | 本轮实现 | 9 | 4 | 2 | 1 | 5 | — |
| 33 | 记忆与裁决 | `memory_version` | 本轮实现 | 12 | 4 | 4 | 2 | 9 | — |
| 34 | 记忆与裁决 | `memory_decision` | 本轮实现 | 13 | 4 | 4 | 3 | 7 | 缺列 quality_attempt_id；增列 request_seal；FK 契约未落 1 组 |
| 35 | 记忆与裁决 | `decision_candidate` | 本轮实现 | 5 | 2 | 3 | 4 | 1 | — |
| 36 | 记忆与裁决 | `memory_required_message` | 本轮实现 | 7 | 3 | 4 | 1 | 1 | FK 契约未落 1 组 |
| 37 | 记忆与裁决 | `memory_citation` | 本轮实现 | 12 | 3 | 4 | 1 | 2 | 增列 accepted_revision；FK 契约未落 1 组 |
| 38 | 助手与副本 | `assistant_discussion` | 本轮实现 | 10 | 2 | 3 | 1 | 3 | 增列 generation/is_current/created_at/last_activity_at |
| 39 | 助手与副本 | `discussion_entry` | 本轮实现 | 11 | 4 | 3 | 4 | 5 | 增列 origin_event_id；FK 契约未落 1 组 |
| 40 | 助手与副本 | `reply_request` | 本轮实现 | 12 | 5 | 4 | 1 | 4 | 缺列 carried_selection_id；FK 契约未落 2 组 |
| 41 | 助手与副本 | `reply_attempt` | 本轮实现 | 14 | 1 | 4 | 0 | 2 | 增列 accepted_discussion_generation/accepted_source_revision/accepted_runtime_id/accepted_storage_epoch |
| 42 | 助手与副本 | `reply_context` | 本轮实现 | 14 | 3 | 3 | 1 | 4 | 缺列 owner_publication_id/contact_publication_id；增列 skill_run_json；FK 契约未落 3 组 |
| 43 | 助手与副本 | `reply_context_item` | 本轮实现 | 13 | 4 | 1 | 2 | 3 | 缺列 candidate_id/memory_id/memory_version_no/document_id/document_version_no/preference_id/preference_version_no/selected_candidate_id/selected_version_no/selection_id；FK 契约未落 7 组 |
| 44 | 助手与副本 | `reply_candidate` | 本轮实现 | 4 | 1 | 3 | 0 | 1 | — |
| 45 | 助手与副本 | `reply_candidate_version` | 本轮实现 | 9 | 3 | 2 | 2 | 5 | 增列 part_count |
| 46 | 助手与副本 | `reply_version_part` | 本轮实现 | 5 | 1 | 1 | 1 | 2 | — |
| 47 | 助手与副本 | `reply_basis` | 本轮实现 | 7 | 2 | 1 | 1 | 2 | 缺列 relation_kind/explanation；FK 契约未落 1 组 |
| 48 | 助手与副本 | `reply_selection` | 本轮实现 | 7 | 2 | 2 | 1 | 1 | FK 契约未落 1 组 |
| 49 | 助手与副本 | `runtime_copy` | 本轮实现 | 17 | 3 | 5 | 2 | 7 | 缺列 expected_identity；增列 address_json/accepted_data_generation/source_revision/preparing_attempt_id/cleanup_operation_id/manifest_complete；FK 契约未落 1 组 |
| 50 | 助手与副本 | `runtime_context` | 本轮实现 | 7 | 2 | 2 | 1 | 3 | — |
| 51 | 偏好与文档 | `expression_preference` | 暂缓不建（入口关闭） | 0 | 0 | 0 | 0 | 0 | 13／15 暂缓，不建空表 |
| 52 | 偏好与文档 | `expression_preference_version` | 暂缓不建（入口关闭） | 0 | 0 | 0 | 0 | 0 | 13／15 暂缓，不建空表 |
| 53 | 偏好与文档 | `preference_source` | 暂缓不建（入口关闭） | 0 | 0 | 0 | 0 | 0 | 13／15 暂缓，不建空表 |
| 54 | 偏好与文档 | `memory_document` | 本轮实现 | 6 | 2 | 1 | 0 | 4 | — |
| 55 | 偏好与文档 | `memory_document_version` | 本轮实现 | 11 | 3 | 3 | 1 | 3 | 增列 version_identity/hint/topic_key |
| 56 | 偏好与文档 | `document_block` | 本轮实现 | 6 | 1 | 1 | 1 | 2 | — |
| 57 | 偏好与文档 | `document_statement` | 本轮实现 | 16 | 1 | 1 | 0 | 3 | 增列 profile_kind/section/temporal_status/uncertainty |
| 58 | 偏好与文档 | `document_basis` | 本轮实现 | 10 | 2 | 2 | 1 | 3 | — |
| 59 | 偏好与文档 | `document_publication` | 本轮实现 | 12 | 4 | 3 | 3 | 6 | 增列 member_count/members_digest |
| 60 | 偏好与文档 | `publication_member` | 本轮实现 | 4 | 2 | 1 | 1 | 0 | — |
| 61 | Skill最小关联 | `skill_package` | 本轮实现 | 12 | 2 | 3 | 0 | 5 | 增列 directory_name/description/enabled_origin |
| 62 | Skill最小关联 | `skill_package_revision` | 本轮实现 | 9 | 1 | 2 | 1 | 7 | — |
| 63 | 删除与元数据 | `deletion_operation` | 本轮实现 | 17 | 0 | 4 | 0 | 7 | 增列 domain_manifest/runner_token/runner_runtime |
| 64 | 删除与元数据 | `deletion_target` | 本轮实现 | 14 | 1 | 3 | 0 | 6 | 增列 domain/target_key/target_payload |
| 65 | 删除与元数据 | `deletion_check` | 本轮实现 | 8 | 1 | 1 | 0 | 2 | — |
| 66 | 删除与元数据 | `request_tombstone` | 本轮实现 | 7 | 1 | 1 | 0 | 1 | — |
| 67 | 删除与元数据 | `database_instance` | 本轮实现 | 8 | 0 | 1 | 0 | 5 | 增列 runtime_id/epoch/schema_digest |
| 68 | 删除与元数据 | `schema_migration` | 本轮实现 | 3 | 0 | 0 | 0 | 2 | — |
| 69 | 纠错与诊断 | `organization_feedback` | 暂缓不建（入口关闭） | 0 | 0 | 0 | 0 | 0 | 13／15 暂缓，不建空表 |
| 70 | 纠错与诊断 | `feedback_input` | 暂缓不建（入口关闭） | 0 | 0 | 0 | 0 | 0 | 13／15 暂缓，不建空表 |
| 71 | 纠错与诊断 | `quality_case` | 暂缓不建（入口关闭） | 0 | 0 | 0 | 0 | 0 | 13／15 暂缓，不建空表 |
| 72 | 纠错与诊断 | `quality_case_input` | 暂缓不建（入口关闭） | 0 | 0 | 0 | 0 | 0 | 13／15 暂缓，不建空表 |
| 73 | 纠错与诊断 | `quality_run` | 暂缓不建（入口关闭） | 0 | 0 | 0 | 0 | 0 | 13／15 暂缓，不建空表 |
| 74 | 纠错与诊断 | `quality_attempt` | 暂缓不建（入口关闭） | 0 | 0 | 0 | 0 | 0 | 13／15 暂缓，不建空表 |
| 75 | 媒体提取 | `message_media` | 本轮实现 | 7 | 1 | 2 | 1 | 4 | — |
| 76 | 媒体提取 | `media_extraction_attempt` | 本轮实现 | 31 | 5 | 7 | 1 | 12 | 增列 eligibility_json/runtime_id/cleanup_operation_id |
| 77 | 媒体提取 | `media_file` | 本轮实现 | 23 | 3 | 7 | 2 | 13 | 增列 managed_address/container_valid/viewable/playable/cleanup_operation_id |

说明：实际 82 表 = 67 张本轮实现的逻辑目录表 + 15 张实现关联／账本表；上表仅列 77 项逻辑目录。暂缓表与替代表已由结构测试断言不存在。

## 附录 B：115 个旧 PG 名称逐项映射

| # | 旧名称 | 结论分类 | 新落点 |
| ---: | --- | --- | --- |
| 1 | `assistant_candidate_selection` | 本轮实现 | `reply_selection` |
| 2 | `assistant_candidate_version` | 本轮实现 | `reply_candidate_version` |
| 3 | `assistant_runtime_deletion_target` | 本轮实现 | `deletion_target` |
| 4 | `assistant_runtime_session` | 本轮实现 | `runtime_copy`、`runtime_context` |
| 5 | `assistant_session` | 本轮实现 | `assistant_discussion` |
| 6 | `assistant_session_input` | 本轮实现 | `discussion_entry`、`reply_request` |
| 7 | `assistant_session_turn` | 本轮实现 | `discussion_entry`、`reply_request` |
| 8 | `background_task` | 本轮实现 | `processing_task` |
| 9 | `background_task_step` | 本轮实现 | `processing_step`、`step_attempt`、`task_contribution` |
| 10 | `channel_identity` | 本轮实现 | `conversation_binding` |
| 11 | `cli_backfill_state` | 本轮实现 | `read_goal`、`history_cutoff`、`read_grant` |
| 12 | `cli_history_sync_state` | 本轮实现 | `read_goal`、`history_cutoff`、`read_grant` |
| 13 | `confirmed_memory` | 本轮实现 | `memory`、`memory_version` |
| 14 | `contact` | 本轮实现 | `contact` |
| 15 | `contact_memory_index` | 查询派生不建表 | — |
| 16 | `contact_memory_state` | 本轮实现 | `contact` |
| 17 | `conversation_binding` | 本轮实现 | `conversation_binding` |
| 18 | `cross_domain_deletion_operation` | 本轮实现 | `deletion_operation`、`deletion_target`、`deletion_check` |
| 19 | `expression_preference` | 本轮暂缓（目标表不建，入口关闭） | `expression_preference`、`expression_preference_version`、`preference_source` |
| 20 | `expression_preference_operation` | 本轮暂缓（目标表不建，入口关闭） | `expression_preference_version`、`request_tombstone`、`deletion_operation` |
| 21 | `expression_preference_state` | 本轮实现 | `owner` |
| 22 | `front_sync_state` | 本轮实现 | `owner` |
| 23 | `import_confirmation` | 入口退役（手动导入） | — |
| 24 | `layered_memory_batch` | 本轮实现 | `step_attempt`、`execution_event`、`execution_input`、`event_source` |
| 25 | `layered_memory_fact_correction` | 本轮暂缓（目标表不建，入口关闭） | `organization_feedback`、`feedback_input` |
| 26 | `layered_memory_feedback` | 本轮暂缓（目标表不建，入口关闭） | `organization_feedback`、`feedback_input` |
| 27 | `layered_memory_generation` | 本轮实现 | `document_publication`、`publication_member` |
| 28 | `layered_memory_job` | 本轮实现 | `processing_task`、`processing_step`、`step_attempt` |
| 29 | `layered_memory_state` | 本轮实现 | `owner`、`contact` |
| 30 | `layered_profile_batch` | 本轮实现 | `step_attempt`、`execution_event`、`execution_input`、`event_source` |
| 31 | `layered_profile_version` | 本轮实现 | `memory_document`、`memory_document_version`、`document_block`、`document_statement`、`document_basis` |
| 32 | `local_wechat_observation` | 本轮实现 | `sync_capture` |
| 33 | `manual_contact_confirmation` | 本轮实现 | `manual_confirmation` |
| 34 | `media_attempt` | 本轮实现 | `message_media`、`media_extraction_attempt`、`media_file` |
| 35 | `media_request_tombstone` | 本轮实现 | `request_tombstone`、`deletion_operation` |
| 36 | `memory_candidate` | 本轮实现 | `memory_candidate` |
| 37 | `memory_correction_decision` | 本轮实现 | `memory_decision`、`memory_version` |
| 38 | `memory_extraction_receipt` | 本轮实现 | `processing_run`、`run_input`、`processing_item` |
| 39 | `memory_extraction_schedule` | 本轮实现 | `processing_run`、`run_input`、`processing_item` |
| 40 | `memory_extraction_trace` | 本轮实现 | `step_attempt`、`execution_event`、`execution_input`、`event_source` |
| 41 | `memory_extraction_trace_call` | 本轮实现 | `execution_event`、`model_call` |
| 42 | `memory_extraction_trace_dependency` | 本轮实现 | `execution_input`、`event_source` |
| 43 | `memory_extraction_trace_event` | 本轮实现 | `execution_event` |
| 44 | `memory_extraction_trace_link` | 本轮实现 | `execution_input`、`event_source` |
| 45 | `memory_extraction_watermark` | 本轮实现 | `processing_run`、`run_input`、`processing_item` |
| 46 | `memory_processing_legacy_adoption` | 已确认退役 | — |
| 47 | `memory_processing_operation` | 本轮实现 | `processing_run`、`processing_task`、`request_tombstone` |
| 48 | `memory_processing_plan` | 已确认退役 | — |
| 49 | `memory_processing_receipt` | 本轮实现 | `processing_run`、`run_input`、`processing_item` |
| 50 | `memory_processing_round` | 本轮实现 | `processing_run`、`processing_task` |
| 51 | `memory_processing_round_target` | 本轮实现 | `run_input` |
| 52 | `memory_processing_round_task` | 已确认退役 | — |
| 53 | `memory_processing_scope` | 本轮实现 | `owner`、`contact` |
| 54 | `memory_processing_target` | 本轮实现 | `run_input` |
| 55 | `memory_upgrade_batch` | 已确认退役 | — |
| 56 | `memory_upgrade_job` | 已确认退役 | — |
| 57 | `memory_upgrade_operation` | 已确认退役 | — |
| 58 | `message` | 本轮实现 | `message` |
| 59 | `message_source_ref` | 本轮实现 | `capture_record` |
| 60 | `model_call_learning_claim` | 本轮实现 | `model_call` |
| 61 | `model_call_receipt` | 本轮实现 | `model_operation`、`model_call` |
| 62 | `organization_quality_attempt` | 本轮暂缓（目标表不建，入口关闭） | `quality_attempt` |
| 63 | `organization_quality_case` | 本轮暂缓（目标表不建，入口关闭） | `quality_case`、`quality_case_input` |
| 64 | `organization_quality_fact_intent` | 本轮暂缓（目标表不建，入口关闭） | `memory_decision`、`organization_feedback` |
| 65 | `organization_quality_revocation` | 已确认退役 | — |
| 66 | `organization_quality_run` | 本轮暂缓（目标表不建，入口关闭） | `quality_run` |
| 67 | `outbound_ledger_entry` | 本轮实现 | `model_operation`、`model_call` |
| 68 | `owner` | 本轮实现 | `owner` |
| 69 | `owner_channel_identity` | 本轮实现 | `channel_account` |
| 70 | `owner_memory` | 本轮实现 | `memory`、`memory_version` |
| 71 | `owner_memory_state` | 本轮实现 | `owner` |
| 72 | `relationship_overview_projection` | 查询派生不建表 | — |
| 73 | `reply_attempt` | 本轮实现 | `reply_attempt` |
| 74 | `reply_candidate` | 本轮实现 | `reply_candidate`、`reply_candidate_version`、`reply_version_part` |
| 75 | `reply_candidate_citation` | 本轮实现 | `reply_basis` |
| 76 | `reply_context_evidence` | 本轮实现 | `reply_context`、`reply_context_item`、`event_source` |
| 77 | `reply_exploration` | 本轮实现 | `discussion_entry`、`reply_request` |
| 78 | `reply_expression_preference_use` | 本轮实现 | `reply_context_item` |
| 79 | `reply_invalidated_key` | 本轮实现 | `request_tombstone` |
| 80 | `reply_original_source_use` | 本轮实现 | `reply_context`、`reply_context_item`、`event_source` |
| 81 | `reply_request` | 本轮实现 | `reply_request` |
| 82 | `reply_skill` | 本轮实现 | `skill_package`、`owner` |
| 83 | `reply_skill_file_cleanup` | 本轮实现 | `deletion_target` |
| 84 | `reply_skill_method` | 本轮范围外（入口关闭） | — |
| 85 | `reply_skill_publication` | 本轮范围外（入口关闭） | — |
| 86 | `reply_skill_version` | 本轮实现 | `skill_package_revision` |
| 87 | `reply_skill_working_copy` | 本轮范围外（入口关闭） | — |
| 88 | `scenario_document_mapping` | 本轮实现 | `publication_member` |
| 89 | `scenario_document_version` | 本轮实现 | `memory_document`、`memory_document_version`、`document_block`、`document_statement`、`document_basis` |
| 90 | `skill_draft` | 本轮范围外（入口关闭） | — |
| 91 | `skill_history_operation` | 本轮范围外（入口关闭） | — |
| 92 | `skill_learning_batch` | 本轮范围外（入口关闭） | — |
| 93 | `skill_learning_operation` | 本轮范围外（入口关闭） | — |
| 94 | `skill_learning_receipt` | 本轮范围外（入口关闭） | — |
| 95 | `skill_learning_scope` | 本轮范围外（入口关闭） | — |
| 96 | `skill_library` | 本轮实现 | `skill_package`、`owner` |
| 97 | `skill_method_identity` | 本轮范围外（入口关闭） | — |
| 98 | `skill_policy_operation` | 本轮范围外（入口关闭） | — |
| 99 | `skill_policy_state` | 本轮范围外（入口关闭） | — |
| 100 | `skill_review_call` | 本轮范围外（入口关闭） | — |
| 101 | `skill_review_comparison` | 本轮范围外（入口关闭） | — |
| 102 | `skill_review_operation` | 本轮范围外（入口关闭） | — |
| 103 | `skill_scope_policy` | 本轮范围外（入口关闭） | — |
| 104 | `source_document` | 本轮实现 | `sync_capture` |
| 105 | `source_processing_batch` | 本轮实现 | `sync_capture` |
| 106 | `source_processing_capture_tombstone` | 本轮实现 | `request_tombstone` |
| 107 | `source_processing_record` | 本轮实现 | `capture_record` |
| 108 | `wechat_auto_read_suppression` | 本轮实现 | `read_exclusion`、`history_cutoff` |
| 109 | `wechat_binding_history_authorization` | 本轮实现 | `read_grant`、`read_goal` |
| 110 | `wechat_history_sync_authorization` | 本轮实现 | `read_grant`、`read_goal` |
| 111 | `wechat_message_metadata` | 本轮实现 | `capture_record`、`message` |
| 112 | `wechat_observation_baseline` | 本轮实现 | `history_cutoff`、`read_goal` |
| 113 | `wechat_observation_cursor` | 本轮实现 | `read_goal` |
| 114 | `wechat_sync_exclusion` | 已由06来源级排除替代 | `read_exclusion` |
| 115 | `wechat_sync_scope` | 本轮实现 | `channel_account`、`owner` |

说明：disposition 与落点由 `backend-ts/test/fixtures/cutover/build-audit-catalog.mjs` 从设计工件生成并提交；原始工件保留在 `.scratch/sqlite-database-rebuild/`，fixture 仅含表名、分类与计数。

## 附录 C：已确认结构差异明细

### C1 未以 SQL FK 落地的 51 个契约组

| 表 | 引用目标 | 契约列组 | 分类 |
| --- | --- | --- | --- |
| `owner` | `document_publication` | `owner_id`、`current_publication_id` | 发布指针/循环FK |
| `contact` | `document_publication` | `owner_id`、`current_publication_id` | 发布指针/循环FK |
| `read_grant` | `contact` | `owner_id`、`contact_id` | 范围候选键 |
| `read_goal` | `contact` | `owner_id`、`contact_id` | 范围候选键 |
| `sync_capture` | `contact` | `owner_id`、`contact_id` | 范围候选键 |
| `capture_record` | `contact` | `owner_id`、`contact_id` | 范围候选键 |
| `message` | `contact` | `owner_id`、`contact_id` | 范围候选键 |
| `processing_item` | `contact` | `owner_id`、`contact_id` | 范围候选键 |
| `run_input` | `processing_run` | `owner_id`、`run_id` | 范围候选键 |
| `run_input` | `contact` | `owner_id`、`source_contact_id` | 范围候选键 |
| `run_input` | `message` | `owner_id`、`message_id` | 范围候选键 |
| `run_input` | `memory_version` | `owner_id`、`memory_id`、`memory_version_no` | 材料/版本分支 |
| `run_input` | `memory_document_version` | `owner_id`、`document_id`、`document_version_no` | 材料/版本分支 |
| `run_input` | `organization_feedback` | `owner_id`、`feedback_id` | 暂缓目标表 |
| `processing_task` | `document_publication` | `owner_id`、`accepted_publication_id` | 发布指针/循环FK |
| `task_contribution` | `processing_run` | `owner_id`、`run_id` | 范围候选键 |
| `task_contribution` | `contact` | `owner_id`、`source_contact_id` | 范围候选键 |
| `step_input` | `organization_feedback` | `owner_id`、`feedback_id` | 暂缓目标表 |
| `model_operation` | `quality_run` | `owner_id`、`quality_run_id` | 暂缓目标表 |
| `model_operation` | `quality_case` | `owner_id`、`quality_case_id` | 暂缓目标表 |
| `operation_scope` | `contact` | `owner_id`、`contact_id` | 范围候选键 |
| `model_call` | `quality_attempt` | `owner_id`、`quality_attempt_id` | 暂缓目标表 |
| `execution_event` | `quality_attempt` | `owner_id`、`quality_attempt_id` | 暂缓目标表 |
| `execution_input` | `message` | `owner_id`、`message_id` | 范围候选键 |
| `execution_input` | `capture_record` | `owner_id`、`record_id` | 范围候选键 |
| `execution_input` | `memory_candidate` | `owner_id`、`candidate_id` | 范围候选键 |
| `execution_input` | `memory_version` | `owner_id`、`memory_id`、`memory_version_no` | 材料/版本分支 |
| `execution_input` | `memory_document_version` | `owner_id`、`document_id`、`document_version_no` | 材料/版本分支 |
| `execution_input` | `organization_feedback` | `owner_id`、`feedback_id` | 暂缓目标表 |
| `execution_input` | `quality_case_input` | `owner_id`、`quality_case_id`、`quality_input_no` | 暂缓目标表 |
| `execution_input` | `quality_case` | `owner_id`、`quality_case_id` | 暂缓目标表 |
| `event_source` | `contact` | `owner_id`、`source_contact_id` | 范围候选键 |
| `memory_decision` | `quality_attempt` | `owner_id`、`quality_attempt_id` | 暂缓目标表 |
| `memory_required_message` | `contact` | `owner_id`、`source_contact_id` | 范围候选键 |
| `memory_citation` | `message` | `owner_id`、`message_id` | 范围候选键 |
| `discussion_entry` | `contact` | `owner_id`、`contact_id` | 范围候选键 |
| `reply_request` | `contact` | `owner_id`、`contact_id` | 范围候选键 |
| `reply_request` | `reply_selection` | `owner_id`、`carried_selection_id` | 范围候选键 |
| `reply_context` | `contact` | `owner_id`、`contact_id` | 范围候选键 |
| `reply_context` | `document_publication` | `owner_id`、`owner_publication_id` | 发布指针/循环FK |
| `reply_context` | `document_publication` | `owner_id`、`contact_publication_id` | 发布指针/循环FK |
| `reply_context_item` | `message` | `owner_id`、`message_id` | 范围候选键 |
| `reply_context_item` | `memory_candidate` | `owner_id`、`candidate_id` | 范围候选键 |
| `reply_context_item` | `memory_version` | `owner_id`、`memory_id`、`memory_version_no` | 材料/版本分支 |
| `reply_context_item` | `memory_document_version` | `owner_id`、`document_id`、`document_version_no` | 材料/版本分支 |
| `reply_context_item` | `expression_preference_version` | `owner_id`、`preference_id`、`preference_version_no` | 暂缓目标表 |
| `reply_context_item` | `reply_candidate_version` | `owner_id`、`selected_candidate_id`、`selected_version_no` | 材料/版本分支 |
| `reply_context_item` | `reply_selection` | `owner_id`、`selection_id` | 范围候选键 |
| `reply_basis` | `reply_context_item` | `owner_id`、`context_id`、`item_no` | 材料/版本分支 |
| `reply_selection` | `reply_request` | `owner_id`、`request_id` | 范围候选键 |
| `runtime_copy` | `contact` | `owner_id`、`contact_id` | 范围候选键 |

### C2 逻辑目录字段未以同名列落地的 49 项

| 表 | 未落地字段 |
| --- | --- |
| `read_goal` | `restore_request_key`、`restore_confirmed_at` |
| `processing_run` | `finished_at` |
| `run_input` | `memory_id`、`memory_version_no`、`document_id`、`document_version_no`、`feedback_id` |
| `step_input` | `role`、`feedback_id` |
| `model_operation` | `resolution_code`、`quality_run_id`、`quality_case_id` |
| `operation_scope` | `scope_kind`、`contact_id` |
| `model_call` | `input_tokens`、`output_tokens`、`quality_attempt_id` |
| `execution_event` | `quality_attempt_id` |
| `execution_input` | `source_contact_id`、`message_id`、`record_id`、`accepted_revision`、`candidate_id`、`memory_id`、`memory_version_no`、`document_id`、`document_version_no`、`feedback_id`、`quality_case_id`、`quality_input_no`、`kind` |
| `memory_decision` | `quality_attempt_id` |
| `reply_request` | `carried_selection_id` |
| `reply_context` | `owner_publication_id`、`contact_publication_id` |
| `reply_context_item` | `candidate_id`、`memory_id`、`memory_version_no`、`document_id`、`document_version_no`、`preference_id`、`preference_version_no`、`selected_candidate_id`、`selected_version_no`、`selection_id` |
| `reply_basis` | `relation_kind`、`explanation` |
| `runtime_copy` | `expected_identity` |

### C3 实现补充字段 101 项（按表）

| 表 | 补充字段 |
| --- | --- |
| `owner` | `state` |
| `channel_account` | `source_generation` |
| `read_goal` | `target_json`、`eligibility_json`、`support_json`、`completed_partitions`、`failure_code`、`created_at`、`resume_cursor`、`cursor_scope_digest`、`cursor_scheme`、`handoff_from_goal_id`、`pages_accepted`、`last_accepted_at` |
| `history_cutoff` | `contact_id`、`source_generation`、`account_key`、`conversation_key`、`target_json`、`support_json`、`proof_json`、`manifest_sha256`、`member_count`、`reason`、`created_at` |
| `sync_capture` | `response_digest` |
| `capture_record` | `availability` |
| `message` | `display_no`、`status_code`、`status_observed_at` |
| `processing_run` | `policy_config` |
| `run_contact` | `binding_id`、`accepted_identity_generation`、`accepted_account_revision`、`accepted_source_generation` |
| `processing_task` | `error_code` |
| `processing_step` | `accepted_memory_revision` |
| `step_input` | `accepted_state_revision`、`accepted_head_revision`、`source_contact_id`、`message_id`、`record_id`、`accepted_revision`、`publication_id` |
| `step_attempt` | `runtime_token` |
| `operation_scope` | `source_contact_id` |
| `model_call` | `receipt`、`model`、`configuration_id`、`input_cap`、`output_cap` |
| `execution_input` | `producer_event_id` |
| `memory_candidate` | `event_id` |
| `memory_decision` | `request_seal` |
| `memory_citation` | `accepted_revision` |
| `assistant_discussion` | `generation`、`is_current`、`created_at`、`last_activity_at` |
| `discussion_entry` | `origin_event_id` |
| `reply_attempt` | `accepted_discussion_generation`、`accepted_source_revision`、`accepted_runtime_id`、`accepted_storage_epoch` |
| `reply_context` | `skill_run_json` |
| `reply_candidate_version` | `part_count` |
| `runtime_copy` | `address_json`、`accepted_data_generation`、`source_revision`、`preparing_attempt_id`、`cleanup_operation_id`、`manifest_complete` |
| `memory_document_version` | `version_identity`、`hint`、`topic_key` |
| `document_statement` | `profile_kind`、`section`、`temporal_status`、`uncertainty` |
| `document_publication` | `member_count`、`members_digest` |
| `skill_package` | `directory_name`、`description`、`enabled_origin` |
| `deletion_operation` | `domain_manifest`、`runner_token`、`runner_runtime` |
| `deletion_target` | `domain`、`target_key`、`target_payload` |
| `database_instance` | `runtime_id`、`epoch`、`schema_digest` |
| `media_extraction_attempt` | `eligibility_json`、`runtime_id`、`cleanup_operation_id` |
| `media_file` | `managed_address`、`container_valid`、`viewable`、`playable`、`cleanup_operation_id` |

补充字段用于运行代次／租约／幂等键、证据摘要、隔离与清理账本、失败原因、目录身份与发布状态等实现账本；结构基线 fixture 已锁定，任何增减都会使结构审计测试失败。
