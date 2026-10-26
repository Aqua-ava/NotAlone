# 静态诊断交接（未执行实验）
1. 生产基线1e90d9edde3a5c3ac0de08c018149dd79bbebdfc；本轮只静态。
2. 已应用diagnosing-bugs/codebase-design；继承RED，未自称重新复现。
3. 主树源码、三用户文件、依赖、index/Git提交未碰；只新增本目录。
4. 无App/微信、测试、PG、HTTP、typecheck、宿主、profiler或模型流程。
5. 无sub-agent/新chat；与root/前作者的既有chat互通已获授权。
6. Root独占App/微信；日常桌面只npm run dev，禁打包/packaged。
7. 已核实host-plugin:259→skill-host:87–89的async false。
8. 已核实host-plugin:455→host-reply:367→public-api:31–34的GET async false。
9. 二者无分支IO，但耗时未知；不能从await数目归因。
10. GET在:527–534经Handoff进Context；POST在publicApi内部走两事务。
11. withClient的COMMIT后finally释放也在关键路径；不得漏算。
12. 既有preload:45–57已ALS.run，完整/最小同用；不能称产品框架ALS证据。
13. app-boot实际包装ESM resolveSync/CJS _resolveFilename；不能声称无loader拦截。
14. 官方Include绝对插件URL→内部ModuleLoader.import；未见本链转译器调用。
15. 三固定路径未见运行时import证据；关系概览分支的动态import不适用。
16. 静态导入量不是实际JIT/GC/heap证据。
17. 优先假设：前置分派；同代码storage/续点；GC/实际后台；JSON/观察器；loader/JIT。
18. 下一流程提议：旧锚→新完整原观察器→新完整阶段观察器→旧锚。
19. 共4宿主串行，3路径各10暖机+30计分，总480；readiness/原读回另计。
20. 预算180s（工作150/收尾30）；不自动补跑、加暖机/空闲或换最小服务器。
21. 同request_id收单调时点；只内存缓冲，原finish行保持，新阶段末尾一次落private。
22. 首轮不patch pg.query/parser/Promise；query await包含执行/解码/续点，仍不能分离。
23. GC/后台只记录真实时刻；CPU/ELU仅进程范围，观察臂对照评估扰动。
24. 测量前需root明确归还窗口；本目录无已实现runner/patch，不可直接当可运行流程。
25. 主树任意源码patch需先向root报依据/patch/验证计划并获授权。
26. 仅自有private子树写raw，0700/0600，不读邻居；不碰共享PG或原资料。
27. 原H1/H2均无净收益；H2准备错误/失败与metadata更正仍保留。
28. 固定输入/依赖SHA和本次源码/公开证据SHA在evidence.json。
29. 精确公开提交候选清单在staging-manifest.json，未add/commit。
30. 所有payload及manifest输出SHA在SHA256SUMS，静态检查在static-checks.json。
31. 未知：实际根因、ready/tick/GC重叠、观察器开销、loaded scripts/JIT、pg解码/续点。
32. 未执行全量/96正式回复/40startup×60sRSS/最终App；不得批准整体性能或25/26。
