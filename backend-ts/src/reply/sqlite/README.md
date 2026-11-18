# SQLite 助手讨论与运行副本

产品合同以[回复生成](../../../../architecture/current/reply-generation.md)、[运行副本删除](../../../../architecture/current/privacy-deletion.md)为准；本页只保留本模块的接口、装配和故障处理。

`schema.ts` 导出 `discussionMigration(version)`；版本由公共 `storage/sqlite/registry.ts` 固定登记，已发布迁移不修改或重新编号。

本模块拥有 `assistant_discussion`、`discussion_entry`、`reply_request`、`reply_attempt`、`reply_context`、`reply_context_item`、`runtime_copy`、`runtime_context`、`runtime_file`。记忆执行域拥有通用模型调用和实际追踪表；必须组合安装后才能写发言和副本，不能给缺失父表提供空壳或关闭FK。

请求固定 `owner_id/contact_id/discussion_id`、`request_key`、`trigger_entry_id` 和身份依据。手动依据引用联系人域的 `manual_confirmation`；自动依据引用同contact绑定和verification。请求先插入、触发用户发言随后插入，在同一短事务内由延迟FK完成闭环。`reply_attempt` 的 `lease_token/accepted_data_generation/accepted_discussion_generation/accepted_source_revision` 必须在每次写入复验。删除后旧请求不得换ID复活。

`reply_context` 的 request 分支必须关联真实 `request_id/attempt_id`，rebuild 分支两者均为 NULL。基础 context 保存消息与 capture_record、同讨论 entry 和 Skill 修订；候选域通过独立的类型化快照接入记忆、文档与选稿，由各写者同事务核验实际版本及完整来源。长期表达偏好不从一次性回复要求静默形成。

记忆共享调用表接 reply 分支的合同：`model_operation.reply_request_id`；`model_call.reply_attempt_id/reply_context_id`；`execution_event.reply_attempt_id/originated_call_id`；`execution_input.reply_context_id/context_item_no`。模型发言引用真实成功call及其 `kind='assistant_message'` 的实际事件；事件JSON `text` 与发言正文完全一致，call所属attempt.request和operation.reply_request均须等于发言请求。候选编辑不写讨论模型发言。

`runtime_copy` 在创建目录前保存副本ID、官方SessionId、不可复用定位、讨论代次及contact资料代次。`address_json` 为统一删除的完整 ManagedAddress（含父目录身份）；只有登记真实身份后才可dirty/写DSH。业务提交、官方flush/close、事件摘要与配置/来源核验分别完成后才ready。dirty/preparing不能直接恢复。

`runtime_file` 是关闭排空后完整清单，包含根目录及全部子目录/文件的独立身份。`manifest_complete` 不能由目录不存在推定；无身份准备件须通过同一创建意图核验后显式登记。删除fence后只准登记关闭产生的清理清单，不重新开放DSH writer。沿统一删除同一 operation的typed文件目标及holderKeys清理，文件I/O位于事务外。

`runtime_file` 仅是 `runtime_copy.expected_identity` 的完整子项文件身份索引，辅助统一删除生成typed `deletion_target`；用户资料与来源删除的唯一operation、计划修订、runner及最终复核均沿05。Skill读取失败仅回收本次未提交的临时执行副本：先在原副本登记 `blocked + skill-discard:<attempt>` 持久意图，冻结current指针与原清单；沿每项既有身份逐项擦除并登记cleared，全部复核后才移除context及置deleted。启动先继续该意图，不恢复执行，也不扩大到已提交副本、原Skill目录或其它业务资料。副本状态沿统一设计的preparing/dirty/ready/blocked/deleting/deleted；退役表示不再由current_runtime_id指向，不新增状态。

`deletion.ts` 导出 `collectDiscussionDeletionImpact(tx,operation)` 无正文影响清单，共享调用／追踪清理复用同一实际输入闭包。来源通过真实context材料反查请求、后续entry引用及同一运行副本后续纳入位置，包含非current副本。注册次序为通用模型/追踪域、本讨论域、identity、skill_metadata。讨论域在跨域模型FK仍被引用时保持blocked，不清空未释放的父件。

