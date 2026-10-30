# 03 私聊历史支持档核验

## 2026-10-30 用户操作下的发送与撤回元数据观察

用户明确授权对单个私聊进行只读元数据观察，并亲自在同一会话发送并保留 A，再发送和撤回 B。A 发送后重新建立基线；基线锁定数为 0。B 发送后观察器锁定一条本人发送的新增记录：原始 type 为 `1`、status 为 `2`，已分配 server ID；用户撤回 B 后，观察到同一条记录的 type 为 `10000`、status 为 `4`，本地主键和 server ID 均保持一致。观察器正常关闭，未发现本次观察进程残留。

本次只观察已选择会话的元数据，未读取正文、source/XML 或媒体，未调用模型、未由 Agent 发送或撤回；匿名证据留在本机，不包含原始身份和消息正文。结果只证明本次受控操作的前后观察，未观察到 pending 或 server ID 分配过程，也不能推广为全部状态语义或跨重启来源连续性。开发制品仍为 ad-hoc、`realWechatVerified=false`，`normalHistory` 和支持档继续 `unverified`，不放宽正常 target/page 门禁。用户后续另授权仅该会话文字历史及隔离本机测试，仍不得读取媒体、访问其他联系人或调用模型。

## 已删除来源的实例变化停读（合成验证）

为已删除来源与已认证清空成员增加目标表实例及来源代次比对。读取前发现已保存排除键无法对应当前目标时，另行提交联系人范围的持久围栏并停止；接收页时在事务内再次比对。围栏不会因为目标随后恢复或数据库重启而自动清除。该切片只检查已有排除键可否映射，不证明无排除时的来源连续性，也不证明相同实例摘要期间没有不可观察的变化；未知状态、实际微信支持档及普通正文读取仍保持未认证。

日期：2026-10-29。覆盖现存只读制品核对、同配套库的原生合成检查，以及本票新增隔离开发 CLI 的指定私聊结构复验。没有安装、初始化或替换用户组件，原制品与 v5 阶段未读取真实消息行；后续只投影获准范围的消息元数据，未读取正文或媒体，没有迁移／恢复实验或模型。获准受控发送及停止结果见 v7。原工具与新增窄操作是不同制品，分别记录；结构通过不能放行未知状态和来源连续性。

## 原有制品与运行证据

| 制品 | 大小 | SHA-256 |
| --- | ---: | --- |
| bin/wechat-cli | 8495824 | d566d4842b656ca5b07a8af0c1fdada5c225724e9e7fda28e409b06f117d0655 |
| lib/libWCDB.dylib | 4490832 | 4f05cafc4626a142afca1818f0a88c4092a13d5f4c83e30cd5125b558ba0417d |

文件为普通非符号链接arm64，codesign --verify --strict均为0，与既有静态构建审计的字节一致。工具根缺组件manifest和旁侧公开源码，未宣称完整发行、可重现构建、公证或干净机器通过。固定补丁命令白名单仅status/sessions/resolve-chat/tail/watch/help/version，强制只读且禁止自动刷新。静态核对没有发现inspect_message_schema、message_metadata_barrier、table_xinfo、index_xinfo、source_generation或sqlite_schema入口；不以普通消息查询后删输出充当无正文结构检查。

在既有配置所指的同一CLI上执行有界status --include-debug --strict-read-only，退出0、strict_read_only=true、live_read_ok=true、readiness=degraded；既有parseConfiguredWechatAccount接受候选，但不授予来源连续性或正文资格。stdout/stderr仅在端侧进程内存解析，不保存账号标识、配置或路径。DYLD_PRINT_LIBRARIES观测到一条预期配套WCDB加载，未见其他WCDB；该结论只覆盖此次status进程。

## 最终配套WCDB字节的原生合成检查

复用既有wechat-wcdb-native-probe-v3.py，以本次配套dylib为唯一显式参数。脚本通过ctypes调用该库导出的sqlite3函数，仅新建并清理自有临时合成数据库；没有以Python内置SQLite代替。库内sqliteVersion=3.27.2，12/12断言组通过：加密错误密钥拒绝、只读禁写、两分片完整身份与精确大整数/正文列authorizer、WAL固定快照、持续变动拒绝、静止后重试、observer/reader短获取窗口及扫描期间正常提交、窗口内提交拒绝、新分片失效、短暂命名空间变化正向观测、文件替换失效、interrupt后语句/连接释放。

这些结果将既有12项机制证据绑定到本次实际配套库字节，不认证当前微信schema、消息状态、迁移映射或来源命名空间连续性。kqueue正向观测不证明事件永不丢失，持续提交时仍只承诺有界拒绝，不承诺必定取得共同切面。既有14项生命周期仍是合成状态规则，本轮未冒称重跑真实状态转移。

## 原有制品阶段的桌面与缺证结论

dev:status为stopped，无本工作树dev进程；未启动、重启或关闭开发实例。Computer Use核对实际微信窗口已在用户指定目标，未切换到他人、滚动、输入或发送。没有将窗口名作为稳定会话身份，没有持久化截图。

上述原有CLI没有受控消息schema窄操作；这一阶段尚缺实际目标的schema、声明主键、完整分片/表实例、消息状态语义、来源连续性及可靠历史目标/游标证明。新增窄操作补证见下节，原工具本身未替换。因此真实身份适配器继续unverified，未经02正常逐人确认创建真实读取许可，也未读取真实正文或媒体。组件准备与安装仍搁置；不能绕过白名单、扫描密钥或用tail补证。03的正常合成服务、来源删除和界面检查与该真实门槛分别报告，票保持claimed。


## 新增窄操作开发制品与本机结构复验

新增 `desktop/wechat-history/` 在锁定上游源码和严格只读补丁上增加 `notalone-history`。仅从既有 schema2 配置取得明确账号根目录；缺失、不规范目录或账号切换在打开来源前拒绝，不调用上游自动账号目录发现。元数据只解析用户指定的一个精确私聊，重名或无匹配失败；消息结构查询只查该目标的 sqlite_master、PRAGMA table_xinfo/index_list/index_xinfo 和触发器摘要，不读消息行、source/XML 或其他会话数据。

