# 07 根集成与实际 App 验收

日期：2026-10-25（Asia/Taipei）

## 接收范围

独立会话提交已按原 SHA 合入主树：

- `fa4b5750480f6eb4a07e10bc2bc0454a34512c0a`：恢复候选时从当前或已保存回复共同派生实际 Skill。
- `5dc90e83d12e759fff1763a138a533a2baaad5d3`：提交独立会话的 CUA 矩阵。

主树另以
[`feadf945`](../context-invariant-l3/validation.md)
修复了真实会话中失效 L3 依赖阻断空白建议的问题；该提交属于根回复上下文修复，
不改变 07 的 Skill 选择或写入责任。

## 根验证

| 验证 | 结果 |
| --- | --- |
| `desktop && ./node_modules/.bin/tsc --noEmit` | 通过，0 错误 |
| `node --test tests/unified-workspace-view.test.mjs` | 8/8 通过 |
| `test:pages --case understanding-direction` | 通过；完整 owner 切换、迟到结果、失败、续改删除与历史依赖删除 |
| `test:pages --case reply-strategy-skills --case source-deletion-replies` | 通过；express/suggest 的自动 Skill、通用流程、版本固定重试和来源撤销 |
| 两组页面资源清理 | `cleanupConfirmed=true`，Chrome 与合成后端退出，自有资源查询 0 |

## 真实开发 App

使用现有 `npm run dev` 热更新实例，正常停读退出并重启，未打包、未启动打包版。
只选择用户指定的验收联系人 `ran`，通过手工输入确认本次联系人；未读取或切换其他
联系人，未发送外部消息。

1. 在 ran 工作区点击“帮我想想”，真实请求越过失效 L3 依赖并在模型后保存 3 个候选。
2. 初次客户端等待超时后，使用现有“查看已保存讨论”恢复同一组 3 个候选；这是可见的
   恢复竞态，不改变持久结果，也没有产生第二组候选。
3. 修复后的候选区显示“本次使用通用流程（未使用回复 Skill）”；持久回复中的
   `used_skill` 为 `null`，页面与实际快照一致。
4. 本次参考显示聊天 50 条与本次输入 1 条；未复制、编辑或发送候选，未扩大桌面读取范围。

此前已完成的 express、自动 Skill、最近 50 条和候选编辑保存证据继续有效；本轮不重跑或
覆盖旧证据。联系人切换、删除和迟到结果由本轮无头生产页面在隔离合成资源中验证。

## 剩余风险

- 真实 App 的通用流程分支已覆盖；自动加载具体 Skill 和编辑保存的最终原生证据沿用既有
  实际 App 记录，本轮没有用无头结果替换。
- 客户端在服务端已经持久化后仍可能先显示等待超时，必须通过“查看已保存讨论”恢复；
  结果不丢失，但自动刷新体验仍需后续优化。
- 全量桌面安全集仍被既有 `tests/expression-preferences/bigint.test.mjs` inventory
  缺口阻断；相关模块全部通过，不能宣称全量安全集通过。

## 结论

07 的原五项验收要求均已具备代码、DSH 边界、合成 HTTP/PG、生产页面与必要实际 App
证据；可以标记 resolved。上述客户端恢复体验和全量 inventory 缺口作为独立风险保留，
不回退 07 已验收的业务行为。
