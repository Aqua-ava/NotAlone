# 无 handle 的启动失败：重连 fixture 剩余 P2

固定独立审查 `review-manifest.json` SHA `2580fa572435b980b2f60cadf414b7b0be4e150d070d6cf5095bd561b12c94d3`；输入 fixture 为 `e3fbfdfe4e6e3c12ebb62b49d11f75b395bb20dad2699a8c6082ed656809300f`，正式回归为 `1e3f345ca1d61c40abf03384eb2c88a3d7f2707f1c91f810c0f06bb7c714f1a0`。上一轮全部 artifact、manifest 与结果逐文件哈希不变。

证据排序为：一，`host=await launchDsh(...)` 的拒绝会使赋值未完成，但旧 `stopped=!host` 将它误认成未启动；二，launcher 必然已清完的解释被当前 `launch.ts:174–178` 的 `backend_cleanup_failed` 分支直接否定，release 也必须先通过原 Python 身份退出核验；三，即使该时刻 `active=0`，也不能推导未取得 handle 的宿主以后不会再连接，因此不以 PG 快照替代生命周期证明。

最小修改只有 fixture：新增 `launchAttempted=false`，调用 `launchDsh` 前置为 true，teardown 的初始 `stopped` 改为 `!launchAttempted`。已取得 handle 的退出确认、排空断言、原错误保存和原存储清理代码未改；正式回归整个文件逐字节未改。没有捕获或替换原启动异常。

结果为：尚未尝试启动时仍可清掉本轮自有存储；启动已尝试但没有 handle/退出证明时只关闭本夹具明确自有 client，返回失败并保留库/目录。已有 handle 时继续依赖 `OwnedDshProcess` 的完整退出结果。没有改生产 `launch.ts`、共享 `host-storage-fixture.mjs`、DSH 核心或 parent-loss；没有增加 PID 搜索、kill 或新的 FORCE 路径。

验证是纯隔离模块接缝：Node24 `SourceTextModule` 直接读取并执行完整 fixture 字节，输入 SHA 在运行前核验，没有抽取/复制 `close()` 或改写源码。真实内置文件系统仅用于本轮随机临时目录；`launchDsh`、存储 factory 和 `pg` 是显式边界替身。启动替身抛同一个 `Error('backend_cleanup_failed')`，用例要求原 fixture 创建调用向上传递该相同对象。它没有声称模拟成功相当于真实 launcher 的清理失败。

同一纯接缝测试 SHA 为 `3ede3302b1629407641cb8426a0e33917c9822bf2cff88c19f1bb2b48009634a`。

| 场景 | 旧输入 | 新候选 |
| --- | --- | --- |
| 已尝试启动、拒绝、无 handle、active=0 | 红：close 意外成功并清理 | 绿：自有 client 关闭，库/目录保留，close 拒绝并缓存 |
| 已尝试启动、拒绝、无 handle、active=1 | 红：存储 close 被调用 | 绿：原失败保留，存储 close 0，自有 client 关闭，目录保留 |
| 启动前准备失败 | 绿 | 绿：未尝试 launch，可清理 |
| 已有 handle 且确认退出 | 绿 | 绿：正常清理 |
| 已有 handle、确认退出、active=1 | 绿 | 绿：原断言对象与缓存错误保留，同时清理 |
| 已有 handle 但退出未确认 | 绿 | 绿：自有 client 关闭，现场保留 |

`seam-red.log`：6 例，4 通过、2 失败、0 skip、exit 1；`seam-green.log`：6/6、0 skip、exit 0。两次都是同一测试字节与完整 fixture 模块；唯一相关差异是上面的启动标志。结果文件保存输入/测试/raw 日志/脱敏日志 SHA。原样保留上一轮结果，不将其转签新候选。

没有运行真实 profile、PG、CLI、模型、App 或微信；没有自然到达真实 `launchDsh backend_cleanup_failed`。这项限制明确保留。原正常 23 秒用例没有重跑，当前候选的两条正式集成用例待根会话重新执行，不能凭这 6 个纯接缝控制宣称集成已过或 19 新签收。

所有纯接缝自有临时目录在测试 finally 删除，两个结果均证明剩余 0；patch-check 临时树也已删除。没有创建真实数据库或产品子进程，没有信号发往未知 PID，没有读取项目 `.env` 或用户资料。现有 Node 为 `v24.19.0`，无依赖安装。固定 DSH 仍为 `0.2.1-rc.2 / 687f282e8625c6b8d11ff58211a90524be2e4317`，复用前轮官方生命周期源码依据并复核文件 SHA；本次没有新增直接 DSH API。

`fix.patch` 是从 e3 输入到 d095 新候选的单文件增量，已仓外 `git apply --check` 和实际应用后逐字节核对。独立复跑命令为 `$PY verify.py draft independent`；追加参数使新结果只留在私有随机临时目录，不覆盖已冻结证据。绿色执行后只将 wrapper 的 try/finally 覆盖到临时目录创建之后的全部准备步骤，并做 Python 语法检查；fixture 与测试字节未变，不将 wrapper 小改冒充额外验收。