构建通过 `desktop/scripts/build-history-cli.mjs`，校验锁定源码、Go 归档、严格只读补丁和现存 WCDB 字节，离线输出到新的开发目录。构建不会运行完整组件准备，也不覆盖现工具或私人配置。当前支持档与制品摘要见[窄操作三值报告](../../backend-ts/src/history/sqlite/support-profiles/wechat-4.0.6-29387-narrow-v1.json)；原有工具报告保留在[原制品报告](../../backend-ts/src/history/sqlite/support-profiles/wechat-4.0.6-29387.json)。新 CLI 的开发签名完整性通过，manifest 的 realWechatVerified 仍为 false。

使用正式 `NarrowWechatClient` 对唯一获准对象执行 resolve → inspect → support，随后正常 target 在客户端门禁拒绝。检查 8 个分片，其中 2 张目标表；均为 17 列、声明 `local_id INTEGER PRIMARY KEY AUTOINCREMENT`、4 个非唯一索引、0 触发器。`server_id` 没有唯一索引约束，不能据它猜测全局或会话唯一语义。支持报告分别保留 13 项三值：当前版本、完整结构、声明主键、自动分配规则和状态列已核验；状态语义、来源生命周期、重启连续性、恢复映射及正常历史仍未验证。没有进入真实 snapshot/消息分页，也没有按类型读取正文样本；缺证时不扩大读取来制造正常路径结论。

最后一次开发构建自己的 fresh archive 源码上运行原生定向测试与 race：60 个用例／子用例、2 包通过，0 失败、0 跳过。覆盖精确整数、同秒与分片、共同固定快照期间持续写入、DDL／表实例变化、游标重放、取消与真实关闭、命名空间变化、失败守卫回收、缺账号根目录拒绝、NUL 与坏 UTF-8 尾部、Zstd 限额及单元 8 MiB 上限。单次查询超限不返回部分行；有效文字按完整字节读取，坏 UTF-8 不以静默截断或替换成为正常正文。每页最多 16 条，客户端 page 响应上限 8 MiB，其余响应 2 MiB；超时及取消等待子进程退出。

这些合成机制不证明真实微信的状态转移或没有原位恢复。kqueue、dev/ino、birthtime、schema_version、rootpage 和建表摘要只能检测部分变化；旧游标或旧出现身份不能因此自动跨启动／恢复续用。真实正常历史保持关闭，03 仍未完成。公共宿主的非空合成服务／HTTP／SQLite／05 删除路径与后续实际 App 界面证据另行核验，不能由本节代签。


## v6 单条元数据观察（未授予正文资格）

在已有单一对象最小只读授权内，新增独立 `observe-metadata`。严格 resolve/inspect 后，七个类型家族各调用一次；每次固定全部分片 reader，只投影一条 local/server 身份、原始 type/status、sender 类别和 create_time 元数据。切面探针只返回常量，不额外读取任意消息编号。不会调用普通 Page/projectRows，不查询正文、source/XML 或媒体，不写普通捕获，不授予生成、完整覆盖或普通 target/page。

正式客户端实际检查仍为微信 4.0.6/build29387、8 分片、2 张目标表。文字、图片、文件家族、表情及其他类型各匹配一条，共 5 条；语音与视频均未匹配，报告未观察，不报告不支持或完整。原始状态观察到 2、4，只能说明本次字段值，不能解释为完成、已送达或已撤回。每次观察只证明当次固定快照，不把七次调用冒充同一个历史切面。观察后普通 target 仍被 history_support_unverified 门禁拒绝，全部 reader 和子进程关闭。

新开发字节与匿名结果见[v6 元数据报告](../../backend-ts/src/history/sqlite/support-profiles/wechat-4.0.6-29387-metadata-v1.json)。源码/配置依赖仍为同一上游、Go、只读补丁及 WCDB；新增 Go 观察入口、受影响快照和协议从 fresh archive 执行定向 race，共 43 用例／子用例通过、0失败0跳过，typed 相关 8/8、后台类型检查通过。未变化的原生底座 60 项沿 v5 与相同 WCDB 字节复用；v5 摘要不代表 v6。严格开发签名核验退出 0。

审查先修复两处后才执行真实观察：原固定切面探针会多读任意 local_id；客户端未核对原始 type 低32位与请求类型。现在探针仅返回常量，七类夹具使用各自合法原值，错类型／精度失真／额外正文或 XML 字段均拒绝。无正文列的合成表、最多一条、缺分片、DDL、取消和 Close 排空均有证据。

原始来源键、账号、发送者名称和时间没有保存。未发送、撤回、重发或删除外部消息，未增加媒体样本或其他联系人。下一项状态校准需要另行确认精确对象、固定测试文字及发送／撤回动作；现有样本不代替状态转移。迁移／恢复实验继续范围外，普通本次固定快照、跨新快照、重启和恢复分别报告，未证能力仍为 unverified。

## v7 受控状态观察（关联歧义即停止）

另获精确对象、固定两条文字及仅撤回第二条一次的人类授权后，增加 `observe-test-metadata`。一次 arm 只读取所选会话各分片 MAX 主键标量；next 在共同固定快照先有界计数，全部分片仅一条新增 owner/text 行才锁定分片／表实例／主键，最多两条。current 仅复查已锁主键，允许类型／状态变化或缺失，不用新系统行顶替。每阶段关闭全部 reader，长期目录守卫保留至结束。十分钟／二十次调用上限，歧义或读取失败永久终止，关闭先取消并排空；不调用 Page、正文、source/XML、媒体或产品发送能力。

