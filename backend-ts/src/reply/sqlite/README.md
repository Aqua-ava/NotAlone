# SQLite 助手讨论与运行副本（实施11）

`schema.ts` 导出 `discussionMigration(version)`，暂号由集成方重新分配，已发布迁移不修改。

11拥有 `assistant_discussion`、`discussion_entry`、`reply_request`、`reply_attempt`、`reply_context`、`reply_context_item`、`runtime_copy`、`runtime_context`、`runtime_file`。07拥有通用模型调用和实际追踪表；必须组合安装后才能写发言和副本，不能给缺失父表提供空壳或关闭FK。

请求固定 `owner_id/contact_id/discussion_id`、`request_key`、`trigger_entry_id` 和身份依据。手动依据引用02的 `manual_confirmation`；自动依据引用同contact绑定和verification。请求先插入、触发用户发言随后插入，在同一短事务内由延迟FK完成闭环。`reply_attempt` 的 `lease_token/accepted_data_generation/accepted_discussion_generation/accepted_source_revision` 必须在每次写入复验。删除后旧请求不得换ID复活。

`reply_context` 的 request分支必须有真实 `request_id/attempt_id`，rebuild分支两者均NULL。当前材料仅开放真实message+capture_record、同讨论entry及实际Skill修订。候选/选择、偏好与文档分支由后续票增量扩展，不预建不存在的父表。运行副本通过 `runtime_context` 记录所有实际纳入的context，不能只存展示依据。

07接reply分支的合同：`model_operation.reply_request_id`；`model_call.reply_attempt_id/reply_context_id`；`execution_event.reply_attempt_id/originated_call_id`；`execution_input.reply_context_id/context_item_no`。模型发言引用真实成功call及其 `kind='assistant_message'` 的实际事件；事件JSON `text` 与发言正文完全一致，call所属attempt.request和operation.reply_request均须等于发言请求。候选编辑不写讨论模型发言。

`runtime_copy` 在创建目录前保存副本ID、官方SessionId、不可复用定位、讨论代次及contact资料代次。`address_json` 为05完整ManagedAddress（含父目录身份）；只有登记真实身份后才可dirty/写DSH。业务提交、官方flush/close、事件摘要与配置/来源核验分别完成后才ready。dirty/preparing不能直接恢复。

`runtime_file` 是关闭排空后完整清单，包含根目录及全部子目录/文件的独立身份。`manifest_complete` 不能由目录不存在推定；无身份准备件须通过同一创建意图核验后显式登记。删除fence后只准登记关闭产生的清理清单，不重新开放DSH writer。沿05同一operation的typed文件目标及holderKeys清理，文件I/O位于事务外。

`runtime_file` 仅是 `runtime_copy.expected_identity` 的完整子项文件身份索引，辅助05生成typed `deletion_target`；用户资料与来源删除的唯一operation、计划修订、runner及最终复核均沿05。Skill读取失败仅回收本次未提交的临时执行副本：先在原副本登记 `blocked + skill-discard:<attempt>` 持久意图，冻结current指针与原清单；沿每项既有身份逐项擦除并登记cleared，全部复核后才移除context及置deleted。启动先继续该意图，不恢复执行，也不扩大到已提交副本、原Skill目录或其它业务资料。副本状态沿统一设计的preparing/dirty/ready/blocked/deleting/deleted；退役表示不再由current_runtime_id指向，不新增状态。

`deletion.ts` 导出 `collectDiscussionDeletionImpact(tx,operation)` 无正文影响清单，07通用调用/追踪清理复用同一实际输入闭包。来源通过真实context材料反查请求、后续entry引用及同一运行副本后续纳入位置，包含非current副本。注册次序为通用模型/追踪域、本讨论域、identity、skill_metadata。讨论域在跨域模型FK仍被引用时保持blocked，不清空未释放的父件。

精确讨论用 `discussionDeletionAuthority`，组合以 `withDiscussionDeletionAuthority(existing)`；`discussionDeletionRequiredDomains` 必须合入requiredDomains。contact_history仅清与聊天来源有关的请求和副本，独立user-only讨论及其无正文手动归属依据保留；旧确认仍受contact资料代次阻止新写入。联系人/账号删除继续清这些依据。

请求幂等命名空间固定为 `databaseId:discussion.begin`，request_key在同owner内唯一。相同key重送仅回查原contact/原讨论/原请求，跨contact、正文冲突、取消或失效均拒绝；空闲分段前先检查该键，不能因十二小时或换段重送模型。05以相同namespace/key写删除墓碑，来源闭包清理后仍不可重受理。

