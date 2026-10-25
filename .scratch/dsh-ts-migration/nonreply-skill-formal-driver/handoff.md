# Skill formal driver交接
1. 仅新增本目录；未改生产、冻结材料、oracle、primary、三个既有人类测试、index或commit。
2. 固定旧3c168296e9e8edaa43b8b323ff693e790e709069、新e60074b5946b8d1c990fcb75ba13bd58f789b2fb。
3. 相对9b20仅reply-comparison.ts已知16行差异；Skill/ModelHost依赖SHA相同。
4. 入口index.mjs/createSkillBusiness；从固定archive导入，沿FormalExecutor业务端口接入。
5. snapshot.mjs、probe-worker.mjs演示源码与端口接线；903文件独立SHA见source-binding-manifest.json。
6. 冻结broker四文件SHA见snapshot.mjs/BROKER_FREEZE；从兄弟目录只读复制，不跨改。
7. 新臂官方profile→startModelHost→生产SkillLearningTaskRunner/Runtime→Host.callExtraction。
8. 旧臂私有隔离冻结Store.capture/validate/save与LangChainSkillProposalRuntime.propose。
9. 不构造业务草稿绕过真实SDK、验证或PG；旧入口原本无ModelHost，差异保留。
10. 一次propose claim；成功后确定性verify claim；SDK/business重试0，未启动自动Worker。
11. 完整Host默认最多3次claim未改、未认证；不能把单次runner叫完整后台重试合同。
12. 最终同一budget统一4pair/8HTTP：probe-mltosA-summary.json，verification-iZTZtI.json。
13. HTTP8=outer reserve8=journal physical8=PG ledger8；预算1000/used8/remaining992。
14. correction旧/新均成功非空pending1/revision1，s4与消息依赖/目标v1绑定，启用v1不变、发布0。
15. 503两臂各1HTTP/1PG失败/0草稿；未靠耗尽额度模拟0重试。
16. 持久关闭授权再返回late非空提案；两臂cancelled/0草稿，请求与PG各计1。
17. 缺终态两臂unknown；保留原executor/business.failed与broker.unknown，不升级成功。
18. 成功pair完整五阶段与SDK首token；失败/取消无最终持久结果保持null。
19. 实际输出393216、费用unknown/不设门槛；旧top_p1、新省略照实记，不认证正式同配置。
20. 时间资格clock-evidence.json：公开学习无as_of/clock；保留来源观察时间和实际壁钟/PG时间。
21. 不改Date、PG now、租约或oracle；formal preflight实际因缺少时间/语义资格拒绝。
22. 新公开approve缺comparison实测500/internal_error；pending1/v1不变；独立源修复由根协调。
23. 该5xx旧证据冻结，不能叫完整审核HTTP通过；修复后只做新pin小差异补验。
24. 四个相关集成测试实际4/4；probe-history.json保留13轮/35HTTP/35reserve及失败/unknown。
25. 首次统一8HTTP后有1个旧取消夹具收尾见1连接；原失败和独立清理回执保留。
26. 精确核验自有worker、scope/source SHA/任务cancelled与0连接后drop；现夹具一次有界1.5秒等待。
27. 最终8fixture均drop/无连接；source snapshot44604KiB→0、自有引用进程0；raw保留0700/0600。
28. manifest与log-bindings绑定全部raw/public SHA；初始两个依赖错误无原工具raw日志，明确unknown不补造。
29. 最小命令：node --test 本目录/driver.test.mjs；node 本目录/verify.mjs（Node24/现有依赖/合成PG）。
30. 原1056非回复/1152总分母不变，当前observed8/not_run1048；120/96/完整矩阵/独立语义未执行。
31. 正常新业务与PG准备0Python；冻结材料导出是离线准备，旧对照Python仅私有夹具。
32. 根独占App/微信/Git；本轮真实供应商/App/微信/外部消息均0，不读真资料/.env/旧账本。
33. 日常开发只npm run dev，禁止自行打包或运行包；本任务未启动桌面，不再委派。
34. 25/26不批准；工程driver可接入不等于正式质量、完整调度或实际渠道通过。
