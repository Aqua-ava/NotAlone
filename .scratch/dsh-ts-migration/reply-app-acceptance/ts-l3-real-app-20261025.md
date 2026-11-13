# DSH/TypeScript owner L3 与继续讨论真实 App 验收

日期：2026-10-25（Asia/Taipei）。运行方式：复用 `npm run dev`，`NOTALONE_REPLY_RUNTIME=typescript`；仅使用联系人 `ran`。

## 修复

- 原因：TypeScript `validateLayeredSnapshot` 未递归复验 owner L3 的完整 `dependency_ids`，失效候选仍可进入回复准备。
- 修复：复用 `forbiddenGenerationMemoryDependencies`；rejected、invalidated、expired 任一依赖使 capture／validate／正文读取统一失效，未重签旧快照。
- 数据处理：诊断只记录错误类型与调用栈；诊断代码和 `/tmp/notalone-reply-diagnostic*.log` 已移除，未记录正文、凭据或关系资料。

## 自动验证

- `reply-context-layered`：2／2。
- 分层上下文、概览、讨论、回复存储与真实主宿主组合：36／36；TypeScript `tsc --noEmit` 通过。
- `desktop/tests/assistant-generation-quit-http.test.mjs`：42／42、1..42，约151秒；每个合成库迁移重复数为0，清理后自有库剩余为0。

## 真实 App

- 生成：TypeScript 运行时完成真实模型请求并显示2条候选；回复 turn、request、attempt 均为 `completed`，模型收据1项为 `succeeded/http_accepted`。
- 编辑：第一条候选保存为修改版本1；持久正文为本次合成文本：`你好，最近还好吗？我有件小事想和你确认一下。`
- 显式选择：用该修改版本新开讨论；候选选择记录 `is_current=true`，新讨论当前输入为 `candidate_carry/active`。
- 重开：正常退出并重新执行 `npm run dev` 后，同一携入会话恢复相同编辑正文和当前选择。
- 中断可见：历史中原失败轮次仍显示“生成未完成”；重开没有自动续跑，新增模型调用为0。
- 删除：未删除任何既有讨论或本次验收会话，避免在没有额外确认时执行破坏性 UI 操作。
- 外部发送：未复制到微信、未发送任何消息；App 只显示本地候选和复制入口。

原始私有运行标识与散列保存在仓库外诊断目录，不提交联系人正文或可识别身份。