精确讨论用 `discussionDeletionAuthority`，组合以 `withDiscussionDeletionAuthority(existing)`；`discussionDeletionRequiredDomains` 必须合入requiredDomains。contact_history仅清与聊天来源有关的请求和副本，独立user-only讨论及其无正文手动归属依据保留；旧确认仍受contact资料代次阻止新写入。联系人/账号删除继续清这些依据。

空闲分段只在 `discussion.begin` 的身份、幂等和受理事务内执行；不提供单独预选或分段的写入口。回看、目录与明确新开／继续沿各自正式入口执行。

请求幂等命名空间固定为 `databaseId:discussion.begin`，request_key在同owner内唯一。相同key重送仅回查原contact/原讨论/原请求，跨contact、正文冲突、取消或失效均拒绝；空闲分段前先检查该键，不能因十二小时或换段重送模型。统一删除以相同 namespace/key写删除墓碑，来源闭包清理后仍不可重受理。

删除fence先把受影响实际发言从available不可逆转为cleared，擦除正文并断开实际call/event引用（请求身份保留到后续清行）。available状态始终要求真实成功call和原始事件，不允许更新旧正文；cleared不能复活。这样共享调用域可在排空后先清追踪，讨论域随后清请求闭环，blocked期间产品读口也不会返回旧正文。文件目标仅在官方所有者排空、完整manifest登记后产生，不能提前冻结活动writer的旧清单。

手动确认通过 `(owner_id,contact_id,confirmation_id)` 真实复合外键固定同联系人；context 身份、冻结修订和实际材料不可原地改写。每次出站／提交复验请求依据及当前授权。前台名称匹配与用户选择如何取得联系人上下文见现行领域合同；工具配置账号元数据不冒充前台登录账号的独立认证。

## 正常业务端口与验证边界

`SqliteDiscussionService` 提供list/view/newDiscussion/continueDiscussion/begin/trace；回看与继续不触发模型。`SqliteDiscussionRuntime` 将真实官方副本、活动holder、目录创建意图和完整关闭清单串联；`SqliteDiscussionTurns` 接受一次明确的联系人与文字请求，冻结实际entry及显式选取的同联系人message，执行有界讨论，并与候选生成共用 `generation.ts` 的官方 DSH 执行、Skill 目录按需读取和物理调用预算。候选另负责冻结编号材料、依据及结构输出；两种动作不另建模型账本。新请求均拒绝显式选包，历史材料按 ADR-193 保留原只读合同。

`SqliteDiscussionSkillProtection` 的assertCurrent、recordSelection、recordInput均通过具名动作复验真实call/attempt/context/来源；实际Skill输入写事务同时requireSkillRun及requireSkillRevision。`selected`事件不产生loaded输入。实际读取经 Skill 域官方 provider，原目录不改写、不复制为新来源。

`discussionCallDeletionDomain`（model-deletion.ts，id为discussion_calls）仅管理共享调用表的discussion producer，不建第二套调用表。prepareCall在operation_scope登记真实联系人；来源/讨论清理封存无正文不可复用回执，联系人/账号清对应调用。必需域包括discussion_calls和discussion；建议次序discussion_calls、memory_extraction、discussion、history、identity、skill_metadata，其他领域按实际FK加入。未知在途发送在fence后保留unknown，取消不宣称未发送。

`SqliteDiscussionHttp` 复用原assistant-sessions目录、新开、读取与resume路由，返回显式SQLite实际entries；DELETE 始终交统一删除。可选turns提供显式entries POST，未配置模型时拒绝。HTTP不接受owner、SQL、文件定位或SDK身份；恢复核验后再次读取业务权威，不返回旧正文快照。

运行attempt还保存受理时database runtime_id与epoch，存储重开后旧业务租约不可继续冻结输入、登记副本或提交。副本preparing_attempt_id通过真实FK固定创建者；正常身份落库必须复验同一attempt，关闭/恢复清理仅能登记身份为blocked或deleting，不改current。来源闭包在尚无runtime_context时仍经request→attempt→preparing copy覆盖准备目录。

