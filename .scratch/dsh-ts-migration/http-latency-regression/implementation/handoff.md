# HTTP延迟局部优化交接（已冻结）
1. 状态：局部优化完成，真实HTTP退化仍在，不批准25/26；冻结后不再推进。
2. 基线HEAD：54aebef5ccad427d680ce243eb852c5bd4d91f1e；冻结生产e5d8183bff811bc9bdd466a3035deb0b6abf10e3。
3. 产品仅backend-ts/src/host-storage.ts:254、backend-ts/test/host-storage.test.mjs:291。
4. host SHA256：ca7663b4c8af53f8f30d8fc5fb3378d3af179c5528233d47fbd972dd5999d387。
5. test SHA256：4015603ed51e891c501a1754c25abffa72a6397410ccb70ea48dd14a0fc00cdf。
6. product.patch SHA256：a301bf6a10b9840b61e67e26438b171cfd3c89c0dca5352b7438fcb893a19752。
7. 根因：116文件I/O与catalog串行叠加；trace inspect4.486ms、files1.762、catalog1.197，连接+关闭约1.65ms。
8. 最小修复：仅并行完整文件哈希与catalog读取；allSettled保留文件错误优先级并收尾查询。
9. 每次仍全读116文件、核账本／基线／全部结构；不缓存成功、不少检查、不改SQL。
10. trackQueryFailures、withClient事务／关闭屏障、connectionOptions/TLS逐字未改。
11. 新安全回归含同大小／mtime字节篡改、读文件故障、恢复；旧版也通过，不冒充性能RED。
12. micro：原RED6.9318ms→初次GREEN4.7911ms→最终RED5.0260ms；5ms仅诊断阈值，全部保留且不重跑挑选。
13. 相关HostStorage/PG错误/receipt/claim模块82/82；最终安全单例1/1；typecheck及diff-check通过。
14. npm不可用exit127保留；改用已装node+typescript/bin/tsc，无安装。
15. HTTP before/after各旧新10/30×3例，总480/480成功，160次写回读全部成功，负载并发1。
16. after TS/旧p50：contacts6.655/1.843ms=3.61倍；sources7.505/1.311=5.73倍；session10.432/2.814=3.71倍。
17. 原统计阈值p50=1.15/p95=1.25、10000 bootstrap：after三个case全部failed；sources无明确改善。
18. 两臂HTTP观察均无全局pg/psycopg查询patch；不能拿root-preflight数值直接当本轮before。
19. 完整40次启动／60sRSS未执行；这里不是正式总体性能结果，root-preflight-summary未改。
20. after精确复制冻结源码并覆盖当前host字节；379文件只有host不同，before/after源码与依赖均核SHA。
21. 原/新各自事务设置未改；不同实现的实际设置见settings.json，不声称两臂隔离级别相同。
22. 元数据歧义字段已纠正，原capture保留，480行样本SHA完全相同；见metadata-correction.json。
23. 无模型调用/出站拒绝/模型缓存；自有HTTP进程、4库、work/profile/raw清理通过，设置探测另核0会话/库不存在。
24. 仅授权合成资料；无App/微信/原.env/原资料/用户backend-launch/预算/index/add/commit/push/远端/PR/打包/新agent/chat。
25. 仅串行自检，无独立Agent审查；root独占集成，staging-manifest.json列本任务候选文件与精确SHA。
26. 详细解释、命令、风险及全部样本在report.md与其引用JSON；剩余连接及完整核验开销未解决。
