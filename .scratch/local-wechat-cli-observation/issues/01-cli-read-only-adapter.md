# 01 — 建立本地微信 CLI 只读适配器

Type: task
Triage: ready-for-agent
State: resolved
Blocked by: None

## What to build

建立 NotAlone 与用户自行安装的 `wechat-cli` 之间的最小只读适配器。适配器负责调用 `resolve-chat`/`sessions` 和一次性 `tail`，解析结构化事件，保留 `username`/`talker`、消息 ID、时间、`is_from_me`、sender、文字类型和 cursor；CLI 不可用、返回错误或输出不完整时返回稳定失败，不打印聊天正文。

## Acceptance criteria

- [ ] 所有调用显式使用严格只读模式，不安装、初始化、刷新或导出 CLI 数据。
- [ ] `display_name` 候选按精确、模糊、私聊/群聊类型保留结构化结果。
- [ ] `tail` 事件只接受 v1 文字消息；消息 ID、sender/from_me、时间和 cursor 可读取。
- [ ] 非零退出、无效 JSON、缺少会话标识或缺少消息 ID 映射为稳定错误。
- [ ] 错误和日志不包含消息正文、完整会话 ID、数据库路径或凭据。

## Verification

- 使用 fake CLI 输出覆盖成功、重名、CLI 不可用、非法游标和结构漂移。
- 使用当前 v1.6.20 CLI 做一次单联系人严格只读冒烟，只报告字段和计数。

## Out of scope

- 不写 PostgreSQL，不创建绑定，不启动 `tail --follow` 长进程。
- 不读取截图，不负责当前前台窗口判断。

## Answer

已完成本地微信 CLI 只读适配器：

- `resolve_chat` 保留精确/模糊候选、私聊类型、最近时间和 `username`。
- `sessions` 保留左侧会话匹配所需的时间、预览和发送者元数据。
- `tail` 解析文字消息、外部 ID、sender、`is_from_me`、时间和 cursor；非文字事件跳过并推进 cursor。
- CLI 不存在、超时、非零退出、无效 JSON、空输出、跨 talker 事件和缺失消息 ID 都返回稳定错误，不泄露原始 stderr 或聊天正文。
- 所有调用显式使用 `--strict-read-only`；没有数据库、绑定、截图或长进程接线。

验证结果：

- `conda run -n NotAlone python -m unittest tests.unit.wechat_cli.test_adapter -v`：14/14 通过。
- `conda run -n NotAlone python -m compileall -q src/notalone/wechat_cli tests/unit/wechat_cli`：通过。
- `conda run -n NotAlone python -m unittest discover -s tests -q`：289 通过，2 跳过。
- 当前本机 `wechat-cli` v1.6.20 严格只读冒烟：候选 6、精确候选 2、读取 5 个事件，其中 4 个文字事件，cursor 存在；未输出聊天正文。
