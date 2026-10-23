# 任务18：微信账号、范围、绑定与排除静态合同审计

日期：2026-10-23。结论：静态审计完成，**本审计不代表任务18实现或验收**。派发审计时04仍在实施／审查；归档时主会话已核验04在`f4acc05d`/`2dd9ad4a`完成，另行派发18实现。03基点为`9f39d6c2`；此处不重验前置、不提前移交写入责任。

## 证据口径与优先级

- 旧产品证据统一为 `3c168296e9e8edaa43b8b323ff693e790e709069`，以下标为“旧”的路径、行号均由 `git show <SHA>:<path>` 取得，不代表当前工作树。04正在变动的实现不作旧行为基线。
- 票据为 `.scratch/dsh-ts-migration/issues/18-wechat-scope-binding.md:6`、`:17`；规格为同目录上级 `spec.md` 的身份／资料、切换及验收矩阵。读过 workflow、engineering、domain、issue-tracker 入口，并核对架构索引、领域词汇及相关规格定位段落。
- 当前用户提供的 AGENTS 硬边界优先：默认所选会话、明确全部私聊、不追溯新绑定 baseline 前历史。**与 ADR-100:35 及 current/privacy-deletion.md:67 的自动首次全历史设计存在冲突，实施前须裁定；本审计不以 ADR、旧代码或历史 accepted 记录扩大真实读取授权。**
- 区分三件事：显式单联系人文件历史导入；账号级历史授权版本记录；后台按绑定自动追溯。前两者的存在不自行授权第三者越过当前 baseline 硬边界。
- ADR-023／025／030 的运行、停读、补齐边界，ADR-087 的真实联系人来源，ADR-089 的账号范围／排除，ADR-095 的探测复验与首次事务，ADR-101 的默认所选分支，ADR-102 的唯一写入方均需保持。ADR-100 的冲突部分单列，不静默解决。

## 锁定 DSH 的官方核对（无直接微信接口）

锁定证据：`.scratch/dsh-ts-migration/runtime-validation/dependencies.json:2` 起记录 Node `24.19.0`、DSH `0.2.1-rc.2`、commit `687f282e8625c6b8d11ff58211a90524be2e4317`、锁摘要 `69fcd1a15fb734f9c58c2a241939db6fc003b3c10001a33ecb11f6bf6e5841c2`。本轮使用已有 `/tmp/notalone-dsh-official-687f282` 导出，不安装或下载；版本来源为上述锁定证据，本轮未重新取得远端或逐文件验哈希。

以下位置均相对该导出；官方固定链接前缀为 `https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/`，不是可变 master 文档。

| 官方依据 | 核对结论及18的适配边界 |
| --- | --- |
| `docs/cordis-tutorial/02-lifecycle-and-effects.md:5`、`:13` 的 timer／child plugin 示例、`:90` 的异步清理说明 | 外部连接、定时器、CLI 子进程属于业务资源；通过既有薄插件生命周期归属清理。多个异步 disposer 可并发，需顺序的“停接收→停止读取→等待退出→关闭连接”必须在同一个 disposer 内 await。不能假定框架卸载自动关掉任意外部进程。 |
| `packages/core/agent/src/index.ts:98`、`:101`、`:147` | create 的 signal 仅负责创建期；setup 在发布前构成作用域；handle.dispose 停循环并清理 session／scope。不能用创建 signal 或 DSH session ID 替代账号权限、业务绑定及提交前复验。 |
| `packages/core/tools/src/index.ts:224`、`docs/tool-execution-pipeline.md:5` | 工具异步执行须观察／转发 signal，框架不能硬杀同进程代码。官方 guards／作用域也不能替代 PostgreSQL 的 owner/contact 检查和业务撤销；业务晚结果须拒绝提交。 |

18的账号检测、范围确认、绑定事务不涉及直接 DSH 模型 API：保持普通 TS 业务与受控 HTTP／桌面入口。微信 status／sessions／正文读取、授权写入和聊天发送均不因迁移注册为模型 Tool；不新增微信插件、Shell 或 SDK 子进程层。DSH清理能力只约束共享后台的资源生命周期，不能证明18已可运行。

## 旧版公开与桌面合同

以下缩写仅用于节省篇幅：`B=backend/src/notalone/`，`D=desktop/src/`，均是仓库相对路径。

