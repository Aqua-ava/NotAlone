只读最小delta复核完成；原active=1断言失败P2已修，另有1项P2启动失败边界，暂不签整体0。
审查只覆盖repair/draft/backend-ts/test两指定最终源，不把同名RED副本当最终，不重审parent-loss。
fixture SHA e3fbfdfe4e6e3c12ebb62b49d11f75b395bb20dad2699a8c6082ed656809300f。
test SHA 1e3f345ca1d61c40abf03384eb2c88a3d7f2707f1c91f810c0f06bb7c714f1a0。
已关闭：取得host且确认退出后，fixture:47–64先收集原排空失败、finally清理、单错误原样抛出，缓存reject不被吞。
新增真实额外PG连接回归test:70–98，要求active=1原断言/重复close同异常与全资源清理，旧正常主体不变；本轮只静态看源码。
剩余P2：fixture:38把!host当stopped；99的host=await launchDsh若拒绝，handle未赋值，49–51仍调用共享fixture的FORCE清库。
当前launch.ts:174–178明确启动清理不能确认时可抛backend_cleanup_failed；126–127也可能因Legacy退出核验失败拒绝，缺handle不是退出证明。
建议最小区分launch尚未尝试与已尝试未获handle；后者保留库/目录、关自有client、保留原失败，不能强删活库或kill未知PID。
详细控制流/行号见findings.md；无产品/main/index/票/原候选/原目标修改，零测试/DB/HTTP/CLI/模型/App/微信/网络/打包/push。
DSH锁定0.2.1-rc.2/687f282，无新增API；框架disposal开始不等于launcher完整退出，根负责后续delta与实际验证。
