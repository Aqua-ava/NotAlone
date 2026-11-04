# 05 — 实际开发 App 验收单次 Skill 调用

Type: task
State: resolved
Triage: ready-for-agent
Blocked by: 04

按 [spec](../spec.md) 在实际开发 App 中验证预加载 Skill 的一次模型调用、依据展示和失败降级。必须使用 `pnpm run dev`，不得自行打包或运行打包版。

## What to build

- 先核验并复用现有热更新开发实例，不并发重启多个 App。
- 使用隔离用户目录或合成联系人资料完成候选生成；如必须使用真实联系人资料，遵循现有授权和最小数据范围，不提交私人截图或正文。
- 验证首次模型调用已包含 Skill 正文，且本次请求只有一个 Skill 选择/生成模型调用。
- 验证页面显示本次预加载 Skill 名称、版本和降级状态。
- 验证没有逐次手选 Skill 控件。
- 验证 `skill_resource` 若非必要不触发额外调用；若触发，记录真实次数和原因。
- 不发送任何外部消息，不调用微信发送能力。
- 核对 App、后端、模型和读取进程的收尾状态，清理本轮临时资源。

## Acceptance Criteria

- [x] 实际 App 正常生成候选，不发生“先选 Skill、再生成”的第二次调用。
- [x] 候选依据与真实预加载 Skill 一致。
- [x] 预算或 Skill 失效时可看到明确降级提示。
- [x] 页面没有新增手选步骤。
- [x] 未发送外部消息，未读取或上传无关私人资料。
- [x] 验证使用 `pnpm run dev`，未触碰打包发布门禁。
- [x] 验证结果、限制和日志证据写入 Answer。

## Tests

- Computer Use 操作实际开发 App 和必要的本地窗口。
- 后端状态接口或受控日志确认 `model_call` 次数和失败阶段。
- 相关桌面合成回归优先复用 04 的结果。
- 不能由 HTTP 成功或页面显示单独推断完整桌面链路。

## Out of Scope

- 真实微信发送。
- 真实用户长历史质量评测。
- 打包、签名、发布和远端操作。
- 后台图片/记忆查询性能修复。

## Answer

- 最终 HEAD：`416f4b7509e4532ccf30f64fe9fa2c4fff6651c9`。实际使用 `pnpm run dev --user-data-dir <隔离目录>` 启动，进程命令包含 `--notalone-dev`；未运行打包版、`pnpm start` 或发布流程。
- 实际 App 在同一合成联系人、3 条合成聊天、92 个内置 Romance Skill 和本地合成 SSE 模型上完成两次候选生成。点击 `帮我想想` 后，两次请求均只有 1 条物理 `model_call`，各有 92 条 `skill_selection` 与 92 条 `skill_input`；没有先选 Skill 再生成的第二次调用。
- 候选项显示本次预加载的 Skill 名称和第 1 版，展开“实际进入模型输入的 Skill 内容”后可见 92 个 `SKILL.md` 的名称、版本、相对路径和正文。打开详情前后 `model_call`、模型日志行数和 `skill_input` 数均不变；本轮没有 `skill_resource` 额外调用。
- 页面没有逐次手选 Skill 控件。预算/整体失败路径使用 257 个合成 Skill 验证：请求仍 `committed` 且只有 1 次物理模型调用，出现 `skill_unavailable`，UI 显示“回复策略暂不可用”，不渲染 Skill 详情，也不截取部分 Skill。
- 数据边界：仅使用合成联系人、聊天、Skill 和本地回环模型；未读取真实微信或私人资料，未向外部模型发送数据，未发送任何消息。
- 最终干净空 `userData` 复核只执行普通 UI `Cmd+Q`：App 正常退出，`dev:status` 为 `{"mode":"stopped","pids":[]}`，无残留 Electron/后端/模型/读取进程。
- 详细时间、候选窗口、状态码、分页限制和自动测试证据见 [Performance 04 Answer](../../reply-generation-performance/issues/04-dev-app-latency-acceptance.md)。限制：真实 92 Skill 正文未自然超过 1.5MB，因此多页正向路径由后端集成测试覆盖，未伪造实际第二页。

## Comments

- 2026-11-04：按规格创建，依赖 04。
