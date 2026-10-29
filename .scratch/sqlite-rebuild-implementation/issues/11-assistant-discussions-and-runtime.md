# 11：助手讨论与 DSH 副本

Triage: ready-for-agent
State: resolved
Type: task
Parent: [数据库重建](../../sqlite-database-rebuild/spec.md)、[同步与记忆规则](../../sync-memory-behavior/spec.md)
Blocked by: [02 联系人绑定与同步授权](02-contact-binding-and-read-grants.md)；[05 统一来源删除与清理流程](05-source-deletion-and-cleanup.md)

> 2026-10-29 经总调度明确授权实现并完成定向验收；本票只处理助手讨论与受管副本。[任务索引与共同约定](../planning.md)。

## 交付行为

用户可以在已确认联系人下查看、继续已有助手讨论。业务发言与 DSH 运行副本分别持久化，分段、重开、释放及来源删除具有可核验状态；运行副本不能成为独立绕过来源删除的内容副本。

## 验收条件

- [x] 讨论、发言、请求和运行副本具有真实的用户及联系人关系约束；不能更换讨论的联系人归属，也不能由同一用户身份推导跨联系人可读。
- [x] 沿用已确认的讨论分段规则；新分段与明确继续旧讨论可区分，重开不隐式继续旧讨论或发起新的模型请求，不预建旧发言编辑／分支平台。
- [x] 实际用户／助手发言的顺序和来源可回查；模型发言关联本次真实请求及调用，不复制可编辑候选正文来伪造讨论发言。
- [x] DSH 通过官方 profile、公开插件与生命周期接入，业务数据库保存可见历史主记录；不得修改核心、另造 Harness 或臆造会话删除 API。
- [x] 副本创建前持久保存独立副本身份、官方 SessionId、固定联系人范围、写入代次及受管保留定位；preparing 时目录尚未建立可无预期身份，允许写入前必须登记真实目录身份。陌生目录或会话身份冲突不得接管。
- [x] 业务提交、副本 flush／close 与 ready 状态分开记录；只有实际事件边界、配置摘要、来源资格和业务提交均核验后才将副本置 ready，不能把进程内 symbol／revision 当跨重启证明。
- [x] 运行副本记录真正纳入的每份上下文及其来源，包括展示依据之外的实际输入；来源删除能反查所有当前、退役和重建副本，而非只查当前路径。
- [x] 重开先检查当前实例、维护／删除状态和副本资格；dirty／preparing 副本不能直接恢复。无法核验时明确受阻，只能从仍合法业务资料在后续明确请求中重建，不为核验调用模型。
- [x] 来源或讨论清理先持久封禁旧写入，等待 Agent 和读写所有者释放，再在事务外按已登记身份清理完整受管副本，最后复核数据库及活动引用；close 的末尾写入须纳入排空，释放错误或超时不能记清理完成。
- [x] 在创建目录前后、真实身份落库前、业务提交后、flush／close 期间及删除前后注入失败；重开只沿原清理操作续清，不扩大路径、不误删同定位的新身份，也不将物理文件操作放入长数据库事务。
- [x] 请求重送及迟到回调保持原请求、租约和写入代次校验；被取消或来源失效的回调不能新建讨论内容或重新登记已删除副本。
- [x] 现有讨论界面与正常业务入口能展示分段、继续、加载失败和恢复受阻状态；日志不包含聊天正文、密钥、原始路径或可复用私密材料。

## 验证与证据

通过正常讨论服务、正式 profile 和既有桌面入口，用两个联系人及多段合成讨论验证保存、重开、明确继续和范围隔离。使用真实受管临时目录检查释放末写、身份冲突、活动引用与同操作恢复；外部模型仅在已核验授权和配置下有界执行，模拟结果与真实质量分开报告。先运行最小生命周期用例，再覆盖相关副本／删除模块；本轮实际执行及有效复用的证据见下方 Answer。

### 实施记录（2026-10-29）

