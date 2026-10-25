# 微信首连取消围栏定点核验

输入基点：dd97457bdd604fbda970c6eb0e5dc406ab1157bd。根冻结全量日志未读取或改写。本轮只修改 wechat-setup.test.mjs 和新增本子目录，未修改任何生产文件、原事务错误测试或旧证据，未操作 Git index/commit。

## 根因

原单例稳定 RED：Missing expected rejection，原冻结测试位置 143 行。它把 HTTP 取消模拟成 WechatProbeUnavailable('cancelled')；WechatSetupService.run 在 wechat-setup.ts:44–48 将这种探测失败转换成 tool_not_ready/wechat_probe_failed 状态。旧 HostStorage 错把它包成 database_unavailable，所以以前偶然满足 assert.rejects。

生产 HTTP 在 wechat-scope-api.ts:61 用 HostStorageError(runtime_stopping) 表示 closed/AbortSignal；:120 把取消转换为 503/runtime_stopping。PostgresWechatSetupStore 在 :120、历史快照在前后 check，均在事务提交前复验；HostStorage 继续在 COMMIT 前检查自身关闭状态。

## 差分排除

同一生产设置服务和真实合成 PG，三种 HostStorage、三种故障各运行一次。旧版固定为 63cef611，当前为 dd97457，第三种仅在私有副本移除 query 来源跟踪的安装行。

| 取消/关闭注入 | 旧版 | 当前 | 停用 query 跟踪 |
| --- | --- | --- | --- |
| 服务关闭 | reject runtime_stopping | reject runtime_stopping | reject runtime_stopping |
| 旧测试的 ProbeUnavailable(cancelled) | reject database_unavailable | resolve wechat_probe_failed | resolve wechat_probe_failed |
| 生产 HTTP 的 HostStorageError(runtime_stopping) | reject runtime_stopping | reject runtime_stopping | reject runtime_stopping |

九组均在最后 INSERT front_sync_state 后阻塞、触发条件后 release；四张授权表均为 0 行，所有 fixture 清理通过。结果见 matrix.json，原字节摘要见 manifest.json/commands.json，源码副本摘要见 variant-pins.json。查询跟踪不是本次差异来源，也不是时序不稳定；生产取消围栏没有遗漏授权提交。

## 测试修复

- 原用例改为与生产 HTTP 相同的 HostStorageError(runtime_stopping)，并将任意 reject 收紧为 name/code 精确断言；不增加等待、不放宽 reject，保留四表零行断言。
- 新增生产 createWechatScopeApi 用例，使用合成 CLI 和真实 PG，在最后写入后分别触发实际 AbortSignal 和 api.close。两支均为 503/runtime_stopping，公开 read 返回 null，四表均为 0。
- 没有修改 host-storage.ts、WechatSetupService、API、历史授权流程或产品取消规则。

## 验证与数据范围

原单例 RED 1/1；校正后单例 GREEN 1/1；新增 API 用例 3/3（含 cancel/close 两个子例）。微信设置、范围 API 和事务错误合同三个相关模块最终 38/38、0 skip，约 19.47 秒。未重新运行全量，未更改根的 1454/1456 历史结果。

仅合成 PG、合成 CLI 本地子进程；0 真实模型、0 App、0 微信或外部消息，未读取项目 .env 或真实资料。原始日志仓库外 0700/0600，公开副本已去本机路径并保留 SHA。全部测试 teardown 通过，自有客户端、数据库、CLI 和临时目录已清理。私有诊断的 node_modules 链接已删除，源码副本作为原始证据保留。

Standards/Spec 自审均无待修问题，遵从不委派。原目录 manifest 列出的六份证据逐项 SHA 相同，既有业务错误测试仍为 c8481e3b…，生产 host-storage 仍为 a0b61732…。

复现新矩阵时，先在仓库外创建 0700 私有目录，执行 prepare-variants.py，再以 Node24 运行 diagnose.mjs 并传入其 variants 目录。node24 在 commands.json 中为实际 Node v24.19.0 绝对路径的脱敏代称。