删除fence先把受影响实际发言从available不可逆转为cleared，擦除正文并断开实际call/event引用（请求身份保留到后续清行）。available状态始终要求真实成功call和原始事件，不允许更新旧正文；cleared不能复活。这样07可在排空后先清追踪，11随后清请求闭环，blocked期间产品读口也不会返回旧正文。文件目标仅在官方所有者排空、完整manifest登记后产生，不能提前冻结活动writer的旧清单。

手动确认通过(owner_id,contact_id,confirmation_id)真实复合FK固定同联系人；context身份、冻结修订和实际材料不可原地改写。运行中每次出站/提交继续复验请求绑定或手动确认资格；只有已核验的前台binding证明可用于自动身份，渠道元数据建联本身不替代前台会话确认。

## 正常业务端口与验证边界

`SqliteDiscussionService` 提供list/view/newDiscussion/continueDiscussion/begin/trace；回看与继续不触发模型。`SqliteDiscussionRuntime` 将真实官方副本、活动holder、目录创建意图和完整关闭清单串联；`SqliteDiscussionTurns` 接受一次明确的联系人与文字请求，冻结实际entry及显式选取的同联系人message，执行无Tool、至多一次物理调用的讨论。候选生成、候选编辑和长期偏好由其他票负责。

`SqliteDiscussionSkillProtection` 的assertCurrent、recordSelection、recordInput均通过具名动作复验真实call/attempt/context/来源；实际Skill输入写事务同时requireSkillRun及requireSkillRevision。`selected`事件不产生loaded输入。实际读取经14官方provider，原目录不改写、不复制为新来源。

`discussionCallDeletionDomain`（model-deletion.ts，id为discussion_calls）仅管理07共用表的discussion producer，不建第二套调用表。prepareCall在operation_scope登记真实联系人；来源/讨论清理封存无正文不可复用回执，联系人/账号清对应调用。必需域包括discussion_calls和discussion；建议次序discussion_calls、memory_extraction、discussion、history、identity、skill_metadata，其他领域按实际FK加入。未知在途发送在fence后保留unknown，取消不宣称未发送。

`SqliteDiscussionHttp` 复用原assistant-sessions目录、新开、读取与resume路由，返回显式SQLite实际entries；DELETE始终交05。可选turns提供显式entries POST，未配置模型时拒绝。HTTP不接受owner、SQL、文件定位或SDK身份；恢复核验后再次读取业务权威，不返回旧正文快照。

当前后台组合已用真实SQLite Worker、07共同producer、官方DSH/Adapter、环回SSE及真实受管目录验证；无SQLite业务端口替身的正常/重开/Skill/来源/账号/在途取消与故障窗口见sqlite-discussion-integration.test.mjs。早期driver/generation测试中的业务端口替身仍只用于局部机制，不冒充正式profile、外部模型质量或实际桌面验收。公共宿主、桌面页面及受控外部模型验收继续单列记录。

运行attempt还保存受理时database runtime_id与epoch，存储重开后旧业务租约不可继续冻结输入、登记副本或提交。副本preparing_attempt_id通过真实FK固定创建者；正常身份落库必须复验同一attempt，关闭/恢复清理仅能登记身份为blocked或deleting，不改current。来源闭包在尚无runtime_context时仍经request→attempt→preparing copy覆盖准备目录。

run/inspect获取阶段纳入同一pending排空；close开始后拒绝新获取，等待已进入的SQLite读取与实际DSH释放结算。HTTP恢复核验从当前正常模型配置、当前Skill资格及业务选择重新计算预期摘要，不能把副本自己保存的摘要当作当前配置证明。

`createSqliteDiscussionHost` 只拥有本领域 service/runtime/http，接收宿主唯一的 provider 与 arbiter。关闭先停受理，取消并等待尚未进入副本管理器的整轮请求（包括受理、冻结及失败清理），再关闭真实副本并等待所有 HTTP 权威读取；公共宿主只能在这些步骤成功后关闭 SQLite，释放失败保留同操作重试条件。

## 正式开发宿主接线

`registry`保留已发布1至6版，按总调度共同基线追加7 discussion、8 memory、9 execution，具名动作及删除域实际注册。官方SQLite profile加载共享LLM服务；明确的`discussions`、`memory`能力分别启用HTTP入口，未配置模型仍可回看和明确继续。领域清理所有者始终初始化，以便能力未启用时也能清理旧副本。

`sqlite-model-config`只从已确认env指针读取模型白名单；`sqlite-model-runtime`创建唯一ModelHost、arbiter和provider，07只消费共享对象。discussion用真实dispatch/commit预算与同一arbiter；socket计费仍由07具名事务核验，未知查询合并两种producer的真实调用键，不虚构ModelLedgerReceipt.purpose或第二账本。旧实例attempt在正常启动标记不可续写，已发送状态保留unknown，准备调用记failed，不为恢复重新发送。

