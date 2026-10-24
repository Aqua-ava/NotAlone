# cleanup-fix-v2 窄 delta 复核

结论：原 P2/P3 在 v2 候选中均已修正，本窄 delta 新增 finding 0；原冻结报告保留。P3 修复仍是 review-only 候选，原打包记录不改写；集成与实际业务组合验证由根负责。本结论不签 App、整05、25、切换或原业务矩阵。

P2：`candidate/reply-fixture-cleanup.mjs:43–63` 对各阶段加 deadline；两真实 after-hook 在 seed/config 前注册并调用同一入口。`:21–38` 仅使用原 spawn handle，未确认 pid 直接失败；TERM／KILL 回执均有界，强退后仍失败。`:64–85` 汇总原异常及 cause，停止失败、进程身份未知或连接关闭失败均不调用 disposeFixture，写 unconfirmed 证明并保留库／目录。自有 provider／PG client 独立收尾。主 public 夹具还记录已知 Legacy PID，启动身份未确认时保留现场；无 host 时安全释放空 fixture。没有新增 FORCE drop 或按任意 PID 杀进程。锁定 pg@8.16.3 的 end 重入分支与已记源码 SHA 匹配。

独立执行已有 `candidate/reply-fixture-cleanup.test.mjs`：9/9，0 skip；直接 VM 运行两实际钩子，覆盖 stop 抛错、worker 不退出、两钩子 host 未 spawn／正常退出、强退不能吞失败、多阶段异常保留。host 停止有界同时由共享 helper 的 deadline 路径核对。独立日志 `6d30bc3b5d8b5491ceeb739a0d582ca01805975e2d21eaf7917ab752942f80cc`。

P3：候选 `package-evidence.py.candidate:45` 只把两处 absent 改为声明的 fixture 根 parents[4]/parents[3]，符合原真实路径布局。仅 AST 提取该表达式并执行已有临时目录用例：1/1，验证 state 不存在但根仍在时 false，删除根后才 true；未运行完整打包脚本。独立日志 `4a1e4907298ebab12792323b024c88c4eed52ca60fd0fe6d63489c655a49d3fb`。

输入：manifest `aaa6a4394ff3a4ba989e64bd6f4e84173799afa05aea2ac5f7df97facdc7f7af`；P2 delta `8720c5c6b73927726f838d98c81f245e1e7309916e12984d82b3d8d2ce7cb7b0`；P3 delta `89cfec220ef66dbce85f99976fee2f88ec0f8c8b355842066cf507e91358f773`。源与实际日志全 SHA 见 `delta-input-sha256.json`。两 delta 及执行源匹配 manifest，作者5份日志双SHA匹配；原 c39fc9／236abb／21983c、原打包脚本及8份原raw SHA均不变。

实际新增活动只有上述纯 node／Python 临时目录测试；SDK、HTTP、PG、App、微信、新业务 pair 均0。仅写本审查目录，未修改原件、产品代码、index 或 Git。
