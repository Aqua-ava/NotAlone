# 19 全局会话 follow 的读取边界审计

本轮仅核对固定官方源码、仓库补丁和既有构建身份记录，没有执行实际 CLI、App、微信、数据库或模型，也没有修改产品代码或 Git 索引。本文不记录真实账号、联系人、消息或本机用户目录。

仓库审计基线为 `a268f20603477dcc22e88f30f3c0688c88c58ff6`。已复算 `desktop/wechat-patches/readonly-cli.patch` 的 SHA-256，为 `c143ef47728d32c5e647196c75efc33278b49647bd35f3f058b51aeb92ce06aa`，与 `desktop/wechat-sources.lock.json:114–118` 一致。

## 结论与适用范围

固定 CLI `2.0.1-rc.5`／`795071fa0591da5fc2c6ab94a70f22ccd93ef06c` 加当前只读补丁的 `tail --mode sessions --follow`，查询会话和联系人元数据，不查询或解码 `summary`、消息正文，不枚举历史消息正文，不在失败时回退到消息时间线或启动缓存刷新。这是沿 follow 入口单独核对后的结论，不能仅从 `sessions` 的输出字段或“严格只读”名称推导。

该入口面向当前账号可见会话的全局元数据窗口，包含未绑定会话及各类会话，默认最多读取 5001 行以检测截断；它不按某一已选联系人过滤。初始快照允许带较早的会话名称、身份和最近会话时间，不受单联系人正文 baseline 限制。`global_follow` 不表示已授权读取这些会话的正文。

实际工具身份沿用[真实 CLI 读取边界审计](../foreground-location/real-cli-read-boundary-audit.md)中的历史构建记录、锁定补丁字节、当前二进制静态 SQL 特征和文件摘要交叉证据，CLI SHA-256 为 `d566d4842b656ca5b07a8af0c1fdada5c225724e9e7fda28e409b06f117d0655`。该记录同时保留缺少组件 manifest、未证明实际进程加载哪个 WCDB 路径等限制；本次不重新执行或扩大这些身份验证，不声称完整发行验收。

## 固定调用闭包

以下官方行号均按固定 raw 文件实际行号；补丁行号按仓库文件。网页提取器去除空行后的编号不作为依据。

