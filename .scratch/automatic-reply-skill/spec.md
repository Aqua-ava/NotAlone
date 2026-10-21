# 根据当前对话自动加载回复 Skill

> 2026-10-21 设计审查：正常产品三入口与先确认方向门由 [ADR-079](../../architecture/adr/079-unified-expression-workspace.md) 局部替代，见 architecture/adr/079-unified-expression-workspace.md；旧探索接口保留兼容，不作为当前默认交互。自动 Skill 的受控目录、零或一个版本、明确场景权限与来源失效继续有效，主动样本按 [ADR-082](../../architecture/adr/082-retire-explicit-style-samples.md) 退役。

用户于 2026-10-19 确认：按原设计根据当前对话自动判断并加载 Skill，回复区只展示本次实际策略，不提供手动选择。

## 范围

- 回应消息和主动联系的方向探索先读取当前联系人受控 Skill 精简目录，再根据冻结的对话、目的及本次要求选择零或一个版本，按需加载该版本正文。
- 没有目录或没有适合的方法时沿通用流程；不得为使用 Skill 推断用户立场。
- 选择调用与探索调用复用预算、超时、宿主优先级和出站台账，先建立合法任务再调用模型。
- 实际版本或明确无 Skill 的结果固定到本次任务；确认、重试及候选生成复用其选择，来源、版本失效仍拒绝。
- 当前回复区移除场景与策略选择，显示实际使用的名称、版本或通用流程；未运行前不宣称已使用策略。
- 原有 Skill 管理、历史读取和内部固定版本 API 兼容保留。

## 边界

- 模型推断的沟通任务不成为权限：不得写入用户声明的 skill_scene，不扩大 owner_id + contact_id 目录，不绕过方法停用或删除。
- 不增加外部发送能力，不变更记忆、Skill 发布范围或既有资料。
- 草稿改写的独立精确场景声明入口保持原范围，不纳入本次回复控件调整。

## 验证

- 方向探索公开接口：自动选用、无匹配、范围隔离、实际正文与版本延续。
- 桌面回复页面：无手选控件、只读策略与通用流程展示。
- 用户已确认以上两个边界补回归测试；按单例、相关模块、全量阶梯执行。
- 实际开发 App 使用既有 npm run dev 热更新实例验收，禁止打包；不发送外部消息。

## 第三方接口查证

复用现有 bind_tools/ModelRequest 调用装配，未引入新框架能力；核对 [LangChain Models](https://docs.langchain.com/oss/python/langchain/models) 与 [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)。本机 langchain 1.3.15、langchain-core 1.5.5、langchain-openai 1.5.1、deepagents 0.7.6；以合成模型和公开接口回归证明工程接线，不代替真实供应商验收。

实际结果、命令与限制见[验证记录](validation.md)。
