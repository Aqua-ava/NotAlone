# 助手运行副本

`AssistantRuntime` 只管理候选回复的本机 DSH 副本。可见讨论、候选、版本及来源继续由 PostgreSQL 裁定。

- `history` 通过官方 JSONL 只读句柄取回已提交事件；真实事件作为零 HTTP 预检的 seed，正式生成使用官方 `agents.resume`。
- `acquire` 在模型调用前标记 `dirty`，同一讨论只允许一个写者；`commit` 在官方句柄释放后执行持久化屏障并核对业务提交及事件数，再允许下次恢复。
- `hasHistory` 只选择运行引用表示；原来源、不可变版本、绑定、Skill 和提交守卫继续复验。引用模式不构造整段 `discussion.items`，但目前仍读取旧正文作指纹和来源校验，不能据此声称历史查询全部消失。
- `quarantine` 禁止恢复不合格文件；`erase` 只清除经过归属标记核验的应用目录，失败保留业务映射供重试。

Host 通过可信的 `persistentAssistantHome` 显式装配。当前只由合成 profile 启用，完整删除及恢复合同完成前，正常用户配置保持临时运行。来源、联系人及受管恢复副本的整体删除另由跨域删除流程负责，不能把这里的基础会话删除当作完整生产删除验收。

所有 DSH 能力固定为 `0.2.1-rc.2`，Cordis 为 `4.0.5`。运行世界仍挂在正式 profile 的同一根 context，使用官方 Session、Agent、Projection、SystemPrompt、Tools、JSONL 和 AgentLoop 插件；不修改 SDK，也不另建启动根。为适配该版本隔离子作用域的依赖继承，薄插件沿用[官方 Loader 的 `internal/plugin` 与 `Inject.resolve` 接缝](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/vendor/loader/src/index.ts#L129)，仅补本轮 Loop 直接子 fiber 的明确依赖，随运行世界关闭撤销。
