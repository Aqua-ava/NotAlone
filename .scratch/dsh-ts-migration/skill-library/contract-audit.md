# 06 Skill 库：存储与官方插件合同审计

审计日期：2026-10-23；仅静态准备，不认领／完成06，不启动实现，不以04工作树为验收证据。
旧业务引用固定 `3c168296e9e8edaa43b8b323ff693e790e709069`（下称“旧”）；02固定 `fc8dcf50`，03完成点 `9f39d6c2`。
DSH 固定 `0.2.1-rc.2`／`687f282e8625c6b8d11ff58211a90524be2e4317`；本次读预置源码副本，副本无 `.git`，未重新下载或独立证明全部制品同源。
发布tag和发行完整性沿用 `../runtime-audit.md:7` 的既有证据；本次核对三个Skill包的package.json版本及公开接口，不把旧审计当作新集成测试。
03的 `backend-ts/src/legacy-backend.ts:9,79` 仍声明 skills 由Python执行并转发 `/api/skills`；因此宿主已接通不代表06已迁移。

## 结论与票界

通用注册表、分层目录、Tool注册和取消／释放应优先复用官方公开机制；业务存储、审核、方法政策、来源删除和owner/contact权限仍归普通TS模块。
官方文件插件不是NotAlone版本库，官方Skill工具也不是既有受控 `read_file` 合同的直接替代；不得先写另一套通用发现器，也不得把所有业务强制插件化。
06负责列表／发现／导入／创建／编辑／版本与启停／导出删除、受控读取及失效；审核发布的文件原子性和业务依赖必须承接。
07负责方向探索、自动／显式选择及候选工具循环（依赖05、06）；06提供允许目录与冻结版本，不新增探索循环。旧探索仍是单次有界调用，不借迁移扩权。
15负责授权素材学习、提案、同输入审核预览与发布／撤回流程（依赖06、10、13、14）；06不得把普通包导入当作学习草稿批准，也不提前实现L2/L3预览。
依据：`../issues/06-reply-skill-library.md:15`、`../issues/07-exploration-skill-replies.md:15`、`../issues/15-skill-learning-review.md:15`；`architecture/adr/102-dsh-typescript-backend-migration.md:8`、ADR-096／098。

## 锁定官方接口与适用性

