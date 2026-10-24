# 宿主回复运行组件验证

2026-10-24。基于已提交的 `29798879` 回复/仲裁基础组件，主协调完成 `createHostReplyRuntime` 及官方运行夹具的整合。它尚未接入主 `host-plugin`，生产回复责任没有因此转移。

模块装配真实官方 provider、ReplyGenerationService、独立 token 的私有 HTTP 与 HostStorage 事务。停止接收后取消业务，等待实际 stream/服务退出，再注销 provider；HTTP 断连不充当物理结算。缺少 owner 时没有可用私有处理器，装配失败释放已注册 provider。

验证使用真实官方 profile、合成 PG 和本机 SSE：未授权零 HTTP；同键重放保留原 UUID 且不再出站；关闭时取消实际 SDK stream、排空许可，迟到结果无候选；重复 close 幂等，关闭后新请求失败关闭。独立 Spec 审查无 finding，主协调完成 Standards 复核。

先运行单个实际装配用例 1/1，再在 `backend-ts` 运行相关 HTTP 和 Python 薄桥链 8/8：

```sh
node --test --test-concurrency=1 test/host-reply-runtime.test.mjs test/reply-http.test.mjs test/reply-remote-runtime.test.mjs
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --skipLibCheck --esModuleInterop --target es2024 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions src/host-reply.ts
```

基于新基础组件的合并验证再次覆盖这 8 项，0 skip，严格 TypeScript 退出 0；本机日志 `/tmp/notalone-host-reply-accounting-integrated.log`。同一日志中的 7 项任务策略测试不计入本组件签收：独立真实 Worker 核验随后发现学习跨 claim 合法重试被单次额度假设误限，该策略仍在修正，尚未提交或接入主宿主。

全部使用合成数据与本机 provider，没有真实模型。主宿主完整生命周期、后台任务身份/预算/未知恢复、公开业务/App、近期上下文覆盖和预注册质量性能仍需继续整合；本记录不代表完整 05 已验收。
