# 本地HTTP诊断收口交接
1. 用户决定contacts/sources/session-default已知毫秒级退化为non_blocking_by_user。
2. 决定入口.scratch/dsh-ts-migration/local-http-latency-scope-update.md，commit23e96e91。
3. 该项不再阻塞25或26前置；其他硬门槛不变，不改历史gate为passed。
4. 25仍claimed/not approved、26仍open，其他验收由root继续，不等本项根因。
5. 立即停止三路后续实验、优化、完整根因查明；不准备native-client监听/SQL变体。
6. 首轮完整HTTP480/480及其旧锚漂移/观察器限制原样保留。
7. v2旧run保留0成功/1失败/39未执行，缺失EXPLAIN对象继续unknown。
8. 新run40事务/80执行成功、10warm/30score，PG Planning/Execution p50 .195/.475ms。
9. 新run原catalog残余await p50 .514666ms，未复现完整宿主1.8–2.1ms，不跨轮相减。
10. 实际计划pg_attribute复合索引含attrelid和attname两条件，不认定text使索引全失效。
11. 40份新EXPLAIN原件已私有0600保存，旧缺失不补写。
12. 自有库/会话/进程/源码及运行目录已清0并独立核对，窗口已归还。
13. 原计划、所有失败/unknown、原始样本及冻结SHA不改；只新增本收口附录。
14. 原v2公开清单87路径，SHA5cad1290f457016e32941bf3597f84a5bcb0107581de7456779771285e907f60。
15. 本目录manifest/SHA256SUMS合并旧87路径及本附录精确清单，原文件未改。
16. 无新PG/HTTP/采样/生产或原文档修改，无index/commit/push/新App/模型授权。
