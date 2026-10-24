# L3 失效依赖生成恢复验收

## 根因

冻结的 L3 生成快照只比较整理输入的 memory/revision/manifest，没有复验其完整
`dependency_ids` 的生成资格。底层候选后来变为 `rejected` 时，快照仍被标记为可用，
但助手 turn 保存了该拒绝依赖，随后 `require_current_input` 以
`memory_generation_forbidden` 阻断整个工作区。

## 修复

- `PostgresLayeredMemoryStore.validate_in_transaction` 在快照形状、范围和版本之外，
  再沿完整依赖集合检查 `forbidden_generation_memory_dependencies`。
- 任一失效或过期底层记忆存在时，L3 快照不再具备生成资格；新回复安全省略该层，
  原回复与审计仍按既有只读路径保留。
- 不改变 rejected/expired 的资格，不放宽 ADR-080，也不把旧 L3 重新签名。

## 自动验证

- 新增 RED：L3 batch、profile batch 与 generation 的依赖中加入真实 rejected 候选后，
  `capture` 原实现返回快照。
- 最小 GREEN：同一用例通过；owner L3 被省略，新材料不进入模型输入。
- 相关模块：79/79 通过，0 skip，耗时 206.995 秒。
- 覆盖 `test_owner_contact_layered_reply`、`test_layered_reply_context` 与
  `test_owner_layered_memory` 的真实 PG、HTTP 和受控模型链路。

## 实际 App 验证

- 使用 `npm run dev`，正常停读退出旧实例后热更新重启。
- 仅选择已授权验收联系人 `ran`，通过“切换为手动输入”确认本次联系人。
- 点击“帮我想想”后，持久请求最终完成并保存 3 个候选；初次客户端等待超时后，
  使用现有“查看已保存讨论”恢复出同一组 3 个候选。
- 本次调用成功越过上下文不变量并在模型后持久化；不再出现原先的
  `context_invariant_failed` 且 0 候选结果。
- 未向微信发送任何消息，未复制候选，未读取验收范围外聊天。

## 剩余风险

- 客户端等待与服务端持久化存在竞态：服务端已经完成后，界面可能先显示
  “未收到生成结果”，需要“查看已保存讨论”刷新。该恢复路径保留了已保存结果，
  但自动刷新体验仍应继续跟踪。
- 本轮仅证明 ran 的真实 App 路径；未据此宣称整个 DSH/TypeScript 迁移、
  最终质量门槛或 Python 退役已经完成。