run获取阶段纳入同一pending排空；close开始后拒绝新获取，等待已进入的SQLite读取与实际DSH释放结算。公开HTTP回看与继续只核验业务资料及切换当前讨论，不为此打开DSH或调用模型；用户明确生成时，才用当前模型与Skill资格计算摘要并复验旧副本，不能把副本自己保存的摘要当作当前配置证明。

普通讨论的旧边界核验与继续执行共用本次独占所有者和DSH驱动；核验失败须先真实排空旧所有者，才可按原规则另建合法副本，开始执行后的失败及关闭失败均不自动重试。执行后仍关闭原驱动，再用独立驱动核验最终持久边界并登记完整文件清单，最后才标记ready。同一合成SQLite、官方DSH与环回模型的重开继续用例中，恢复轮的所有者关闭／清单登记各由两次降为一次，`runtime.inspect`由四次降为三次；SessionId、实际发言和模型请求次数保持，不据此推断整体回复耗时。

`createSqliteDiscussionHost` 只拥有本领域 service/runtime/http，接收宿主唯一的 provider 与 arbiter。关闭先停受理，取消并等待尚未进入副本管理器的整轮请求（包括受理、冻结及失败清理），再关闭真实副本并等待所有 HTTP 权威读取；公共宿主只能在这些步骤成功后关闭 SQLite，释放失败保留同操作重试条件。

## 正式开发宿主接线

正常 SQLite profile 加载共享模型服务，`sqlite-host-plugin.ts` 装配联系人、历史、记忆、文档、候选、Skill 与删除模块；迁移与动作由公共 registry 统一组合。讨论服务接收同一 provider／arbiter 和共享 ActiveHolders，不创建并行账本或另一套模型客户端。

`sqlite-model-config`只从已确认env指针读取模型白名单；`sqlite-model-runtime`创建唯一ModelHost、arbiter和provider，记忆提取只消费共享对象。discussion用真实dispatch/commit预算与同一arbiter；出站计费仍由共享调用账本的具名事务核验，未知查询合并两种producer的真实调用键，不虚构ModelLedgerReceipt.purpose或第二账本。旧实例attempt在正常启动标记不可续写，已发送状态保留unknown，准备调用记failed，不为恢复重新发送。

宿主关闭先停新工作，逐域排空；任一业务或模型关闭未证明成功时不关SQLite。journal末写失败后可沿原关闭续清，只有真实内核锁释放才标结束。来源删除started事件同步撤正文并锁定读取，DELETE回执丢失不能让旧快照继续留在界面；随后权威读取才能恢复仍合法内容。

锁定的DSH、llm及deepseek adapter均为0.2.1-rc.2。官方`dsh-llm/lib/types/types.d.ts:131`及`:434`明确适配器异常以终止`finish.reason.failure`返回；`LlmFailure`在`:26`提供固定code及可选HTTP status。讨论在拒绝非stop终止前提取这些分类，随原有预算receipt保存；固定白名单再次过滤，不保存message、requestId、cause或任意供应商文本。环回HTTP500和断连接分别验证SERVER/status500及TRANSPORT，保守unknown结算和禁止自动重试不变；此修复不能追回旧存档已经丢失的错误详情。

## Skill 与验证入口

Skill 发现、默认启用、不可变修订、多包加载和失败清理的产品合同见[Skill 库](../../../../architecture/current/skill-library.md)，实现端口见[SQLite Skill](../../skills/sqlite/README.md)。官方 Loader、scope 与资源释放依据集中在 [DSH.md](DSH.md)。

模块回归入口包括 `sqlite-discussion-integration.test.mjs`、`sqlite-discussion-generation.test.mjs` 和 `sqlite-reply-skill-loop.test.mjs`。按实际改动选择；合成 provider、正常 profile、真实 App 与模型效果分别报告，不能沿用旧轮次通过数字。

阶段实现和旧验收记录已移至[开发历史](../../../../docs/history/backend-development-history.md)；历史数字不表示当前版本通过。
