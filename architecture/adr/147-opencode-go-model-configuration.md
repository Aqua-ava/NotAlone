# ADR-147：OpenCode Go 的模型环境配置

> 状态：已采纳；日期：2026-11-02。用户确认通过 `.env` 设置模型并修复 OpenCode 调用。
> 局部修订 ADR-146 仅支持 `deepseek-flash` 的限制；既有来源、授权、预算、人工发送与删除边界保留。

设置页继续只有 Base URL 和 API Key 两项。`NOTALONE_DEEPSEEK_MODEL` 可显式指定 OpenCode Go 的 `deepseek-v4.1-flash`；不自动把官方模型别名改为其他供应商模型，不根据失败回退供应商或套餐。

已核对的 Go 地址是 `https://opencode.ai/inference/go/anthropic`（可含 `/v1`），旧 `/zen/go/v1` 保留对应路由兼容。普通请求仍使用官方 DSH Messages 适配器；来源核验走同一 Go 接收方的 `/inference/go/openai/v1/chat/completions`，旧地址使用 `/zen/go/v1/chat/completions`。认证使用 Bearer，标识客户端为 NotAlone，沿用实际业务会话的 DSH 原生 session header，不把所有会话映射到固定 ID。

按 OpenCode 官方模型目录，为该模型独立声明 1000000 上下文 tokens 与 384000 最大输出 tokens，保留 65536 安全余量与完整请求估算。该容量只用于已知 Go 路由及模型组合；未知模型仍拒绝，地址切换不扩大容量。标准工具参数与来源校验仍执行本机验证，单次工具返回不能证明服务端必然严格约束所有 schema。

依据：[模型目录](https://opencode.ai/inference/v1/models)、[路由与会话](https://opencode.ai/v2/docs/console/harnesses#base-urls)。Go 官方用途定位为 coding agents；本次连通结果不能代替其对关系助手用途的适用性或数据政策确认，不伪装客户端。验证见 [OpenCode Go 修复验收](../../docs/verification/opencode-go-20261102.md)。