| 入口／领域 | 旧代码证据与事实 | 迁移应保留或补齐 |
| --- | --- | --- |
| 工具路径设置 | 旧 `D/renderer/StartupSettings.tsx:136` 暴露 `wechatCliPath`；`D/main/backend/config.ts:100` 严格校验配置键、canSave，临时文件0600后 rename | 配置不等于账号、列表或正文授权；换配置需失效候选并复验。不得要求用户继续依赖已退役 Python 路径。 |
| 研发组件准备 | 旧 `desktop/scripts/prepare-wechat.mjs:6` 从锁定 sourceCache 调构建，默认不下载；`:26` 的完整性检查明确真实接入未验收 | 这是开发组件脚本，不是干净机器的可恢复产品准备界面；不得把脚本存在写成完整首用已交付。 |
| 状态与探测 | 旧 `B/server/app.py:2861`：GET `/api/setup/wechat`，POST `/api/setup/wechat/detect` 只接受 `{}`；`B/application/wechat_setup.py:54` 状态只读保存值，`:62` detect 生成候选 | owner未初始化不探测；ready只是候选。响应为 `state/account_id/candidate_token/failure_code`，错误限固定码、不回显配置／密钥。 |
| 账号证据 | 旧 `B/wechat_cli/adapter.py:289` 固定 `status --include-debug --strict-read-only`，无 expected 时即返回；有 expected 时前后 status 中间 `sessions private limit=1` | 探测的是工具配置账号，不是微信前台登录账号。首次复验变化必须先于列表调用拒绝；末次变化不得落身份／授权；不能读 tail/history 测连接。 |
| 首次连接确认 | 旧 `B/server/app.py:2872` 仅接受 `candidate_token,confirmed:true`；`B/application/wechat_setup.py:79` 比较token、复验账号／可读性；`B/persistence/wechat_setup.py:29` 原子事务 | token仅主进程保管，renderer不得指定owner／账号；已有身份、撤销身份、跨owner占用或运行账号冲突不覆盖。重复确认不得重开开关或改授权时间。 |
| 首次范围缺口 | 旧 `B/persistence/wechat_setup.py:51` **固定写 all_private**，`:56` 同时写历史accepted，`:60` 开同步；HTTP没有mode字段 | 仅是旧事实。ADR-101:12、18验收要求默认selected且列表不预选：不能机械复制该首次事务。须先设计“账号／列表必要同意→仅选中绑定”分支，绝不能先全部授权再缩回。 |
| 列表访问 | 旧 GET `/api/sync/cli-sessions` 位于 `B/server/app.py:1153`；`B/front_sync/cli_binding.py:109` 输出username、display_name、last_timestamp、bound_contact_id | 桌面 `D/main/bindings/controller.ts:90` 启动／重连只读已存状态，明确refresh才读列表。首次selected分支还需显式列表同意，不能把账号detect当同意。 |
| 摘要处理 | 旧 `B/wechat_cli/adapter.py:1017` 的候选解析仍把summary接入内存对象；`B/front_sync/cli_binding.py:118` 绑定投影不带summary；账号可读性检查丢弃sessions结果 | 已观察到的是“业务投影丢弃”，不是“适配器从未接收”。建议18在最早不需要摘要的边界丢弃并测试不进入UI、DB、日志／模型；全局事件 `adapter.py:962` 仅保留cursor和locator，正文读取归19。 |
| 选择与绑定 | 旧 `D/renderer/use-binding-consent.ts:13` 初始选择空，`:36` 刷新仅保留有效选择；`D/main/bindings/controller.ts:122` 提交前重新读列表／绑定，再POST `/api/sync/cli-bindings/confirm` | body为selections，含locator、display_name、observed_display_name及可选contact_id。`B/front_sync/cli_binding.py:174` 拒绝消失／改名／改绑；`:208` 批事务建联和baseline。同名不合并、改名不换contact ID。 |
| 全部范围变更 | 旧 POST `/api/sync/scope` `B/server/app.py:1194` 严格要求 `{mode,confirmed:true}`；`B/front_sync/full_sync_engine.py:375` 保存selected/all_private但不修改总开关 | 无记录默认selected；再次all_private保留grant时间。切回selected停止自动纳入、已有有效绑定保留；换账号不得继承旧账号范围。 |
| 发现现有／新增私聊 | 旧 `B/front_sync/full_sync_engine.py:436` 开关开且all_private才周期列私聊；5000上限失败，不猜完整；`B/persistence/sync_scope.py:50` 事务重查范围与排除 | 稳定username/locator为键；复用唯一active渠道身份、冲突报错／事务回滚，群聊跳过；已撤销身份不自动复活。每批250／2秒上限，周期后续接续。账号变更须拒绝或重核，不能沿用旧scope；本轮不证明后台每次读取都复验实际工具账号。 |
| 历史授权 | 旧 POST `/api/sync/history-authorization` `B/server/app.py:1212` 严格要求decision accepted/declined和confirmed；`B/persistence/history_authorization.py:22` 当前version=1 | 无行／旧版本为required；拒绝保留原增量，接受后迟到declined不得降级。独立账号键不由总开关推断。旧代码有accepted后启动历史请求（`full_sync_engine.py:408`），与本轮baseline硬边界冲突，须裁定，不能照搬启用。 |
| 撤销与排除 | 旧POST `/api/sync/cli-bindings/revoke`；`B/front_sync/cli_binding.py:226` 核对owner/contact/binding和账号；`B/persistence/conversation_repository.py:218` 幂等撤销 | 桌面 `D/main/bindings/controller.ts:166` 发请求前撤旧窗口资格，busy可显式重试，其他失败读回真实状态；重开开关／改范围不恢复排除。物理删除触发排除见下表。 |
| 状态事件与晚回执 | 旧 `D/main/setup/wechat-bridge.ts:13` 的get-state/refresh/detect/confirm/retry-restart限manager，发布 `wechat-setup:state-changed`；`D/main/bindings/bridge.ts:38` 发布 `bindings:state-changed` | setup控制器`:148` 按generation+epoch拒绝晚结果，`:91` 按revision拒绝过期确认；丢响应只GET读回不重放授权，restart失败可恢复。绑定控制器同样按scopeRevision及epoch复验。UI忽略晚回执不等于撤销服务器已提交事务。 |

