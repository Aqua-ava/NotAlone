# 03 — 持久化 CLI 会话绑定与一次性重名确认

Type: task
Triage: ready-for-agent
State: resolved
Blocked by: 01, 02

## What to build

把唯一 CLI 外部会话定位标识绑定到已有 NotAlone `contact_id`。首次重名、display name 改名或备用视觉指纹变化时提供一次性选择；之后使用保存的 `username`/`talker` 和匹配元数据自动切换。

## Acceptance criteria

- [x] 绑定始终带 `owner_id + contact_id + channel + account_scope`。
- [x] 保存外部 `username`/`talker`、display name 映射、左侧元数据匹配摘要和可选视觉指纹摘要。
- [x] 同一外部会话不能被同一 owner 同时绑定到两个 active 联系人。
- [x] 无匹配、重名无法区分、头像/元数据变化时不自动改绑。
- [x] 撤销绑定后不能继续读取或进入候选回复。

## Verification

- 两个同名候选只能通过一次性选择绑定，后续唯一匹配自动通过。
- 改名、头像变化、跨 owner/contact 和重复绑定均 fail closed。

## Out of scope

- 不读取聊天正文，不管理 tail 进程，不管理 cursor。

## Answer

已完成 CLI 会话绑定持久化与一次性重名确认：

- 迁移 019 为 `conversation_binding` 增加 `display_name`、`metadata_summary`（jsonb 对象）和 `visual_fingerprint` 三个可空证据字段；预览只保存 SHA-256 摘要，不保存原文。
- 仓库新增 `read_active_by_locator`、`list_active_bindings` 和 `update_matching_metadata`，并在创建/读取/撤销路径携带新字段；全部查询保持 `owner_id` 隔离。
- 新增纯领域匹配器 `match_front_session`：前台 display name/选中行证据与 CLI 私聊候选比对；已有绑定同名自动通过，改名要求一次确认，重名用时间/预览收窄，仍无法区分时返回一次性选择；证据全部矛盾或无候选时 fail closed。
- 同名候选只能通过一次性选择绑定；同一外部会话在同一 owner 下的 active 唯一性由已有唯一索引保证，冲突返回稳定错误。
- 撤销后的定位符不再被 `read_active_by_locator` 返回，也不能进入验证 Ready 路径（既有测试覆盖）。

验证结果：

- `conda run -n NotAlone python -m unittest tests.unit.conversation.test_matcher -v`：12/12 通过。
- `conda run -n NotAlone python -m unittest tests.integration.persistence.test_binding_cli_metadata tests.integration.persistence.test_conversation_binding -v`：11/11 通过。
- `conda run -n NotAlone python -m unittest discover -s tests -q`：307 通过，2 跳过。
- 迁移 019 已在 `notalone_dev` 与 `notalone_test` 成功执行。

剩余风险：

- 头像视觉指纹的实际生成（探针头像裁剪哈希）还未接入，字段仅可保存；`07` 接线时才产生真实指纹。
- 一次性选择的交互入口（展示 display name、最近时间和候选）由 `07` 的端到端接线提供。
- 评审后修复（提交 fcd3f1e）：时间证据比对只在文本含 `HH:MM` 时刻时生效，纯日期或相对时间不再误判为矛盾；迁移 019 改为幂等写法。
