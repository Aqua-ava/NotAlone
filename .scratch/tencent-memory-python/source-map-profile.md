# L3 增量画像映射

参考腾讯只读源码 `e9a8293`，目录 `/tmp/notalone-tencent-memory-inspect/MemoryCore/src`。只借鉴流程，自行 Python 实现，不引入腾讯运行时或额外供应商。

| 腾讯代码 | 本项目实现 | 产品适配 |
| --- | --- | --- |
| `core/persona/persona-generator.ts:80,91` 读取已有画像 | `persistence/layered_profile.py:incremental_profile_context` | 同 owner/contact、启用代次选择基准；校验完整底层来源，任何旧依据失效则不外发旧正文 |
| `core/persona/persona-generator.ts:110,122` 找变化场景 | `ProfileWork.changed_scenarios/removed_scenario_version_ids/base_profile_version_id` | 使用不可变版本而非时间戳比较；持久化本次基准及完整输入，提交前再次检查撤回、来源、纠错、租约与当前场景全集 |
| `core/persona/persona-generator.ts:143,149` 无变化跳过及增量模式 | `LayeredMemoryService._organize_profile`、`profile_workspace.maintain_profile` | 沿用02独立无变化回执，场景不变时不调用画像模型；变化时传入已有画像与变化场景 |
| `adapters/standalone/llm-runner.ts:132,156,182,347` 文档工具循环 | `memory/profile_workspace.py` | 内存 profile.md 可read/write/edit，当前场景只读；不访问真实文件；最多五轮、每轮八次工具操作 |

正式默认工厂 verified_items 同时启用 L2/L3 工具。L3最多五次物理请求，保留独立核验一次；共享16次任务额度，每次HTTP发送前持久扣账。显式 qualified_suite 仍保留单次提案、四阶段4次合同。

Markdown编译回现有画像条目协议。仍有效旧来源不能丢失；未受变化场景影响的条目必须完整保留；独立核验还要审查受影响条目的语义遗漏。核验过滤后再次检查保留约束，失败不发布部分画像。所有条目仍须实际L1版本证明，场景和旧画像不能代替事实来源。本人范围使用既有白名单投影，旧画像不带联系人来源身份。来源删除仍沿用递归物理删除，人工纠错保护仍沿用既有终态校验。

## 验证

用户确认的公开边界：聊天导入/生产任务到当前L1/L2/L3读取；只脚本化模型HTTP与已有embedding边界。

- 首次红：旧JSON提案不支持画像工具；绿：首次及下一次增量画像均通过HTTP任务完整发布。
- 保留红：仅新条目的画像原可发布；绿：遗漏未变化条目/仍有效来源拒绝发布。
- 5项HTTP覆盖首次与增量、遗漏保护、事实纠错重建、无变化跳过和来源物理删除。
- 工作树绝对PYTHONPATH运行 `python -m unittest tests.integration.server.test_tencent_profile_tools tests.unit.application.test_default_organization_runtime tests.unit.memory.test_organization_sdk_verification -v`：14项通过。
- 临时数据库运行 `test_layered_profile_management.LayeredProfileHttpTest` 的 `test_dirty_does_not_resume_failed_profile_or_refill_paused_budget`、`test_failed_fourth_call_and_restart_cannot_refresh_a_free_profile_budget`：2项通过；临时库已删除。
- 未调用真实模型、未启动桌面、未打包。03调度由并行任务交付；真实整链和桌面验收由04完成，本文不宣称已完成。

## 工具协议纠错补充

画像工具提示词独立于旧 JSON 提案协议，明确 documents 为完整可读索引，仅允许简单 Markdown 文件名；空场景索引直接创建文档，画像仅写 profile.md。单次工具参数或路径错误以静态错误说明回传 ToolMessage，可在原有五轮内纠正；不读取真实路径、不增加预算，持续越界仍失败且不发布。

公开 HTTP 合成边界先复现 `/memories/preferences.md` 错误导致失败，再验证纠正后正式发布；L2/L3 共16项通过，涵盖未纠正越界、合并来源保留、删除及增量画像。本轮未调用真实模型。
