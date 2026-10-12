# 最终候选B的实际组合与最小修复（2026-10-13）

对应[Mac20原票](../mac-desktop-app/issues/20-mac-app-delivery.md)。最终候选 `desktop/artifacts/goal-ocr-package-20261013-b/NotAlone-darwin-arm64/NotAlone.app`：ASAR SHA `25c3e21fd9a27d3b909c6448b03cf286c63e0817b21c78a1ec006d00038f1d6d`，包内probe十一输入锁定`7a61a001`。[B静态来源与现场缺项](goal-mac-20261013-provenance.md)独立记录。该包运行外部Conda后端，本场后端源码基点`6ca36359`，后续分项须各自记录新后端提交，不能都归为包内源码。

## 唯一原全量场及实证失败

Root预登记01:55:42.616–02:55:42.616（Asia/Taipei）、最多180次，静态预计158；仅由正式`test:app --suite`执行，workers1/retries0/repeat1/maxfail1，启用MAC_DELIVERY与ASSISTANT_LIFECYCLE，其余现场flags关闭。有限参数、280包文件初始摘要与deep strict签名先核。仅合成资料、独立userData／握手、随机_test库、受控CLI及模型；没有真实微信、OCR、外部供应商调用或新权限。

实际86项通过、1失败、4跳过、71未运行，测试报告5.4分钟，runner exit2。失败为`import-submit.spec.ts`首份导入bootstrap的第一个`/api/sync/status`请求，读取本轮`backend.info`为ENOENT；此时尚未导入或重装配。Root初按用例标题概括为重装配阶段握手问题，后按真实堆栈纠正，不能归因导入后删除握手。

确定接缝：ContactFixture的owned模式由App异步启动后端，`app.firstWindow()`只证明窗口存在。shared `firstImportBootstrap`直接发首个HTTP，没有等待认证连接；headless入口已先连接后端，因此旧页面通过不能覆盖该竞态。只在首HTTP前增加公开`本机服务已连接` exact等待、20秒上限；该文案仅真实phase connected时显示，不使用任意sleep、文件存在或HTTP重试。原503→导入6条→认证停读重装→新握手→200／空bindings／1source／queued任务等断言全部保留。产品代码与B包字节不改。

## 最小实际回归

Root登记02:10:40.225–02:20:40.225、最多且实际1次，以同一B包执行 `test:app tests/import-submit.spec.ts --grep 首份导入后`。同一原失败场 **1/1通过，7.4秒（报告7.7秒），runner exit0**。App PID与userData当前不存在、租约absent；类型检查通过。仅该最小回归通过，不把71未运行写为通过，也不重开整套。

独立Standards和Spec均0项，核了公开认证状态、原后续断言和真实失败位置；评审不运行App或HTTP。共享scenario更改只用于验收就绪协调，不改变产品同步、导入、记忆、供应商、默认维度门或产品自动发送能力。一次真实红与同包绿分别保留。

## 本轮收尾与证据

全量目录 `desktop/artifacts/goal-final-suite-20261013-b/`（0700）：session-plan、package-before、runner.log、results、post-failure-census、lease-cleanup-preflight、candidate-process-census、lease-retirement。最小回归另在 `desktop/artifacts/goal-import-bootstrap-replay-20261013-b/`，真实计划与失败上下文不覆盖。只提交本文及验收scenario，不提交私有产物或原始UI。

原场91个排程位置含3个文件级skip和1个body skip，88次初始App启动；已执行生命周期、联系人重开、快捷键重开与重复实例四个额外启动分支，共92次受控启动。其中89个App PID有独立收据，其余三分支按已通过的公开真实重开／退出断言和固定单执行代码计数，不声称broker持久保存了完整启动日志。最小回归再1次；本目标的两次OCR失败另外计数。

Root核原场90份owned记录、104个记录PID均不存在、所有记录目录及失败fixture目录不存在；B当前进程0、14个记录随机库不存在，限定测试库命名空间当次为空。runner保留的自有租约原UUID／PID／project／SHA／0700／dev/ino复核一致后，归档到本轮私有`retired-owned-lease/`，共享锁复查absent；未杀未知进程、删除业务资料或把兜底回收当产品退出成功。首轮清理断言误要求已由server.close移除的socket存在，未执行任何mutation；核实只剩lease.json后按真实身份安全归档，原cleanup_unconfirmed失败仍保留。

剩余71场会按原清单明确文件组继续，源码稳定及新有限场次登记之后才启动；不重复此前已通过部分。Finder、真实系统导入／快捷键、OCR、真实CLI退出及WCDB精确构建许可另列，普通合成App绿灯不代签这些缺项。原票claimed／needs-info、原四AC继续保持，不认证完整交付。
