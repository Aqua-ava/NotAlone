# 票 20 DSH 查证

日期：2026-10-25。仅核对锁定官方源码和本项目实现，没有运行模型、实际 App 或微信。

## 固定版本

- 官方 tag `dsh-v0.2.1-rc.2`，提交
  [`687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317)。
- npm 制品 `@deepseek-ai/dsh@0.2.1-rc.2`；本仓
  [`backend-ts/pnpm-lock.yaml`](../../../backend-ts/pnpm-lock.yaml) 锁定同一版本。
- 版本/制品基线沿用
  [`runtime-validation/progress.md`](../runtime-validation/progress.md)：npm tarball
  SHA256 为 `40e3d025c0240c4316ff42dee9bedc7709c0fb38aea10543b47076ed2af52e1d`，
  但没有可验证的官方构建 attestation，不能把它写成可复现构建证明。

## 官方依据

- [架构](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md#L9-L45)：
  DSH 由 profile 组合插件，支持的应用经官方 launcher 启动；插件效果随卸载回退。
- [生命周期示例](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/cordis-tutorial/02-lifecycle-and-effects.md#L5-L40)：
  timer、连接和 watcher 等非 Cordis 管理资源应由 `ctx.effect()` 获取并在 disposer 中释放。
- [官方 launcher 源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/profile-boot.ts#L283-L350)
  在 boot 和宿主装配后提交 `appReady`，并由 profile 整体 dispose 驱动收尾。
- [官方关闭源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/process-shutdown.ts#L1-L77)
  提供 5 秒有界优雅关闭，并允许进程故障时强制退出。
- [Jobs 公开合同](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/jobs/jobs/src/index.ts#L36-L137)
  和 [README](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/jobs/jobs/README.md#L40-L57)：
  jobs 按 Agent Session 授权，提供模型输出环；随进程结束，跨重启持久执行需要另一后端。

## 本票结论

- 本票不涉及直接 DSH 模型、Agent、Tool 或 Session API。历史追平是普通 TS 业务模块，
  由现有官方 profile 宿主调用，模型配置不参与读取门禁。
- 不采用 `ctx.jobs`：历史任务是 owner/contact/binding 范围的持久业务覆盖，需要跨重启
  检查点、PG 原子提交和无正文状态，而不是 Agent Session 所有、随进程消失的输出环。
  若把它挂到 jobs，还会增加模型可见输出面，违背只入库、不同步唤醒模型的边界。
- 本票没有新增独立 timer、连接或 watcher；每片读取沿用现有宿主驱动的
  `SyncIncrementalEngine` 生命周期。CLI 子进程、共享存储和 timer 仍由既有宿主在
  关闭时排空。历史模块只接受本轮 `AbortSignal` 和 current-check，不自行启动后台循环。
- 官方源码只证明公开生命周期约定；本票真实行为由隔离合成 PG、合成只读 CLI 和
  严格测试验证。宿主接线属于根集成点，未在本工作树宣称已通过官方 profile。