正式客户端确认同一微信版本、8 分片与 2 张目标表，arm 成功。Computer Use 核对精确私聊和固定第一条文字后仅发送一次，实际界面显示绿色气泡、输入框清空。随后 next 返回 history_identity_ambiguous，未返回可锁定记录，客户端及 native 关闭。按停止条件，第二条未发、未撤回、未重发、未扩读旧消息猜关联。现有错误不能区分多行、sender 映射或类型条件，原因保留未分类，不能宣称微信不支持。

新字节见[匿名受控观察记录](../../backend-ts/src/history/sqlite/support-profiles/wechat-4.0.6-29387-controlled-state-v1.json)。fresh archive 定向原生 race 28 顶层／含子用例 57 项通过，0失败0跳过；typed 两文件组合28项、后台类型检查通过。合成验证含 Close 取消与实际 reader 排空、空 MAX、跨分片同主键、同期多行、未知 sender／type、schema／文件变化、缺失行不顶替及歧义后不可复活。双轴复核的资源与失败重试问题已修复。

本次只证明第一条在实际 UI 发送成功；pending、server 别名补齐及撤回语义仍未验证，普通历史保持门禁。迁移／恢复继续排除，公共首次触发和合成 App 展示／删除验收继续推进。

## v8 本人类别修复与发送前校验

锁定上游 795071fa 的 main.go:8440–8453 用 selfWxid() 区分账号目录设备后缀，既有本人消息分类同样复用该函数。三处窄投影此前直接比较完整 cfg.Wxid，合成设备后缀用例能复现本人变 unknown。现仅发送者类别使用官方派生值，账号隔离键及 sourceGeneration 不变。不能据此倒推 v7 的具体失败原因，也不回找第一条身份。

arm 新增所选现存分片 Name2Id 的 canonical/raw 精确有界计数；未知、重复或冲突在发送之前终止，不枚举用户名或返回原始账号。另以固定原因码区分新增多行、sender、type 和主键门禁；错误仍永久关闭观察。新字节及匿名预检见[v8 发送前校验](../../backend-ts/src/history/sqlite/support-profiles/wechat-4.0.6-29387-controlled-preflight-v2.json)。实际正式客户端 resolve/inspect/support 后，8 分片／2 目标表的发送者预检和 arm 通过，lockedCount=0，随后 reader 与子进程关闭；未发送、撤回或读取正文。

设备后缀三投影先红后绿，相关原生 race 26 顶层／含子例 71 项通过；新五类固定原因码均验证客户端拒绝后排空。另从 v8 fresh archive 运行更广定向回归并保存本地日志。实际预检只证明本次元数据映射可证，不认证正在运行微信当前登录账号、消息状态或普通历史资格。第二条操作仍须独立桌面时段及新基线。

后续取得短桌面时段后，先核对所选会话、第一条保留状态和空输入框。Computer Use 对消息气泡的单独坐标点击直接返回 AXError.notImplemented，聊天区无可操作 AX 节点，键盘菜单也未打开撤回入口。第二条尚未输入或发送，未开启新基线，未回撤第一条；确认无观察器和开发实例后释放桌面。此项为实际操作能力缺口，已有固定发送／撤回授权仍有效，不能写成缺少授权或状态测试通过。

## v9／v10 工具配置账号的元数据认证

按 ADR-095:16–19 和 ADR-110:7–11，认证对象是已配置工具账号；前台登录账号不是此证据。固定 inspect-account-schema 只读取 contact／SessionTable 声明、完整列和索引 xinfo、主键及触发器摘要。实际微信仍为 4.0.6/build29387：SessionTable 为19列、3索引、username主键，contact为22列、1索引、id主键；均非自动递增、无触发器。两次配置账号及来源守卫复验通过，未投影名单或聊天记录。

正式 metadata-account 支持档按上述完整结构、当前程序版本和配套 WCDB 字节匹配，再固定 SELECT 1 LIMIT 1 核验会话可读性，前后重核结构、配置及两份持有中来源实例。v10 正式客户端多次 accountMetadata 证据完全一致；与唯一获准私聊 resolve 的完整配置账号、sourceGeneration 相同，metadataStatus/configuredAccount 为 verified，连续性只声明 held-contact-session-instances。普通历史支持仍 unverified，target 实际被门禁拒绝。全部读者及子进程已关闭，无整名单、正文、source/XML、发送或撤回。匿名结构和资格绑定见[配置账号元数据支持档](../../backend-ts/src/history/sqlite/support-profiles/wechat-4.0.6-29387-account-metadata-v1.json)。

metadata-sessions 是独立许可的固定窄操作，仅必要私聊身份与名称，服务端5000界，超量整批拒绝；明确非私聊先排除，可能私聊仍须唯一 contact、合法 verify_flag 和官方分类。真实整名单本次未读，不以合成列表冒称端到端认证。正式空库 ContactService 与合成原生进程8项通过；未知版本、重复、缺失、夹带正文、账号／来源变化及关闭取消均有覆盖。失败后显式重检重新创建客户端，本次操作不自动重试，旧授权不恢复；该恢复缺陷及非私聊缺 contact 反例均先红后绿，独立复核收敛。

v10 fresh archive 的定向原生 race 共37顶层／含子例91项通过，0失败0跳过；之后名单提前分类仅补受影响定向 race，客户端恢复仅补新增两例及类型检查。真实资格绑定 v10 字节，后续新制品须按实际字节复验；未变化底座沿既有证据复用，不重复宣称重跑。

包含上述修复的 v11 已 fresh build 并通过严格开发签名核验。正式 createWechatContactMetadata 端口实际两次读取工具配置账号，assurance 均 verified、证据相等，随后端口及原生进程关闭；未调用名单或正文。新字节和端口结果已追加到同一支持档的 formalPortVerification，旧 v9／v10 证据保留各自制品绑定。

## 首次自动入口的正式宿主验证

