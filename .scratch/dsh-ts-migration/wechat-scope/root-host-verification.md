# 主会话独立宿主核验（2026-10-24）

范围：18共享宿主接线的当前工作树，不代表18整票验收。执行真实锁定DSH官方profile与随机合成PG、合成CLI，未读取真实微信或业务库，未调用外部模型。

源码复核：`backend-ts/src/host-plugin.ts` 对微信内部路径先使用与路由相同的URL标准化结果认证，专用token不可被公开token替代；scope端口先监听再启动Python消费者，关停先取消及排空业务再关闭存储。`wechat-http-body.ts` 在读取前检查声明长度，限制1MiB及10秒总时长，错误响应保持413/408/400协议。

独立执行（工作目录 `backend-ts`，Node24）：

```sh
node --experimental-strip-types --test test/wechat-scope-host.test.mjs
```

结果5/5通过、0跳过，约20.94秒。覆盖公开范围与单绑定历史快照、撤销排除、错误token及dot-segment绕行拒绝、关停取消在途合成CLI后无绑定写入、真实socket超限/非法长度/残缺正文以及10秒正文超时。各测试使用自身夹具清理；共享合成PG集群仍供其他票使用。

首次从仓库根目录运行因既有support的相对项目路径假设报 `ENOENT`，尚未进入宿主验证；按测试所在目录重跑上述命令成功，没有将该环境失败记成产品缺陷或省略失败记录。

剩余验收：18负责实际开发App、双轴审查收敛、原工具准备任务关联及本票完整提交。此记录不证明真实微信数据同步、模型质量或后续19/21已经完成。

## 签收后取消竞态修复

06的同类RPC审查提示自动重连风险，根在微信范围端口补真实loopback回归：显式connect成功后、request发送前调用close。修复前已复现一次discover请求仍被服务端收到；在已显式connect的HTTPConnection设置`auto_open=0`后，相同用例拒绝发送、服务端零请求。没有变更端点、身份、凭据或业务授权。

单例RED→GREEN；随后 `python -m unittest tests.unit.front_sync.test_wechat_scope_remote tests.unit.front_sync.test_wechat_history_scope tests.unit.server.test_wechat_scope_drain tests.integration.server.test_wechat_scope_handoff` 共23/23通过（10.18秒）。规范/规格独立只读审查均无finding；审查范围仅该竞态两文件，未替代其他票验收。
