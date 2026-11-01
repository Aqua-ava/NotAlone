# OpenCode Go 修复验收（2026-11-02）

用户要求通过 `.env` 配置并修复当前 OpenCode Go 模型调用。新增已知 Go 路由与 `deepseek-v4.1-flash` 组合，页面仍只有地址、密钥输入及保存按钮。设计见 [ADR-147](../../architecture/adr/147-opencode-go-model-configuration.md)。

## 失败与修复依据

最初独立探测未传 `sessionId`，返回 `400 MissingSessionID`；它不代表正式 App 路径缺会话标识。补上实际 DSH 原生会话标识后，旧模型 `deepseek-flash` 返回 `400 Model is unavailable`。当前服务模型列表与[官方目录](https://opencode.ai/inference/v1/models)一致，模型 ID 为 `deepseek-v4.1-flash`，声明 context=1000000、output=384000。

主配置新增独立容量和模型组合，Bearer 认证绑定完整选定地址并声明 `User-Agent: NotAlone/0.1`。Messages 使用 Go Anthropic 路由，来源核验使用同 Go 的 OpenAI Chat Completions 路由，保持现有严格工具结构与本机校验。未知组合继续拒绝；不自动降级或换套餐。

DSH 声明、锁定、安装版本均为 `0.2.1-rc.2`，Cordis 为 `4.0.5`。安装包公开 `DeepSeekAdapter` 的请求实现 `lib/index.js:2218-2231` 已核对：由公开配置与认证回调提供地址、headers，`sessionId` 转为原生会话 header，禁止重定向。既有固定源码参考为 `687f282e8625c6b8d11ff58211a90524be2e4317`，沿用本项目既有官方扩展点，没有升级或修改 DSH 核心；未声称制品逐字可复现构建一致。

## 验证

- 配置回归先失败：新模型返回 unavailable；实现后 `node --test test/host-reply-config.test.mjs test/model-output-configuration.test.mjs` 11/11。实际 adapter / strict send 的 fetch 拦截验证地址、Bearer、会话、User-Agent、模型与最终请求预算。
- `node --test test/model-provider.test.mjs test/sqlite-memory-profile.test.mjs test/sqlite-reply-candidates-profile.test.mjs` 4/4；正式 SQLite profile 的记忆、回复及授权边界使用本机合成供应商，包含关闭与临时目录清理。
- `node --test test/deepseek-strict-verification.test.mjs` 3/3；本地 strict schema 和响应解析。
- `pnpm --dir backend-ts run typecheck`、`git diff --check` 通过；独立代码检查未发现阻断缺陷。
- 真实供应商调用使用现有凭据与合成提示，无私人资料。官方 Messages adapter 发往 `/inference/go/anthropic/v1/messages`，HTTP 200、finish=true，返回“连接成功。”；生产 `beginStrictVerificationCall().send()` 发往 `/inference/go/openai/v1/chat/completions`，HTTP 200，返回 `SourceVerificationOutput` 的 `{"results":[]}`，success=true。两路使用正常配置的默认 off 与输出额度，没有临时降低额度。独立传输探测未建立业务联系人，许可及记账回调使用测试实现，不记为完整业务闭环。
- 成功后原子更新本机 `.env` 的地址及模型名，保留 Key 与其余配置，权限 0600；真实文件被 Git 忽略，没有提交凭据。
- Computer Use 正常退出后以 `pnpm run dev` 重启；`dev:status` 为 development。实际设置页显示新 Go 地址，脱敏诊断为 startup ready、backend connected，无错误。未打包或发送外部聊天消息。

本轮复用现有开发构建，未创建独立 App、运行时副本或长期临时夹具；自动测试自建目录已清理。没有逐档实测 low/high/max，也未把工具单次返回当作供应商严格 schema 保证。真实联系人完整生成、第三方用途与数据政策不在本次连通验收结论内。
