# 03 原库兼容、历史接纳、迁移与 owner 恢复核验

核验日期：2026-10-23。旧业务基线 `3c168296e9e8edaa43b8b323ff693e790e709069`，02 完成点 `fc8dcf50`。本文只核对旧实现及既有约束，不审查03进行中的 TS／桌面代码，不认证03已通过。
本文 `路径:行号` 均相对仓库根，代码行号以旧基线为准；复核可用 `git show 3c168296:路径 | nl -ba`。未连接数据库、未读取用户资料或凭据。

## 锁定 DSH 与职责边界

- 已先读固定源码副本的 `docs/architecture.md:17`、`:43`、`apps/cli/src/profile-boot.ts:271`、`apps/cli/src/process-shutdown.ts:4`。版本为 `0.2.1-rc.2`，提交 `687f282e8625c6b8d11ff58211a90524be2e4317`；版本来源为 `backend-ts/README.md:7`、`.scratch/dsh-ts-migration/runtime-validation/progress.md:7`，副本没有 `.git`，不能声称本轮重新验证了 tag 签名或提交对象。
- 一手固定链接：[profile 启动](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/profile-boot.ts#L271)、[有界关闭](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/process-shutdown.ts#L4)、[官方架构](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md#L43)。本核验不涉及直接 DSH API 实现。
- `runProfile` 装配配置树、提供 ready 并处理启动期间 SIGTERM；ACTIVE＋loader 后提交框架 ready（`:323–345`）。这不是业务数据库可用证明。**DB 身份、账本及结构检查必须在业务 ready 和业务可写前完成**；PG 更新事务本身只在检查通过的受控迁移阶段开放。
- 关闭最多等待五秒，然后可强制结束；DSH 不替代 PG 事务、数据库会话锁、owner 恢复或业务租约一致性。02证据是合成 runtime 验证（`runtime-validation/progress.md:28`），不能充当数据库迁移验收。

## 03 必须保持的数据库验收表

| 场景／具名反例 | 旧实现证据 | 可执行验收断言 |
| --- | --- | --- |
| 空库首次初始化 `empty_public` | `backend/src/notalone/startup_diagnostics.py:101`；`database_migrations.py:86` | 无账本且 public 无既有表、分区表、视图、物化视图、序列、外表才判待迁移；执行完整正式迁移后 ready；第二次无重放。不是检查 owner 行数。 |
| 无账本旧库 `owner_only_untracked` | `startup_diagnostics.py:102`；`database_migrations.py:98` | 即使存在 owner，返回 `baseline_missing`／迁移入口 `legacy_database_untracked`；不创建假成功历史，不自动接纳，不换空库。 |
| 可信执行历史 `tracked_059`、`tracked_060` | `startup_diagnostics.py:113`；`database_migrations.py:110` | 已执行 name＋checksum 必须等于正式序列的完整前缀；保留既有行、ID、暂停状态与连接，逐个补齐缺少版本。059起先核对既有运行结构，060起包含手动联系人确认表。 |
| 假最新记录 `107_only`、`107_with_gap` | `startup_diagnostics.py:116` | 只有当前107、漏掉中间版本、额外未来版本或改写 checksum 均拒绝；不能用 `MAX(version)=107` 或“最新文件已登记”替代全历史检查。 |
| 账本全但结构坏 `latest_missing_manual_confirmation` | `startup_diagnostics.py:26`、`:58`、`:128` | 核对必需表、字段及类型，包括 owner.created_at；账本齐全仍可 `schema_incomplete`。当前普通启动不是全库逐对象 fingerprint 认证，也不认证自定义对象。 |
| SQL 文件漂移 `duplicate_002`、`changed_001` | `database_migrations.py:34` | 文件名严格三位连续编号，从001开始且每号一个；SHA256针对原始文件字节，不能重格式化旧 SQL 后更新账本。 |
| 审计035基线 `adopted_035` | `backend/src/notalone/database_baseline.py:64` | 基线必须唯一、format=1、through=35、完整固定001–035 manifest、非空备份摘要及恢复时间，并有实际迁移表；只跳过已认证035，实际账本从036开始。基线不是伪造的001–035执行收据。 |
| 无可信基线／分叉 `old_memory_059_068`、`synthetic_s_058` | `backend/tests/integration/persistence/test_database_migrations.py:407`、`:448` | 拒绝旧分叉账本转换；不能看到近似表结构就套正式历史。保留现场并明确停止。 |
| 迁移并发与连接 `second_client`、`second_migrator` | `backend/src/notalone/startup_database.py:35`；`database_migrations.py:70` | 本机明确业务库、无其他 client backend，持有会话锁 `(1852798049,1)` 后更新；重复启动竞争者 busy，不结束未知连接。旧后台活着即挡更新：`desktop/src/main/startup/diagnostics.ts:126`。 |
| 事务与崩溃 `receipt_insert_failure`、`extra_COMMIT` | `database_migrations.py:124` | 每版 SQL＋该版收据原子提交；DO内执行防额外事务语句逃逸；失败只回滚当前版，前版保持，进程断开释放会话锁，重试从失败版继续。锁覆盖整轮，非每版重新抢锁。 |
| 特殊103 `corrupt_skill_resource` | `database_migrations.py:125`；`backend/src/notalone/persistence/skill_schema_upgrade.py:123`、`:200` | 103先校验并升级旧 Skill 包、资源与方法清单，再执行删旧内容列的SQL；不能只重放SQL。文件损坏要使当前DB事务回滚，保留旧内容并可修复重试；文件写入不能被误称与PG同一原子事务。 |
| 固定错误与诊断 `driver_error_with_secret` | `startup_database.py:43`；`database_migrations.py:165`；`database_audit.py:219` | 外部只见固定分类，不回显 DSN、驱动行内容、业务 UUID 或私人正文。历史审计仅输出违规分类计数。 |

表内缩写 `startup_diagnostics.py`、`database_migrations.py`、`startup_database.py` 均位于 `backend/src/notalone/`。

## 历史接纳与 fingerprint 的实际边界

`database_adoption.py:249` 是保留的显式受控035接纳实现，不是普通启动自动修复入口。它先核对固定前缀、本机PG16专用库、共享迁移锁和无其他连接（`:78–109`、`:239`）；已登记迁移的库不能再接纳（`:264`）。
历史接纳比较完整规范目录；仅允许已审计的 `source_document_source_type_check` 旧定义替换，未知对象、约束或归属漂移拒绝（`database_audit.py:146`）。来源核验覆盖无来源消息、跨owner／contact引用、binding定位、孤儿水位及活动记忆来源（`:164–223`）。
原接纳流程在 SHARE 锁下验证本机备份恢复，比较结构摘要与全行业务摘要，修补、baseline及空实际账本一事务提交；写证据后再次核对连接与目录，避免并发对象漏检（`database_adoption.py:271–319`）。等数量却内容不同也拒绝（`test_database_adoption.py:602`）。
**这些是历史工具的实现事实，不是03新增强制备份要求。** ADR-066 `architecture/adr/066-in-place-schema-updates-and-database-reuse.md:9` 已取消普通启动的备份、参考库、复制及切换；合法既有baseline凭证仍须能识别，未接纳旧库不能自动套该流程。
旧桌面 `update-operation.json` 的 format=1、completed、backup UUID、两份64位fingerprint是历史更新收据格式检查；不是当前schema完整性证明。损坏／未知收据或 managed import-pending 无收据时阻止启动，不恢复旧搬库流程（`desktop/src/main/startup/historical-update.ts:6–30`）。

## 资料位置、受管进程与 owner

| 场景／反例 | 旧基线证据与03验收内容 |
| --- | --- |
| 外置配置失联 `external_unreachable` | `desktop/src/main/backend/config.ts:39–89` 优先既有 backend-launch.json；缺失且有resources才区分 managed/state.json／first-run。外置配置损坏不是“新装”；保留原 project、env、info及DB目标，禁止切换新空库。 |
| 原资料目录 `changed_HOME` | `backend/src/notalone/runtime_config.py:46`、`:106` 按显式env路径或cwd向上找配置，环境已有值优先；`persistence/skill_files.py:222` 从 NOTALONE_SKILLS_DIR 或 `~/.notalone/skills` 定位。DSH隔离HOME／cwd不能把旧Skill目录变成空目录；原DB、资料及显式路径必须保持。 |
| 未知受管目录 `cluster_without_PG_VERSION` | `desktop/src/main/startup/managed-runtime.ts:31–40` 不覆盖外置配置，无state但目录非空拒绝；`:72–93` 只有bootstrap未完成且cluster不存在才initdb，临时目录完成后rename，已有PG_VERSION须为16。不能删除未知目录后重建。 |
| 初始建库中断 `bootstrap_incomplete` | `managed-runtime.ts:145–162` 只在首次bootstrap阶段检查／创建notalone库、运行结构补齐，成功才写bootstrapComplete；必须验证每阶段重试，不能把部分完成当ready。 |
| 二进制替换／端口冒认 `foreign_pg_isready` | `desktop/src/main/startup/managed-manifest.ts:25–78` 核对架构、固定布局、SHA256、执行权限及库存路径；`managed-runtime.ts:94–140` 使用动态回环端口，PG锁的PID须匹配本次监督器报告且端口一致。pg_isready成功不能证明归属；未知postmaster.pid不删除、不据此杀进程。 |
| 重复启动及退出 | `managed-runtime.ts:44–47` 合并启动Promise；`:230–238` 回收自有监督器。`backend/src/notalone/managed_postgres.py:29–54` 父进程退出后等待业务共享寿命锁释放，再停止自有PG子进程；`desktop/src/main/backend/host.ts:204–228` 先门禁再认证复用／启动，不能因握手暂失另起实例。 |
| 业务ready而非进程存活 | `desktop/src/main/startup/diagnostics.ts:123–149` 诊断→必要迁移→复验；但裸 `backend/src/notalone/server/command.py:79–90` 仅解析配置，没有同等schema门禁，`:198–204` 开调度／同步并发布握手。迁移03必须明确门禁责任方，不能宣称裸旧server已有此保证。 |
| 已有owner `one_owner_missing_config` | `server/command.py:81–90` 从受控环境取运行owner；`backend/src/notalone/application/setup_service.py:82–96` 既有恢复路径写回原UUID。`persistence/setup_owner_directory.py:71–103` 同UUID创建幂等且不改原名；验收原owner、联系人与授权保持，不按昵称或DSH session ID创建身份。 |
| 多owner `two_owners_missing_config` | **旧实现缺口**：setup_service.py:84直接取owners[0]，不核验唯一；不是“唯一自动恢复已实现”。03的唯一复用要求须区分有效已配置owner与缺配置歧义，给出明确拒绝／选择结果，不照搬猜首行。 |
| 首次owner提交后配置失败 | `setup_service.py:76–81` DB创建之后才持久化配置，二者不是同一事务；`setup_owner_directory.py:105–123` 空表创建有事务表锁、5秒超时。验收并发首建最多一个owner，配置落盘失败后不再创建第二身份；不能冒称已有跨DB／文件原子恢复。 |
| 凭据与诊断 | `desktop/src/main/backend/config.ts:119–139` managed环境白名单；`managed-runtime.ts:185–190` 更新DB URL保留其他设置，`:246–268` 校验私有文件。`runtime_config.py:67–103` 去除同键旧赋值，0600临时文件、fsync后replace；配置成功不回显key。`server/command.py:204` 握手stdout含token，`desktop/src/main/backend/process.ts:24–25` 丢弃原始输出，不能把它接入普通日志。 |

本节未写完整目录的 `managed-runtime.ts` 位于 `desktop/src/main/startup/`，`setup_service.py` 位于 `backend/src/notalone/application/`，`setup_owner_directory.py` 和 `skill_files.py` 位于 `backend/src/notalone/persistence/`。

## 最小复跑入口（本轮未执行数据库测试）

这些集成测试会连接PG并创建随机 `_test` 库，部分清理使用 FORCE；仅在实施者明确指定的独立合成实例运行，不沿用默认 `/tmp` 实例，不指向业务库。先进入 `backend`，使用工程指定 Python 环境，设置 `NOTALONE_DISABLE_DOTENV=1 PYTHON_DOTENV_DISABLED=1` 和显式 `NOTALONE_TEST_DATABASE_URL`；命令为 `python -m unittest <下面的完整选择器> -v`，输出裁剪 `2>&1 | tail -60`，保留管道失败状态。

| 最小选择器（共同前缀 `tests.integration.persistence.`） | 证明内容 |
| --- | --- |
| `test_startup_database.StartupDatabaseTest.test_existing_059_keeps_database_and_contact_then_repeats_without_reapplying` | 原库资料保持与重复启动 |
| `test_startup_database.StartupDatabaseTest.test_fresh_database_initializes_current_schema` | 空库首启 |
| `test_startup_database.StartupDatabaseTest.test_untracked_existing_objects_are_not_adopted` | 有表不等于可接纳 |
| `test_startup_database.StartupDatabaseTest.test_other_connections_block_schema_change_without_creating_missing_table` | 其他连接阻断写入 |
| `test_startup_diagnostics.StartupDiagnosticCommandTest.test_audited_baseline_with_only_real_subsequent_ledger_is_ready` | 已接纳035合法恢复 |
| `test_startup_diagnostics.StartupDiagnosticCommandTest.test_latest_ledger_without_manual_confirmation_table_fails_before_business_starts` | 最新账本不替代结构检查 |
| `test_database_migrations.DatabaseMigrationCommandTest.test_history_changes_are_rejected_before_new_migrations` | checksum／历史不符拒绝 |
| `test_database_migrations.DatabaseMigrationCommandTest.test_interrupted_connection_can_resume_same_migration` | 中断回滚与可重放 |
| `test_database_migrations.DatabaseMigrationCommandTest.test_extra_commit_cannot_escape_version_transaction` | SQL不能逃逸版本事务 |
| `test_database_adoption.DatabaseAdoptionTest.test_fake_historical_success_is_rejected_after_audited_baseline` | 不补写假历史账本 |
| `test_database_adoption.DatabaseAdoptionTest.test_same_owner_other_contact_memory_source_is_rejected` | 接纳也不削弱联系人来源隔离 |
| `test_skill_business_state_migration.SkillBusinessStateMigrationTest.test_corrupt_directory_resource_rolls_back_all_owners_and_retries_after_repair` | 103的非SQL前置及恢复 |
| `test_setup_owner_directory.PostgresOwnerDirectoryTest.test_create_owner_is_idempotent_and_keeps_original_name` | owner原UUID与名称保持 |

上述单例通过后再按相关模块扩展，重点包括 `test_database_migrations.py:279` 收据失败、`:407`／`:448` 两类旧分叉，及 `test_database_adoption.py:628`／`:653` 提交前并发。01快照证明合成资料恢复，不证明所有历史分叉兼容；来源 `.scratch/dsh-ts-migration/baseline/README.md:27`。
纯单元入口 `tests.unit.application.test_setup_service.SetupServiceTest.test_initialize_owner_is_idempotent`（`backend/tests/unit/application/test_setup_service.py:73`）只覆盖单owner恢复；不能替代多owner和配置中断验收。桌面已有 `desktop/tests/startup-continuity.test.mjs:128`、`desktop/tests/packaging/managed-runtime.test.mjs:18` 提供历史现场与运行时完整性线索，本轮不运行其打包相关路径。

## 状态、风险和本轮验证

- 已实现事实：上述Python启动、迁移、035显式接纳及受管启动代码与具名测试存在；本轮是源码核验，未重新跑其运行测试。
- 已采纳目标：ADR-061／065首用约束经066原库升级、095账号授权及102迁移决定修订；owner恢复不授权新增微信范围，也不恢复已撤销记录。不能以这些ADR状态证明独立机器首用完成。
- 原票仍未完成：`.scratch/local-app-first-use/issues/02-database-lifecycle.md:4` 及 `.scratch/local-app-first-use/issues/03-wechat-component-preparation.md:4`、`.scratch/local-app-first-use/issues/09-clean-machine-release-acceptance.md:4` 均 open；03应明确承接者和覆盖结果，不能把已有代码存在当作这些票已完成。
- 真实风险：普通ready检查只覆盖所列运行表／字段；受管建库多阶段崩溃、跨语言103文件副作用、未知历史目录、重装和较新版本拒绝仍须按原票做合成验收。本文不新增“完整所有对象fingerprint”要求，不把DSH退出码当业务恢复证据。
- 数据影响：只新增本审计Markdown；不读取 `.env`／凭据／私人聊天，不连接任何数据库，不启动App／微信／模型，不安装、打包、发送消息或push；按委派约定不单独add／commit。
- 文档验证：固定源码与旧基线逐项定位；64处引用及25份基线代码文件已检查，`3c168296 → fc8dcf50/HEAD` 所引旧代码无差异，具名单例选择器存在。仅运行 `git show`／`rg`／文档静态校验，未重复全量baseline、数据库测试或端到端验收。首次校验因系统无 `python` 改用指定Conda解释器，引用短路径补全后复验。