宿主关闭先停新工作，逐域排空；任一业务或模型关闭未证明成功时不关SQLite。journal末写失败后可沿原关闭续清，只有真实内核锁释放才标结束。来源删除started事件同步撤正文并锁定读取，DELETE回执丢失不能让旧快照继续留在界面；随后权威读取才能恢复仍合法内容。

正式launchDsh/profile已验证两个合成联系人、非空用户发言、隔离、新开、明确继续和重开不调用模型；共享模型装配、关闭失败恢复及实际桌面控制器均有独立回归。实际App和受控外部模型验收继续单列，当前证据不等同产品整体或真实渠道质量验收。

锁定的DSH、llm及deepseek adapter均为0.2.1-rc.2。官方`dsh-llm/lib/types/types.d.ts:131`及`:434`明确适配器异常以终止`finish.reason.failure`返回；`LlmFailure`在`:26`提供固定code及可选HTTP status。讨论在拒绝非stop终止前提取这些分类，随原有预算receipt保存；固定白名单再次过滤，不保存message、requestId、cause或任意供应商文本。环回HTTP500和断连接分别验证SERVER/status500及TRANSPORT，保守unknown结算和禁止自动重试不变；此修复不能追回旧存档已经丢失的错误详情。


## 2026-10-31：DSH 回复 Skill 接入验收

四项本地任务已组合完成：受控发现与读取、官方工具自动选择、读取失败安全继续、同修订静态资源读取。新包在管理页先显示目录名和待启用状态；明确启用后建立首个有效修订；已启用包自动技术更新，停用保持。SQLite 沿用原结构版本，没有迁移真实资料或改动用户 Skill 原目录。

自动检查使用 Node v24.19.0，DSH 固定 `0.2.1-rc.2`：

- 后台相关最终命令：`node --test test/sqlite-discussion*.test.mjs test/sqlite-reply-candidates*.test.mjs test/sqlite-reply-skill-loop.test.mjs test/sqlite-skill*.test.mjs test/skill-files.test.mjs test/sqlite-host-launch.test.mjs`，152/152 通过；后台与桌面 `pnpm run typecheck` 通过。
- 桌面相关命令：`node --test tests/sqlite-reply-candidates.test.mjs tests/sqlite-reply-candidate-bridge.test.mjs tests/development.test.mjs tests/sqlite-development.test.mjs tests/fixed-memory-development-network.test.mjs`，27/27 通过，包括真实 React、无头浏览器和 IPC 边界替身。
- 后台完整 `pnpm test` 曾执行 1090 项，1054 通过、36 失败。35 个失败已在任务前固定基线 `ae5ae36a` 的隔离工作树复现；另一项为本次自动发现语义改变后的旧宿主断言，已修正并纳入上述最终通过检查。基线只重跑对应 9 个文件，75 项中 40 通过、35 失败，工作树已清理。
- 桌面完整 `pnpm test` 在测试分类检查被既有 `sqlite-first-session-regression.test.mjs` 未登记挡住，未声称全量通过。该文件及缺登记状态均存在于任务前基线；本次未修改它们。

Computer Use 实际操作隔离的 `pnpm run dev --user-data-dir` App，使用正常 SQLite/profile/模型参数，仅供应商由严格网络守卫重定向到环回合成 SSE。确认 Electron 自身的 preload/spawn 守卫收据后，检查自动正文、正文后辅助资料、无 Skill、读取失败继续及提示；通过输入小窗生成并手动编辑保存候选第 2 版。另通过管理页验证自动发现、明确启用、修订 1 自动更新到 2、停用及刷新后保持停用；查看了实际布局与编辑控件。最终降级候选没有旧的恢复受阻误报。共 10 次合成物理请求，网络审计同为 10 条；无真实模型、微信正文读取或外部消息发送。

独立 Standards 与 Spec 两轴审查的问题均已修复并复验，最终各 0 项未解决。补充回归覆盖 helper 不可用、120KB 合法资源、100 个资源/深目录/低 FD、provider 打开前与 Agent setup 时失效、部分加载后失效、授权撤销、取消、逐次用量、清理中断恢复，以及来源/联系人/账号删除接管技术清理。全部临时运行只来自合成资料，原授权与人工发送边界保持。

限制：本机原生只读器验证范围为 arm64/macOS 15；未制作或运行发布包，未验证其他平台或真实模型回复质量。实际 App 的消息提醒仍因合成环境未连接真实渠道而显示中断，该状态不影响本次受控回复验收。