## 原表、身份和单一写入责任

| 原表／标识 | 合同与任务边界 |
| --- | --- |
| `owner.id`、`contact.id`、`owner_channel_identity`、`channel_identity` | 保留原ID、状态与验证来源。范围是owner_id+contact_id，稳定外部身份另有channel/account_scope/locator；展示昵称、DSH session均不得成为主键。04承接联系人基础；18调用确定性边界，不另造联系人库。 |
| `conversation_binding.id`、`wechat_observation_baseline` | 旧批绑定 `conversation_repository.py:420` 事务保留owner/contact/binding/locator/baseline；手动确认只新增明确选择。18接管授权／绑定，19消费active绑定，不各自创建两套绑定。 |
| `wechat_sync_scope` | 迁移 `100_all_private_sync_scope.sql:4`，PK owner_id+channel+account_scope，mode/granted_at；无旧开关自动升级，18唯一范围写入方。 |
| `wechat_sync_exclusion` | 同迁移`:16`，PK含locator_hash（UTF-8 locator的SHA-256）；`:29` binding撤销／删除触发插入。联系人级联删除后排除仍留，owner删除时不再插入并级联清理。17负责整体删除，18保留并尊重触发器，不能清空排除来“修复同步”。 |
| `wechat_history_sync_authorization`、`front_sync_state` | 迁移105的账号级version/decision/decided_at与总开关分别保留；首次连接原子提交事实不能用来扩张新selected分支。历史记录必须原样兼容，是否驱动baseline前读取按上文冲突裁定。 |
| `cli_history_sync_state`、`local_wechat_observation`、消息／来源与游标 | 迁移104的历史覆盖键为owner_id+contact_id+binding_id，可靠检查点随来源提交；18不将授权成功标为历史完整，不写消息／覆盖。19负责正文增量，20负责历史／缺口接续和覆盖，22负责业务任务状态／租约。 |

19的全局session事件只是触发，正文仍按稳定active绑定＋总开关读取；20不得借补齐绕过baseline／撤销／删除；21负责前台名称定位、重名／改名／低置信度人工门，不是后台读取门禁。17删除需失效缓存与在途结果，22不得盲目重领／恢复。03负责宿主退出，18提供当前授权状态、撤销及资源清理协作，不能用DSH abort替代CLI停读。

建议移交以完整业务功能停接收、收尾／中断、核对租约后切一次责任方；范围、发现建联、撤销、删除触发器和正文消费者需共享同一有效权限。迁移期间禁止Python和TS同时处理同一入口／自动建联写入，禁止逐请求失败兜底或恢复旧库。此为移交建议，本轮没有实施路由切换。

## 具名旧测试（均未运行）

以下都是冻结SHA中的合成用例，不是本次通过记录；将其按公开HTTP／桌面→持久状态迁移，不能只复制私有mock。