- 完整后台、正式 profile、公共桌面接线及删除合同已在 `0c90cba4` 提交；`fc86a0f9` 实际合入总调度 `af98a3ba`，保留已发布迁移与共同调用表祖先关系。
- 两位隔离合成联系人经正式 profile 验证读取、跨联系人404、新开、明确继续及重开不发模型请求。运行副本、来源删除、真实SDK释放末写、故障恢复和共享关闭均已有定点回归，原有有效验证复用。
- 经总调度确认的独立工程小批 `sqlite-discussion-lifecycle-11` 上限3次发送前预留、15分钟、256输出；首个请求409，预留已用1、实际HTTP次数及实耗未知，调用保留unknown，只有用户发言而无助手发言。按停止合同结束，不重试、不续期、不退款，不归因供应商故障，不宣称模型质量或07结构化提取恢复。
- 本地HTTP500最小用例复现并修复SDK终止错误分类丢失：只保留白名单kind/code/status/dispatch，随原预算receipt保存；不保存供应商错误正文、请求编号或因果链。32个相关用例、后端类型检查通过；Standards与Spec独立审查未决0。旧外部失败详情不可追回。
- 小批后用正常 profile 不出站验证：原用户发言保留、dirty副本恢复受阻、新段为空、明确继续与重开不追加预留；两次shutdown均200且确认进程退出。该关闭证据是后续独立验证，不冒充首轮原始回执。
- 总调度另行授权本机环回供应商工程资料：通过正常entries API、官方DSH/Adapter/SSE与真实SQLite生成两位合成联系人、三段及三条非空助手发言，各自具有真实唯一成功call和settled回执，未直接插成功行或复制候选。生成装配替换了供应商transport和凭据，独立arbiter；最终保留夹具统计为3次本机请求，不冒充准备阶段或全部历史总数，不耗真实问题账本。
- 未改正式launchDsh/profile重开上述工程资料，三段entry身份、顺序、正文摘要、request/call关联完全一致，runtime ready、跨联系人404，模型请求增量0，shutdown200及进程退出通过。独立Spec窄审未决0；此处正式profile覆盖重开回读，本机合成SSE不能证明外部模型生成或质量。
- 最小公共生成正例另行完成：复用已有固定transport测试工具，仅把Messages/strict目标映射到事先确认的127.0.0.1并拒绝外部连接，未改正式launchDsh/profile/sqlite-host共享ModelHost、provider、arbiter及业务提交。认证entries POST200，实际本机HTTP1次；精确request/attempt committed、唯一call succeeded/settled、真实assistant event与entry关联、完整manifest及ready边界、shutdown200及进程退出均通过。11 units为合成usage；真实问题账本前后不变。独立Spec公共接线窄审未决0；此段作为App资料第4段，前三段helper来源仍分列。
- 实际开发App初验已显示公共生成段的非空用户／助手发言；甲的讨论草稿在切乙时撤下，乙仅显示自己的发言。切回甲发现合法讨论被旧候选恢复失败拖成failed，同一后台甲乙目录／发言GET均200/ready；该界面失败现场已保留。
- `c17cc33f`以真实ReplySession的甲乙甲最小红例修复旧候选端口耦合：显式SQLite discussionEntries在读回及会话切换时跳过旧candidate/selections，普通独立草稿与来源校验仍沿原流程。2项SQLite回归、14项相关旧流程／来源测试、desktop类型通过，独立Standards与Spec未决0；App已正常退出，dev:status为stopped/pids=[]后释放桌面。
- 本票6项已登记（safe-node4、headless2），实际合入中央登记提交`2f44ce6c`并采用root完整清单，无重复。`test:inventory`通过：safe-node141、headless27、isolated-http-pg6、native9、app11、historical1；此命令只核验登记，不替代16／32项回归或实际App。
- 在`b95e4d56`的两套隔离合成库完成实际开发App复验：A→B→A正确恢复且草稿撤下；旧段只读查看保持current，明确继续才切current；新段真实为空；删除非空旧段立即撤正文，刷新后其余三段仍可见。原外部unknown库显示恢复受阻和保存的user，无assistant、未自动重放。未点击生成，未新增模型预留。
- 退出后只读核验：被删讨论为deleted/current_runtime=null，发言、上下文及副本均0；统一删除operation completed、17个target全部cleared且私密定位及payload清除；各项check passed或not_applicable。保留三份ready副本的18个manifest项与磁盘逐项一致，无多余或缺失文件；两库integrity及外键均通过。原unknown仍为1条user、1个unknown调用及dirty副本；问题账本used=1、round=unknown、已过期，无新增预留。
- 两套App均Cmd+Q正常退出；分别按同user-data-dir查询dev:status为stopped/pids=[]，启动器、监督器、Electron及自有dev进程已退出后立即释放共享桌面。随后实际merge root`569f526`保留07资格修复和语音停用；讨论相关代码无变化，复用本次App、16／32项有效验证，不重启、不新增外部调用。

## Answer

已完成助手讨论主记录、正式DSH运行副本、来源及讨论删除、桌面接线与实际验收。12项条件的对应依据如下；本机合成供应商验证的是工程链路，真实外部模型质量仍无结论。

