# 19 DSH接口查证

- 锁定版本：`@deepseek-ai/dsh@0.2.1-rc.2`，官方commit `687f282e8625c6b8d11ff58211a90524be2e4317`；复核本仓package固定值及02的runtime-validation/progress.md、interface-crosscheck.json。共享源码为归档展开目录，未包含.git，不能把git rev-parse失败当作提交认证；版本证据沿02官方tag与制品摘要记录。
- 官方[架构](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md#application-launch)：Node应用必须通过named profile启动；不另建执行Harness。
- 官方[插件生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/cordis-primer.md#practical-rules)：相关资源在同一effect中按顺序释放。本票普通业务模块由现有host-plugin装配，先停收及取消CLI，再排空循环，最后关闭存储。
- 官方[退出实现](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/process-shutdown.ts#L4)：5秒优雅退出预算，超时强制退出进程。不得把框架退出等价于业务已排空；业务需独立测试中止与重启幂等。
- 官方profile启动源码 `apps/cli/src/profile-boot.ts:45–64` 的appReady回调和本仓 `host-plugin.ts` 现有接线一致。适配理由：授权同步是确定性业务，不调用模型、Agent、Tool或DSH session；只有启动与退出受官方宿主管理。普通同步状态和游标继续在原PG，不转入DSH日志。
- 官方示例与裁剪profile依据沿02已核验的 `packages/bundle/sdk-minimal/cordis.patch.yml`，不继承其无关工具。实际启动/HTTP/退出验证尚待本票模块接线，文档查证不替代运行证据。
