# 助手运行副本

`AssistantRuntime` 只管理候选回复的本机 DSH 副本。可见讨论、候选、版本及来源继续由 PostgreSQL 裁定。

- `history` 通过官方 JSONL 只读句柄取回已提交事件；真实事件作为零 HTTP 预检的 seed，正式生成使用官方 `agents.resume`。
- `acquire` 在模型调用前标记 `dirty`，同一讨论只允许一个写者；`commit` 在官方句柄释放后执行持久化屏障并核对业务提交及事件数，再允许下次恢复。
- `hasHistory` 只选择运行引用表示；原来源、不可变版本、绑定、Skill 和提交守卫继续复验。引用模式不构造整段 `discussion.items`，但目前仍读取旧正文作指纹和来源校验，不能据此声称历史查询全部消失。
- `run` 将准备、恢复读取、模型执行、提交和真实句柄释放纳入同一范围取消与完成边界；删除等待读写结束后才清盘，不持 owner 事务锁等写者。SDK 无法确认关闭时保留占用并让删除失败，不能把插件卸载当作清盘完成。
- `quarantine` 禁止恢复不合格文件；`erase` 只清除经过归属标记核验的整段应用目录，覆盖所有运行世代、分叉、索引、缓存及临时文件，并复核目录消失。

Host 组合根在模型装配前创建唯一运行管理器，供启动删除恢复及模型端共用。合成宿主可在可信启动配置中显式提供同 businessHome 的 `persistentAssistantHome`；当前正常配置仍保持临时运行，完整恢复及桌面验收另行完成。

公开来源、联系人和助手会话删除沿真实业务闭包，在级联或正文擦除之前将目标及阻断持久绑定到原 deletion operation（迁移 118）。文件清理失败后，即使业务会话已不存在，目标仍可跨重启核验、阻断恢复并明确重试；受管更新恢复副本沿原归属校验清除。成功后只保留去身份凭证。未完成讨论删除允许同 owner、contact 范围只读查找最小 UUID，桌面重启据此恢复失败占位，不能把 404 当作清盘成功。

合成回归通过真实产品 Host、官方 JSONL、环回供应商与文件读取屏障验证跨重启清理、迟到结果、故障重试及无关讨论保留。它们不证明真实模型效果或原生 App 验收。

所有 DSH 能力固定为 `0.2.1-rc.2`，Cordis 为 `4.0.5`。运行世界仍挂在正式 profile 的同一根 context，使用官方 Session、Agent、Projection、SystemPrompt、Tools、JSONL 和 AgentLoop 插件；不修改 SDK，也不另建启动根。为适配该版本隔离子作用域的依赖继承，薄插件沿用[官方 Loader 的 `internal/plugin` 与 `Inject.resolve` 接缝](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/vendor/loader/src/index.ts#L129)，仅补本轮 Loop 直接子 fiber 的明确依赖，随运行世界关闭撤销。
