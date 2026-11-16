# 私聊历史窄读取开发适配层

本目录在锁定上游 CLI 源码与严格只读补丁上维护 NotAlone 窄协议，提供选定联系人元数据、历史／增量、引用和受控媒体能力。当前产品读取、授权、去重与失效规则见[微信同步](../../architecture/current/wechat-sync.md)及[数据契约](../../architecture/current/domain-data.md)，接线见[正式窄客户端](../../backend-ts/src/history/wechat/native-client.ts)。协议或构建存在不证明真实渠道能力已认证。

## 构建与开发切换

完整上游源码放在仓库根目录被 Git 忽略的 `local-tools/wx-cli/`；本项目扩展保留在当前目录，未提交的上游工作副本编辑不进入固定 Git 对象构建。输入来源与 Go 归档按 [wechat-sources.lock.json](../wechat-sources.lock.json)核验，WCDB 必须匹配构建器固定摘要。

从仓库根目录显式构建新制品，命令以 [build-history-cli.mjs](../scripts/build-history-cli.mjs) 为准：

```bash
node desktop/scripts/build-history-cli.mjs \
  --go-archive "/绝对路径/锁定Go归档.tar.gz" \
  --wcdb-library "/绝对路径/libWCDB.dylib" \
  --output-directory "/绝对路径/NotAlone/local-tools/wx-cli/.notalone-builds/新的目录"
```

默认源码即 `local-tools/wx-cli/`，隔离对照可明确指定 `--source-directory`；Go 和 WCDB 路径必填，输出须为 `.notalone-builds/` 下尚不存在的直接子目录。构建核对空间、来源及摘要，使用自有副本离线构建并开发签名，manifest 不保存私人路径。它不安装到 App 或恢复读取授权。

App 运行目录也位于 `.notalone-builds/`。切换前先用 `pnpm run dev:status` 核对实例，并正常退出确认停读；仅在本机配置将 `wechatCliPath` 改为已核验制品的 `bin/wechat-cli`，随后通过 `pnpm run dev` 重启并再查状态。当前 SQLite 不展示旧路径编辑表单。移动目录须保留对应 manifest、同字节 WCDB 与合法来源兼容文件的权限和绑定，不能把旧别名复制到不同摘要的新制品。

