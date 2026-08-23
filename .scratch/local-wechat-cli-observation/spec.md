# 本地微信 CLI 前台增量观察规格

Type: task
State: open
Triage: ready-for-agent

> 来源：2026-08-24 `grill-with-docs` 设计访谈，共 43 个问题；架构记录见 ADR-016、ADR-017。
> 本规格记录用户已经确认的产品行为，不代表对应代码已经实现。

## Problem Statement

NotAlone 原计划用 OCR 识别微信聊天正文，但 OCR 还需要判断消息分组、说话人、时间、重复消息和历史连续性。当前本机已经安装的 `wechat-cli` 可以只读读取本地微信数据库，提供会话定位、增量消息、发送者、时间和稳定消息标识，因此应由 CLI 负责消息正文，OCR 只负责判断当前前台会话。

当前真实 CLI 测试已经证明：display name“姐姐”解析出 6 个候选，其中 2 个是精确私聊候选；候选 1 的最近时间为 `2026-08-23 19:59:43`，与截图左侧会话行的 `19:59` 对应。使用候选 1 的稳定会话标识调用 `tail` 时，严格只读模式返回 5 个 `message` 事件，字段包含 `id`、`text`、`is_from_me`、`sender`、`create_time`、`time_iso` 和续传 cursor。

## Goal

用户手动开启同步后，NotAlone 能够：

1. 确认微信在前台，并用顶部 display name 与左侧选中会话行的最小元数据定位当前会话。
2. 将当前会话解析为唯一的微信外部会话标识（`username`/`talker`）。
3. 通过 `wechat-cli tail --follow` 读取该会话的文字消息，包括联系人和我方消息。
4. 为每个 NotAlone 联系人独立保存 cursor/local_id，切换联系人时停止旧监听并启动新监听。
5. 切回联系人时补读其水位之后的消息，标记来源模式为 `cli_catchup`；补读消息通过校验后可以参与回复和记忆提取。
6. CLI 不可用时不退回 OCR 正文，不写入不可靠消息。

## Canonical Flow

```text
用户手动开启同步
  -> 微信前台检查
  -> OCR 顶部 display name
  -> OCR 左侧当前选中会话行的选中状态、最近时间和短预览
  -> 与 wechat-cli sessions/resolve-chat 候选匹配
  -> 唯一匹配后得到 talker/username
  -> 读取该 contact 的独立 cursor
  -> wechat-cli tail --follow --strict-read-only
  -> 校验 owner/contact、文字类型、sender/from_me、时间和消息 ID
  -> 按稳定消息 ID 去重
  -> 写入 local_wechat_observation -> message
  -> 更新该 contact 的 cursor
```

切换联系人时：

```text
旧联系人 tail 停止并保存 cursor
  -> 新 display name/选中行元数据匹配
  -> 启动新联系人的 tail
```

切回旧联系人时从其独立 cursor 补读，并将来源模式标记为 `cli_catchup`。手动关闭同步期间不补读；应用异常重启且同步仍开启时，当前前台联系人从已保存 cursor 恢复。

## Decision Log

以下编号对应 Grill 访谈中的 Q1-Q43；其中 Q6-Q10 的“纯 OCR 消息正文路径”在 Q21 选择 CLI 主路径后降为备用探索，不作为当前主实现路径。

1. 第一阶段目标是自动前台增量同步并写入消息层，不只是显示 OCR 文本。
2. 识别不确定时保留临时未归属观察，不进入 `message` 或检索，超时清理。
3. 首次绑定、首次开启和异常批次需要人工关注；正常可靠批次自动处理。
4. v1 只处理纯文字消息。
5. 开启同步时先读取当前可见内容，再与已有消息去重。
6. 在纯 OCR 方案中，说话人必须可靠区分；该责任现在由 CLI 的 `is_from_me`/sender 字段承担。
7. CLI 或来源提供明确时间时使用原始时间；没有时间时保留未知，不用读取时间冒充发送时间。
8. 在纯 OCR 方案中，多行片段按位置和行距合并；当前主路径由 CLI 消息边界替代。
9. 在纯 OCR 方案中，人工复核可以修改文字、说话人和时间；当前主路径不因正常 CLI 消息要求逐条复核。
10. 在纯 OCR 方案中，保留 OCR 来源和人工修正后的规范消息；当前主路径保留 CLI 来源元数据。
11. 唯一 display name 可以自动定位；没有匹配或重名时暂停，不猜联系人。
12. display name 改名时只确认一次新旧联系人映射。
13. display name 暂时不可读时跳过当前帧，等待下一帧，不沿用旧联系人写入。
14. 相同文字不能单独作为去重键，必须使用稳定消息 ID或上下文；CLI 主路径使用稳定消息 ID。
15. 用户手动滚动默认不触发同步，补录必须是单独明确开启的流程。
16. 自动处理需要唯一会话定位、可靠消息来源和稳定增量结果；主路径由 display name/选中行元数据加 CLI 字段满足。
17. 第一轮测试使用现有本地探针/命令窗口，不先做正式产品 UI。
18. UI 应持续显示当前联系人和同步状态。
19. 同步只能由用户手动开启，关闭时不读取。
20. v1 只支持一对一聊天，群聊不写入。
21. 采用混合路径：OCR 定位当前会话，CLI 读取消息正文。
22. 使用 CLI 增量读取，不重复导出全部历史。
23. CLI 读取受前台、同步开关和当前唯一会话限制；不全局监听。
24. CLI 输出先形成最小来源记录，再生成规范 `message`。
25. 历史导入和 CLI 消息按稳定消息 ID 去重；同一规范消息可以保留多个来源引用。
26. CLI 不可用时不退回 OCR 正文，提示同步不可用并重试。
27. CLI 由用户自行安装和初始化；NotAlone 只调用只读命令，不自动提取密钥或接管 CLI 生命周期。
28. 正常运行使用 `tail --follow`；首次测试先用一次性 `tail`。
29. 切换联系人时停止旧 tail，启动新联系人的 tail。
30. cursor/local_id 水位保存在 NotAlone，每个联系人独立保存。
31. display name 只用于定位；解析后使用稳定 `username`/`talker`，消息 `local_id`/cursor 只负责增量位置。
32. 切回联系人时从其 cursor 补读，来源标记为 `cli_catchup`。
33. 通过校验的 CLI 补读消息可以参与回复和记忆提取。
34. 手动关闭同步期间不补读。
35. 应用异常重启且同步仍开启时，当前前台联系人从 cursor 恢复。
36. 第一轮 CLI 验证是单联系人 `resolve-chat -> tail`，不接数据库。
37. 重名时需要一次性绑定稳定外部会话 ID，之后不重复确认。
38. 一次性绑定展示 display name、最近活动时间和头像等候选信息，由用户选择。
39. 重名自动区分需要当前会话的额外视觉或 UI 证据，不能只靠相同 display name。
40. 左侧选中会话行的头像可以作为备用视觉证据。
41. 头像变化时暂停一次，让用户确认并更新绑定。
42. CLI 同步联系人和我方消息，使用 `is_from_me`/sender 保存说话人。
43. 当前会话匹配优先使用 display name + 左侧选中会话行的时间/短预览，与 CLI `sessions`/`resolve-chat` 对齐；头像只作无法区分时的备用。

