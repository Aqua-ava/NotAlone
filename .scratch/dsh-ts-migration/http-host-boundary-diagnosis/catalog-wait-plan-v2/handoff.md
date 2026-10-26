# catalog等待计划v2交接（静态，未授权运行）
1. Root独占单例复现；0新PG/本地HTTP/采样/测试/产品修改。
2. 仅新写本目录方案、精确SQL/参数及source pins；旧七文件/run-v1均不改。
3. 产品基线1e90；host-storage SHA0c96568ae4d608beda97af03bbaba696f07148627ecae153b1692dc52ee94f25。
4. 原catalog SQL431–453，await457，selectors703–709。
5. 原SQL SHA8a15efb91f36745a9d06eeef6e4b503d68092c95c3a1da581b33a28eb8617670。
6. 参数两数组各108项、24个column=null；旧103是结果行数，不裁参数。
7. 推荐40真实HostStorage事务单元：10warm/30score，单并发、一自有_test库。
8. 必经inspect原Q原位计时，callback同一lease追加一次EXPLAIN+原Q/原params。
9. 共40原Q+40EXPLAIN=80次目标catalog执行；初始化/控制SQL另计。
10. 不另跑第三条raw Q，不跳fresh文件/实时catalog/ledger/约束。
11. 原BEGIN/3SET/COMMIT/撤销/DISCARD/5秒lease保持。
12. raw始终先于EXPLAIN，位置/缓存偏差保留，不假称随机因果配对。
13. EXPLAIN固定ANALYZE/BUFFERS/TIMING OFF/SUMMARY ON/FORMAT JSON；不SERIALIZE、不改GUC。
14. 40单元可查毫秒级PG线索，不足根因或性能门槛；p95仅描述。
15. PG planning不含parse/rewrite，默认EXPLAIN不覆盖正常结果转换/网络，且有观察开销。
16. 同EXPLAIN planning+execution可加；其client剩余不能称纯客户端。
17. 不跨执行相减raw/explain，更不减首轮HTTP/catalog中位数。
18. 当前只有HostStorage探针方案，无完整DSH/HTTP；环境差异不能归因框架。
19. 同批EXPLAIN核name/text cast落点、Index Cond各键/过滤/扫描循环，不新增SQL变体。
20. cast/SeqScan/IndexName存在都不能单独证明失去索引或根因。
21. 首轮无ready/dataRow观察；可选实例级观察须root另审阅，不global monkey patch。
22. 可选监听须在native client创建lease前安装并最终逐一移除，保持原监听顺序。
23. 不从lease读connection，会污染reusable；不监听Query.row/connection.message。
24. dataRow/ready前后也不等于完整wire解析或纯Promise排队。
25. 建议后续预算120秒（工作90/收尾30），尚未授权、未实现runtime patch/driver。
26. 固定Node24.19及原dump/双deps/工具SHA在source-pins；PG实际版本仍unknown。
27. raw初始0700/0600，launcher先开fd；所有失败/not_attempted/原件与双SHA保留。
28. 收尾仅关/删自有进程、连接、库、临时源码；不碰共享PG/root复现库。
29. 实施前先冻结私有patch/driver供root审阅；不从旧窗口自动继承许可。
30. 方案/public清单/SHA见plan.md、manifest.json、SHA256SUMS；无index/commit。
31. 官方文档链接仅核EXPLAIN语义，不冒充本机PG版本事实。
32. 不批准性能或25/26。