| 条件 | 结果与依据 |
| --- | --- |
| 1 用户及联系人范围 | 复合外键、不可变触发器及真实HTTP跨联系人404；`sqlite-discussion.test.mjs`、正式profile合成库回读通过。 |
| 2 新段与明确继续 | 保留既有分段规则；`sqlite-discussion-integration.test.mjs`及实际App验证查看不改current、明确继续、新开空段且不请求模型。 |
| 3 真实发言与来源 | 正常entries API经官方DSH真实event提交，唯一request/call/assistant event关联与顺序可核验；公共profile环回生成和重开读回通过，未复制候选伪造。 |
| 4 官方扩展与生命周期 | 正式launchDsh/profile、公开插件、共享ModelHost/provider/arbiter；`sqlite-discussion-host.test.mjs`、`sqlite-discussion-dsh.test.mjs`及公共生成正例通过，无核心修改或虚构删除API。 |
| 5 预登记与目录身份 | 独立副本身份、SessionId、范围及代次先保存，实际目录身份在允许写入前登记；真实换身份、preparing及陌生目录用例拒绝接管。 |
| 6 ready证明 | 业务提交与flush/close分离；真实事件边界、配置摘要、来源资格及manifest核验后才ready，故障窗口保持dirty/preparing；DSH及integration用例通过。 |
| 7 全部输入来源闭包 | context/item及runtime_context记录实际纳入输入；integration来源删除覆盖当前、退役、后续重建与尚未登记context的准备副本。 |
| 8 重开与受阻 | recovery/integration及正式profile回读通过；实际App原unknown库仅保留user并明确显示恢复受阻，无验证模型调用或自动重放。 |
| 9 封禁、排空与清理 | 先fence并排空Agent和读写所有者；deletion及integration覆盖close末写、释放失败、在途请求、HTTP读取与统一关闭。实际删除完整清除受管副本，文件操作位于事务外。 |
| 10 故障与同操作续清 | integration、deletion及DSH真实目录用例覆盖mkdir、身份、提交、close、删除窗口；同操作续清、同定位换身份拒删、释放失败不完成。 |
| 11 重送与迟到回调 | 真实请求键、attempt租约、存储epoch及写入代次校验；原URL换段后重送、来源失效及迟到响应、重开旧租约用例通过。 |
| 12 正常界面与最小日志 | 实际开发App展示真实发言、查看/继续/新开/删除与恢复受阻；首轮真实加载失败复现后修复A→B→A并实机通过。失败receipt只保存白名单分类，隐私回归通过。 |

实际执行过的最小及相关验证包括：

- 后端讨论／DSH／恢复／删除模块及正式profile有效验证，后续安全错误修复的generation、integration、failure共32项及后端typecheck通过。
- `cd desktop && node --test tests/sqlite-discussion-session.test.mjs`：2项通过；`node --test tests/workspace-session-switch.test.mjs tests/skill-feedback-session.test.mjs tests/sqlite-discussion-source-lifecycle.test.mjs`：14项通过；desktop typecheck通过。相关panel、bridge等既有有效结果继续复用。
- `pnpm run dev --user-data-dir <隔离合成目录>`分别运行两套真实App，以Computer Use直接核验上述流程；`pnpm run dev:status --user-data-dir <相同目录>`及实际PID确认正常退出。未打包、未读取真实微信、未发送外部聊天。
- 私有验收目录保留截图、AX及`post-app-audit.json`，不纳入Git；只读数据库与文件manifest核对通过。原真实问题账本used仍1、unknown已封闭，工程环回4次成功调用与真实质量严格分列。

数据影响：业务讨论按owner/contact保存真实发言及来源，受管副本有完整登记和删除路径；用户明确删除的合成讨论及副本已清除，独立联系人和其余讨论保留。本轮不自动沉淀长期记忆，不增加后台聊天发送能力。外部首轮未知调用的供应商原因、实际HTTP次数与实耗无法追回，非空外部模型发言的质量及保存重开未获证明，不作为本票工程链路已验收的外推。

最终独立Standards与Spec窄增量审查均未决0，同意12项条件完成；只读审查复用已有有效测试，不额外启动App或模型请求。桌面租约已释放，真实微信、产品整体及暂缓任务仍不在本票验收结论内。

## 规格与证据入口

- [统一数据库设计：助手与副本](../../sqlite-database-rebuild/greenfield-design.md#助手与副本)
- [真实 DSH 生命周期回归](../../../backend-ts/test/sqlite-discussion-dsh.test.mjs)、[受管副本与删除回归](../../../backend-ts/test/sqlite-discussion-deletion.test.mjs)
- [DSH 源码查证流程](../../../docs/agents/dsh-development.md)

## 范围与执行门禁

- 本票实现由总调度明确授权；该授权不扩大到真实微信、模型外部出站、其他暂缓任务或发布。
- App 首次使用继续搁置；不新增首用向导、微信组件准备、模型设置、干净机器或发布任务，不执行微信迁移／恢复实验。复用已有配置仍须核验其有效性与资料用途授权。
- 后续桌面开发只用 `pnpm run dev`，先以 `dev:status` 核验并复用监督器；不得自行打包、运行打包版、推送、创建远端分支或 Pull Request。
- 测试使用隔离合成资料；真实微信读取范围、模型凭据或文本出站授权未核验时不得放行。合成验证不代表真实渠道、模型质量或产品整体已验收。
- 通用范围、执行和证据口径见[本轮任务索引](../planning.md)。本票不修改或关闭父规格和旧研究任务。

2026-10-29 用户另行授权的真实供应商合成复测：独立会话在源提交 f5cb11f8e52c3f78176611c86508f9f613fb34e1 上通过正式 SQLite DSH profile 和认证 HTTP 完成1次真实模型调用，生成1条助手发言；后端关闭重开后发言仍在，重开没有增加请求。未启动App、读取微信或发送外部聊天。总指挥已核验源提交为集成分支祖先，并仅投影核对本地私有结果报告的状态与数量；旧unknown及旧预算记录保留，不推断旧失败原因。该合成复测不认证真实微信或真实聊天语义质量。
