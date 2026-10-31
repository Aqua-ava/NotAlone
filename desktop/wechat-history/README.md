# 私聊历史窄读取开发适配层

来源指纹和文件实例比较均不使用系统设备号。指纹保留指定名称、inode、创建时间及文件链接数，实例比较仍核对文件类型；目录链接数不参与身份。2026-10-31 的回归覆盖同一来源仅设备号变化时指纹与守卫均保持有效。该变更会改变既有指纹，旧账号基线、消息来源身份、检查点及已撤销授权的兼容恢复需另行核验，不能直接替换读取器后宣称全量同步恢复。

本次在隔离源码与合成资料中执行 `go test -json -race -count=1 -p 2 -run '(?i)notalone' ./cmd/wechat-cli ./internal/wcdb`，256 项通过，1 项既有真实安装程序版本检查跳过。未替换已安装读取器，未执行业务资料迁移或真实 App 全量同步验收。

最新日常开发读取器已修复 APFS 目录条目计数和系统信号中断导致的误停：旁车变化后重验数据库白名单，`kevent` 的 `EINTR` 重试，其余异常仍失败关闭。原生 race 为 222 pass、1 skip。App 已验证持久化、重启去重、空闲增量及正式新增来信自动入库与复扫去重，详见核验记录最新追加。

该层叠加在锁定的官方 CLI 源码和既有严格只读补丁上，提供选定联系人元数据、目标结构检查、受状态与来源能力报告门控的普通历史及增量读取和受控快照诊断；不开放 SQL、任意路径、发送或密钥扫描。`notalone-history` 使用有界 JSONL，未知操作及未确认范围在打开来源前拒绝。

构建入口为 `desktop/scripts/build-history-cli.mjs`。输入必须是锁定源码、经摘要核验的 Go 归档及既有 WCDB 字节，输出只能是 `.scratch/sqlite-history-cli/` 的一个新直接子目录；不会替换用户工具或配置。构建先核验剩余空间，复制自有源码、补丁与测试，离线构建后只对新 CLI 作开发签名，并写入不含私人路径的 manifest。

原生查询通过精确整数、有界行数和真实 sqlite3_interrupt 收敛；取消等待本次查询结束后才允许关闭连接。来源守卫核验直接子文件身份并监听目录及文件命名空间变化。结构检查只投影目标 schema、声明主键、索引与触发器指纹，实例身份包含 schema_version/rootpage/建表 SQL 摘要。正常使用重启按 ADR-127 重新核验账号、数据库文件、来源分片及表实例；只有支持报告明确给出 `continuity='same-source-instances-normal-use-v1'` 且全部身份相同时，新进程才从头完整重扫，保留已删除或排除的本地出现键，不复用旧进程的不透明游标。任何已检测变化、缺项或失证都持久停读。相同身份标识下无法辨认的原位回滚不在连续性保证内。

快照原语在观察连接的共同 data_version 窗口内固定所有分片 reader，再通过声明的主键分页；持有期间的新提交不进入原快照。快照两分钟到期，关闭及取消先中断真实查询，再回收 reader。排序字段始终不冒充先后证据，server_id 非唯一时不签发别名。

状态原值捕获和真实消息资格分开。`snapshot-opaque-v1` 只用于明确的合成原语验证或无正文的单条元数据诊断，不构成真实 status 或恢复证明；支持档缺证时保持 unverified。锁定的官方 622 构建已通过本机真实读取验证；App 侧集成验收仍在进行。

正常 `pnpm run dev` App 已对一个获准会话验证正文持久化、读回和同进程 tail。全联系人扫描目前因 SQLite sidecar 变化被来源监测误报而暂停；App 新进程续读与稳定日常仍待验证，详见 `docs/verification/sqlite-private-history-support-03.md`。