旧组件构建器 `prepare-wechat.mjs` 的存在不恢复第三方组件捆绑分发或 App 发布权限。完整源码、运行目录和本机输出均不提交；App 打包仍按[发布门禁](../README.md#资源构建与发布边界)执行。

## 原库访问安全

所有账号、会话、联系人、消息、图片和头像库统一从首次连接使用只读主库及只读 SHM。原始路径按 `file:` URI 编码，以 `SQLITE_OPEN_URI`、`mode=ro` 和 `readonly_shm=1` 打开；文件名中的 URI 特殊字符不能覆盖这些参数。独立的原库只读 VFS 将 DB、WAL 与主 journal 的打开强制降为只读，并把真实只读 outFlags 返回 SQLite；保留原 Unix 锁及 SHM 实现、临时文件的正常行为。仅主库 mode=ro 仍可能让底层库以读写方式打开 WAL，不能替代该防护。缺少 SHM、无法安全初始化、锁忙或 I/O 暂不可用时停止本次读取并按既有调度重试，不创建旁车，不回退到可写连接、`immutable=1` 或 `nolock=1`。

应用在启动任何原库读取进程前核验制品摘要、`rawSourceSafety: wechat-raw-source-readonly-v2` 及实际二进制安全标记；只有给旧 manifest 添加字段不能获得读取资格。更新制品不恢复授权，也不放宽来源身份核验。原件打开模式、截短和跨进程锁的回归要求见[共享内存崩溃防复发](../../docs/guides/wechat-shm-crash-safety.md)。

## 账号、许可与共享进程

`notalone-history` 使用有界 JSONL；未知操作、身份或许可不合法时在打开来源前拒绝，不开放 SQL、任意路径、发送或密钥扫描。操作字段与验证以 [notalone_protocol.go](cmd/notalone_protocol.go) 为准。

- `wechat-shared-process-v1` 以排他租约串行切换联系人。`release-selection` 必须带当前账号、会话与 `selected-metadata-v1`；返回 released 前关闭快照、增量状态、阶段观察基线与图片令牌，再允许 resolve。账号守卫与账号级图片密钥通道保留至进程结束；旧目标及令牌不能因切回恢复。
- `imageOpenIsolation: wechat-image-open-local-v1` 声明 `image-open` 按影响范围返回错误码：会话、目标、来源代次、快照与守卫失效保持 `history_scope_unverified`、`history_target_*`、`history_source_changed`、`history_snapshot_*` 等原码；并发打开超限为 `history_image_request_invalid`，查询失败与解码被取消为 `history_image_read_failed`；只有本张图片的关联缺失、本机文件缺失、内容核验、格式与解码失败使用单图码。TS 客户端仅对声明该协议的制品，把这五个单图码当作当次 `image-open` 的局部失败：保留进程、选择范围与其他联系人的守卫；`image-read`、`image-close`、其余错误码、超时、取消和非法回执仍终止读取。旧制品不因 TS 升级获得该资格。
- `metadata-sessions-all` 使用独立 `all-session-list-metadata-v1` 许可，仅返回账号内有界会话身份、显示名及类型，不查询摘要或正文，不扩大私聊授权。未知类型、格式错误与身份冲突不能通过丢弃候选制造唯一匹配。
- `metadata-avatar` 需要已核验账号、精确私聊与 `selected-contact-avatar-metadata-v1`；只从 `head_image/head_image.db` 按该联系人的稳定 `username` 读取本机头像位图，缺失为 null；不读取头像 URL、不发出网络请求。回执使用 `wechat-contact-avatar-local-v1`，最多 256 KiB，后台负责完整解码、缩图与本机持久保存。它不枚举联系人或授予历史资格，界面只读取已保存的头像。

产品全部私聊是用户明确授权的可选范围，读取器单次操作始终核验精确对象。元数据列表或协议可表达范围，不证明当前 SQLite 界面已开放全部私聊授权。

## 来源、快照与增量

来源指纹与实例比较不使用系统设备号；指定文件名、inode、创建时间、链接数及文件类型各按来源合同核验，目录链接数不参与身份。守卫监听文件与命名空间变化，微信进程身份也须持续成立。

`source-identity-aliases.json` 是已核验来源身份的受控兼容文件，须绑定当前制品摘要、配置账号和来源目录摘要，并核验所有者、0600、普通文件、大小、UTF-8、无重复键和一对一映射。缺失或不符不能自动扩大授权，也不证明新旧资料连续。

[升级器](../scripts/upgrade-history-image-cli.mjs)的 `prepareAliases` 只接受已审查的固定旧／新配对并核验完整构建链、身份算法与旧别名绑定，产生独立凭证且拒绝覆盖。prepared 只表示制品与别名证明完成；启用前仍须逐项核验现有授权对象的新旧账号、来源、支持档及分片／表实例，不修改旧授权或围栏，不复用旧进程游标。

快照在共同 `data_version` 窗口固定分片 reader，按声明主键分页；快照持有期间的新提交不混入。查询受精确整数、行数和真实 `sqlite3_interrupt` 限制，取消须等待查询结束再关闭连接；快照到期按既定协议处理，不把排序字段当成时间或身份连续性证明。

历史终页返回不透明 `resumeCursor`，后续按 [ADR-133](../../architecture/adr/133-page-delta-private-history-sync.md)的变化页和持久检查点补差，不能描述为每轮完整重扫正文。声明 `durableHistory` 的读取器另支持 [ADR-164](../../architecture/adr/164-resumable-history-slices.md)：`page` 请求 `checkpoint: true` 可在非终页返回独立 `checkpointCursor`，应用同事务接受后才允许切片和恢复。部分点不表示历史完整；恢复重新核验来源并建立新快照，补读未完成身份、已读行变化及待核对缺失。最后未持久片段可能安全回放，旧进程内分页游标不继承；相同身份下不可辨认的原位回滚仍不在保证内。

快照补差的原始页（分片 `.db`、`-wal`、`-shm`）、读盐和来源守卫的额外句柄按文件身份与打开方式复用，并在仍有源 SQLite 连接时保护实际关闭；原库连接全部结束后排空。关闭单个快照不足以证明其他快照的锁已释放。macOS 的 POSIX 劝告锁按“进程＋文件”记录，同一进程对同一文件的任一句柄关闭都会释放该进程在其上的全部锁，使 SQLite 共享内存的存活标记与固定快照的读标记失效。与原库无关的图片守卫及时释放；共用读句柄的读盐使用固定偏移，不共用可变游标。新增原件打开须经过同一生命周期入口，由 [锁保持测试](cmd/notalone_delta_locks_test.go) 和 [原件只读回归](wcdb/notalone_source_readonly_darwin_test.go) 覆盖。

`boundary-snapshot` 使用 `selected-history-boundary-v1`，只枚举所选会话的有界完整身份集合，不读正文或媒体。独立 observer／reader 的采样与读完成证据、精确成员及计数共同组成客户端复验的 manifest；未认证、超限或失证时不能宣称完整清空边界。

## 消息类型与正文资格

状态原值、来源能力和真实语义认证分别管理；规则按完整 `local_type`、方向与状态匹配，高位子类型不能继承低位类型的资格。只有已核验支持档允许的消息才取正文，未知状态明确保持未知，数值本身不证明已读、送达或撤回。

普通文字、引用回复和图片各用自己的受控能力。引用类型 `(57 << 32) | 49` 已有独立 [quote 适配](cmd/notalone_quote.go)与正常页内引用处理，不能再用“所有 49 家族均不读 XML／引用正文”的旧说明否定它；其他富消息和转发也不会因此获得任意正文展开权限。引用作者、实际正文与目标消息关系分别核验。

非文字占位不冒充实际媒体。图片由 `image-open/read/close` 及正式能力报告控制，实际图文记忆输入遵守 ADR-153。微信侧撤回或消息缺失与本机已保存资料的保留、使用资格分别处理，当前规则见 [ADR-128](../../architecture/adr/128-deduplicated-wechat-message-storage.md)；系统类型 `10000` 不能单独证明撤回。

## 显式诊断与隔离原型

- `observe-metadata` 使用 `selected-message-metadata-v1`，只投影指定类型的单条元数据；无正文、XML、媒体或普通捕获写入，不授予真实状态或覆盖资格。
- 两个方向的 `observe-test-metadata`／`observe-received-test-metadata` 分别持有基线、身份与许可，不能互借；仅在唯一新增文字及发送方可核验时锁定。它们不发送消息，也不授权普通历史读取。
- `snapshot-opaque-v1` 只用于合成原语验证或无正文元数据诊断，不构成恢复证明。
- `quarantine-target/page` 使用另行明确授权的 `selected-quarantine-history-v1`；未知文字仅进独立本机隔离仓，保持 unverified，不进入普通聊天、检索、记忆或生成，也不替代正常跨重启认证。

原型结论见[来源续证实验](prototypes/fsevents-replay-notes.md)和[状态隔离原型](state-quarantine-prototype.md)，只覆盖各自当时实验。

## 验证与历史证据

定向 Go 测试在构建器准备的隔离源码中运行，`NOTALONE_TEST_WCDB` 仅指向已核验现存 dylib；只使用合成临时数据库。构建及测试前确认实际源码、来源锁、工具链与输出归属，不能直接把扩展补丁目录当成独立完整 Go 工程。

既有测试与真实读取记录见[私聊历史支持核验](../../docs/verification/sqlite-private-history-support-03.md)及[历史读取器阶段记录](../../docs/history/desktop-development-history.md#历史读取器整理前记录)。旧累计条数、通过数、超时、暂停及单次恢复不描述当前运行状态，不证明新制品、全部联系人或完整 App 集成可用。本 README 整理未执行读取器切换、真实资料迁移或微信／模型调用。
