# 03：首次历史同步与消息展示

Triage: ready-for-agent
State: claimed
Type: task
Parent: [同步与记忆规格](../../sync-memory-behavior/spec.md)；[SQLite 数据库重建规格](../../sqlite-database-rebuild/spec.md)
Blocked by: [02 联系人绑定与同步授权](02-contact-binding-and-read-grants.md)

> 2026-10-29已批准发布，未开始实现。[任务索引与共同约定](../planning.md)。

## 交付行为

对已确认联系人接入本机可读历史，形成有来源的规范消息，并在现有聊天和同步界面显示文字、非文字占位、进度和覆盖不足。固定渠道合同可先用隔离合成源验证，未经认证的真实支持档不得读取。

## 验收条件

- [ ] 首次历史限于已选联系人及本机微信当前可读消息；历史/增量共用规范化规则，不恢复手动文件导入入口，不承诺其他设备缺失历史。
- [ ] 建立版本化能力报告，区分已支持、明确不支持、未验证；核验当前schema、声明主键、分片/表实例、状态字段及来源连续性，不以其他版本样本或字段存在冒充认证。
- [ ] 内部message身份与来源出现键、服务端别名和续读位置分开；大整数精确保留，server_id为0无别名，合法补齐不创建第二条消息，不要求永久全球唯一。
- [ ] 跨分片同local_id、排序变化、同秒记录、乱序与多页重复均有无歧义处理；排序未知明确显示，不把展示兜底次序当真实先后或因果证据。
- [ ] 已获准联系人范围内消息身份不足时隔离来源待核验，不进入正常聊天、记忆或生成；联系人/读取范围未核验时不能借隔离记录绕过授权先读正文。
- [ ] 文字保存正文；非文字正文为空、保留类型和位置；不下载媒体、不ASR/OCR、不触发记忆或模型；原聊天正文不直接编辑、不新增正文历史版本表。
- [ ] 捕获记录、来源引用、规范消息以及可靠游标/覆盖在具名事务原子提交；提交前复验账号、授权、读取与数据代次，迟到旧页不推进有效覆盖。
- [ ] 分页、分片缺失、身份冲突或中断显示真实覆盖不足；仅成功读取部分不能显示完整；首次历史尚进行时阻止生成，明确不完整后的用户确认与警告贯穿请求。
- [ ] 保存完整来源关联、删除目标注册及迟到写入资格保护，按05已定合同验证本票写者；05尚未落地时仅用明确的合同替身验证注册与拒绝，不宣称真实删除联调通过。05就绪后在20切换前复核实际删除链；重复捕获可关联同一消息，不能改写旧执行真正使用的来源。
- [ ] 合成源覆盖正常/重复/冲突/中断与界面反馈；真实版本结构、实际CLI/WCDB制品及身份状态未核验时保持真实读取门禁，不把合成闭环写为真实微信通过。
- [ ] 复用已有WCDB原生12项与生命周期14项声明范围内的证据；研究库摘要不等于原缓存或最终产品字节；迁移／恢复实验不加入本票。
- [ ] 实施时显式统一ADR-100及相关旧baseline阅读入口与本轮已确认首次历史目标，不凭秒级时间或独立local_id补造覆盖保证。

## 验证与证据

用正式同步/规范化/存储/展示路径和受控合成渠道先验证单页，再验证多分片、多页和重启覆盖；真实渠道另记录版本、只读制品、授权范围和仅必要匿名结构证据。所有输入拒绝不算正常历史接入通过。

依据[统一数据库设计](../../sqlite-database-rebuild/greenfield-design.md)和父规格实施；历史研究票、骨架或已知合成探针不能标为本票已完成。真实门槛见[定稿验证记录](../../../research/wechat-spec-finalization-validation.md)。

## 范围与执行门禁

当前微信4.0.6/build29387只确认了程序版本，真实结构与状态仍缺证据；原业务库不可连接导致既有读取范围无法核验。未取得证据前不得放行真实读取，不能自动开同步、扩联系人或扫描密钥。

本轮仅发布，尚未开始实现。`ready-for-agent`表示任务描述可供后续安排，不能据此自动领取、改代码、建业务库、读取微信或发起模型调用；须在用户后续明确要求实现时才开始并将State改为claimed。

后续开发及桌面验收只用`pnpm run dev`，先`dev:status`核验并复用热更新实例；不得自行打包、运行打包版、改发布门禁、push或创建PR。只处理必要的合成或已获准资料，不提交私人聊天、身份、凭据、截图或真实媒体。App首次使用继续搁置，迁移／恢复实验不纳入本轮。

## Comments

