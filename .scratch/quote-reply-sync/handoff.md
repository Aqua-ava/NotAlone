# 引用回复任务交接（已收尾）
状态：按用户要求停止修改；不以全量历史追平为本轮完成前提。
本任务本地提交：0adc05be（基础）和0f2f03c459bf5553726be86d6d5d57c98a86e57b（tail/关闭修复）。未推送。
并行图片任务提交：25563846，本轮引用提交未带入其改动。

当前实现：新旧引用都经消息入库后的后台扩展补齐；不含“新消息在正常读取中直接解析携带保存”的后续改造。
旧引用存history_quote，尝试存history_quote_attempt；schema26；parser版本wechat-quote-v2，不删旧尝试、不重置文字cursor。
仅exact49/57、owner2/contact4；缺原消息不猜关联，删除目标不能从快照复活；六类单条错误可恢复，来源变化停读。
普通历史结束进入tail后，引用可读，tail target/checkpoint/cursor保留；临时快照关闭失败清空内容并停用session。

实际验收：固定CLI→存储→API hash相同；CUA旧历史气泡中原作者/原话/回复分开。
最终CLI真实615条历史/39页转tail后，同一引用hash不变，随后原增量游标仍可继续。
切换最终CLI前已存413条引用；全量未补齐。新组件启动后未等待追平，剩余由后续任务处理。
基础150996条消息与任务前备份核对，ID/绑定/作者/类型/时间/正文均无变化。
最终升级285对scope核对：272来源相同，13隔离保留，授权未变；不解除这些隔离。
最小验证：原生race351pass/1既有skip，close修复后quote race29pass；TS/引用HTTP存储23pass；构建升级25pass。

当前开发实例：主仓pnpm run dev，App PID80218、launcher80168，日志/tmp/notalone-dev-quote-tail-v2.log；本机服务已连接。
桌面已释放，不再重启或操作。图片任务另有现有HTTP批量导入运行器，需由图片聊天自行恢复/协调。
backend-launch.projectDirectory是主仓；wechatCliPath指向下列最终组件。不要启动第二个dev实例。
CLI：/Users/local-user/Documents/learn/NotAlone/local-tools/wx-cli/.notalone-builds/quote-tail-20261101-v2/bin/wechat-cli
CLI SHA：93e85f1b7087cd901cb69ab5ab7fa714e14cbf67ad3e86c20619159c0b4c30b8；quoteReader=wechat-quote-normal-tail-v2。
图片Go与协议文件逐字保留image-content-20261101-v2，图片内容合同未回退。
Go archive：/Users/local-user/Library/Caches/NotAloneHistoryCli/go1.26.5.darwin-arm64.tar.gz
可复用Go build cache：/tmp/notalone-quote-tail-build-cache-20261101（按接手要求保留）。
CLI构建：desktop/scripts/build-history-cli.mjs；固定升级：desktop/scripts/upgrade-history-image-cli.mjs。后续Go改动需新目录及正规别名升级，不覆盖V2。
私有制品/aliases/receipt在忽略目录，不强制提交。业务DB/启动配置备份在userData/backups，不能放managed/sqlite。
临时固定开发副本已退出并清理约48.4MiB；此前旧编译缓存清理127.8MiB。当前Go缓存和已签发制品链保留。

关键文件：backend-ts/src/history/sqlite/service.ts:11,161（版本/补齐）；quote-store.ts（来源/去重/关联/事务）；quote-sync.ts（后台/停止）。
原生：desktop/wechat-history/cmd/notalone_quote.go:220（snapshot/tail/cleanup）；notalone_protocol.go（quote-read分发，未改普通page契约）。
UI：desktop/src/shared/message-quote.ts，renderer/ContactChatHistory.tsx；两处main/messages.ts共用解析。
验收记录：docs/verification/quoted-reply-history-sync-20261101.md；约束：architecture/adr/139-quoted-reply-sync-and-history-enrichment.md。
未实施：新消息内联引用解析/保存；全量旧引用追平；旧runtime guard恢复/同步架构改造。按用户指令留给接手聊天。