| 环节 | 已核对行为 | 证据 |
| --- | --- | --- |
| TS 启动参数 | `sessionEventsFollow` 默认 `scanLimit=5000`、`pollInterval=3s`；显式传 `--mode sessions --follow --jsonl --include-media-paths false --strict-read-only`，没有 chat、type-filter、keyword 或 history 参数。 | `backend-ts/src/sync-incremental-cli.ts:45–51` |
| CLI 分发 | tail/watch 分发到 `runTailCLI`；流式模式创建 server，在同一个循环调用 `toolReadEvents`，只写事件并续接返回 cursor。错误直接退出，没有切换模式或消息回退。 | [cli.go:276–281、712–749](https://github.com/r266-tech/wx-cli/blob/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/cli.go#L712) |
| 事件模式分支 | 显式 `sessions` 只调用 `readSessionEvents`；`readMessageEvents`／`toolChatTimeline` 是另一分支，不因空 cursor 自动进入。 | [tail_tool.go:14–29](https://github.com/r266-tech/wx-cli/blob/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/tail_tool.go#L14) |
| 会话读取 | 将扫描窗口设为 `scanLimit+1` 后调用同一个 `toolSessions`；不会在这里枚举每个会话的消息。产品补丁额外拒绝 sessions 模式的 history 参数。 | [tail_tool.go:116–138](https://github.com/r266-tech/wx-cli/blob/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/tail_tool.go#L116)；`desktop/wechat-patches/readonly-cli.patch:302–310` |
| 会话 SQL | 打开 `session/session.db`，仅查询可见会话的 `username,last_timestamp,sort_timestamp`。补丁同时删除 summary 关键词搜索、最近发送人及类型字段处理，不是查询正文后再丢弃。 | [sessions.go:12–73](https://github.com/r266-tech/wx-cli/blob/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/sessions.go#L12)；`desktop/wechat-patches/readonly-cli.patch:201–245` |
| 联系人补全 | 批量打开 `contact/contact.db`，只查 username、显示名和 verify_flag；失败只添加降级警告，保留身份回退，不读消息。 | [sessions.go:96–131](https://github.com/r266-tech/wx-cli/blob/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/sessions.go#L96) |
| 分页与类型 | `collectSessionPage` 只执行上层传入的会话查询回调；`decorateSessionRows` 只根据身份和验证类型设置 chat_type。函数位于 cache.go 不代表会打开缓存。当前 argv 没有 type-filter，执行一次窗口查询。 | [cache.go:1162–1204](https://github.com/r266-tech/wx-cli/blob/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/cache.go#L1162)；[agent.go:270–282](https://github.com/r266-tech/wx-cli/blob/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/agent.go#L270) |
| 事件输出 | 用会话时间和身份构造 cursor，事件携带上述会话元数据；初次无 cursor 仅输出窗口中最新的 limit 项，后续按 session cursor 续接。没有调用消息规范化、摘要解码或历史正文分页。 | [tail_tool.go:201–246](https://github.com/r266-tech/wx-cli/blob/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/tail_tool.go#L201) |

## 数据库打开、失败及缓存路径

- `main.go:378–402` 的 openDB 先 ensure，随后只打开指定的 session 或 contact 数据库。`ensure:93–147` 读取配置和密钥准备状态；缺少密钥时严格模式拒绝自动提取。`refreshKeysFromWxkey:150–154` 也在严格模式立即报错。补丁 `readonly-cli.patch:151–171` 固定严格只读及禁用自动刷新，不能由参数或环境关闭。[固定打开入口](https://github.com/r266-tech/wx-cli/blob/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/main.go#L378)
- WCDB `OpenWithKeyMap:154–163` 只读取指定文件的 salt 并匹配密钥；`OpenWithEncKey:127–136` 使用 `SQLITE_OPEN_READONLY`，`openWithKeyBlob:198–213` 设密钥及 busy_timeout 后返回。此链不调用 BackupTo、明文导出或复制表函数。[固定 WCDB 包装层](https://github.com/r266-tech/wx-cli/blob/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/internal/wcdb/wcdb.go#L127)
- `wcdb.Query:526–558` 只执行传入 SQL 并读取其结果列；`readColumn:602–622` 转换结果类型，不遍历未查询字段，也不调用聊天内容解压函数。Go 包的 zstd 初始化 `main.go:7664–7667` 只创建解码器，不能据此推断发生正文解码。[固定结果读取实现](https://github.com/r266-tech/wx-cli/blob/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/internal/wcdb/wcdb.go#L526)
- 当前 follow 参数不含 keyword，因此不会调用模糊名称查找；即使该辅助路径被显式使用，`main.go:8453–8479` 也只查询 contact 名称元数据。会话补全失败没有进入名称解析的缓存回退。[固定名称查询](https://github.com/r266-tech/wx-cli/blob/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/main.go#L8453)
- 此调用链不进入 `openCacheIndexWithWarnings`、`ensureCacheFresh`、会话缓存刷新或消息缓存导出。作为另一层保护，`cache.go:157–159` 的 ensureCacheFresh 在严格模式直接返回；这不替代前面的不可达性核对。[固定缓存保护](https://github.com/r266-tech/wx-cli/blob/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/cache.go#L157)

SQL 不投影正文并不等于底层存储页不含相邻字段；本结论限定于应用的逻辑查询、结果列、正文解码和导出路径，不冒称原生数据库引擎不会读取包含其他列的物理页。

## 已有证据与剩余验收边界

`desktop/wechat-patches/readonly-cli-test.go:210–245、278–308` 的既有合成夹具在 SessionTable 缺少 summary 等正文列时运行 tail/watch sessions，并检查禁止字段、只读文件字节及输出协议；加回 summary 后还验证正文独有关键词不会命中会话。这是已有测试代码证据，本轮未重新运行。连续 follow 本身由上述同一调用循环的静态闭包支持，不冒称本轮完成真实流式运行验证。

该结论不授予全部会话正文、历史导入或模型调用权限。所选联系人正文仍须由有效绑定、selected 范围、账号核验、总开关、严格的新消息下界和原 cursor 合同约束。观察到业务消息写入数为零不能单独证明 CLI 没有读取正文；本次判断依据是入口到 SQL 和结果处理的闭包。

本次没有发现需要为消除正文读取而修改 tail sessions SQL 的新增问题。若验收要求连其他会话的身份、名称和时间也完全不得观察，则当前全局 follow 仍超出该更窄范围，必须另行限制全局元数据观察，不能把 selected 正文范围当成全局元数据过滤器。启用策略、App 退出停读、真实模型禁用及完整运行验收由主执行者继续核验。
