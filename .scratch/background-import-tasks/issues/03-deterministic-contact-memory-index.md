# 03 — 确定性联系人记忆目录

**Triage:** ready-for-human
**State:** resolved

**What to build:** 在记忆提取成功后，为每位联系人维护一份只用于定位的 `contact_memory_index`。目录只引用当前有效的 `confirmed_memory`，不成为新的事实源；单条变化优先增量更新，批量变化或版本不一致时合并重建，并在验证成功前保留旧目录。

**Blocked by:** 02 — 目录需要消费记忆提取和自动采纳的结果。

- [x] 每个 `owner_id + contact_id` 只有一份当前逻辑目录。
- [x] 目录只保存少量分类、主题摘要和 `memory_ids`，最多 20 个主题，不复制聊天或记忆正文。
- [x] 只把 active、有效期内且来源仍有效的 `confirmed_memory` 放入目录。
- [x] 每次记忆变化递增 `memory_revision`；目录记录 `built_from_memory_revision` 并能识别过期版本。
- [x] 单条新增、修改、删除支持确定性增量更新；批量变化、版本不一致或更新失败进入合并重建。
- [x] 重建不调用模型；新目录完成数量、范围和有效性验证后才替换旧目录。
- [x] 重建失败时旧目录继续可用，任务记录失败原因并支持重试。
- [x] `index` 和 `verify` 步骤的成功/失败状态与父任务一致，不能由模型宣布成功。
- [x] 合成 PostgreSQL 测试覆盖目录隔离、有效期、删除、revision、增量更新、重建回滚和主题上限。

## Comments

- 目录规则以 ADR-015 和现行数据契约为准。

## Answer

已完成：新增 018 迁移、联系人级 `memory_revision` 和 `contact_memory_index`。目录由确定性代码从
当前 active、有效期内且来源有效的 `confirmed_memory` 生成，只保存分类、主题提示和 UUID 引用，
最多 20 个主题，不复制正文。

单条变化支持增量入口；批量变化、版本不一致或主题上限不适合增量时走完整重建。重建在同一事务
中完成候选验证、写入和持久化后二次验证，失败会回滚并保留旧目录；读取时再次校验当前 revision、
来源状态、有效期和引用范围。Worker 已接入 `index -> verify`，不调用模型。

验证：目录、Worker 和记忆存储相关测试通过，全套测试 262 个通过、2 个既有权限测试跳过；018
迁移在 `notalone_test` 和 `notalone_dev` 应用成功；编译与 `git diff --check` 通过。
