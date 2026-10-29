# 03 私聊历史支持档核验

日期：2026-10-29。覆盖现存只读制品核对、同配套库的原生合成检查，以及本票新增隔离开发 CLI 的指定私聊结构复验。没有安装、初始化或替换用户组件，原制品与 v5 阶段未读取真实消息行；后续 v6 只投影获准范围的单条消息元数据，始终未读取正文或媒体，没有迁移／恢复实验、模型、发送或撤回。原工具与新增窄操作是不同制品，分别记录；结构通过不能放行未知状态和来源连续性。

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