## Source And Scope

### Allowed

- 用户自行安装的 `wechat-cli` 只读命令。
- 微信前台状态、顶部 display name 和当前左侧选中会话行的最小元数据。
- 当前唯一绑定联系人的 `tail` 消息事件。
- 联系人和我方文字消息、发送者、时间、稳定 ID、cursor 和最小来源元数据。

### Not Allowed

- 全局监听所有联系人或同步开关关闭期间补读。
- 读取其他 App、自动切换微信会话、自动滚动、自动发送。
- 把 display name、头像、`username`/`talker` 直接当作 `contact_id`。
- CLI 不可用时用 OCR 正文作为静默降级。
- 保存全量 CLI 导出、完整截图或上传原始视觉帧。
- v1 群聊、媒体正文、语音转写和完整产品 UI。

## Data Contract

- `conversation_binding` 保存 `owner_id`、`contact_id`、微信账号范围、外部 `username`/`talker`、display name 映射、选中会话元数据和可选备用视觉指纹。
- `local_wechat_observation` 保存一次 CLI 增量读取的来源元数据、CLI 版本、读取时间、cursor/local_id、来源模式和外部消息 ID，不保存全量导出。
- `message` 必须显式带 `owner_id + contact_id`，保存正文、说话人、可用时间、稳定 ID 和来源引用。
- 每个联系人独立保存 cursor；初次 tail 不传非法的 `since_local_id=0`，成功返回的 cursor/local_id 才能用于后续增量读取。
- 删除绑定或来源时，按来源级删除规则清理其消息、派生记忆、索引和缓存；不删除本机微信数据库中的原始数据。

## Verification Plan

1. CLI 只读契约：对一个已选会话运行 `resolve-chat` 和一次 `tail --strict-read-only`，验证唯一会话、消息事件、ID、时间、`is_from_me` 和 cursor；报告只输出计数和字段，不输出正文。
2. 重名匹配：验证 display name 候选、左侧时间/预览和 CLI `sessions` 能区分候选；无法区分时不启动 tail。
3. 切换隔离：A -> B -> A，验证三个独立 cursor，不串联系人。
4. 补读：A 切走期间产生消息，切回 A 后只从 A 的 cursor 读取，并标记 `cli_catchup`。
5. 暂停：关闭同步期间产生消息，重新开启后不补读关闭期间数据。
6. 崩溃恢复：同步仍开启时进程中断，重启后从当前联系人 cursor 恢复，不创建重复消息。
7. 失败关闭：CLI 不可用、display name 不可读、选中行元数据不匹配或候选重名时，不写入消息、不退回 OCR 正文。

## Current Implementation Gap

- 当前 CLI 已安装并通过了单联系人只读结构探测，但没有 NotAlone CLI 适配器。
- 现有 `conversation_binding` 只有通用 `conversation_locator`，还没有 CLI cursor、选中会话元数据和备用视觉指纹的正式存储字段。
- 当前 `macos_sync_probe` 仍是前台截图/OCR 探针，尚未识别左侧选中行并启动 CLI tail。
- `local_wechat_observation`、CLI 消息规范化、跨历史导入去重和按联系人恢复仍未实现。
- 绑定候选 1 已由用户选择，但尚未写入 NotAlone 数据库。

## Related Decisions

- [ADR-001：Mac 微信前台会话同步](../../architecture/adr/001-macos-wechat-active-session-sync.md)
- [ADR-016：用本地微信 CLI 读取消息正文，OCR 只定位当前会话](../../architecture/adr/016-local-wechat-cli-observation.md)
- [ADR-017：优先用选中会话元数据匹配当前微信会话](../../architecture/adr/017-selected-session-metadata-matching.md)
