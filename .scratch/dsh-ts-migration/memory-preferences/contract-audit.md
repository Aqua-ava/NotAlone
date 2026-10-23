# 09 记忆与表达偏好合同静态核验

日期：2026-10-23。结论：本轮仅完成合同审计；09 实现仍等待 04 实际验收，不改变票状态。

## 固定证据与范围

- 旧业务固定 `3c168296e9e8edaa43b8b323ff693e790e709069`。下文 `B/`＝该提交 `backend/src/notalone/`，`D/`＝该提交 `desktop/src/`；SQL、测试也固定该提交，用 `git show` 读取。
- 03 完成点按移交为 `9f39d6c2`；不据此认定04/09通过。04的 `contact-context/contract-audit.md:12-39` 仅供边界参考，不把其在变工作树作为基线。
- 已核对 workflow、engineering、domain、issue-tracker、09/spec；领域定位 CONTEXT、domain-data/core-flows/privacy-deletion、agent-runtime 和 ADR-002/005/006/009/080/085/102。ADR-080取消失效旧版生成例外，ADR-085不恢复额外置信度人工门。
- 可移植工作区入口为 `$HOME/Documents/learn/NotAlone`。不读取真实 Skill、聊天、关系资料、凭据或数据库。

## 锁定 DSH 查证

- 锁定 `@deepseek-ai/dsh@0.2.1-rc.2`、[官方提交687f282](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317)。阅读 `/tmp/notalone-dsh-official-687f282`，`package.json:3` 版本吻合，提交归属沿用 `runtime-validation/dependencies.json:5-6`。导出无 `.git`，`rev-parse` 失败；未独立验证档案内容哈希，不冒充构建证明。
- 官方 `apps/cli/src/profile-boot.ts:202-235,271-345` 合成 profile patch，dispose 清 root fiber/代理，SIGTERM/SIGINT 触发 shutdown；boot后须 active fiber/loader 才 ready。ready不代表业务来源有效，退出不替代事务收尾。
- 官方 `packages/core/agent/README.md:43-63,176-177`：setup 在发布前安装能力，cancel 默认清 inbox，whenIdle 等待静止，局部注册随 ctx dispose 解除。取消不回滚已提交用户决定。
- 官方工具文档/示例 `packages/core/tools/README.md:30-61,83-89,109,126`：执行体接收 `exec.signal`；restrict 限制继承工具，guard 同步单调拒绝；取消为协作式，不能替代 await 后来源复验及提交资格。框架作用域不是 owner/contact 授权。
- 官方 `packages/bundle/sdk-minimal/cordis.patch.yml:1-23` 仍含 session-log-deepseek；minimal名称不是无上报证明，继续使用已锁定专用profile，不为09加载默认工具/日志。
- **09 管理 CRUD、版本和事务不涉及直接 DSH 接口**：`B/application/expression_preference_service.py:14-43` 是普通持久化端口，记忆也由认证HTTP调用业务服务。建议普通TS service/store/DTO，薄插件仅装配和释放；此为建议，未实现验证。不改框架、不新增模型写记忆工具，不以目录或DSH session代替业务身份。

## 记忆公开入口、原表与版本

