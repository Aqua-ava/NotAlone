# 最终 e60074b5 的一对离线复核

结果：passed_localhost_pair_only。仅执行最终提交 e60074b5946b8d1c990fcb75ba13bd58f789b2fb 的一对既有 paired-decline:1 本机成功样例，2条逻辑记录/2次loopback业务HTTP；未运行8项套件、固定96采集或真实网络模型。

- 新旧臂实际wire均为393216，source audit均verified，五阶段的显式分区、请求摘要与最终持久结果逐一绑定；固定计划分母仍为96。
- 归档入口、5项生产/评测文件与最终pin逐字节相同，未混入工作树增量；依赖运行前后摘要相等。
- policy文件SHA：`123f5d6be9df09b0fbcfafe13f360baaeced73b807c1586970001006af86ed3a`；实际canonical SHA：`36cc9fb4df65fa7418968a9281cc510fe78a12ef5f208f6d0666545dbd4bf381`；范围快照SHA：`cb23a4c108170623e4ecd5288b09bec7b3c566c5cda8b1447aca164833a054b9`。
- 实际collector源码树SHA：`2e65ec90f21ba1e5467a3e08859661ac946c65b847621b4574451420098dc948`；执行候选文件集合SHA：`a29e39d0b517567a33dcab3a44280f6b96207124411db4a919716de7fc37f763`。
- arms_configuration_equal=false 与原始配置unknown原因保持；Prompt/协议语义等价、底层响应模型版本、真实质量及strict来源核验路线均未认证。这里只记录本机fake延迟及fake usage/cost，费用不冒充供应商账单。
- 真实模型调用0、实际App/微信操作0；Ticket 25/26及切换均未批准。

本轮冻结副本中的控制适配（原件未改）：

| 路径 | 适配前SHA256 | 适配后SHA256 |
| --- | --- | --- |
| `collector/primary.json` | `7579968367de21208170639e073c31b6531a3abcce03ccb27c3ae138750e19e3` | `b69ac0e7476c99fd712c6b652d3ef8a9c21740bbb5eabbbd5c89c05d70b58174` |
| `collector/vendor-forward.mjs` | `b940407b1b00f16feb9f5de062829535d1069d4a0ddd8ed5d2515c8cb0e49410` | `2b5684d2b3dd54e607a779c681d863934ca90a5e33b4910da3b43ec9c40a925e` |
| `collector/old-arm.py` | `eaad5c5315113a9b0544555195792140d931519325e375a16db97b6b32ff1c5e` | `e4af2369e2d79bff58f6a83acf4a113ce8cb8f42115da578f2dfdb62830da7df` |
| `generated/collector-plugin.ts` | `cd82821d94f4d0960482367c7b1bc60f97c39782420aa8e57b3a369d4a31fb5d` | `3965e2a8bbd2521f65a7713f3960a290aed1bc01c87f63a942900de6105902fa` |
| `backend-ts/test/reply-service-runtime-support.mjs`（仅原始wire观察） | `b757830e6451f4e6eb30c5d401d0dfb57cc7b2439cff882e751d03024a8a8b2e` | `c92058f716e3430c9dc72d5af23946007b727a791ca4af7376436ab31e1232da` |

清理：collector确认自有随机_test库、临时profile与子进程已释放；另核对无文件引用后精确删除archive/reporter-delta，磁盘占用17796→648 KiB。原始采集及日志保留在仓库外0700/0600路径，公开仅占位符与SHA。

原有core verification、artifact-manifest、SHA256SUMS、报告与交接逐字节未变，SHA见本轮verification的frozen_core_sha256。完整最终源码、profile、逐请求、来源/计时绑定及原始证据SHA见 [verification.json](verification.json)；本目录文件清单见 [artifact-manifest.json](artifact-manifest.json)。
