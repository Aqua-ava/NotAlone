# 助手运行副本

`AssistantRuntime` 只管理候选回复的本机 DSH 副本。可见讨论、候选、版本及来源继续由 PostgreSQL 裁定。

- `history` 通过官方 JSONL 只读句柄取回已提交事件；真实事件作为零 HTTP 预检的 seed，正式生成使用官方 `agents.resume`。
- `acquire` 在模型调用前标记 `dirty`，同一讨论只允许一个写者；`commit` 在官方句柄释放后执行持久化屏障并核对业务提交、事件数及完整事件摘要，再允许下次恢复。
- `AssistantRuntimeProjection.read` 以 owner、contact、业务会话和已核验绑定构造有效业务投影，不需要新建生成锚点。正文、作者、记忆、来源、偏好、分层资料与已加载 Skill 资源逐项复验；完整材料清单还覆盖未被候选直接引用的背景、工具材料和 Skill 目录。修正、失效和范围收窄排除旧输入及其派生候选，仅保留可证明合法的引用。
- `materialize` 在同一产品讨论内建立或替换底层运行实例；正常合法追加保留 SDK 历史，变化回执不含正文。新旧计划在发布事务再次比较，建档和文件释放在事务外执行。会话级占用与 operation 参加来源删除排空，宿主关闭也等待该操作；未知写者或删除屏障不能借重建解除。
- `hasHistory` 只选择运行引用表示；原来源、不可变版本、绑定、Skill 和提交守卫继续复验。正常引用模式不把完整讨论重复复制进当前提示；资格投影仍读取业务正文和材料指纹，不能据此声称历史查询全部消失。出站与保存各自复验，不跨阶段沿用成功结果。预检与正式恢复还比较同一运行身份、资格和事件内容，实际恢复历史与伴随引用均计入完整序列化请求预算。
- `run` 先核对持久未完成的 deletion operation，再将准备、恢复读取、模型执行、提交和真实句柄释放纳入同一范围取消与完成边界；删除等待读写结束后才清盘，不持 owner 事务锁等写者。SDK 无法确认关闭时保留占用并让删除失败，不能把插件卸载当作清盘完成。
- `quarantine` 禁止恢复不合格文件；`erase` 只清除经过归属标记核验的整段应用目录，覆盖所有运行世代、分叉、索引、缓存及临时文件，并复核目录消失。

既有数据库讨论仍只读，首次明确继续才建立存档，不批量迁移、重新提取或生成候选。`origin=business_bootstrap/business_rebuild` 以有效业务投影落盘为凭据，允许真实的 `committed_request_id=NULL`；`origin=generated` 必须对应真实完成的数据库请求，不混淆两类凭据。迁移 121 增加资格和完整事件摘要，117—120 保持不变。

零模型建档使用官方 `SessionStore.create`、`sessionPersistence.create(header)`、写句柄 `flush/close` 建立合法空档，业务引用保存在同一受管运行目录的 `business-reference.json`。首次明确生成时，在当前用户轮携入这一份低权重业务引用；随后只复用真实 SDK 消息。伴随文件与数据库投影摘要逐字核对，保留输入、候选、编辑版本及来源身份，旧要求不成为长期偏好、当前事实或已发送证据。

直接先追加业务 `user/message` 的探针只能证明 resume：首次真实 followup 后，锁定 SDK 的[格式校验](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-format-v3-to-v4/src/relationships.ts#L124)要求系统消息位于受保护的首节点，会拒绝这种先用户后系统的档案。本实现用空档和自有伴随文件避开该不合法顺序，不手造 SDK 执行轮，不使用 experimental plugin record，也不修改 SDK。只有真实 Host 跨重启、首次生成及再次续用测试才作为该接线可用的依据。

`materialize(scope, session, configuration, readPlan, signal, options)` 是恢复票复用的零模型构建接缝，返回原业务身份、新运行身份、origin、状态、事件数、业务提交身份、资格摘要和无正文变化回执。存储损坏、缺失、异常退出及未提交轮的分类和有界恢复由后续恢复职责补齐；本接缝不从坏档挑候选，不自动发模型请求，也不放开删除或身份封禁。

Host 组合根在模型装配前创建唯一运行管理器，供启动删除恢复及模型端共用。合成宿主可在可信启动配置中显式提供同 businessHome 的 `persistentAssistantHome`；当前正常配置仍保持临时运行，完整恢复及桌面验收另行完成。

删除操作提交后就建立早期屏障，先在事务外取消并排空相关轮次，再执行任何可能失败的备份核验、闭包擦除或文件清理。来源的 owner memory／携入依赖可跨联系人，因此未完成的来源清理保守暂停同一本人的恢复和生成，历史只读及无关档案保留；清理成功后才解除，失败显示“资料清理未完成，暂时不能生成”并保留明确重试。联系人／账户按自身范围协调，包括没有助手 turn 的兼容临时轮；讨论删除只匹配自身会话或已核验闭包。

公开来源、联系人和助手会话删除沿真实业务闭包，在级联或正文擦除之前将目标及阻断持久绑定到原 deletion operation（迁移 118）。文件清理失败后，即使业务会话已不存在，目标仍可跨重启核验、阻断恢复并明确重试；受管更新恢复副本沿原归属校验清除。成功后只保留去身份凭证。未完成讨论删除允许同 owner、contact 范围只读查找最小 UUID，桌面重启据此恢复失败占位，不能把 404 当作清盘成功。

合成回归通过真实产品 Host、官方 JSONL、环回供应商与文件读取屏障验证跨重启清理、迟到结果、故障重试及无关讨论保留。它们不证明真实模型效果或原生 App 验收。

所有 DSH 能力固定为 `0.2.1-rc.2`，Cordis 为 `4.0.5`。运行世界仍挂在正式 profile 的同一根 context，使用官方 Session、Agent、Projection、SystemPrompt、Tools、JSONL 和 AgentLoop 插件；不修改 SDK，也不另建启动根。为适配该版本隔离子作用域的依赖继承，薄插件沿用[官方 Loader 的 `internal/plugin` 与 `Inject.resolve` 接缝](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/vendor/loader/src/index.ts#L129)，仅补本轮 Loop 直接子 fiber 的明确依赖，随运行世界关闭撤销。
