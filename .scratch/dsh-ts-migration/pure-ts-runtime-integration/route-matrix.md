# 纯 TS 公开运输盘点（工程冻结，非25签收）

开关：`NOTALONE_HOST_RUNTIME=typescript`；默认 `legacy` 保留旧兼容臂。三项 reply/extraction/history 缺省补 TS，显式 Python／旧 remote／permit 配置冲突拒绝。产品仍使用官方 profile。

| 公开业务入口 | TS 承接与当前证据 |
| --- | --- |
| `/api/runtime/status`、`shutdown` | 无 Legacy ready／正常停止；OS整树零Python；真实 launcher 合成通过 |
| setup status/initialize/recover-owner/credentials/official-deepseek | 原 HostStorage；原身份和原库不变；旧臂相关回归通过，纯TS首片status通过 |
| contacts、messages、sources、relationship-overview、manual-confirmation | 原 ContactContext＋原事务锁；无Legacy初始激活；纯TS列表/确认通过，原相关12项通过 |
| memories／memory-candidates／owner-memory、expression-preferences | 原 MemoryService／PreferenceService＋原结构核验／管理租约；原handoff回归通过，完整新臂矩阵待独立验收 |
| skills 管理与 skill-learning | 原 SkillHost/Library/Learning；独占初始同步不调用Python；原Skill相关回归通过，新臂UI待根验收 |
| imports preview/commit、tasks status/run/retry/list/stop/recover | 原 HistoryImportApi／TaskApi／BusinessTaskApi＋唯一TSworker；task stop/公开重读通过 |
| message.created、sync.status_changed、task.progress SSE | 原 id/type/owner/contact/time/payload DTO；有界提示和慢消费者断开；公开同步消息及任务终态通过 |
| `/api/reply/generate` | 原 ReplyGenerationService；官方provider仅本机假SSE；持久重放和撤销拒绝通过 |
| contacts/:id/replies/:request/evidence | 原来源／讨论／Skill守卫和保存结果投影；公开读取实际引用与候选通过 |
| assistant default/new/list/read/input/select/delete、候选版本／选择／carry | 原 AssistantDiscussionService；默认讨论/重开、会话read_part／read_id哈希CAS、候选receipt编辑及page／through公开链路通过；完整App矩阵待根 |
| assistant replies/prepare、replies | 新 lifecycle 补真实A锚点后复用原回复服务；经产品launcher prepare零模型→generate持久→重开通过 |
| assistant replace/retry-interrupted/continue、格式、异步准备／取消／恢复 | 独立生命周期模块已冻结并接入recover/drain、verified scope及runInScope；其12项及既有31项GREEN。运行中旧C保守报recovery_unconfirmed，不盲重放 |
| assistant explorations open/read/stop/confirm/answer/prepare-* | 原 ExplorationService及原公开envelope核验；已确认探索→A准备/生成由同一lifecycle桥接，未公开私有generation_command |
| contact/owner layered-memory read/enable/refresh/disable/delete/pause/continue/quality/fact等 | 管理模块已冻结，全部matches优先旧handler；同一taskControl／qualityStore、原算法／runner；管理13项+原39项GREEN，宿主未配置拒工作、公开disable均通过 |
| 自动分层维护与有效期 | 唯一PG LISTEN＋350ms合并＋nextDueAt及30秒漏通知补查；原管理器持久资格／目标核验，已有暂停／失败不复活；真实合成PG通知及关闭排空通过 |
| `/api/layered-memory/*` 质量输入／审核／run／execute／report | 同一provider、SDK runtime、原Unix许可／PG authority、原问题总账、Store唯一source_ref helper；纯TS正式launcher公开六phase8次实际HTTP与累计账本一致，重开报告保持、不重放、不发布产品记忆 |
| setup/wechat、sync scope/history-authorization/cli-sessions/cli-bindings | 原 WechatScopeApi；revoke先停收/drain→原绑定事务→按代际恢复；公开revoke通过 |
| sync status/enable/disable/check/priority/backfill pause/retry | 原 SyncIncrementalApi/Engine＋PureTsSync寿命与原DTO；授权写入、去重、disable/check停读通过 |
| sync foreground/observe | 原 TS 前台定位／原生probe；权限与局部名称OCR边界保持；我未操作真实桌面 |
| sync follow-smoke status/start/stop/interrupt/checkpoint | 同一增量引擎诊断控制，内存元数据；状态及关闭拒绝start通过；`last_valid_observation`目前为未知null，无正文读取证明 |
| sync confirm/confirm-pending | 当前旧DSH已因scope移交稳定503 `wechat_scope_owned_by_typescript`；新臂保持同错误，桌面当前使用cli-bindings/confirm，无静默旧回退 |
| runtime contact-context/memory-management handoff | 纯TS无Python目标；原锁／drain核验保留，显式请求Python返回不可用 |
| 跨域来源／讨论／联系人／owner删除 | 原 CrossDomainDeletionService，原缓存／世代／追踪路径；事件提示同步清理，原相关回归通过；新臂矩阵待独立验收 |

本聊天未读取真实业务配置、数据或原资料；没有实际供应商调用、App／微信操作、Git index／提交、push、PR或打包。桌面启动/诊断/受管迁移另由根安排的可见聊天实施；最终性能与实际App证据须等待完整源码冻结。