- `B/server/app.py:2191-2228`：服务不可用503、请求错误400、版本/修正冲突409、缺失或跨范围404；owner来自宿主，错误不回显正文。所有记忆/偏好响应统一 no-store（`:714-727`）。
- 同文件 `:2231-2387`：`/api/memories/owner`、`/api/contacts/{id}/memories` 及联系人范围本人资料、手录和版本读取；`:2388-2448` 候选 confirm/discard/apply-update；`:2451-2485` 联系人 revert-auto-update/delete/correct。实施时逐分支保留路径/DTO，不把语义相似操作合并。
- 精确路由补充：POST `/api/memories/manual-contact`、`/api/memories/manual-owner`；GET/POST `/api/contacts/{contact_id}/owner-memories`；GET `/api/contacts/{contact_id}/memory-candidates`；POST `/api/contacts/{contact_id}/memory-candidates/{candidate_id}/{confirm|discard|apply-update}`。GET版本用 `/api/contacts/{contact_id}/{memories|owner-memories}/{memory_id}/versions` 或 `/api/memories/owner/{memory_id}/versions`；POST修改在对应记忆项后追加 `correct|delete|revert-auto-update`（`B/server/app.py:2241-2485`）。
- 列表/版本返回 `{memories:[...]}`、`{candidates:[...]}`、`{versions:[...]}`，修改通常返回 `{memory:...}`，不得统一成偏好的DTO。`B/server/app.py:4240-4273` 联系人记忆DTO保留memory_id/level/contact_id/text/category/topic/adoption_method/status/revision、退役原因/时刻、source_ids、confidence/risk_flags、supersedes_memory_id、timing/event/conditions/evolution/version_evidence及来源当前性、can_revert_auto_update、valid_at/invalid_at和来源依赖字段。
- **不能统一臆造CAS**：correct/delete不要求 `expected_revision`；correct用明确旧memory_id新建版本，同文重放复用新版，异文迟到冲突（`B/persistence/memory_store.py:535-591`）。apply-update要求 `previous_memory_id + expected_revision`、可附 `correction_decision_ids`（`B/server/app.py:2391-2415`）；revert显式要求revision（`:2454-2459`）。
- `backend/database/migrations/009_memory_store.sql:3-60` 保留 memory_candidate/confirmed_memory 各自UUID及 owner_id/contact_id；复合FK绑定contact/candidate，confirmed对 `(owner_id,contact_id,source_candidate_id)` 唯一。`adoption_method=auto|manual`，confirmed表名不表示用户确认。
- `B/application/memory_service.py:138-155`：SELF候选转owner store，其他转contact store；人工确认才用manual。候选/正式记忆、原来源及版本不能折叠成一个DSH记忆对象。
- 管理列表可包含 expired/invalidated（`B/application/memory_service.py:62-84`）；默认持久读取过滤active、有效期及同范围来源，历史读取明确UUID集合，空集合直接空结果（`B/persistence/memory_store.py:870-943`）。历史可看不等于可生成；state_changed旧版也受ADR-080禁用。
- `B/persistence/memory_store.py:967-1008` 按scope列版本并逐版核来源；撤销持contact/owner锁、复验新旧来源并清新版回复依赖。`B/persistence/memory_versions.py:254-292` 仅接受准确revision的active auto叶、invalidated auto旧版、无active后继且version_evidence有效；不是撤销任何人工决定或通用恢复接口。
- `architecture/current/domain-data.md:56-62`：记忆页面“我”依当前联系人来源过滤；底层owner_memory仍按owner共享，不复制为联系人一份。未选联系人不回退全局本人资料；全局表达偏好则有独立范围合同。

## 表达偏好公开合同

