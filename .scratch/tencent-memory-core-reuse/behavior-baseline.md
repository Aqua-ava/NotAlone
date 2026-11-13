# 腾讯流程参考与 Python 实现基线

参考版本：TencentDB-Agent-Memory `e9a82935b52741e0c798c75326e90b7144eb4d5f`。用户明确要求参考行为，不接入其运行时。本表是静态代码核对，不代表端到端通过。

| 流程 | 上游证据（MemoryCore/src/） | 现有 Python 证据（backend/src/notalone/） | 后续任务 |
| --- | --- | --- | --- |
| L1 完整提取 | core/record/l1-extractor.ts:93 | memory_extraction/direct_adapter.py 已直接生成完整候选，有限重试和修复保留 | 02 验证，不重造标签流程 |
| L1 相似召回与裁决 | core/record/l1-dedup.ts:56 批量裁决，默认 topK=5 | memory_extraction/adoption.py:374 逐条召回，:558 逐条裁决；adjudication.py:51 字符 bigram；:586 禁用正文级 noop | 02 补批量裁决及有来源的去重，明确召回差异 |
| L1 合并 | 上游 update/merge 写入 | adoption.py:628 已有多父 merge；command.py:185 注入 verifier；application/memory_upgrade_preview.py 未注入合并校验器 | 02/04 统一入口，保护手动资料 |
| L2 持续场景 | core/scene/scene-extractor.ts 读取已有场景并更新文档 | layered_memory_service.py:235 已带旧场景；scenario_publication.py:32 未提供 replaces 时拼接旧段落；organization_sdk.py:18 未告知模型替换协议 | 03 明确重整/替换语义，防止按批累加 |
| L3 更新旧画像 | core/persona/persona-generator.ts:92 旧画像，:112 变化场景，:143 无变化跳过 | persistence/layered_profile.py:81 仅构造场景、底层记忆、纠错；service.py:445 和 SDK:109 没有旧画像参数 | 03 冻结有效旧画像和来源，更新同一逻辑画像；无变化跳过 |
| 正式/预览一致 | 参考同一流程和检查点原则 | 私有全量预览临时脚本绕开正式持久流程；不能作为集成验收证据 | 04 共用 Python 正式编排，隔离存储，小批验证 |

保留差异：PostgreSQL 版本及递归来源、联系人/本人隔离、手动确认保护、有据背景限制、人工发送边界。不复制上游失败时全部存入的兜底，不增加未经授权的 embedding 外发。现有关键词召回不能声称向量或混合检索。

## 本轮验证

删除仅本任务创建且未跟踪的 memory-engine 实验目录（约 948 KiB）。没有修改本地腾讯项目、业务数据库、私人预览或已有重试实现。规格已改为现有 Python 架构内实现，四项依赖不变。
