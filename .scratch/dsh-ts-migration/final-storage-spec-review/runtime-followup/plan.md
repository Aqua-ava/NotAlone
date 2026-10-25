# 小ACK与客户端合同：独立运行准备

准备时状态为`prepared_not_executed`；后经根明确归还窗口完成运行。仅`execution-v3/`为有效冻结证据，前两轮保留失败并排除资格。此计划不据此批准最终提交或25／26。

本探针在合成本机HTTP服务上组合冻结的生产`PureTsSync.handle`、`SyncPriorityController`和`JsonClient`。不启动DSH、产品后台、App或微信，不连接数据库或模型。增量／状态与账号查询采用显式测试替身；这些替身不证明PostgreSQL实际授权或删除链路通过，避免与其他审查的存储合同重复。

## 冻结与运行

- 输入仍为manifest `3513144b9dd7e53825a52c262a3df7ce631616928e0d93ff8b267b81c5c86deb`。
- `frozen-sources.json`冻结128份含类型依赖的源码；三份入口取v1，其他依赖取捕获提交`3a550efb6f59342b487b212c65b5819fa7b1425c`。esbuild虚拟解析不读取当前同名源码。
- `prepared-binding.json`记录源码、探针、运行器及已装esbuild／pg源码摘要。编译服务只在获准运行后启动，编译结束即停止；随后禁止产品代码启动进程。未安装依赖。
- 同一探针对base只做ACK正向断言，预期RED；candidate顺序做下面9项。两臂均保留原始返回，不重跑输臂。
- 授权窗口内由根指定可用Node路径，再执行：`python3 .scratch/dsh-ts-migration/final-storage-spec-review/runtime-followup/run-probe.py --node "$REVIEW_NODE" --runtime-window-authorized`。
- 总进程硬上限75秒，预估10–20秒；两秒期限只测一次。事件监听加单次有界超时等待，无sleep轮询。
- 运行前后重新核验静态v1的43份SHA256SUMS，不改原件。结果另存`execution-v1/`，已有结果目录则拒绝覆盖。
- 原始stdout/stderr保留独立0700临时目录，单文件0600；公开副本移除本机路径，公开摘要只含raw哈希。私有定位文件不得stage或作为公开证据。

## 九项可观察合同

1. 精确`?response=ack`返回极小登记回执；不读完整状态、发事件或填写读取／历史成功。
2. 无参POST与GET仍返回相同337行大状态，7条incomplete保留。
3. 附加／重复ACK参数、其他命令ACK、owner／账号注入、非法body均拒绝且不登记。
4. 原登记错误和缺失运行身份不变成成功ACK。
5. 初始clear在途切换两次，只串行登记null→最终联系人；目录外选择只清除；实际请求保持2000ms／16384字节。
6. 真正超过16KB的HTTP回执触发`response_too_large`，代际不变；下一事件重新clear后登记最新目标。
7. 阻塞HTTP在原两秒网络期限触发连接失败，随后按最新目标重试clear；测量耗时只报告，不新增性能门槛。
8. 在途连接代际变化取消旧请求，新代际先clear再登记最新选择；旧响应不能把提示改回旧值。
9. 错代际回执不确认clear；后续刷新重试，显式关闭只登记null。

## 边界与后续

这里独立验证的是接口组合、网络限制和客户端调度。真实账号绑定、owner+contact数据库隔离、读取／历史、持久删除、完整宿主关闭以及实际App／微信仍按原任务验收，不能由本探针替代。代码最终approve仍需最终提交与新delta，原v1含WIP；HTTP RED及其余运行门禁保持。

## 原始证据位置校正

root要求原始日志移到仓库外，已逐字迁到`spec-storage-ack-runtime-raw-20261026`，目录0700、文件0600；六份SHA全吻合。仓库内原始树已移除，仅保留脱敏副本和basename／SHA定位，详见`raw-location-correction.json`。该位置校正没有重跑、修改或丢弃任何观测。
