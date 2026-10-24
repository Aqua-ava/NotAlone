# 官方profile增量重连永久回归根验收

根从冻结候选精确接收两个新增测试路径，fixture为d095a277、正式test为1e3f345c。产品、共享fixture、DSH核心和已提交parent-loss测试均未改；19既有签收不扩大。

根先运行完整夹具源码的纯模块接缝6/6、0skip，再在主树运行 `node24 --no-warnings --test --test-concurrency=1 --test-reporter=tap backend-ts/test/sync-incremental-reconnect.test.mjs`：2/2、0skip、约26.73秒。官方profile、真实Legacy和PG下，CLI自然code7退出，5122ms后新流接续metadata cursor，重复页得到规范消息2、创建回执2、复用回执4，历史及范围外正文读取0；关闭后跨heartbeat无新命令，正常退出。另一正式用例通过真实自有额外PG连接制造active=1，原断言和重复close的同一错误保留，仍回收本轮库/目录。

初次独立审查的失败清理P2及后续“已尝试launch却无handle仍强删”的P2均保留原finding。最终窄delta审查0 finding；launchAttempted三处修改只在未确认宿主停止时保留本轮库/目录并关闭自有client，启动前失败仍可清，已取得handle的退出确认不变。六例VM使用完整fixture字节、真实临时普通文件与明确launch/storage/pg边界替身，只证明分支，未自然复现真实launcher backend_cleanup_failed；不能冒称该分支真实集成已验收。

两正式用例全部自有测试库、目录、锁和宿主正常清理，未调用应急救援；共享PG保留。根日志原始与分享字节相同，原始冗余临时副本已清。只用合成数据和假只读CLI，真实供应商、App、微信、安装、签名、打包及push均0，不读取项目.env或私人库，不重复旧suite。两份根result及accepted-manifest记录精确源、原审查和日志摘要。