| 固定源码／文档 | 已核实合同 | 适用与缺口 |
| --- | --- | --- |
| [Skill文档](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/subsystems/skills.md#L9) | registry／filesystem provider／tool consumer分离；host与scope合并 | 可复用基础能力；scope是DSH注册层，不自动等于owner/contact授权。 |
| [Provider接口](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill/src/index.ts#L247) | `list(options)`、`get(candidate,options)`；candidate可携不透明locator；lookup提供cwd/signal | 可用业务冻结版本作locator；API没有业务审核、来源、事务和版本资格字段。 |
| [注册生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill/src/index.ts#L390) | `ctx.skills.registerProvider(factory)`返回disposer；control.signal随释放abort、invalidate清缓存并通知 | 适合薄适配器；必须把owner revision、删除、取消接入，不能只等待文件watch。 |
| [读取](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill/src/index.ts#L481) | `snapshot({cwd,signal,scope})`返回complete；`get`每次调用provider，校验名字 | 不缓存正文不等于冻结版本；同名内容更新仍须由业务定位和哈希拒绝混用。 |
| [文件配置](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill-filesystem/src/index.ts#L48) | `includeDefaultRoots`默认true，customSkillDirs、watch及followSymlinks可配置 | 不能直接指向全部用户目录；默认发现项目／用户Skill、符号链接与业务范围不等价。 |
| [文件正文](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill-filesystem/src/index.ts#L209) | get重新parse文件，返回directory resourceBase；支持bundle／flat条目 | 无SQL103清单／方法索引／来源发布核验；不能让工作副本绕过快照成为运行正文。 |
| [资源约定](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill/src/index.ts#L185) | resourceBase可为directory、url、opaque，只生成相对路径提示 | 不是受控资源读取接口；不校验NotAlone资源清单、哈希或预算，url不能变成网络授权。 |
| [官方Tool](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/tool-skill/src/index.ts#L82) | `skill({name})`复验存在及modelInvocable，传递signal，返回全文和resourceBase | 可借provider守住业务资格；没有版本参数、offset/limit、零或一个版本硬限制。 |
| [目录更新](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/tool-skill/src/index.ts#L215) | pre-step按可见tool获取snapshot；complete=false保留此前目录；摘要仅name/description | 同名同描述的版本替换不保证目录变化，更不会清除历史Tool正文；必须使旧运行失效。 |
| [工具白名单](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L1098) | scoped `tools.restrict({allow,deny})`只限制global tools，限制取交集；局部工具仍可见 | 白名单必须核对最终视图，不能误以为restrict屏蔽scoped注册；禁Shell／任意文件／发送。 |
| [执行权限](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L1135) | `tools.guard`同步、只能deny；`tools/pre-execute`支持异步决策 | 异步DB资格宜在执行边界／业务读取复验；guard不能承诺异步授权或提交事务。 |
| [权限preset](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/interaction/permission-presets/src/index.ts#L1) | 组合sandbox与approval策略 | 不是owner/contact业务权限；不得当作来源删除或审核授权。 |

三个官方包为 `@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-skill-filesystem`、`@deepseek-ai/dsh-tool-skill`，源码manifest均为0.2.1-rc.2；06实际新增直接依赖须写精确版本并更新消费lock，不能推断02安装闭包已覆盖新插件。
官方示例 [skill-load](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/snapshots/session/skill-load/snapshot.yml#L1) 标明authored／headless／default composition，只证明演示场景，不证明NotAlone隔离可用。
官方测试 [tool-skill.spec.ts:660](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/tool-skill/tests/tool-skill.spec.ts#L660) 明确“body-only edits…loads the latest body”；:723明确“retains the last-good catalog…incomplete”；:190覆盖dispose，:218覆盖abort信号。本轮仅阅读这些合成测试，未执行。
官方文档 `docs/subsystems/skills.md:81` 明确包下resource修改不属于catalog变化；`tool-skill/src/index.ts:268`提示加载所有适用Skill，不能当成每轮至多一个版本的约束。

## 最小合成反例与候选适配方向（均未运行、未经采纳）

1. 一个scope内依次调用skill(a)、skill(b)：官方consumer无数量记账；业务必须拒绝第二版本，不能只改提示词。
2. 同name/description的v1正文改为v2：官方测试确认目录不更新但get读取新正文；业务须冻结version_id/hash/revision并拒绝旧轮提交。
3. A联系人允许而B不允许的同名策略：复用host provider会泄漏目录；须从已验证业务scope闭包提供隔离目录，不能让模型传owner/contact。
4. 已显示目录后撤销a，同时另一个provider list失败：官方保留last-good目录；业务须在每次读取、物理模型请求及提交前拒绝已撤销状态并销毁旧正文视图。
5. 仅修改references/x.md或增加symlink到包外：不能靠官方catalog watcher发现全部变化；业务清单完整性和路径校验仍不可省。
6. 全局只allow skill，但scope另外注册shell：restrict不屏蔽局部注册；应核对最终schema及执行guard，验证任意文件／网络／发送工具不可见不可执行。
候选：保留普通TS SkillPort／存储模块，用官方registry+业务provider装配受控目录；对官方consumer是否可经公开hook满足零或一个、路径与失效合同做合成试验，缺口明确时保留业务只读Tool。
候选：filesystem provider仅在明确禁用默认roots、受控目录和业务校验之后评估用于发现辅助；它不取代SQL事务发布。无需修改DSH核心，当前没有做采纳决定。

## 旧文件／业务合同（以下源码与选择器全部固定“旧”提交）

| 证据 | 必须保留的合同 |
| --- | --- |
| `backend/database/migrations/103_skill_business_state_only.sql:3` | 升级器先落盘核验，SQL不复制正文；active缺路径／document、content、manifest哈希或旧正文未清空即 `skill_content_upgrade_required`；:22移除资源表及重复内容列。不得重跑旧迁移、创建空库或重新赋ID。 |
| `backend/src/notalone/persistence/skill_files.py:220` | 根为 `NOTALONE_SKILLS_DIR`，默认 `~/.notalone/skills`；工作包 `<根>/<owner_id>/<name>/`；:274快照 `<根>/.versions/<owner_id>/<skill_id>/<version_id>/<name>/SKILL.md`，现有相对定位保持。 |
| `backend/src/notalone/persistence/skill_files.py:238` | UTF-8文档格式为 `---\nname: <name>\ndescription: <JSON字符串>\n---\n\n<body>`；description用ensure_ascii=False；:326核路径与文档SHA256，:339另验正文SHA256。不能用TS重新序列化已有文件而改变原字节／哈希。 |
| `backend/src/notalone/persistence/skill_manifest.py:16` | manifest.json在版本根，不在name子目录；schema_version=1、name、description、warnings、resources；资源保留相对路径、媒体类型、大小、哈希。:38 JSON用ensure_ascii=False、sort_keys=True、紧凑逗号冒号，已有文件仅允许相同字节；:94验DB清单哈希。 |
| `backend/src/notalone/persistence/skill_methods.py:29` | 版本根methods.json；:132方法在methods/<method_id>.json，内容method_id/title/instruction，索引method_id/relative_path/content_sha256；紧凑UTF-8 JSON但不采用manifest的sort_keys规则。:70核哈希、DB身份／顺序及允许子集；1–6方法。保留原方法ID与政策映射。 |
| `backend/src/notalone/persistence/skill_files.py:249` | 拒绝绝对路径、点段、反斜杠、重复斜杠；:259检查根、祖先及逐段symlink；不能以DSH可发现链接文件放宽业务路径。 |
| `backend/src/notalone/skills/package.py:22` | SKILL.md≤500行／估算5000tokens、description≤1024字符；≤100资源、单个≤1MiB、合计≤4MiB；:29仅references/assets顶层，:45类型限制。禁止把脚本／URL引用变为可执行或外部读取能力。 |
| `backend/src/notalone/persistence/skill_port.py:57` | catalog限定owner、contact为空或匹配、active/current/enabled、无待同步／清理；:31审核版本再核发布、owner/contact/scene及原来源generation；:78元数据先行，选中后正文。 |
| `backend/src/notalone/persistence/skill_port.py:154` | load_version使用只读repeatable-read；方法停用后的execution_view不得开放原资源路径绕过；:87候选提交事务复验目录、owner级revision、版本、范围、来源、execution_view，失败ReplyInputInvalidatedError。冻结不等于可忽略撤销。 |
| `backend/src/notalone/reply/adapters/langchain_runtime.py:81` | 虚拟根 `/notalone/reply-skills`；:435只接受当前entries列出的 `<根>/<目录键>/SKILL.md` 或该版本资源；实际磁盘定位不交给模型。 |
| `backend/src/notalone/reply/adapters/langchain_runtime.py:378` | SkillLoadBudget至多一个版本；先读SKILL.md再读同版本资源并记录路径；:469正文offset≥0、limit为1–1000；:485每页带used_skill_version_id；:487资源整份UTF-8返回，不按offset/limit裁切。 |
| `backend/src/notalone/reply/adapters/langchain_runtime.py:504` | 第二Skill触发SecondSkillLoadError，资源失败记resource_failed；不存在独立单次／累计资源运行额度。完整模型输入及输出预留另受 `backend/src/notalone/reply/input_budget.py:243` 的profile检查，不能以包导入成功替代整轮输入检查。 |
| `backend/src/notalone/persistence/skill_library.py:615` | delete先撤资格；:658清学习派生、所有版本content_path／哈希／source_locator、启用与current，并登记文件清理；:693递增revision。`backend/src/notalone/persistence/skill_files.py:437`及:460承担重试清理；清理失败不得重新发现复活。 |

目录刷新／每轮显式同步发现合法新增或编辑，未变不重发版；带审核来源变更不能洗掉来源、扩大范围或方法停用。读接口自身不能隐式迁移／写文件，见下方read-path测试。
原子性应保留“先不可变文件准备并核验、后数据库事务发布定位和业务状态”；失败暂存不进入目录，删除资格先撤、磁盘清理可重试。当前约束见 `architecture/adr/096-directory-backed-reply-skills.md:13`、`architecture/adr/098-skill-business-state-only.md:19`，不把文件系统和PG误写成一个物理事务。
创建／编辑有工作目录及学习草稿两类入口；通用包导入可直接发布，学习草稿须审核。实际导出能力不得扩大为未经核验的桌面按钮或HTTP路由。

## 具名 HTTP 与桌面合同

| 固定旧入口 | 请求／响应／错误及职责 |
| --- | --- |
| `backend/src/notalone/server/app.py:3028` | GET `/api/skills` → skills列表（skill_id/name/description/status/contact_id/current_version_id/current_version_number/enabled）；序列化 `backend/src/notalone/application/skill_service.py:90`。 |
| `backend/src/notalone/server/app.py:3032` | POST `/api/skills/import` {package_path}；:3058 GET `/<id>/preview`、`/<id>/versions`；:3072 POST `/<id>/enable|disable|delete`；:3084 POST `/<id>/rollback` {version_id}。后缀均接 `/api/skills`。 |
| `backend/src/notalone/server/app.py:2985` | 503 skill_unavailable，400 skill_request_invalid，404 skill_not_found／skill_version_not_found，409 skill_deleted；内部skill_persistence_failed。:3043导入拒绝压为409 skill_import_rejected、reason=package_invalid，不能直接暴露服务层name_conflict。 |
| `backend/src/notalone/application/skill_service.py:115` | 同名导入拒绝并要求update；:147版本列表含版本身份／序号／描述／is_current／enabled／created_at。旧通用HTTP未发现独立create/edit/export端点，迁移不能凭目标规格虚构这些路由已存在。 |
| `backend/src/notalone/server/skill_learning.py:16` | `/api/contacts/<contact>/skill-learning/drafts/<draft>` GET；POST edit/compare/approve/decision均保留expected_revision、operation_key。compare带input/scope，approve带comparison_id/scope及confirmed、replacements_confirmed=true；decision仅reject/defer。流程属15，06承接存储、资格和发布原子性。 |
| `backend/src/notalone/server/skill_learning.py:56` | 同一skill-learning根下GET `/skills`／`/skills/<skill>`；POST `/skills/<skill>/rollback`须version_id、expected_revision、expected_current_version_id、operation_key；不与通用rollback请求混为一谈。 |
| `backend/src/notalone/server/skill_learning.py:75` | GET/POST `/policies`；写入含skill_id/version_id/method_id/scope/disabled/expected_revision/operation_key；POST `/policies/<policy>/undo`。:132错误400 skill_learning_request_invalid、404 not_found、409 skill_learning_stale_or_disabled、503 skill_learning_unavailable／runtime_stopping、500 internal_error。 |
| `desktop/src/shared/skill-learning-bridge.ts:72` | openReview/updateReview/saveReview/compareReview/approveReview/decideReview；openHistory/rollbackHistory；openPolicies/changePolicy/undoPolicy；保留ContactSelection、expectedRevision、明确确认。:3草稿pending/published/rejected，proposal_kind=create/update/merge；:23对照冻结draft_revision/input_version/input/scope及前后version/load_state/execution_view。 |
| `desktop/src/main/skill-learning/bridge.ts:58` | skill-learning:* IPC仅manager窗口；:68 approve-review、:74 rollback-history、:78 change-policy；不能暴露给模型或任意窗口。 |
| `desktop/src/main/skill-learning/controller.ts:236` | 请求绑定contact路径；对operation／scope／generation／删除门复验，迟到响应不得回填旧联系人；compare响应必须匹配input/scope。 |

## 边界验证选择器与缺口

以下是后续实现最小测试选择，不是本次已通过测试。先单例，再模块；HTTP／桌面控制器检查持久状态和可见结果，不能只跑DSH示例。

| 固定旧测试定位与选择器 | 必测合成反例 |
| --- | --- |
| `backend/tests/integration/persistence/test_skill_business_state_migration.py:174` — SkillBusinessStateMigrationTest.test_upgrade_preserves_all_owners_content_review_scope_and_disabled_decisions | A/B owner同名包、已有版本和停用决定保留；:202已有文件字节不变，:219坏资源整批回滚，:257 SQL失败可恢复；TS应做同文件／原ID读写等价测试，不重跑升级。 |
| `backend/tests/integration/persistence/test_postgres_skill_read_path.py:117` — test_read_operations_do_not_migrate_synchronize_or_write_files | :131显式同步才发现；:169文件错误不泄露路径；读旧库不能偷偷创建新库或覆盖文件。 |
| `backend/tests/integration/persistence/test_postgres_skill_fs_defense.py:166` — test_symlink_package_directory_is_rejected_without_importing_outside_content | 包内链接到外部拒绝；:199清理父／末段路径逃逸拒绝。 |
| `backend/tests/unit/reply/test_skill_runtime_resources.py:620` — test_resource_before_skill_load_falls_back_to_no_skill | :672跨联系人资源不进模型、:756第二Skill资源拒绝、:844任意路径／URL拒绝、:901revision不符回退无Skill；不同阶段按原错误处理，提交失效不能一概静默降级。 |
| `backend/tests/unit/reply/test_skill_version_receipt.py:195` — SkillVersionReceiptTest.test_each_page_has_version_receipt_and_preserves_selected_body_lines | 分页保留行与版本回执；:222伪造另一版本拒绝；冻结v1后写v2不得以v1回执返回新正文。 |
| `backend/tests/integration/server/test_skill_review.py:471` — SkillReviewHttpTest.test_changed_input_and_library_revision_invalidate_old_approval | :490跨范围／并发批准只发一次，:675删除后批准重放／恢复不能复活，:715目标更新令旧update／merge审核失效；学习端完整链属15。 |
| `backend/tests/integration/persistence/test_postgres_skill_deletion.py:140` — PostgresSkillDeletionTest.test_delete_scrubs_all_versions_source_and_resources | :232其他owner不泄露存在，:372无可恢复内容哈希；A来源曾发布owner范围策略后删除，B已有候选同样复验依赖。 |
| `desktop/tests/skill-learning/controller.test.mjs:97` — 待审核控制器在联系人变化后丢弃迟到旧列表并清空私人依据 | :124待审核桥接仅接受当前联系人，不提供模型发布或任意路径；与HTTP合同组合验证。 |

补充待建最小合成用例：保持methods.json不变只改方法文件一字节→拒绝；读取同一1MiB资源两次→不得声称已有累计配额，仍须完整模型输入预算检查；禁用／删除后不完整官方目录不能保留可用旧正文。
现有测试选择器是迁移对照入口，不证明TS已实现；未发现通用HTTP创建／编辑／导出不等于允许删功能，后续需沿既有业务入口核验完整可达性与用户操作，不能未经决定新增端点冒充等价。

## 本次实际验证与交付限制

实际执行：对固定提交用git show／git grep／git ls-tree；读取锁定官方源码、文档、authored示例与合成测试源；对本文旧源码定位、官方固定链接路径／行号做静态存在检查：52处通过、0处失败；全文111行，无真实本机用户名路径／线程标识。
未执行：单元／集成／桌面／HTTP运行、数据库迁移或连接、真实Skill读取、模型请求、依赖安装、网络下载；也未验证新插件消费闭包、竞态或原子发布。所有适配建议未经实测。
唯一产物为本文；不改产品代码、其他审计、票状态、planning或execution；不add／commit，由主会话归档。04工作区不作为已验收；06实现仍等04。App唯一允许入口仍为npm run dev，本次未启动，未打包／push／发送消息。
数据处理影响：仅代码和合成fixture源的静态读取，没有读取.env、凭据、真实数据库、私聊或私人Skill内容；没有改变现有路径、哈希、身份或用户决定。
