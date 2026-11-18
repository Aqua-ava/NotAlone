# 历史协议与实施记录

本目录保存从现行规格中移出的旧协议、物理接口和阶段证据。它们用于解释当时设计或冻结评测，不是默认开发入口，也不证明当前实现、资料资格或验收状态。

| 历史材料 | 当前要求入口 |
| --- | --- |
| [核心流程旧接口、预算与阶段状态](core-flow-implementation-notes.md) | [核心流程](../current/core-flows.md)、[同步](../current/wechat-sync.md)、[回复](../current/reply-generation.md)、[记忆处理](../current/memory-processing.md) |
| [旧数据对象、schema 与实现状态](domain-data-legacy.md) | [领域数据](../current/domain-data.md) |
| [语用与三门协议](pragmatic-interpretation.md) | [记忆处理](../current/memory-processing.md)；仅显式历史任务沿原冻结协议核对 |
| [隐私与删除的阶段实现记录](privacy-implementation-notes.md) | [隐私与删除](../current/privacy-deletion.md) |
| [Skill 旧文件历史库与阶段实现](skill-implementation-notes.md) | [Skill Library](../current/skill-library.md) |
| [旧追踪流水线与 Python 接线](memory-trace-implementation-notes.md) | [记忆提取追踪](../current/memory-extraction-trace.md) |

旧设计讨论另见[草案归档](../drafts/archive/README.md)，决定原因见 ADR 目录（本机 `architecture/adr/README.md`）。历史原始数据、冻结证据和测试结果保持各自版本；整理文档不重跑验收、不迁移业务资料，也不把旧证明移作当前证明。
