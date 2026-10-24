# 宿主官方模型配置验证

2026-10-24。纯配置模块已从经独立 Standards 审查的冻结草案应用，主协调复核 Spec 并独立运行测试。它只解析 `HostStorage.runtimeEnvironment()` 的既有配置，不读取真实凭据，也不代表主宿主已经切换。

- 核对锁定 DSH `0.2.1-rc.2 / 687f282e8625c6b8d11ff58211a90524be2e4317` 的公开 `resolveAdapterOptions`、认证和 Messages 适配器；没有修改框架核心或新增依赖。
- 显式保留旧官方模型的输出、温度、思考、上下文、安全余量与截止配置。旧官方 root/v1 精确映射到官方 Messages 入口；未知模型或路由没有可核实预算时失败关闭。
- 按用户明确废除 ECNU 的决定，旧模型或已知旧入口返回 `ecnu_provider_retired`，不自动替换供应商或改写原配置。
- `physical_limit=24` 只是服务器配置上界；真实回复仍须按 `min(24, 8 + 实际场景额度)` 收紧。该纯配置模块不能替代逐物理请求的业务门禁。

最小默认配置用例 1/1 后，全模块 6/6，严格 TypeScript 检查退出 0。应用后在 `backend-ts` 再运行：

```sh
node --test test/host-reply-config.test.mjs
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --target es2024 --module nodenext --moduleResolution nodenext --esModuleInterop --skipLibCheck --allowImportingTsExtensions src/host-reply-config.ts
```

测试确实经过公开官方 adapter 的序列化，fetch 全程替换为内存响应，核对实际 URL、认证头与正文参数；没有真实模型或外部网络。草案源文件应用前后 SHA 一致；规格新增 ECNU 例外后先核对 diff，再更新冻结输入版本，未跳过校验。

主宿主身份、提供者生命周期、取消、任务仲裁、私有回复 HTTP 与公开界面的停用配置提示仍需装配和整体测试；本记录不代替这些验收。
