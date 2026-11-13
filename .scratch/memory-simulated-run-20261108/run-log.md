# 模拟用户启动单个联系人记忆处理：运行记录

目的：以普通用户路径对一位联系人（下称 A，`1c43e3c0`）启动记忆处理，记录过程中遇到的错误，留待后续修复。本记录不含聊天正文与联系人姓名。

## 环境与方式
- 开发实例 `pnpm run dev`（Electron 44.7，SQLite 受控存储）；模型 DeepSeek `deepseek-flash`。
- 本会话没有 Computer Use，开关与启动经本机认证后台接口（`/api/memory-processing/automatic`、`/contacts/{id}/history`）完成，未在界面验收。
- 起始状态：总开关关闭；A 无记忆、无候选；2026-11-03 有一次失败任务 `extraction_model_provider_unavailable`。

## 时间线（2026-11-07 本机时间）
- 22:01 打开总开关，对 A 启动历史处理（run `902ca95f`，433 项：432 文字 + 1 图片；13 张图片未就绪）。
- 22:01:55 另一 run `b8a5dade`（联系人 C `27ab43c0`）同秒出现，22:02:53 run `9085a1da`（联系人 B `08b42fe7`，`history-auto:` 前缀）出现。均非本次请求，见 issue 02、03。
- 22:03:48 关闭总开关（A 的第 6 批此时已在途），所有 run 变为 paused。
- 22:04:04 第 6 批核验失败，任务 `failed`，见 issue 04；失败发生在关开关之后 16 秒内，不能完全排除两者有关，见 issue 04 的复核项。

## 第一轮结果（22:01 至 22:04）
- A：提取成功 100/433 条（5 批），第 6 批失败，383 条待处理；memory 0、candidate 0。
- B：360 条、C：50 条被处理并发送给模型（超出授权范围）。

## 第二轮：限定范围后继续（00:13 至 00:33）
- 为避免其他联系人再被处理，临时在 `.env` 加了 `NOTALONE_BACKGROUND_PROCESSING=manual` 并重启开发实例；重启也清掉了内存里的 pausedBySwitch，B 的 run 保持暂停。结束后已恢复 `.env`，总开关已关闭。
- 打开开关后点「继续」：提取在 420/433 处再次因同一错误失败；再点一次「继续」，最后一批通过，提取 433/433。
- 随后裁决/关系核验完成：联系人范围 16 条记忆采纳，1 条候选待定，本人范围 33 条候选待定；run 状态 `incomplete / later_stages_pending`。
- 全程共 88 次成功模型调用、2 次失败；其他联系人没有新增 run。

## 未覆盖
- L2 主题整理（1 小时窗口）和 L3 画像：manual 模式下后台调度没有启动，没有执行，也没有验证回复阶段如何使用这些记忆。
- 界面：没有 Computer Use，全部经本机后台接口，界面显示和按钮行为没有验收。
- 图片：13 张图片未就绪，仅 1 张进入处理。

## 清理
- `.env` 已恢复，总开关已关闭，辅助脚本与追踪文件在会话临时目录（含聊天内容的 trace 未入仓库）。

## 发现的问题
| 编号 | 摘要 |
| --- | --- |
| [01](issues/01-superseded-binding-copies.md) | 同一联系人消息在 3 个绑定下各存一份，统计为 3 倍 |
| [02](issues/02-global-switch-processes-other-contacts.md) | 总开关全局生效，无法只处理单个联系人；`manual` 配置未传到后台子进程 |
| [03](issues/03-unknown-global-start-run.md) | 出现来源不明的无前缀 run |
| [04](issues/04-verification-root-keys-mismatch.md) | 核验回复被报 `root_keys_mismatch`，诊断分类与现行协议冲突，真实原因被掩盖 |
| [05](issues/05-one-bad-batch-blocks-whole-contact.md) | 单个批次协议错误让整个联系人任务失败，需手动继续 |
| [06](issues/06-self-candidates-left-pending.md) | 本人候选 33 条与联系人候选 1 条停在待决定，run 停在 incomplete |
| [07](issues/07-adjudication-slow.md) | 裁决与关系核验约每条 35 秒 |
| [08](issues/08-pending-items-on-revoked-binding-copies.md) | 已撤销绑定副本上残留 50 个待处理项 |
| [09](issues/09-late-ready-images-not-in-run.md) | 运行开始后才就绪的 13 张图片未进入当前 run |
| [10](issues/10-ambiguity-reason-has-no-ui-text.md) | 待确认原因 memory_ambiguity_unconfirmed 无界面文案；34 条候选界面可见性待验 |
| [11](issues/11-self-candidates-skip-adjudication-mislabeled.md) | 本人 33 条候选未进裁决，且被误标成「歧义待确认」 |