2026-10-29 实施中。依赖c2ae74b4/f4cd6888均为祖先，独立工作树；Goal已启用。稳定合同小提交07164d22098e8effad706785fcaac6bc3d4713ea。独立服务、迁移工厂、05真实删除注册、HTTP和消息UI已形成正常合成路径；等待独立审查与公共宿主串行集成，不标resolved。

真实渠道缺证：已知项目配置没有CLI路径，限定已知构建/制品目录没有最终CLI/WCDB；历史审计未保留候选绝对目录且缺manifest。现只读白名单没有schema窄操作，普通tail会读正文，不能据此补结构证据。程序4.0.6/build29387只证明程序版本，12项研究原生及14项合成生命周期不认证最终制品/当前schema/状态/连续性。未读取真实正文、他人名单、密钥或媒体，未安装/初始化组件、启停App、发送/撤回。真实ran正常授权/读取仍不可用。contact_history精确截断由06负责，缺证时受阻；不把受阻或全部拒绝记作正常同步通过。

2026-10-29 审查收敛：Standards轴发现旧删除误停新代次、count转Number缺边界检查，另有别名查询重复；Spec轴独立复现旧删除误伤、待删来源仍可读取和保存顺序误标已核验。已补反例并修复：按接受代次fence、来源availability即时撤下、派生同事务assertSourceEligibility、展示兜底始终明确未知、共享holder完整释放。额外覆盖长出现键删除、已知server别名抑制和目标外表实例隔离。后台相关63/63、桌面相关20/20、浏览器警告交互2/2及两端类型检查通过；浏览器使用已安装Chrome，无下载。一次从仓库根执行desktop测试因其cwd要求失败，改在desktop目录执行后通过。仍待公共聚合与实机，不resolved。

## Answer

阶段结果（未完成，State保持claimed）：正常合成路径、来源删除注册与消息UI已实现并创建本地提交，独立Standards／Spec审查的问题均修复并通过定向复核。稳定下游入口为backend-ts/src/history/sqlite/contracts.ts、source.ts、service.ts、http.ts与deletion.ts。捕获／消息／来源／游标／覆盖同事务；精确整数、跨分片身份、server补齐、冲突隔离、不可变实际来源、未知展示顺序、重开及迟到页均已验证。source删除使用05真实service/domain/authority和共享ActiveHolders，待删来源即时撤下，后继合法代次不被旧删除误伤；contact_history精确截断仍由06负责。

实际验证：后台sqlite-private-history、sqlite-history-http、sqlite-contact-binding、sqlite-storage、sqlite-deletion五文件63/63；backend与desktop的pnpm typecheck通过；desktop目录下sqlite-history-messages、local-history-sync、sync-scope 20/20，已安装Chrome的history-reply-warning-view 2/2。只有合成渠道替换外部端口，正式服务／HTTP／SQLite／05删除均未替换。未运行本票真实消息App链，未对真实微信正文做正常路径认证。

最新真实证据：已从既有配置精确定位现存CLI和WCDB，字节与历史静态审计一致，签名完整性通过。一次严格只读status退出0，并观测实际进程加载预期配套WCDB；该库字节上的既有原生合成探针12/12，SQLite3.27.2，临时库自动清理。可公开脱敏证据在docs/verification/sqlite-private-history-support-03.md及support-profiles/wechat-4.0.6-29387.json，不保存账号、聊天、截图、凭据或真实源路径。Computer Use核对当前窗口为指定对象，没有切换他人或发送／撤回；未启停开发实例。前述“未找到制品”已由此次精确配置定位补齐，但CLI仍无消息schema窄操作，当前真实schema／声明主键／分片表实例／状态及来源连续性未认证。保持真实metadata与历史读取unverified，不能正常逐人授权并读取ran正文；不安装／初始化组件或借tail补证。

尚未完成：总指挥在05之后串行聚合history HTTP／capability／启动停止与共享删除注册，并安排实际App消息UI验收；真实支持档窄接口缺证仍阻断真实正文。未把外部制品缺失或读取拒绝计作正常路径通过，Goal不标complete，票不resolved。公共修改只有registry的最小history迁移/actions追加（本树暂4，实际集成序决定）；profile、launch、host、desktop startup未改。所有提交仅本票；公开历史检查持续0问题。

总集成检查点：已审核心最终净差异按实际集成序追加history迁移v5，保留已发布v1–v4及Skill动作。集成后backend类型检查、历史服务／HTTP 19/19通过；真实渠道认证和公共宿主接线继续实施，State保持claimed。


2026-10-29 后续检查点：正式宿主／消息／覆盖／共享删除接线已本地提交71fe749604e4b66a35a462ab5e62c2c04934754f，正常DSH非空分页及重开、source/contact/account删除等33/33通过；未以预灌库证明首次自动派发。消息资格失败撤旧正文与迟到保护66755ab5、coverage显示与正文可用性解耦20357a86均有定向红绿，实际App仍待串行窗口。

