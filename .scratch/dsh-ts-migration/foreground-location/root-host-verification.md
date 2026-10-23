# 主协调09与21联合宿主验证

日期：2026-10-24。前台接线已应用当前工作树；官方DSH锁定0.2.1-rc.2、源码687f282e8625c6b8d11ff58211a90524be2e4317。

在 `backend-ts` 目录，用 Node 24 执行：
`node --test --test-concurrency=1 test/foreground-location-host.test.mjs test/memory-preferences-host.test.mjs`

8/8通过、0跳过，18.87秒。包括前台身份/歧义/改名/低置信度/关闭，正式桌面控制器经真实HTTP的人工门，旧删除内部revoke取消在途TS探针；09认证隔离、偏好无损大整数/CAS、管理停收排空与结构失败拒绝回退、纠错后缺失及过期概览缓存的旧分层读取。

首次错误地从仓库根执行，fixture按cwd查找profile导致ENOENT，未作为产品回归。修正cwd后先跑分层最小用例1/1（2.38秒），再执行上述两模块联合验证。

只用合成独立数据库和本地HTTP，测试自行清理；没有模型调用、真实微信或App交互。Mac锁屏的实际App验收仍未完成。09/21各自还依赖05尚未归档的助手删除端口/大小写折叠模块，工作树通过不证明孤立提交可运行。
