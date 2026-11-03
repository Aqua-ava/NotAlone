# 文档、ADR 与整项验收

Triage: ready-for-agent
State: open
Blocked by: 01, 02, 03

规格：[删除逐条消息选择与排除功能](../spec.md)。

## 目标

删除现行文档中的排除功能描述，新增 ADR-165 说明替代关系，并完成全链路验证。

## 范围

- `architecture/current/reply-generation.md`、`core-flows.md` 和 README 的现行表述。
- 新增 ADR-165，并在 ADR-079 标注部分替代。
- 全仓 `excludedMessageIds`／`excluded_message_ids` 清理与兼容拒绝检查。
- 最小相关测试、类型检查、实际开发 App 交互验收。
- 不修改历史记录正文，不删除历史资料。

## 测试 Seam

公开边界：文档引用、当前 SQLite 生成、旧回复合同和桌面可见交互。

## 验收

- 当前文档不再把逐条排除写成可用能力。
- 全仓只保留必要的旧字段拒绝与历史说明。
- 后端、桌面测试和实际 App 验收覆盖新默认行为。

## Comments

- 2026-11-04：按用户要求仅发布实现 ticket，不开始代码实现。
