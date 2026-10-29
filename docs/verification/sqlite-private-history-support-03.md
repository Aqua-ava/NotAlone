# 03 私聊历史支持档核验

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
