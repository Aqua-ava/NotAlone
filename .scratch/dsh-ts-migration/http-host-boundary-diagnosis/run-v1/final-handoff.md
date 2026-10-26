# 完整HTTP边界诊断交接（已清理并释放窗口）
1. 产品基线精确1e90；启动HEAD b8ba仅元数据；主树/依赖/三用户文件/index未改。
2. 原静态7文件和prepared冻结文件保持原SHA；旧状态作为历史保留。
3. 唯一实际流程墙钟16.848s，A旧→B完整baseline→C完整observer→D旧。
4. 三原case、单并发、每宿主每case10暖机+30计分，共480/480成功。
5. 原session持久HTTP回读160/160成功；模型receipt/ledger0、出站拒绝0。
6. A/B/C/D p50 contacts1.736187/3.863250/3.932292/1.887938ms。
7. sources1.193479/4.043937/3.959062/1.191167ms；session2.252854/2.594749/2.565854/2.237083。
8. 旧锚D/A p50漂移+8.740%/-0.194%/-0.700%；C/B +1.787%/-2.099%/-1.114%。
9. C/B p95 -11.485%/+2.224%/-5.503%；不能将顺序差异称纯观察成本或加速。
10. 两GET ingress→context p50 .032084/.024562ms，p95 .049741/.041479。
11. private await .007958/.005979，public await .001750/.001917；不足解释毫秒主差。
12. fresh inspect GET p50 3.020104/2.463980ms；逐请求占比中位77.580%/63.735%。
13. catalog residual await GET2.121729/1.822938ms，占54.234%/46.393%；files .478084/.368875。
14. residual是开始等待结果→恢复，不是已知PG返回→恢复；解码/PG/续点不可拆。
15. session两事务inspect1.023917/1.031917，residual .566146/.573688；inspect总占80.142%。
16. 每case marker40全/30计分；session事务点80全/60计分；完整逐label计数在analysis.json。
17. 120/120 marker finish齐，90计分顶层分段和HTTP误差0、时间逆序0、溢出0。
18. ready实际unconfigured、maintenance=false；task唯一刷新在首样本前37.028ms结束，重叠0。
19. 不新增GC/async hooks/profiler，不patch pg.query/callback/parser/Promise。
20. 原ALS/起止点保留，新阶段内存后退出一次落盘；客户端扰动亦已报告。
21. 实际plan Node v24.19.0且SHA匹配，不误报24.22.1；所有绑定前后true。
22. 控制PATH、显式OS user及两新臂同TMPDIR环境差异已公开记录，产品connectionOptions未动。
23. 下一目标host-storage.ts:431–457 catalog等待；具体PG/解码/续点假设见result-report。
24. 暂无产品patch依据；任何下一观察/产品修改先由root审阅，不启第二实验。
25. HTTP失败0；文本替换、检查模式、启动器前置错误均保留且未变成产品失败。
26. 两次早期静态错误stderr仅工具返回，原件缺口明确；实际driver/宿主raw全私有直存。
27. 自有库/会话/进程/源码与运行临时目录0，独立核对0；两份离线日志0644已修正0600，父目录始终0700，最终违规0。
28. 窗口已明确释放；目前只离线，无App/微信/模型/打包/远端。
29. 原样本result.json、C阶段JSON、analysis.json与result-report.md为结果入口。
30. 精确公开stage_paths、双SHA和所有payload摘要见final-public-manifest.json/FINAL-SHA256SUMS。
31. 未完成正式全量/96回复/40启动×60sRSS/最终App，不批准整体性能或25/26。