- `B/server/expression_preferences.py:32-101`：`/api/expression-preferences` GET列表/POST创建，`/{id}` GET/PATCH/DELETE；唯一可选query为单值contact_id，无分页。GET返回 `{preferences:[...]}` / `{preference:...}`，写成功200，删除 `{state:deleted}`；非法400、缺失404、已删410、冲突409、存储异常503、方法不支持405。
- POST精确字段 `operation_key,text,scope,origin,confirm_long_term`；PATCH为 `operation_key,expected_revision,text,scope,confirm_long_term`；DELETE仅 `operation_key,expected_revision`。创建/修改须明确true，scope含contact_id/reply_mode，origin为manual或message+id。一次性要求、候选选择或复制不构成长久确认。
- DTO同文件 `:17-29` 保留 preference_id/text/scope/revision/confirmed_operation_key/origin/source_ids/confirmed_at/updated_at。owner取宿主（`B/server/app.py:928-930`），不接受请求自报owner。
- `backend/database/migrations/065_expression_preferences.sql:4-58` 保留 expression_preference/state/operation/reply_expression_preference_use 和原UUID。owner集合revision与单条revision不同；operation主键 `(owner_id,operation_key)`；contact NULL表示owner全局，非空受复合FK约束；reply_mode为三种输入模式或NULL，不是场景。
- 消息来源偏好须有contact与来源，手录来源为空；消息偏好不能移往另一范围（`B/persistence/expression_preferences.py:353-355`）。065内旧样本表不是当前能力，096迁移 `:151-154` 已DROP样本/依赖，09不恢复。
- 管理无contact query只返回owner全局项，有contact才返回全局及该联系人项（`B/persistence/expression_preferences.py:299-326`），不是owner全库。生成再按模式筛选，contact/模式具体项优先，最多扫描50、选5条/1536字，当前意图优先（`:187-214`；`B/reply/expression_preferences.py:12-45`）。
- 创建在owner锁内复核范围/来源，同键同摘要且结果版本仍当前才幂等；已删旧键410、异文/版本变化冲突（`B/persistence/expression_preferences.py:226-277`）。修改检查expected_revision，重放匹配当前结果版本；禁止bool伪装整数（`B/reply/expression_preference_models.py:73-89`）。
- 删除owner锁内检查版本、擦托管升级备份和派生闭包，置空正文/来源/旧摘要，保留墓碑及删除操作身份；同删除键可重试，来源删除共用擦除函数（`B/persistence/expression_preferences.py:147-178,374-407`）。Skill文件清理失败返回不可用，不能提前报全完成。
- 生成捕获集合revision、单项版本和实际使用回执，提交复验当前条目/来源（`B/persistence/expression_preferences.py:87-144`）。更新可保留合法历史原快照；删除须擦历史/准备态/恢复副本，不能拿当前偏好回填过去回执（`B/reply/expression_preferences.py:60-78`）。

## 桌面和事件

- `D/main/memory/bridge.ts:82-92` 发布 `memory:state-changed`；`controller.ts:97-127,368-585` 校验后端generation/contactId/scopeRevision，取消失效读写，接版本/修正/采纳/撤销/删除；删除或响应未知撤快照，禁止晚回填。
- `B/server/event_models.py:13-18` 仅有 message.created、sync.status_changed、task.progress，**没有memory.changed/source.deleted SSE**；来源删除联动为 `D/main/index.ts:122-132` 本地回调。
- 偏好 `D/shared/expression-preference-bridge.ts:16-40` 状态含revision/erasureRevision/contactId/scopeRevision/phase/preferences/busy/error；`D/main/expression-preferences/bridge.ts:38-49` 发布 `expression-preferences:state-changed`，提供get-state/refresh/save/update/remove，限定helper页面，不是HTTP事件。
- `D/main/expression-preferences/controller.ts:27-79,126-165` 固定generation和联系人范围，切换丢迟到读取；删除/失效中止读写并清retry。操作键只在可信内存重试，重启先重读；客户端abort不保证服务器未提交，事务与重新读取决定真实状态。

## 责任边界

- 09负责L1管理、候选人工处理、修正/版本/撤销、偏好和桌面状态，同时接原人工保护及删除失效合同；不能把后台生产迁移夹带进来。
- 10/11负责提取、来源核验、租约/批次/预算、自动裁决及采纳发布；09保留其接口和保护记录，不把auto改manual。13/14负责L2/L3整理生产、纠错及发布；04的读取边界不证明整理已验收。
- 15负责Skill学习审核、发布及政策权限；偏好不是Skill授权。09删除不能跳过旧erase_skill_learning和文件清理依赖。
- 17负责跨域整体删除及完整闭包；09的读写/删除竞态不能延期。每项业务唯一写入方，切换/回退先核对在途任务，禁止双写或旧库回灌；不把底层联系人清理适配器描述为现成整体删除UI。

## 具名验证入口（只核对定义，均未运行）