新窄操作从锁定上游与Go离线构建，原用户组件和配置未替换。最终开发CLI上正式typed client对唯一获准对象仅resolve/inspect/support：8分片、2表，当前结构／声明主键／自增规则已核验，server索引非唯一；未读消息行或正文，正常target因真实状态及来源生命周期未认证拒绝。分项报告与最终字节见docs/verification/sqlite-private-history-support-03.md及support-profiles/wechat-4.0.6-29387-narrow-v1.json。fresh归档源码定向+race60项／2包通过、0失败0跳过；NUL截断已修复f3894fc3，缺配置自动发现、账号预检和guard回收a6ae5a86已修。

仍在实施：正常首次自动派发的独立协调器与正式service测试；连续来源删除遗漏早期旧代次读者的P1复现已确认，正按共享holder领域资格补齐；首次自动入口、实际App消息／覆盖／删除旧正文的证据未满足。真实状态与跨启动／原位恢复连续性仍缺独立证据，不扩大范围补发送／撤回或迁移恢复实验。State继续claimed、Goal继续active，不把结构成功、全拒绝或预灌数据计作03完成。


2026-10-29 最新收敛：P1来源删除早期读者遗漏已修复5650ad84e9a1893785be000d35aaf0b70cc432b6，连续三来源接受代次及新合法代次／他人／默认无flag均有红绿和独立复核。首次历史协调器c72eca1abc0baf868574aa84eb17fcbfe4ac3880正式Storage／ContactService／HistoryService10/10、相关组合28/28；未预灌验证正常首次派发，停止／新wake／扫描名单变化两处漏派已修。总指挥已实际集成这两项。当前等待16保存实际公共基线后串行接startup/confirm/enable hooks，并保留媒体停读与本地转换的区别；实际App窗口仍由总指挥分配。真实支持档与票/Goal状态不变，不能把独立协调器当公共自动入口已验收。

2026-10-29受控状态检查点12cfb6ab：v6单条类型元数据已观察5条，v7受控watch正式typed 28项/原生race57项（28顶层）及类型检查通过。另获人类固定A/B及仅撤回B一次授权，实际仅发送A一次并由微信界面确认；next身份歧义即闭锁并关闭，B未发、无撤回/重发/扩读。原因保持未分类，不能据此宣称真实渠道不支持。找到独立可复现sender映射缺陷：锁定上游selfWxid区分账号目录设备后缀，三处投影此前直接比较完整账号；正在修复并加发送前精确计数门禁和固定安全原因码。普通历史仍关闭，迁移/恢复不新增为本票要求。桌面已释放17；后续等待11公共checkpoint后实际merge总基线接首次触发，再进行合成实际App。State claimed/Goal active。

2026-10-29公共短检查点：89069571已保存正式工具配置账号metadata；真实v9完整结构、v10资格、v11正式端口重复证据一致且关闭，无整名单或正文。d8f2d159正式history-channel已保存。2cf0e4f实际merge公共af98a3ba，保留源祖先、迁移1..9、11共享模型与关闭失败保留SQLite、媒体全关wechat/撤销all。本轮公共startup/成功confirm/enable wake、disable/revoke stop、退出先排空coordinator、显式CLI路径及最新blocked状态已接。正式HTTP/launchDsh/profile等相关组合24/24及后台类型通过；未预灌消息/goal、未手动history/sync证明自动入口，双轴反例已修。

仍缺独立实际App消息/覆盖/删除撤正文证据。真实正文状态未验证，保持门禁。B未发送：Cua消息点击AXError.notImplemented，不能保证撤回，现依最新人类指令改为未来观察器ready后由用户手动一次B；先发送不撤回、唯一锁定再仅撤回B。A保持不动，迁移恢复继续排除；State claimed/Goal active。

2026-10-29 v11人工B发送态：正式客户端工具配置账号与ran账号/来源相等，8分片2表，arm新基线0；人类手动发送第二条一次并确认未撤回，next唯一锁定1条owner/type1/raw-status2、serverId已分配、local主键精确保留。随后人类明确将撤回测试跳过，立即close退出0，观察器及native进程实际消失，无current或额外消息读取；A/B均原样保留，不重发。公开匿名controlled-state-v2绑定实际v11字节；pending/撤回/server补齐/来源生命周期仍unverified，普通正文门禁保持。桌面已释放11，实际App消息/覆盖/删除撤正文仍待窗口。State仍claimed。

20公共接线待办：SQLite尚未承接桌面来源管理所需GET /api/contacts/:id/sources，正式具名来源DELETE及删除状态已承接。本票用已知合成sourceId执行正式DELETE并在实际App刷新验证撤下，不宣称来源列表可用；具体调用与边界已记docs/verification/sqlite-private-history-support-03.md。
