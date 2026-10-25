# 冻结 input-v1 独立运行补审

代码结论：`undetermined`。该冻结输入的 Standards 静态检查及本轮目标独立运行检查均通过，无可行动问题；尚无最终提交，正式 `approve` 仅待最终 commit 及相同源码摘要绑定。
总体门禁：不批准，25 `claimed/not approved`，26 `open`。本轮结果不放行性能或最终 App/微信验收。

- 输入 manifest：`3513144b9dd7e53825a52c262a3df7ce631616928e0d93ff8b267b81c5c86deb`；捕获 HEAD：`3a550efb6f59342b487b212c65b5819fa7b1425c`。六份覆盖源文件在运行前后均与冻结 bytes/SHA 一致；未使用当前 WIP 源码。
- 自有 0700 私有快照从捕获提交提取必要 TS/Python 源码、迁移及夹具，再覆盖六份冻结文件；已安装依赖只读复用，摘要与初次静态绑定一致。执行环境只传允许项，使用合成 HOME/TMPDIR、禁用 dotenv，不读取真实配置或原库。
- 运行版本：Node `v24.19.0`、`Python 3.12.15`；每个尝试为一条 180 秒有界串行流程。成功尝试合计 20.839 秒，此耗时仅为验证调度记录，不是性能验收样本。

| 阶梯 | 独立执行结果 | 公开原始输出摘要 SHA-256 |
| --- | --- | --- |
| pg 原生 Query/回调/thenable 单例 | 7/7 通过 | `5d8b9378e544798c9d1cfa356b0033c469725f3881449f6077f1b9d252de92e9` |
| 相关 pg 错误、重入、只读事务、取消与关闭 | 31/31 通过 | `674b032474c628b557c811112b15b9e83a2419115da4cef0da07fbe17ed951c1` |
| 存储租约、passfile、文件身份、实时 catalog、迁移资格 | 13/13 通过 | `80ebcde383a048e3354e4e8d30e17f55aa285c9ef06bd628350d0b45dcade9a6` |

单例 7 项已包含在后续 31 项，不能重复算作独立覆盖数。后两组共 44 个测试结果记录；未运行全量。命令为 `node --test --test-concurrency=1 --test-reporter=tap --test-name-pattern=<具名范围> <对应测试文件>`，精确过滤式和快照闭包见 `attempt-03/run-validation.py` 与 `runtime-input-binding.json`。

第一轮在解包准备阶段因本机标准库 API 不兼容终止，未运行测试。第二轮夹具因允许环境未含 PG 用户而报 `28000`，未到 HostStorage 业务断言；该轮遗留的一个自有合成库已清理。原始错误、原日志、失败结果及原脚本全部保留；第三轮仅修正审查夹具环境后按原测试运行，没有修改产品、测试断言或门槛。

`runtime-result.json` 与各日志均保留原始/公开双 SHA；成功日志不含私有路径，双 SHA 相同。原始日志为 0600，private 目录 0700。原静态 report、binding、handoff 未覆盖。未启动模型、App、微信或新依赖，未开其他 Agent/chat，未改索引或 Git。

最终只读清理审计：本轮共观察 32 个自有随机 `_test` 库（包含第二轮 1 个），库、活动连接、自有进程及临时运行目录均为 0。审计显式指定的 `/dev/null` passfile 被 libpq 按非普通文件忽略并发出警告；没有使用实际 passfile。证据目录按要求保留。

**独占负载窗口已释放，后续只整理证据，不再运行负载。** HTTP 性能 RED、正式40startup/RSS、最终回复96、最终实际App/微信及1056/120 deferred 的既定门禁不由本轮改变。
