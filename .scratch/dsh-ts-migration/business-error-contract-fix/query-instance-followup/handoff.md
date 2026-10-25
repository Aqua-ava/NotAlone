# Query 错误合同交接

1. 输入 ae12d7f1a407fc5852ae9c02d87253ded6828363；仅 host-storage.ts、新错误合同测试和本目录。
2. 原 Standards P2 稳定 RED：配置回调、Query 回调/事件错误漏记，真实写入仍全回滚。
3. 现 Promise、位置/配置回调、Query 内/位置回调与事件都返回受控数据库错误。
4. Query 原对象、排队中 callback/this、成功结果与 end 结果身份保持，支持冻结配置和只读 callback。
5. 额外 Query 自有 then 身份 RED 已修；不将显式 Query 消费为 Promise。
6. 解析错误优先于后续 PG 错误也受控；Query 超时仅一次回调；业务 NotFound/普通 Error 原对象保持。
7. 已核验 pg 8.16.3 本地源码与 SHA；未修改第三方包、连接、SQL 或 wire 协议。
8. 需 Standards 重点复核：受限观察 handleError/_canceledDueToError 两个 pg 实现细节，错误/end/同步抛错恢复入口。
9. 该入口非文档化公共 API，版本耦合已明确；升级 pg 必须重核验。
10. 最终两相关模块 43/43，0 skip，约 13.70 秒；TSC 退出 0；没有全量。
11. 冻结独立反例脚本由本轮重放：四种形式全受控，domain_identity_preserved=true。
12. fix.patch 精确两文件；manifest 载源码/测试 SHA、原始日志 SHA 与冻结证据核验。
13. 原核心六份、微信八份证据 SHA 均不变；已集成微信测试和原 Standards finding 未改。
14. fixture 全收尾，原始日志仓库外 0700/0600；0 真实资料/模型/App/微信/外部消息。
15. 未动 index/commit/push/PR；root 负责提交后让 Standards 仅增量复验。
