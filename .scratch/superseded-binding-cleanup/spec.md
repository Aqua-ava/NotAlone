# 修复同步后清理被取代的旧绑定副本（交接，2026-11-07）

状态：needs-triage → 待实现。用户已明确：与 ADR-144 冲突时直接覆盖其“旧消息保留”条款。

## 现状（只读实测，真实库）
- 每次“修复同步”（recertify）`Rotate` 把旧 binding 置 `revoked` 并新建 binding，全量重读历史进新 binding；`Finalize` 只删栅栏，不清旧副本（backend-ts/src/history/sqlite/recertify-actions.ts Rotate≈L160-180、Finalize≈L196-212）。
- 联系人 A：4 个 binding，3 个 revoked，各 14195 条（真实消息数），新副本 14203；库内该联系人 5.6 万条。活跃联系人各 2–5 份，全库 832 binding。
- 旧副本仍被派生结果引用（联系人 A）：reply_candidate_input_source 350、reply_context_item 350、run_input 75、processing_item 67、memory_citation 4、memory_required_message 4；另有 capture_record/history_quote/message_media/media_file 等。新副本目前无任何记忆/候选引用。
- 读取资格只认当前 binding（history/sqlite/source.ts: `m.binding_id=g.binding_id`），旧副本是存量浪费，界面/检索/记忆是否会读到未逐一核实。

## 目标行为
1. 修复通过（Finalize）后，同联系人被取代(revoked 且已被新 binding 取代)的旧 binding 下，**没有任何派生引用**的消息及其 capture_record/alias/quote/媒体文件被清理；仍被引用的保留。
2. 现有存量副本：先出清单（联系人、binding、可清/保留条数、媒体文件数/字节），**用户确认后**才执行；执行前备份。
3. 走现有删除框架（backend-ts/src/storage/sqlite/deletion/，scope 见 contracts.ts:4-6；history 域 history/sqlite/deletion.ts；媒体 media/sqlite/deletion.ts 处理托管文件），不手写 DELETE；有界分批，不阻塞同步。
4. 不触发 history_deletion_fence/排除项（这不是用户删除，不能阻止重读）；与进行中的 recertify/删除操作互斥。

## 必须覆盖
- “被引用”判定：全部含 message_id 的表（排除 message_alias 本身）；用 PRAGMA 枚举或登记表，新增表漏登记要有测试兜底。
- 媒体托管文件的磁盘清理与 holder 机制；history_quote 依赖；capture_record 复合外键。
- 测试：合成库造 3 旧 binding + 部分引用，断言只删未引用，引用方不变；Finalize 触发；幂等/中断续跑；真实库副本上演练（只读原库，复制后跑）。
- 文档：新 ADR 说明覆盖 ADR-144 哪些条款；同步 architecture/current/wechat-sync.md、privacy-deletion.md；ADR-144 顶部补回链。

## 第二阶段（另起任务）
修复改增量：旧新来源可证明同一物理来源时，继承旧游标/消息，只补读增量，避免全量重读（需改 ADR-144“空游标完整遍历”）。

## 另：15 位联系人仍被围栏（修复成功后又被围栏，触发点未知）
在 1 完成前不要批量点“修复同步”，否则每人再多存一份。现场保留清单见 docs/verification/fence-origin-attribution-20261107.md。
