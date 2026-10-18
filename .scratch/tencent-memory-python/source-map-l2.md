# L2 场景工具维护映射

参考源码：本机腾讯只读检出 `e9a8293`；目录 `/tmp/notalone-tencent-memory-inspect/MemoryCore/src`。不引入腾讯运行时、服务、Node sidecar或外发embedding。

| 腾讯实际代码 | 本项目实现 | 明确适配差异 |
| --- | --- | --- |
| `core/scene/scene-extractor.ts:166,276` 读取场景索引并运行工具Agent | `memory/scene_workspace.py:maintain_scenes` | Python内存Markdown工作区；只载入当前范围已冻结场景及合法底层输入，不读真实文件 |
| `adapters/standalone/llm-runner.ts:132,156,182,347` read/write/edit及有限迭代 | `SceneWorkspace.execute`、五轮工具循环 | 路径只允许单个受限文件名；旧文档先读后改；edit必须唯一精确匹配；无shell和其他App工具 |
| `core/scene/scene-extractor.ts:325` 写`[DELETED]`表示软删除 | `SceneWorkspace.compile` | 仅允许完整合并明确替换已读旧版本后软删除，不允许无依据单独抹除旧资料 |
| `core/profile/profile-sync.ts:420` 内容差异及基准版本回写 | `persistence/layered_memory.py:publish` | 回编现有scenario_id/replaces协议，独立逐项核验后事务发布；冻结来源、隐藏依赖、历史映射和物理删除沿用现有SQL |
| `utils/pipeline-factory.ts:862` 无文件变化跳过场景checkpoint递增 | `DeepSeekOrganizationVerification.verify_items`、`_publish_unchanged` | 对无需更新本身独立核验并绑定输入摘要；成功批次记录真实覆盖，scene/version/generation和有效画像不变 |

正式默认工厂 `application/organization_runtime.py` 使用 `verified_items`、16次共享物理请求额度；L2最多5轮，预留L2核验及后续L3五轮+核验共7次。每次HTTP发送前在既有job上原子扣额，不因工具轮次、SDK失败或恢复重置。显式`qualified_suite`仍采用单次JSON提案与四阶段4次合同。

原文段落采用Markdown正文和SOURCES引用，META承载标题/提示/合并版本。编译器不信任模型的身份或引用：保留旧文件稳定身份，替换只能引用读过的当前版本，合并必须保留仍有效旧来源。独立核验额外检查语义遗漏；最终writer重新核验同范围来源、版本、纠错及租约。工具失败或越界不会部分发布暂存文档。

LangChain接口依据：官方 `https://reference.langchain.com/python/langchain-core/messages/tool/ToolMessage` 与 `https://www.langchain.com/blog/tool-calling-with-langchain`；采用现有模型.bind(tools=...)及AIMessage.tool_calls/ToolMessage，不新增框架运行时。

## 验证

已确认seam：聊天导入/生产任务→公开当前L1/L2/L3读取；仅替换模型HTTP响应与L1已有本地embedding边界。
- 首次红：旧OrganizationBudget拒绝工具有限预算；绿：聊天进入正式SDK工具流程，写入/完成/核验三次真实边界请求均计费。
- 合并丢来源红：错误合并原本发布并丢掉旧正文；绿：拒绝更新，旧场景完整保留。
- 无改动红：旧流程创建无意义generation并暂停remaining；绿：独立无变化核验后完成覆盖，保留场景和已有画像版本。
- 同身份精确edit、多文档merge及来源删除、越界路径、五轮耗尽、旧qualified_suite拆分/合并和预算恢复均由合成公开接口验证。
- 未调用真实模型、未启动桌面、未打包；真实模型与桌面体验交04验收。
