# 记忆模块

按业务职责查找代码。模块内部文件可以直接引用，不通过额外的转发入口隐藏依赖。

| 要处理的问题 | 从哪里开始 | 内部实现 |
| --- | --- | --- |
| 从聊天提取有来源的候选 | [extraction/service.ts](extraction/service.ts) | [flow.ts](extraction/flow.ts) 编排单批提取与核验；[prompts.ts](extraction/prompts.ts) 定义模型指令与输出协议；`verification/` 保存来源核验，`tasks/` 保存调度、分批、进度与恢复。 |
| 决定新增、更新、合并或忽略候选 | [adoption/service.ts](adoption/service.ts) | [engine.ts](adoption/engine.ts) 负责采纳与事务规则；[adjudication-dsh.ts](adoption/adjudication-dsh.ts) 负责模型裁决。 |
| 查询、人工补充、修改和删除记忆 | [records/service.ts](records/service.ts) | `mutations/` 保存候选版本、保护和删除逻辑；`documents/` 管理场景与长期背景的共同事务、纠错和清除。 |
| 将记忆整理为持续主题 | [scenarios/service.ts](scenarios/service.ts) | [workspace.ts](scenarios/workspace.ts) 提供 L2 内存文档工具和生成流程，服务负责核验与发布。 |
| 生成或更新人物长期背景 | [profiles/service.ts](profiles/service.ts) | [workspace.ts](profiles/workspace.ts) 提供 L3 文档协议、工具和显式完成流程。 |
| 查看关系概览或重建记忆目录 | [overview/service.ts](overview/service.ts)、[catalog.ts](overview/catalog.ts) | `projection/` 处理资料投影、时间和版本；`evidence/` 重核已存来源证明，也供其他模块复用。 |

## 阅读顺序

自动处理从 `extraction/tasks/runner.ts` 串起提取与采纳；理解单批逻辑时先读 `extraction/flow.ts` 和 `adoption/service.ts`。采纳后的场景与长期背景整理分别进入 `scenarios/` 和 `profiles/`。

人工查询和修改从 `records/service.ts` 进入；场景及长期背景的共同管理入口为 [records/documents/service.ts](records/documents/service.ts)。这些管理操作与模型生成分开，不在两个生成模块重复维护。

场景组织某个持续主题的经历，长期背景汇总跨主题的人物资料，概览负责读取、展示和导航。来源核验、联系人隔离、人工保护及删除约束以现有业务协议为准。

源码版本身份仍按实际文件路径、依赖和内容计算。目录调整会产生新指纹，旧任务与质量证据按既有版本规则核验，不伪装成旧实现继续执行。
