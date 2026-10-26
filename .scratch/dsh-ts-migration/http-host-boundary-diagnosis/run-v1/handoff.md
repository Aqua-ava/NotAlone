# 准备冻结，诊断尚未启动
1. Root已收回窗口用于实际App；本轮立即让出，待重新明确归还后再启动。
2. HTTP样本0、PG连接/自有库0、宿主0；没有运行资源需清理。
3. 主树及原静态7文件未改，无index/commit操作。
4. 两份自有私有源码副本保留，模式0700/0600，无进程引用；不能误称已全部删除。
5. 六个源码文件仅私有计时插桩；没有pg.query/callback/Promise或额外async hooks/GC observer。
6. 准备阶段唯一替换断言失败已修正，原脚本与错误信号保留；0有效HTTP/PG。
7. 初次直接node --check TS模式不适用；改成类型擦除后JS语法检查，六文本通过，未执行模块。
8. 该首个准备错误stderr最初直接返回工具，没有从进程开始保存原件，保留缺口明确记录。
9. 后续准备/语法原始日志从开始留在私有目录，公开别名与双SHA在prepared-status.json。
10. 冻结plan实际Node为v24.19.0，二进制SHA与plan一致；不得误报24.22.1。
11. 控制PG显式取OS user，值不输出；pg_restore在已授权工具目录，产品连接配置未改。
12. Baseline与observer共同透传自有TMPDIR；此环境差异已记录，不能隐藏。
13. 首轮仍固定旧锚→完整baseline→完整observer→旧锚，480原10/30样本，预算180秒。
14. 运行驱动拒绝重复started.json；尚无started.json，不可把语法检查当宿主实验。
15. preflight.json绑定工具/输入/二进制；source-preparation.json及observer.patch绑定源码差异。
16. 本目录精确公开manifest及SHA见prepared-manifest.json/PREPARED-SHA256SUMS，未Git写入。
17. 尚无性能定位结果，不批准性能、25或26；不自动开始第二实验。
