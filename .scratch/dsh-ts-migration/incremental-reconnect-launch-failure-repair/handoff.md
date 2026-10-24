# 重连 fixture 无 handle 启动失败 P2 交接
状态：新窄候选已冻结；原目标、原结果、原正式回归保持不变；根负责应用/索引/提交。
来源 review manifest：2580fa572435b980b2f60cadf414b7b0be4e150d070d6cf5095bd561b12c94d3。
问题：launchDsh 已尝试但 backend_cleanup_failed 拒绝，无 handle 被旧 !host 误判为已停。
唯一修改路径：backend-ts/test/sync-incremental-reconnect-fixture.mjs。
输入 SHA：e3fbfdfe4e6e3c12ebb62b49d11f75b395bb20dad2699a8c6082ed656809300f。
输出 SHA：d095a27712d03ff68fcb1580e6d293ede32ad7084cb8febf8470a8f470f34752。
正式 test 不变：1e3f345ca1d61c40abf03384eb2c88a3d7f2707f1c91f810c0f06bb7c714f1a0。
单文件增量 fix.patch：251be393bce469f232c59c5fee99100f09e63a9585c873c6afeb0a922b133c80。
patch 基于 e3；已仓外 git apply --check、实际应用及候选字节核对。
根也可直接接收 draft fixture，搭配未变的 draft 正式 test。
修改：新增 launchAttempted，调用前置 true；close 初始 stopped 只承认尚未尝试启动。
启动已尝试而无 handle/退出证明时，只关明确自有 client，保留库/目录并失败。
原创建调用的启动异常对象原样上抛；重复 close 仍缓存失败；不杀未知 PID。
未尝试 launch 的准备失败仍可清理；已有 handle 的退出确认和 active=1 原修复未改。
同一完整 fixture 模块纯接缝 RED：6 例，4 通过/2 失败，0 skip、exit 1。
纯接缝 GREEN：6/6、0 skip、exit 0；覆盖 active0/1 无handle、启动前、已有handle三种控制。
测试通过 VM 执行完整字节，不复制 close；launch/storage/pg 是明确替身。
未自然到达真实 launcher backend_cleanup_failed；不把纯接缝当真实集成验收。
本轮真实 profile/PG/CLI/模型/App/微信、安装/打包/push 均 0。
原正常23秒案例未重跑；新候选正式两用例留给根独立执行。
纯接缝自有临时目录0遗留、patch-check树已删；无真实库或产品子进程需清理。
上一轮全部artifact与manifest、生产launch/sharedfixture、官方锁定文件逐字节不变。
DSH仍0.2.1-rc.2/687f282；没有新增核心/API修改。
独立复跑：$PY verify.py draft independent（新日志仅留仓外，不覆盖冻结证据）。
封存清单见 artifact-manifest.json；验证方法与限制见 validation.md。
