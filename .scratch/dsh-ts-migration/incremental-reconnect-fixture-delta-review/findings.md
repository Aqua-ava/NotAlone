# reconnect fixture最小修复独立复核

只读核对指定最终两源，未运行测试/DB/HTTP/CLI/App或修改主树、index、候选、原审查及票。未重审parent-loss。

已审正式候选路径与SHA256：

- `backend-ts/test/sync-incremental-reconnect-fixture.mjs`：`e3fbfdfe4e6e3c12ebb62b49d11f75b395bb20dad2699a8c6082ed656809300f`
- `backend-ts/test/sync-incremental-reconnect.test.mjs`：`1e3f345ca1d61c40abf03384eb2c88a3d7f2707f1c91f810c0f06bb7c714f1a0`

原P2的**已取得host、退出确认成功而active=1**路径已关闭：fixture:47捕获原断言，48–57继续清理本轮资源，63单错误原样抛出；`closed`缓存的仍是同一拒绝结果。最终test:70–98通过真实额外PG连接制造排空断言，要求原断言actual=1/expected=0、重复close同异常、client/库/目录/profile/lock消失；没有catch后改绿或skip。旧正常用例只增加pg import，主体行为不变。作者红绿仅作他人执行证据，本轮没有复跑。

## 剩余1项P2：没有host handle不证明启动未留下活宿主

位置：最终fixture:38（`let stopped=!host`），关联99（`host=await launchDsh(...)`）、49–51（`stopped`为真调用`f.close()`）。

如果`launchDsh()`已经开始创建宿主，但因启动清理失败而拒绝，99的赋值不会完成，`host`仍为undefined。teardown就把`!host`视为已确认退出，即使45–46检测到业务连接尚在，也仅收集该断言后进入51。现有`host-storage-fixture.mjs:26–29`的`f.close()`使用`DROP DATABASE ... WITH (FORCE)`并移除本轮目录，会切断尚未确认停止的活宿主数据库和归属文件。

这不是假设launcher拒绝必然已经清理：当前`backend-ts/src/launch.ts:174–178`明确在内部`handle.terminate()`无法确认完成时抛`backend_cleanup_failed`；126–127的release也可能因Legacy退出核验失败而拒绝。不能用未获得返回handle代替退出证明。

最小建议：区分“尚未尝试launch”和“已尝试但未取得handle/退出证明”。前者没有宿主可正常释放；后者不能令`stopped=true`，应保留原启动失败、关闭明确自有client并保留库/目录供归属核验。若有可靠退出证明才可释放本轮库；无需改生产launcher、扫描/kill未知PID或放宽自然退出断言。

该finding只针对本次明确要求的未确认停止边界；不否认active=1原反例已修复，也不要求新增Electron/20追赶范围。原test的失败`t.after`仍保留拒绝，未发现把失败用例当PASS的第二项问题。

固定DSH仍为`0.2.1-rc.2/687f282e8625c6b8d11ff58211a90524be2e4317`。此次delta没有新增直接DSH API；通过现有launcher等待完整退出的公共handle，官方profile/shutdown依据沿原审查，不能把框架disposal启动等同最终退出。
