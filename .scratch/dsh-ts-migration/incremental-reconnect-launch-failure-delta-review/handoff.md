最后窄delta只读复核：0 finding；2580fa57的“已尝试launch却无handle仍FORCE删库”P2已关闭。
仅审launch-failure-repair/draft正式两源；没有重审parent-loss或改原审查/候选/main/index/票。
fixture SHA d095a27712d03ff68fcb1580e6d293ede32ad7084cb8febf8470a8f470f34752。
正式test SHA保持1e3f345ca1d61c40abf03384eb2c88a3d7f2707f1c91f810c0f06bb7c714f1a0。
完整delta仅声明launchAttempted=false（26）、初始stopped=!launchAttempted（40）、await launchDsh前置true（101）；旧业务/测试主体无改。
未尝试launch：stopped=true，启动前准备失败仍走自有存储释放；不会无故保留没有宿主的库/目录。
已尝试但await拒绝/无handle：stopped=false，61仅关闭自有client并保留库/目录，不能到53的f.close/FORCE分支，也不扫描或kill任何未知PID。
已有handle：43原terminate或waitForExit结果继续决定stopped；未确认退出保留现场。active=1原断言在finally清理后仍65原对象抛出；缓存reject语义保持。
正式test完全同字节；旧正常case及active=1真实PG失败回归的断言和失败t.after不变，没有删断言/skip/catch改绿。
作者6例VM仅纯seam：launch-failure-seam.test.mjs:11–13锁定完整fixture源码SHA，47 SourceTextModule原字节，50–56只替launch/storage/pg边界；内置fs保留真实临时普通文件。
两例launch失败active=0/1：create原异常同对象、close仍reject、storage.close=0/client.end=1、目录保留，72–80；启动前失败83–89断言close一次且目录移除。
已有handle正常92–98、active1保留原断言和重复close同异常100–108、未停110–116均核调用次数/存活状态/目录；verify或assert失败不被catch，65–68finally只清纯seam自有普通文件。
静态核作者RED为6例4pass/2fail/0skip、GREEN为6pass/0fail/0skip，same seam SHA3ede3302b1629407641cb8426a0e33917c9822bf2cff88c19f1bb2b48009634a；这是他人结果而非本轮重跑。
该seam不启动真实launcher/profile/PG/CLI/模型，也不证明自然发生backend_cleanup_failed；未把替身验证或临时目录清理冒充真实宿主回收。
DSH仍锁定0.2.1-rc.2/687f282，本delta无新增直接API，沿原launcher等待完整退出合同；没有重读整份官方文档或改核心。
根负责最小纯seam→正式两个case的最终实际接受；本轮只静态读取/hash与独占文档核验，无测试/DB/HTTP/CLI/LLM/App/微信/网络/安装/打包/push。