| 文件（仓库相对） | 具名用例／位置 |
| --- | --- |
| `backend/tests/unit/application/test_wechat_setup.py` | `test_first_connection_reprobes_and_recovers_after_lost_response`:28；`test_existing_account_does_not_reset_selected_or_disabled`:67；`test_invalid_token_never_probes_or_writes`:75；`test_detection_does_not_read_sessions_before_scope_confirmation`:81；`test_changed_candidate_cannot_trigger_authorized_readability_probe`:94。 |
| `backend/tests/unit/wechat_cli/test_setup_probe.py` | `test_readable_account_requires_metadata_and_matching_identity_afterwards`:23；`test_candidate_detection_only_reads_configuration_status`:50。 |
| `backend/tests/unit/front_sync/test_cli_binding.py` | `test_preview_filters_groups_and_marks_existing_binding`:104；`test_confirm_creates_only_selected_unbound_sessions_with_one_batch_call`:113；`test_confirm_rejects_locator_not_in_private_preview_before_writing`:129。 |
| `backend/tests/integration/persistence/test_sync_scope.py` | `test_default_grant_restart_identity_reuse_and_future_baseline`:39；`test_revoked_and_physically_deleted_are_not_recreated`:60；`test_groups_and_other_owners_remain_outside_scope`:71。 |
| `backend/tests/integration/persistence/test_history_authorization.py` | `test_old_authorization_without_version_requires_confirmation`:45；`test_decline_is_persisted_idempotent_and_grants_nothing`:52；`test_concurrent_accept_and_decline_leave_one_accepted_row`:95；`test_accounts_and_owners_are_isolated`:123。 |
| `backend/tests/integration/server/test_binding_consent.py` | `test_final_confirmation_rechecks_observed_name_without_changing_custom_display_name_contract`:70；`test_concurrent_new_contact_confirmation_rejects_stale_choice_without_partial_scope_or_reads`:96；`test_revoke_waits_for_current_tail_and_prevents_all_later_reads`:160；`test_busy_timeout_retains_authorization_and_requires_explicit_retry`:174（409 `cli_binding_revoke_busy`）。 |
| `desktop/tests/wechat-setup.test.mjs` | :47 旧页拒绝、双击不重复写及旧连接迟到写；:56 迟到读／错误不覆盖新连接；:64 重启后不同账号不算成功；:74 管理窗口及严格输入合同。 |

## 最低合成反例建议（尚未执行）

1. owner A、账号X仅detect：命令序列只有status，无sessions/tail/history，无授权／联系人新增；伪造账号或额外字段返回400，错误不得回显摘要／路径。
2. token X检测后换账号Y：首次复验不符时零列表调用；列表中途变Y则末次复验拒绝且事务零写。列表夹带唯一合成摘要标记，确认响应、DB、事件、日志／模型请求中均不得出现标记。
3. 默认selected、零勾选、刷新新增会话：不扩大选中项、不产生全部授权；取消／失败不残留all_private。旧setup固定all_private实现会暴露此缺口，不能以旧测试通过免验。
4. 同名两个locator只勾一个：只建一个contact/binding；提交前改名须重新确认；同locator已绑其他contact不得改绑。明确all_private后纳入未来私聊，但群聊、另账号、稳定身份冲突不得合并。
5. 撤销或删除X后反复selected→all_private、重启、重复首连：X不复活，排除摘要仍在；owner B同locator独立。并发自动纳入与删除也不得复活。
6. 首连响应丢失后用户关开关／改selected：读回或重试不再开、不重写granted_at、不清排除；旧generation或revision晚结果不改UI、不重启新宿主；取消不把服务端未知结果当已回滚。
7. 无历史版本／旧版本／declined不能触发历史读取；accepted与迟到declined并发只保留一份合法决定。baseline前自动读取的预期必须先裁定，不把显式文件导入算自动同步授权。
8. 开关关闭、撤销、退出与在途列表／正文回执竞争：拒绝新读取并阻止失效结果提交；重开仅恢复当前有效范围。19/20验证消息去重／覆盖，18验证权限投影与移交，不能只测按钮灰态。

## 未完成工具准备及后续入口

- `.scratch/local-app-first-use/issues/01-wechat-preparation-feasibility.md:4` 为open，`:34` 尚未执行；先验证无开发环境的安全准备路线。
- `.scratch/local-app-first-use/issues/03-wechat-component-preparation.md:4` 为open，`:6` 依赖01；`:20` 要求取消、拒绝、重试／中断恢复，`:22` 明确准备不授权正文、换组件需重核账号；`:38` 尚未执行。职责留在原首用01／03，18只接入口与状态，不重复建设。未见具名个人负责人，不能虚构负责人，实施前由主协调明确承接人。
- ADR-095:6／:30 对已有可用工具连接与未配置机器交付作区分；`.scratch/authorized-private-history-sync/issues/08-real-wechat-acceptance.md` 的真实验收不得由本次静态审计替代。默认selected首次连接缺口需与原首用流程协同，不能降低18验收。

## 本轮实际验证与数据影响

只运行 `git ls-tree`、`git show`、`rg`、`sed`、`nl`、只读文件定位脚本；`python` 命令缺失后使用 `python3`，若干候选路径不存在后按树定位，未据错误输出作合同结论。仅新增本文，未add／commit、未改票据、未读真实.env／凭据／聊天／Skill内容／数据库；未运行任何测试、App、微信、模型、安装或下载。日常桌面只允许 `npm run dev`，本审计无需启动；没有打包、push、PR或外部消息。

残余风险：首次selected流程与旧实现不等价；历史自动追溯有当前用户硬边界冲突；账号探测／列表同意／正文授权必须分别验收；工具准备与真实渠道端到端仍未证明。审计完成只表示这些合同、缺口和反例已定位，不表示18或依赖票完成。
