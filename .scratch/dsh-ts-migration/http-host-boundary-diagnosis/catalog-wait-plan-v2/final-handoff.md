# v2 revision-03交接（已清理并释放窗口）
1. 新授权run40/40事务成功，10暖机/30计分，40原Q+40EXPLAIN完整，7.429秒。
2. 产品1e90、businessTransaction普通BEGIN、原SQL SHA8a15…及两108参数不变。
3. 实际PG16.15，read committed/read_only off；3SET保持，Node24.19固定。
4. 原Q dispatch→resume p50 .906291ms、files .359812、残余await .514666。
5. EXPLAIN client p50 .961375；PG Planning .195、Execution .475，同次和 .6725ms。
6. 30计分五个原Q边界齐；40对同连接，0额外setup catalog，1条设置控制查询。
7. 同次EXPLAIN未覆盖剩余p50 .291312，不能称纯客户端时间。
8. raw/EXPLAIN及首轮HTTP不可跨执行相减；固定顺序/装配/输出/观察偏差保留。
9. 40计划形状一致；主catalog pg_class SeqScan176/过滤786/loops1/hits24。
10. Hash Cond显示required.relname::text = c_1.relname，但不能由此证明cast根因。
11. pg_attribute实际用relid_attnam复合索引，attrelid与attname均入Index Cond，loops103。
12. checked_tables pg_class复合索引含relname name[]和namespace两个条件。
13. 不能称text参数让组合索引全部失效，也未复现首轮1.8–2.1ms残余。
14. 没有产品patch或下一实验，完整宿主根因仍unknown。
15. 采集修正只先保存command/rowCount/rows再验rows结构；40实际rowCount全null。
16. 40独立private原件初始0600、公开聚合结构一致，逐原件及section SHA单列。
17. 新原件保存位于client计时之后、断言之前；事务总时间含保存。
18. 旧revision-02保持0成功/1失败/39未执行；旧丢失计划/rowCount不追写，unknown不变。
19. 已安装pg Result纯内存单例0PG通过；新运行另授、不替换旧分母。
20. source/deps/input前后绑定及源码未变true；自有库/会话/进程/源码/临时目录0。
21. 独立核对0、权限违规0，窗口已明确归还；只有离线整理。
22. report.md、analysis.json、plan-facts.json为结果入口，全部40计划行和原样本保留。
23. 原计划、revision-02和revision-03执行前冻结件不改；无Git写入。
24. 聚合公开清单与SHA在上级final-public-manifest.json及FINAL-SHA256SUMS。
25. 无产品/HTTP/模型/App/微信/正式矩阵，不批准性能或25/26。
