# 根时间尾零交接
只改 backend-ts/test/exploration-store.test.mjs；生产补丁范围：无。
原三处修复及原冻结17文件未变，核验见original-freeze.json。
根因：PG ::text省略尾零，原断言只换分隔符／+08，未转为Python isoformat。
先固定784690微秒，经真实PG和正式begin/read重现原比较RED。
修复使用独立Python datetime.isoformat，保留完整字符串比较；增加PG同值比较。
新增六个独立夹具覆盖784690/0/1/123456/10/100000微秒及+08/+00/+05:45/-05偏移。
逐项验证数据库六位微秒、任务完整精度／偏移与快照不变，没有JS Date或毫秒降精度。
原记忆用例加入五种固定微秒，Python capture完整深比较、指纹与来源依赖断言保持且通过。
最小命令（backend-ts/；PATH加Conda NotAlone/bin）：
node --test --test-name-pattern='根时间尾零与零微秒' test/exploration-store.test.mjs
结果：RED 1/1；修复后GREEN 7/7（含父用例）。
node --test --test-name-pattern='记忆最多两条，原零相关度排序仍保留' test/exploration-store.test.mjs
结果：1/1通过。
相关模块：node --test test/exploration-store.test.mjs
结果：15/15通过，8.073s（9顶层+6子用例）；全量计数相对原模块增加7。
node --check及git diff --check通过；未运行全量。
跨时区探针触发旧冻结快照失效，保留失败证据；最终按时区独立夹具，不放宽来源复验，也不宣称跨时区旧快照兼容。
关闭钩子已回收自有测试库／连接／临时目录，相关合成测试进程为零，无调试插桩。
0外部模型、0App／微信，未读真实配置／原资料，未打包、改index或提交。
原全量backend-full-dd97457b.log未改写；原始日志0700/0600，公开副本脱敏。
raw/public SHA、原日志摘要见verification.json与baseline.json；冻结见manifest.json和freeze.sha256。
主协调负责集成提交与剩余全量／桌面验收，本交付不代表Ticket25整体完成。