实际合入公共基线 af98a3ba，保留迁移1至9、唯一共享模型、讨论／记忆／媒体消费者以及关闭失败保留SQLite的合同。联系人确认成功和开启读取只唤醒后台派发；关闭读取等待历史及微信媒体排空，撤销按联系人停止所有媒体，退出先排空首次协调器。宿主显式传入配置工具路径，不自动寻找或替换组件。

hooks、覆盖状态、关闭顺序、正式 launchDsh/profile、既有非空 history 和 media 宿主相关组合24项通过，后台类型检查通过。正式初次入口用合成原生子进程及空库，经真实 HTTP 账号确认、名单同意、联系人确认和开启读取自动形成 capture／source／message／coverage，未调用手动同步接口、未预植消息或goal。启动场景只经正式联系人服务准备持久开关；未知支持保持not_started和原因，零 target/page，body_available仍false。来源删除、显示和实际 App 不由该合成结果代签。

DSH查证：声明、锁及实际解析核心均为0.2.1-rc.2；核对安装 cmdline lib/types/index.d.ts:48 的 onReady(void listener) 成功启动一次／返回disposer，以及 lib/index.js:50–73 的effect释放。对应官方固定源码687f282e8625c6b8d11ff58211a90524be2e4317 packages/boot/cmdline/src/index.ts:52、123–145。本次只复用公开生命周期，不宣称整个npm制品已与源码逐字复现。

## v11 人工发送态观察（撤回按用户指令跳过）

重新核对获准私聊与保留的第一条后，用 v11 正式客户端核验工具配置账号、所选私聊的账号／来源相等和当前8分片2表，成功开启新基线，锁定数为0。观察器就绪后，由人类手动发送固定第二条一次并确认尚未撤回；随后 next 在共同固定快照唯一锁定1条本人文字记录：originalType 为1、原始 status 为2、serverId 已分配、local 主键精确保留。没有读取正文、source/XML、媒体或其他私聊，也没有追溯关联第一条。匿名结果绑定本次 v11 CLI／overlay／WCDB，见[v11 人工发送态报告](../../backend-ts/src/history/sqlite/support-profiles/wechat-4.0.6-29387-controlled-state-v2.json)。

人类随后明确指示撤回测试先跳过，由其以后手动处理。观察器立即 close，退出0；实际观察器及原生子进程均已消失，未执行 current 或其他消息读取，第一、第二条均未再操作。这是本次发送后快照的原始字段观察，不证明 status=2 的通用送达含义，也未观察 pending、server 别名补齐或撤回转移。上述能力及来源生命周期继续 unverified，普通正文门禁不放宽；不把跳过写成缺授权或渠道不支持。

## 20 公共旧路由接线待办

当前桌面来源管理通过 `GET /api/contacts/:id/sources` 列举来源（`desktop/src/main/sources/controller.ts:80`），SQLite 宿主尚无该列表路由；`SqliteDeletionHttp` 只承接具名来源 DELETE、删除状态与任务查询，不能由其成功推断来源列表可用。20 切换前须复核并接回来源列表公共合同，保持联系人隔离和删除资格。本票实际 App 删除验收使用已知合成 sourceId 调用正式 DELETE，再刷新实际消息列表验证旧正文撤下；此证据不认证通用来源管理列表。

## 合成实际 App 展示、来源删除与目录计数

独立测试根保留两位已确认的合成联系人，各8条记录（2条文字、6类非文字占位），总读取开关关闭。夹具用于已保存资料展示，不替代前述空库正式 HTTP 自动派发4项。只用 `pnpm run dev --user-data-dir <合成根>`，复用已安装44.7.0 Electron dist，以最小环境和独立后台进程运行；同 scope 的 dev:status 返回 development，监督器、App、DSH 后台实际存活并握手。前两次失败启动没有计为通过；只清理已确认归属的本次失效控制套接字后，复用18已成功的后台方式完成正向检查，未改产品启动或租约门禁。

Computer Use 实际操作管理后台和输入小窗：乙显示历史不完整及继续前警告；分别首次选择乙、甲，展开最近聊天并刷新，均显示8条、六类非文字占位、时间未知和顺序未核验，甲初始状态为完整。切换联系人时旧列表立即撤下。没有发起生成或点击媒体操作；这里的非文字是自建占位资料，不是本轮已暂缓的真实媒体验收。

对甲的一条已知合成 sourceId 调用正式 DELETE，删除操作 completed。正式消息端点由8条变7条，恰好移除所选文字，其余7条身份保留；实际输入小窗点击刷新后，AX 与画面中旧正文撤下，其余7条保留。刷新同步状态后，甲为1条文字、6条占位；来源删除使旧 goal 失效，展示不完整，没有把旧完整覆盖当作当前资格。

实际目录曾固定显示0条，消息端点却有8条。736f8297 修复 identity.directory 的硬编码：只聚合当前 owner/contact 的可见消息，消息可用且至少一条来源为 normalized/available 才计入，与历史读取谓词一致，不读取正文。两历史表不存在时继续返回0，兼容仅身份能力的结构版本3；未改宿主、registry、已发布迁移、正文能力或 source_count。source_count 仍是现合同的0，不能解释为真实来源数量已接回，来源列表与真实计数仍由20承接。

正式 HTTP 红例先复现0不等于8，修复后验证8→来源 fence 立即7→完成7→逐来源删尽0，另一联系人保持3、其他 owner 目录为空，以及无历史表的身份兼容。private-history/contact-binding/hooks 相关41项及后台类型通过；独立 Standards 与 Spec 均0问题，Spec另跑两项新增用例2/2。逐来源删尽不作为06正式清空入口的验收。

正常开发监督器因后台源保存安全重载后，实际管理后台显示甲7、乙8，甲摘要7及覆盖1条文字/6条占位；重新进入甲并刷新，仍只有7条，被删正文未恢复。随后 CUA 正常 Cmd+Q；同 scope 状态 stopped/pids[]，监督器、App、DSH 后台 PID 均消失，专有握手被移除，立即释放桌面。没有重开受控观察器、操作 B、调用模型或读取真实媒体。

