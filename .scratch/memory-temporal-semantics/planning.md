# 记忆时间语义实现索引

规格和四票拆分已于2026-10-20确认。集成分支：`codex/memory-temporal-semantics`。

| 任务 | 依赖 | 状态 |
| --- | --- | --- |
| [01 时间信息与回复依据](issues/01-time-evidence.md) | 无 | resolved |
| [02 来源日期与精度](issues/02-source-date-precision.md) | 01 | resolved |
| [03 适用条件](issues/03-applicability-conditions.md) | 01 | resolved |
| [04 有据时间线更新](issues/04-evidence-timeline-updates.md) | 02、03 | resolved |

仅实际完成并记录验证后更新状态。工程、独立模型质量和原生App验收分别报告。

票01已集成最新统一列表基线；时间设计改为 ADR-081，全部失效记忆禁止进入生成的 ADR-080 规则保持。四票原生 App 验收已完成，见 [原生验收](native-verification.md)。

票02、03已集成。同一本人事实同时携带事件 v2 的年精度与来源支持的适用条件，经正式直接提取、独立核验、确认、L2/L3 安全投影、回复输入和重启后的冻结依据保持一致；来源删除后冻结读取返回404。联合合成验收不代表真实模型质量，原生验收另行完成并记录。

联合验证：`test_memory_temporal_combination`、`test_memory_date_precision`、`test_memory_conditions`、`test_temporal_precision`、`test_memory_temporal_evidence` 共20项后端通过；桌面类型检查及日期／条件／时态相关14项通过。

票04及五项评审修复已集成。最终增量验证为25项时间线／合并／回复、33项事件、84项单元及迁移、5项桌面和类型检查通过；Standards 三项 P1、Spec 两项 P2 均确认修复，保留一项后续类型化建议。整体验证及限制见 [集成验证](integration-verification.md)。

交付仅在隔离集成分支；原工作区仍为用户的 `dacf658b` 及既有未提交改动。没有对业务数据库执行迁移、重提取真实聊天或进行远端发布。