- `backend/tests/integration/server/test_memory_correction_protection.py`，类 `MemoryCorrectionProtectionHttpTest`：`:670` `test_duplicate_correction_returns_one_version_and_stale_change_conflicts`；`:540` `test_confirmation_requires_current_decision_and_replays_one_version`；`:699` `test_source_delete_commits_before_late_correction_and_confirmation`；`:768` `test_contact_decision_does_not_leak_to_other_contact_or_owner`；`:913` `test_late_delete_of_superseded_version_cannot_erase_current_manual_decision`。
- `backend/tests/integration/server/test_memory_correction_grounded.py:319`：`GroundedCorrectionAutomaticHttpTest.test_manual_decision_before_atomic_update_refuses_stale_automatic_write`；`backend/tests/integration/persistence/test_memory_confirm_consistency.py:79`：`MemoryConfirmConsistencyTest.test_contact_replay_rejects_changed_expected_evidence`。
- `backend/tests/integration/server/test_expression_preferences.py`，类 `ExpressionPreferencesHttpTest`：`:78` `test_explicit_save_is_retrievable_idempotent_and_owner_isolated`；`:107` `test_user_can_change_scope_and_delete_without_old_operations_restoring_text`；`:143` `test_directory_and_item_reads_are_filtered_by_selected_contact_before_returning_text`。
- 同类 `:304` `test_delete_during_model_response_rejects_late_result_and_recovery`；`:525` `test_persistence_fault_rolls_back_save_and_delete_then_same_operation_recovers`；`:564` `test_source_delete_during_model_response_rejects_late_result_and_same_key`；`:586` `test_update_during_model_response_rejects_old_snapshot_and_retry_reads_new_version`；`:650` `test_prepared_preference_restart_keeps_exact_receipt_and_update_requires_explicit_reprepare`。
- `backend/tests/integration/persistence/test_expression_preferences_upgrade.py:22-23`：`ExpressionPreferencesUpgradeTest.test_real_064_data_preserved_new_directory_empty_and_repeat_no_write`；real指旧schema夹具，不授权真实DB。
- `desktop/tests/memory-correction/controller.test.mjs:199`：`删除资料撤下受影响正文，成功或响应未知都拒绝迟到比较`；`:347`：`另一联系人来源事件不能在删除提交后回填待删正文`。
- `desktop/tests/expression-preferences/controller.test.mjs:9`：`长期偏好目录在联系人切换后丢弃迟到读取，并只显示当前联系人和全局项`；`desktop/tests/expression-preferences/reprepare-http.test.mjs:5`：`真实HTTP在首次prepare后修改偏好会封旧键，明确核对后才新prepare并读取revision2`。

## 最小合成反例、缺口及实际验证

- 隔离：O1/O2、联系人A/B同昵称；A记忆ID用于B须拒绝。O1全局偏好可用于O1/B、不可用于O2；A消息偏好不可转全局。未选联系人时记忆页面不回退全局本人资料。
- 明确性：“这次简短”、选择/复制候选后偏好表不新增；“以后简短”显式保存才新增。自动采纳仍auto，不凭confirmed表名显示用户确认。
- 交错：暂停A读取→切B或删来源且丢删除响应→释放旧GET，正文不得回屏；偏好rev1准备→rev2修改/删除→旧模型返回/旧键重试，须冲突/失效，重新prepare只读现存版本。
- 版本：M1修正M2，同文重放只返M2；异文纠错或迟到删除M1不得伤M2。旧decision IDs或来源世代变化后确认不能采纳；auto新版已有人工后继/原来源删除，撤销不能复活旧正文；state_changed旧版只可查看。
- 幂等：同键异文冲突，同删除键可重试，删除后原创建键不可复活。TS须补Python JSON摘要兼容、UUID排序、Unicode码点计数（emoji与JS length差异）、bigint revision、UTC精度及NULL对照；这些跨语言用例本轮尚未验证。
- 缺口：未跑旧测试、新TS对照、PG事务竞态、模型、页面或App/微信；未证明09等价、04集成、DSH停机等业务事务或跨域清理恢复。测试定义存在不是本轮通过，也不表示每个反例已有覆盖。
- 实际操作仅 `git show/ls-tree`、`rg/nl/sed` 静态读取，核验报告引用/测试名称和行数；`git rev-parse`确认导出不含Git元数据；首次写入尝试因系统无python而失败，随后使用文件补丁。没有运行测试/App/数据库/模型、安装下载、打包或发送。
- 数据影响：仅新增本报告，不读取/更改个人资料，不变schema，不产外部模型调用或业务副本；不改产品、其他文档、票状态、planning/execution，不add/commit/push，由主会话归档。09实现仍等04；未来桌面验收仅可用npm run dev。