真实普通历史仍全部拒绝 target/page：状态语义、pending、撤回、别名转移及消息来源生命周期仍 unverified，配置账号 metadata 认证不能替代这些能力。以上只补齐合成路径和资料显示，03 继续 claimed，不能 resolved 或标记 Goal complete。

## 固定快照与持久排除的连续性评估

现有账号 sourceGeneration 由配置账号及持有的 contact.db/session.db 实例生成，不包含消息分片实例（`desktop/wechat-history/cmd/notalone_account_metadata.go:131`）。消息读取的独立 observer 在同一连接上对固定 reader 的短获取窗口前后比较 data_version，能够检测该窗口的其他连接提交；SQLite 官方明确该值只可在同一连接的不同时间比较，不能将不同连接或重启后的值相等作为连续性证明（[SQLite PRAGMA data_version](https://www.sqlite.org/pragma.html#pragma_data_version)）。固定快照及持有期间的 guard 不证明快照之间的来源身份，也不能认证当前未验证的消息状态语义。

已删除来源的 local 排除键包含 sourceGeneration、分片、表实例及 localId（`backend-ts/src/history/sqlite/normalize.ts:19`）；正式接收查询按该键或已认证 server 别名匹配（`backend-ts/src/history/sqlite/actions.ts:59`）。在纯内存合成 SQLite 上调用正式 normalize 并执行该生产查询：原键命中；仅改变合成账号来源代次，或保持账号代次而改变合成表实例，旧 local 排除均不命中。serverId=0，不提供 server 别名。此实验只说明键匹配的条件，未证明现有正常路径能绕过门禁或真实微信发生了这种变化。账号代次变化已有独立认证拒绝（`backend-ts/src/contacts/sqlite/actions.ts:72`），但它不等于消息分片连续性证明。

可行的安全方向是：读取正文前，按 owner/contact 持久记录正在使用的来源证据与失证围栏；保留既有精确排除，在同一提交事务内复验授权、数据代次、围栏和当前快照资格。发生无法证明的分片/表实例变化、读取中断或重启后无法续证时，旧排除和围栏必须保留，停止该范围并报告缺口；不能通过新来源代次、重选或后台重试自动清除。围栏需在可能读取之前持久生效，不能只在会回滚的失败事务中写入，也不能仅靠进程内状态保证崩溃后仍生效。这是待实现的合同，不代表现有代码已经具备上述跨次失证围栏。

当前证据不足以将此方向作为正常可用实现：未知状态下仍不能判断哪些行可纳入正文；失去连接后的连续性和旧排除到新实例的身份映射不可证明。永久阻断能避免错误恢复，却不能满足04无声缺口/合法新消息续读，以及06精确边界后继续新消息的正向承诺；全部拒绝也不是这些验收的通过。需要经过认证的消息状态和来源实例连续性或可信映射，以及与04/06共享的精确边界、持续排除、并发删除和迟到页原子合同。只保留固定快照而放行正文，或以时间、最大 localId、重新确认账号和哈希代替映射，均不能解决该缺口。本次未改生产门禁，也没有读取真实微信、发送或撤回消息、做迁移恢复或调用模型。

## 2026-10-29 票03第1/2条双次真实 metadata 复核（仍未认证）

本轮只做两次真实、只读的 metadata 快照，目标是判断票03第1/2条的历史范围、状态语义、来源连续性和覆盖能否认证。正式 `backend-launch.json` 当前指向已安装 CLI `d566d4842b656ca5b07a8af0c1fdada5c225724e9e7fda28e409b06f117d0655`；该制品调用 `notalone-history` 时在打开来源前以 `notalone_command_disabled`、退出码 2 拒绝，因此不具备本轮所需的 metadata 入口，不能作为已安装正式支持档的证据。两次真实快照使用保留的开发只读制品 `d555fdcedf100eba62e8dbc4dbcde50901b3f1b8198f6a6a44e62cfb66c26327`；其 manifest 明确为 `notalone-history-cli-development`、ad-hoc development、`realWechatVerified=false`，不能替代正式安装制品认证。正式配置路径的这一次拒绝没有打开 SQLite 来源，不计为真实读取。

每次快照均只请求 `metadata-account` → `inspect-account-schema` → 精确目标 `resolve` → `inspect` → 单条文字 `observe-metadata` → `support`。没有请求 `target/page`，没有读取 `message_content`、source/XML、媒体、整份联系人名单或会话列表，没有发送、撤回、模型调用或产品数据库写入。两次结果只在端侧解析并落为不含账号、联系人名称、原始消息ID、时间戳或原始分片路径的摘要；目标名称、账号键、会话键和来源代次只保留相等关系，不进入本文件。

两次可比较字段一致，未观察到差异：

- 账号：`wechat-account-metadata-v1` 均为 `verified`，程序 `4.0.6/build 29387`，`configuredAccount=verified`，`continuity=held-contact-session-instances`，`normalHistory=false`；CLI 与 WCDB 摘要分别为上述 `d555…` 和 `4f05cafc4626a142afca1818f0a88c4092a13d5f4c83e30cd5125b558ba0417d`。账号和来源代次在两次独立进程间相等；期间只正常退出并重开 NotAlone App，WeChat 进程没有重启。
- 账号结构：`session` 19 列，声明主键 `username`，schema version 11，3 个索引；`contact` 22 列，声明主键 `id`，schema version 22，1 个索引；账号结构摘要 `9b7f2d14a94a21b4`。两张表的实例摘要、列和索引在两次间一致。
- 消息结构：检查 8 个分片，其中 2 个目标消息表；均为 17 列、声明主键 `local_id`、`AUTOINCREMENT`，各有 1 个组合索引和 3 个单列非唯一索引（含 `server_id`，不提供唯一约束）。两个表实例摘要分别为 `12ff3e6af6323b82`（schema version 229/rootpage 310）和 `6da1a20246f3e94b`（schema version 695/rootpage 6893）；消息 schema 摘要 `c79d35e6b8a272a9`。完整分片集合、表实例、主键和索引在两次间一致。
- 单条可观察状态：两次均匹配同一文字元数据位置，`localIdHash=d4735e3a265e16ee`，`serverId` 为正整数、`originalType=1`、原始 `status=4`、发送方类别为 `contact`、`createTime` 为正整数；报告均为 `statusSemantics=unverified`、`normalHistory=false`、`observationScope=single-fixed-snapshot`。同一原值不能证明状态4的业务含义，也不能覆盖发送、撤回、别名补齐或删除状态。

认证结论：可以认证本次两个时刻的当前账号结构、精确目标、8 分片中的 2 个消息表实例、`local_id` 声明主键、表结构及一个原始状态值在两次间相同；不能据此认证票03第1/2条要求的真实历史范围、状态语义、来源生命周期、跨重启来源连续性或覆盖。`support` 仍返回 `unverified`、`history_message_state_unverified`，其中 `normalHistory`、`statusSemantics`、`sourceLifecycle`、`restartContinuity`、`recoveryMapping`、`snapshotBarrier`、`partitionCoverage` 全为 `unverified`。相同固定切面无法证明变化间映射；当前保留的正式 CLI 又缺少 metadata 入口，开发制品也不能冒充正式支持档。

因此本轮不放宽真实正文门禁、不修改 support profile、不把全拒绝写成正常历史可用，票03保持 claimed。数据影响仅为上述只读 metadata 查询；没有读取正文或其他私人资料，没有向指定目标或任何其他对象发送消息。两次快照后 App 以正常 Cmd+Q 退出；`dev:status` 返回 `stopped`/空 PID，任务自有 App/监督器/DSH 进程和开发握手均已清理，WeChat 保持原运行状态。

## 2026-10-30 合并基线后的分支审计、接线复核与逐条真实缺口（仍未认证）

本轮只做分支合并、只读代码审计、既有证据有效期复核与最小相关重跑；没有启动实际 App、没有读取真实微信正文或元数据、没有发送或撤回、没有迁移／恢复实验、没有模型调用。以下“已过”只指票内已勾选的约定实现与合成／正式服务证据，不等于真实渠道认证。

### 分支与合并审计

- 独立工作树（路径不记录）原为 detached HEAD `e6998001`（父 `a11e04a0`，仅在本文追加双次 metadata 复核段），工作区 clean。恢复为本地分支 `dsh/sqlite-rebuild-03`，未 reset／clean／覆盖。
- 实际执行 `git merge codex/sqlite-rebuild-integration`（基线 `33e7dedc`），无冲突，生成 merge commit `28d78174`；工作区保持 clean，未 push。
- 合并后与基线双向差：`git rev-list --count 33e7dedc..HEAD` = 2（`e6998001` 文档提交 + merge commit），反向 = 0；追加本节前 `git diff --stat 33e7dedc..HEAD` 只有本文 +17 行。
- `git diff --stat a11e04a0..33e7dedc -- backend-ts/src/history` 为空：03 源码已随基线全部集成，旧工作树不作为当前产品状态。
- 集成侧对 03 接线的实际影响：`backend-ts/src/sqlite-host-plugin.ts` 仅新增记忆管理路由（当前文件 `:170`、`:186`），history 服务、协调器、启动唤醒、关闭顺序行未变；桌面历史／消息 UI 文件自合成 App 证据提交 `2f18f7a1` 起 `git diff --stat` 为空。其他集成增量属记忆裁决、候选回复等相邻票，不在本票范围。

### 首次自动入口接线（当前树证据）

- `backend-ts/src/sqlite-host-plugin.ts:123-127`：能力含 `history` 时创建 `SqliteHistoryService` 与 `FirstHistoryCoordinator`，`contacts.setReadStart(()=>firstHistory.wake())`；`:142` 停读时 `firstHistory.stop(contactId)` 并等待媒体停读；`:208` 在 appReady 发布握手后 `firstHistory.wake()`；`:94` 关闭顺序先 `firstHistory` 再 `history`、`contacts`、模型与 SQLite。
- `backend-ts/src/history/sqlite/coordinator.ts:31` 注释明确只由启动、明确确认或开启操作唤醒，首次历史结束后不派发增量、不轮询；`:51-57` wake 清理取消键并重新调度；`:152-168` 单人 stop／整体 close 先取消并等待真实 reader 排空。
- 复核判定：公共首次自动入口的“合成原生子进程 + 正式 HTTP 授权 + 空库”证据仍有效。`sqlite-history-startup-host.test.mjs` 覆盖全新启动不预灌、账号确认 / 名单同意 / 联系人确认 / 开启读取后自动首次 capture，且不调用 `/history/sync`、不预植消息或 goal；未知支持档保持缺口并零 target/page。仍不能把该合成结果当真实支持档已验收。

### 版本化能力报告复核

- `backend-ts/src/history/sqlite/contracts.ts:4-13`：`HistorySupportReport` 固定 `protocol:'private-history-v1'`、`profileId`、`adapterVersion`，`status` 为 `supported|unsupported|unverified` 三值，并含 `serverAliasSemantics`、13 项三值 `capabilities`、`identity`、`statusSemantics`、`continuity`。
- `backend-ts/src/history/wechat/native-client.ts:209-235` 解析并逐项校验 13 项能力键，缺省或越界拒绝；`statusSemantics`／`continuity` 在非 `supported` 时只接受固定未认证文本。
- 版本化制品报告：`support-profiles/wechat-4.0.6-29387-narrow-v1.json`（`format`／`revision:2`／`profileId`＋13 项三值）、`-account-metadata-v1.json`、`-metadata-v1.json`、`-controlled-state-v2.json`；支持档当前 `status:unverified`、`canReadHistory:false`，`statusSemantics`／`sourceLifecycle`／`restartContinuity`／`recoveryMapping`／`snapshotBarrier`／`partitionCoverage`／`normalHistory` 均为 `unverified`。
- 宿主运行能力报告 `sqlite-host-plugin.ts:158-163`：`wechatBodySync`／`wechatHistory` 在 history 能力存在时为 `typescript`，`wechatIncremental` 仍 `unavailable`。未发现“字段存在即冒充已认证”的记录。

### 来源删除注册复核

- `backend-ts/src/storage/sqlite/deletion/registration.ts:17-26`：`installedHistoryDomain` 在正式 `historyDeletionDomain.collect` 之上，为 `source` 删除追加早期读者 holder 键（`historyReaderHolderKey(contactId, accepted_data_generation)` 及前置代次），覆盖 inspect/target 尚无 goal 的读者；`:39-40` 已把 `history` 加入 domains 与 requiredDomains。
- `backend-ts/src/history/sqlite/service.ts:15,45-48`：读取前先登记 `history:read_<contactId>_<generation>`（`coversAllSources:true`），有 goal 后再登记 `history:<goalId>`，finally 逆序释放并等待真实关闭；`:94-95` stop／close 排空。
- `backend-ts/src/history/sqlite/deletion.ts:32-77`：fence 写持久来源排除／删除围栏并把旧 `capture_record`／`read_goal` 置失效，collect 只按固定操作账本收集，clear 校验 owner、identity 与 planned target，verify 拒绝残留行。
- 复核判定：写入／删除注册合同与早读者排空已有合成和正式 HTTP 证据（本轮重跑见下）；真实来源删除链仍未运行（无真实捕获），`contact_history` 精确截断属 06，来源列表 GET 属 20。

### 本轮最小重跑与证据复用

| 验证 | 命令／来源 | 本次结果 | 复用理由 |
| --- | --- | --- | --- |
| 后台类型检查 | `cd backend-ts && pnpm run typecheck`（`tsc --noEmit`） | 退出 0，无错误输出 | 合并后必跑的编译门禁 |
| 03 相关模块 | `ELECTRON_RUN_AS_NODE=1 <Electron 44.7.0> --test` 13 个文件：`sqlite-private-history`、`sqlite-history-http`、`sqlite-contact-binding`、`sqlite-storage`、`sqlite-deletion`、`sqlite-history-host`、`sqlite-history-hooks`、`sqlite-first-history-coordinator`、`sqlite-history-sync-status`、`sqlite-history-source-holder`、`sqlite-wechat-history-channel`、`sqlite-host-close`、`sqlite-history-startup-host` | tests 109 / pass 109 / fail 0 / skipped 0 | 合并树一次性覆盖服务、HTTP、删除注册、hook、协调器、宿主启动 |
| 对照：同一批（除 startup-host 外 12 文件）用普通 `node` | 同一命令去 `ELECTRON_RUN_AS_NODE` | pass 101，仅 2 个启动宿主用例失败：`No usable native binding found for node-addon-require-builtin-darwin-arm64` | 环境限制：DSH runtime node（TeamID `NAN929V4UM`、hardened runtime）无法加载 pnpm 的 ad-hoc `require_builtin.node`；主仓与工作树同缺本地构建，与本次合并和 03 代码无关。改用 Electron 44.7.0 自带 Node v24.21.0（与真实 App 后台启动方式一致）后 4/4 通过 |
| PG 依赖宿主测试 `wechat-history-status-host.test.mjs` | 需要本机 PostgreSQL | 未运行：连接 `/tmp/.s.PGSQL.5432` ENOENT | 本地无 PG；该文件不在既有一组 03 证据内，条件未变 |
| 合成实际 App 展示／删除／覆盖／目录计数 | 提交 `2f18f7a1` 记录，CUA 实操 | 复用 | 历史与消息 UI、backend history 源码自该提交起未变；集成只改相邻记忆模块 |
| 空库正式 HTTP 自动首次派发（startup 4 项） | 本轮 `sqlite-history-startup-host.test.mjs` 4/4 | 重新通过 | 合并后重跑，替代旧计数 |
| 真实 metadata 双次快照与 v6 单条类型观察 | `e6998001` 段、`metadata-v1.json`、v9／v10／v11 支持档 | 复用，未重跑 | 制品字节、账号配置、WCDB 与目标对象相等关系未变，WeChat 进程未重启；条件未变不重跑 |
| 公开历史检查 | `node scripts/check_public_history.mjs --ref HEAD --working-tree` | 提交前后执行，见提交回报 | 提交后必跑 |

### metadata-only 只读诊断判定

- 已授权诊断（七种类型各最多一条，仅来源键、type/status/serverId/sender 类别/create_time）已在 v6 执行：文字、图片、文件家族、表情、其他共 5 条匹配；语音与视频未匹配，报告“未观察”，未报告不支持或完整；原始状态只观察到 2、4。
- 本轮不重跑。原因：读取对象、开发只读制品（`d555f…`）、配套 WCDB（`4f05ca…`）、账号与目标相等关系均未变化，重复同一固定切面不会产生新的观察；语音／视频“未观察”是该单一授权会话快照内没有匹配行，不是探测失败，也不能由同一对象重跑补成“完整”。
- 若要关闭语音／视频类型观察缺口，需要另一个包含该类型消息的已授权私聊快照（新的对象级授权），而不是本票本轮可自行扩大的读取范围。本次未读取 `message_content`／source／XML／媒体，未写普通 captures，未提升 `normalHistory`，无匹配项按“未观察”记账。

### 12 条验收逐条判定

判定说明：“实现＋合成已验”指票内已勾选的约定行为有正式服务／合成／受控 HTTP 证据；真实列仍标注未认证。真实普通历史、真实状态语义与来源生命周期、真实删除链保持未过。

| # | 验收条 | 判定 | 已有证据 | 还缺的证据／所需授权或制品 |
| --- | --- | --- | --- | --- |
| 1 | 首次历史限于已选联系人及本机可读消息，共用规范化，不恢复手动导入 | 实现＋合成已验；真实未过 | 协调器／服务／规范化／正式 HTTP 空库自动派发；合成 App 展示 | 真实支持档 `status=supported` 且真实逐人确认读取（02 真实对象）；当前真实 target/page 全部拒绝 |
| 2 | 版本化能力报告区分已支持／不支持／未验证；核验 schema、主键、分片／表实例、状态字段、来源连续性 | 报告与结构核验已过；状态与连续性未过 | 13 项三值报告；8 分片 2 表 17 列、`local_id` 主键、`server_id` 非唯一、状态列；双次快照结构一致 | 真实状态转移（发送／撤回／别名补齐）与跨重启／实例连续性证据；撤回归属人类操作授权 |
| 3 | 内部消息身份、来源出现键、服务端别名、续读位置分开；大整数、serverId=0、合法补齐 | 实现＋合成已验 | `contracts.ts` 身份／别名／游标拆分；相关测试与既有 63/63 | 真实渠道侧同一出现身份与别名补齐的真实样本（受状态门禁阻断） |
| 4 | 跨分片同 local_id、排序变化、同秒、乱序、多页重复无歧义 | 实现＋合成已验 | 分片／排序／多页测试与合成 DSH 分页 | 真实多分片分页与乱序样本 |
| 5 | 身份不足隔离，不进入正常聊天／记忆／生成，不能绕过授权 | 实现＋合成已验 | 隔离记录与实际读取谓词测试 | 真实范围下的隔离观察 |
| 6 | 文字存正文；非文字为空并保留类型与位置；不下载媒体、不触发记忆或模型 | 实现＋合成已验 | 合成 App 六类占位、非文字空正文测试 | 真实类型元数据仅 5/7 类型被观察，语音／视频未观察；真实正文未读取 |
| 7 | 捕获／来源／消息／游标／覆盖具名事务原子提交，提交前复验 | 实现＋合成已验 | 事务与迟到页测试、正式宿主删除闭包测试 | 真实读取下的原子提交观察 |
| 8 | 分页／分片缺失／身份冲突／中断显示真实覆盖不足，进行中阻止生成 | 实现＋合成已验 | 覆盖显示与正文可用性解耦、警告 UI、生成阻断测试 | 真实覆盖不足场景观察；依赖真实 target/page |
| 9 | 保存完整来源关联、删除目标注册、迟到写入资格保护；05 合同替身验证 | 实现＋合成＋正式 HTTP 已验；真实删除链未过 | 删除域注册、早读者 holder、正式 DELETE 合成 App 8→7、来源列表属 20 | 真实来源删除需先有真实捕获；`contact_history` 精确截断属 06；sources GET 属 20 |
| 10 | 合成源覆盖正常／重复／冲突／中断与界面反馈；真实未核验时保持门禁 | 已过（合成） | 合成 App CUA 证据、覆盖警告 | — （真实渠道见 1／2） |
| 11 | 复用 WCDB 原生 12 项与生命周期 14 项声明范围；研究摘要不等于产品字节；不做迁移／恢复 | 已过（限定字节与声明范围） | 配套 dylib 12/12 原生合成；v5–v11 支持档 | 无新增；不扩到迁移／恢复 |
| 12 | 显式统一 ADR-100 及旧 baseline 阅读入口与本轮首次历史目标 | 已过（文档／入口） | ADR-100／113 与旧 baseline 条款统一记录 | 无新增 |

### 精确真实缺口与所需授权／制品

1. 真实普通历史（第 1 条）：需用户按 02 对真实私聊完成逐人确认与读取授权，且支持档为 `supported`；当前正式安装 CLI `d566d4…` 调用 `notalone-history` 时以 `notalone_command_disabled` 退出 2，缺 metadata／history 窄操作；开发制品 `d555f…` 的 manifest 为 ad-hoc development、`realWechatVerified=false`，不能冒充正式支持档。在支持档未认证前，即使确认完成，target/page 仍会被门禁拒绝。
2. 状态语义与来源生命周期（第 2 条）：需精确对象固定文字的“发送后保留”与“发送后仅撤回一次”的人工授权与可操作撤回归口。人类已指示跳过撤回；CUA 对消息气泡点击返回 `AXError.notImplemented`，不能保证撤回。pending、server 别名补齐需可捕获窗口，未捕获即保持 unverified；禁止重发、重试或扩读其他消息。
3. 跨启动／实例连续性：`sourceGeneration` 不含消息分片实例，`data_version` 仅同一连接可比；持久失证围栏仍是待实现合同。需架构决策与实现授权、真实重启观察协议；迁移／恢复实验继续排除。
4. 真实覆盖（第 1／8 条）：需真实 target/page 全量分页及分片缺失场景，传递依赖第 1、2 项。
5. 真实删除链（第 9 条后半）：需先有真实捕获与来源，传递依赖第 1 项；`contact_history` 精确截断属 06，来源列表 GET 属 20，不在本票扩大范围。
6. 语音／视频类型元数据：需另一个包含该类型消息的已授权私聊快照；同一对象重跑不会产生新观察。
7. 正式制品：需正式签名且含窄操作的 CLI，或由用户／总指挥明确开发制品可用于哪一层认证；当前开发制品声明不能替代正式安装制品。

### 数据影响与资源清理

本轮改动只有本验证文档与票内追加评论，无产品代码、schema、支持档或配置变更；未启动实际 App／监督器／受控观察器／模型；未读取真实微信正文、名单或媒体，未发送或撤回消息；未改迁移／恢复。分支仅本地，未 push、未建 PR。临时产物仅为 `/tmp` 下的测试日志与被终止测试进程的子进程，测试夹具在用例内自清理；未发现遗留 `notalone-dsh-host-*` 目录或本票自有进程。