普通读取的状态规则由本机受版本管理的 profile 提供，同时精确匹配完整 `local_type`、发送方向和原始状态；高位类型不会自动继承低32位类型的资格。规则值与 `StatusSemanticsVerified` 认证分开；只有已认证的 sent/received 文字及必要的服务端身份条件全部满足时才取正文。recalled、absent 和 unknown 只产生无正文状态，不阻断后续增量；未认证的 pending、failed、deleted 仍按 unknown 处理，不读取正文。支持范围只覆盖已核验的规则，不把单次样本推广为全部微信状态组合。

当前4.0.6/29387普通文字规则为本人状态2／3和对方状态3／4，均要求正服务端标识；这些状态不代表“已读”。非文字只输出 `metadataOnly:true` 的类型、位置和原始状态，正文始终为空，不宣称送达状态。10000只表示系统记录，不直接认证为撤回；应用消息49家族仅文件子类型6显示为文件，其余保留原类型并使用其他占位，不读取XML或引用正文。固定来源中同键旧文字变系统的保护由接受事务执行。

同一守卫进程内的增量使用不透明检查点：历史终页交付 `resumeCursor`，`tail` 按完整固定快照重扫并比较记录摘要，覆盖较小编号的新行和已有行变化，不把最大编号或时间当作水位。每页有界，未完成的一轮可在同一守卫中从检查点继续；只有完整扫描结束后才能判断旧身份消失，消失项仅输出未核验、无正文的记录。新进程不继承旧 history/tail cursor，而是在 ADR-127 的身份重验后完整重扫，再建立本进程内增量检查点。该路径需独立的 `incrementalTail` 能力认证。

`boundary-snapshot` 使用 `selected-history-boundary-v1` 许可，只枚举所选会话的完整本地身份集合，不查询正文或媒体。每分片保留独立 observer/reader 的实际 pre/post 取样和读完成证据，窗口变化只在有界次数内重新取样；集合超过上限或来源失证时拒绝返回完整边界。客户端复核范围、分片、精确成员及计数，并计算供 SQLite 原子接受的 manifest。此操作由独立的 `private-history-boundary-v1` 能力控制，未认证的真实清空仍显示边界待确认。

定向原生测试需设置 `NOTALONE_TEST_WCDB` 指向被核验的现存 dylib，测试只创建合成临时数据库。验收证据见 `docs/verification/sqlite-private-history-support-03.md`；最终产品字节必须另行核对，开发构建 manifest 不宣称真实微信通过。


`observe-metadata` 只在同一已解析目标及显式 `selected-message-metadata-v1` 下执行。每次固定全分片reader，仅按指定类型选择一条元数据；固定切面探针只投影常量，不额外取任意消息ID。输出不含正文、source/XML或媒体，字段、类型低32位与全部作用域均严格核验。无匹配返回NULL，未知状态始终unverified；观察不写正常捕获、不授予target/page或完整覆盖资格。取消、超时和Close仍等待真实读者释放。

受控阶段观察按方向隔离：`observe-test-metadata` 使用 `selected-test-lifecycle-metadata-v1` 观察本人新增文字；`observe-received-test-metadata` 使用 `selected-received-test-lifecycle-metadata-v1` 观察已选联系人的新增文字。两者分别维护 arm/next/current 基线和锁定身份，响应 format 不同，不能互用许可或借用另一方向的基线。只在唯一新增文字及发送者映射可证时锁定，出现多条、错误方向或身份歧义即拒绝；已锁定行之后允许报告类型变化或缺失。每方向最多两条、二十次调用、十分钟，均复验同一微信进程与来源守卫，仍只返回未核验元数据，不发送外部消息或授予正常历史资格。


`quarantine-target` / `quarantine-page` 是另行明确授权的一次性隔离快照，consent 固定为 `selected-quarantine-history-v1`。它要求所选私聊、固定版本结构、声明主键、来源文件及微信进程守卫均可核验，允许将未知文字交给独立本机隔离仓；状态始终 unverified，非文字载荷不读取，不能供普通聊天、检索、记忆或生成使用。普通 target/page 的认证门禁保持独立。此隔离入口的来源守卫只检测本次持有期间的变化，不承担 ADR-127 的正常重启身份重验。
