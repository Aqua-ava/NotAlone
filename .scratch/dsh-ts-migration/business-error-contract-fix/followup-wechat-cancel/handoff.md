# 微信取消围栏交接

1. 输入 dd97457bdd604fbda970c6eb0e5dc406ab1157bd；原单例已稳定 RED。
2. 根因是旧测试错误注入 ProbeUnavailable(cancelled)，旧 DB 包装偶然使其 reject。
3. 实际 HTTP guard 是 HostStorageError(runtime_stopping)，领域 Probe 失败本来返回状态。
4. 旧版/当前/停用 query 跟踪共九组差分：关闭和真实 HTTP 取消均 reject/runtime_stopping，四表零行。
5. 当前和停用跟踪结果相同，排除 query 包装回归和等待时序问题。
6. 仅改 backend-ts/test/wechat-setup.test.mjs；生产源码全部保持。
7. 原断言收紧为 HostStorageError/runtime_stopping，保留四表回滚；没有放宽 reject 或加睡眠。
8. 新增生产 API 在最后写入后 AbortSignal/api.close 用例，均 503/runtime_stopping、read=null、四表零行。
9. 单例 1/1；新增 API 3/3（含两子例）；相关三模块 38/38，0 skip，约 19.47 秒。
10. 没有全量；根冻结 backend-full-dd97457b.log 未读取或修改，历史 1454/1456 不改写。
11. 原 manifest 六份证据 SHA 全相同；host-storage 和既有业务错误测试也相同。
12. 本目录含 matrix、variant pins、命令/日志 SHA、精确 fix.patch 和 manifest。
13. 全部 PG/CLI fixture teardown 通过；原始日志仓库外 0700/0600，诊断链接已清。
14. 仅合成数据，0 真模型/0 App/0 真实微信/0 外部消息；无 index/commit/push/PR。
15. root 可仅集成本次测试与必要证据，再处理另一项全量失败；无需生产改动。
