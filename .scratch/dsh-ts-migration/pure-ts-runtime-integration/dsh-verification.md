# 运行边界查证

- 固定 DSH `0.2.1-rc.2`，官方源码 commit `687f282e8625c6b8d11ff58211a90524be2e4317`。本片不升级依赖、不改官方核心。
- 已核对固定 [architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md) 的 profile／bundle、应用入口、effect生命周期约定，以及固定 [profile.ts](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/profile.ts) 的官方 profile 组合与查找规则。
- 继续调用既有 `launchDsh`，由官方CLI `--profile notalone` 加载原 `host.patch.yml`；沿用 `ctx.appReady.onReady` 与 `ctx.effect`，只在自有插件中选择完整TS装配。没有把任意内部Context当入口，也没有猜测“禁Python”的官方开关。
- 原业务服务、PostgreSQL和任务表继续是联系人、来源、状态和恢复的权威；DSH Session不被当作业务讨论或事件库。
- 已通过真实产品launcher验证：不存在的Python路径、无Conda子环境仍ready，公开HTTP/SSE可用，后台整树无Python，关闭与重开可验证；这不替代完整功能、真实模型质量、正式性能或App验收。
- Node `AsyncLocalStorage.run/getStore/exit` 按[固定Node文档](https://nodejs.org/download/release/v24.19.0/docs/api/async_context.html)使用。公开范围先经DB核验，`run`只持有本请求上下文，finally显式失活；已结束但被继承的异步回调不继续携带手动身份。后台学习显式 `exit`，已授权异步准备使用独立 `runInScope`。
- 新回归验证同scope manual/desktop重叠、跨scope、错scope拒绝、结束/后台回落；没有修改全局默认绑定优先级。
- 受管数据库共享寿命锁复用桌面协作方提供的Darwin原生文件锁，与原Python flock使用同一文件；产品宿主的运行期独占阻挡和完整关闭后释放已实测。其他平台不套用Darwin数字flags。
- PG维护通知查证：[node-postgres Client notification事件](https://node-postgres.com/apis/client#notification)与已安装 `pg 8.16.3` 的 `lib/client.js:421–422` 相符；只用现成 `LISTEN`／`notification`／连接释放接口，不用文档中较新版本其他能力。通知只触发同owner既有管理器的复验，未把通知payload当来源或模型输入。
