# 07 — 完成前台定位到消息入库的端到端接线

Type: task
Triage: ready-for-agent
State: resolved
Blocked by: 02, 03, 04, 05, 06

## What to build

把 macOS 前台定位器、一次性会话绑定、CLI tail、来源/cursor、消息规范化和同步状态展示接成一个最小纵切。用户开启同步后可在两个一对一联系人之间切换，消息进入正确联系人范围；用户仍必须在外部微信中手动发送。

## Acceptance criteria

- [x] 当前联系人、同步状态、CLI 可用性和异常原因对用户可见。
- [x] 正常切换不要求重复确认；重名、改名、头像/元数据不一致时只在异常路径确认。
- [x] 消息、来源、cursor、from_me、时间和去重结果可查询且不泄漏正文到日志。
- [x] CLI 不可用、微信非前台、同步关闭、群聊或媒体消息不会进入错误联系人。
- [x] 回复上下文只能读取已验证联系人范围内的规范消息。

## Verification

- 合成 PostgreSQL 端到端测试覆盖绑定、切换、补读、暂停、恢复、去重、删除和联系人隔离。
- 经授权的本地 Mac 微信冒烟只记录计数、状态和字段，不把真实聊天正文写入测试夹具或报告。

## Out of scope

- 不实现自动发送、群聊、媒体解析、全局同步、完整产品 UI 或独立调度平台。

## Answer

已完成前台定位到消息入库的端到端最小纵切：探针证据 -> 绑定门禁 -> 一次性确认 ->
一次性 tail 轮询入库 -> 状态展示，全部由 `notalone-front-sync` 命令驱动：

1、探针机器可读契约：`macos_sync_probe` 新增 `--session --json` 输出（微信前台状态 +
顶部 display name / 选中行时间 / 短预览证据，缺失为 null）；非前台与证据不可读是稳定的 ok
状态，权限缺失等环境错误返回 `ok: false` 错误码；新增 2 个 JSON 字段合成测试，`swift test`
16/16 通过，`scripts/build_cli.sh` 构建成功。
2、Python 探针适配器 `front_sync/probe_adapter.py`：解析 JSON 契约为 `FrontSessionEvidence`，
探针不存在/超时/输出损坏/权限错误都失败关闭为稳定错误码，不回显探针输出；12 个单元测试。
3、`TailLifecycle.observe_front_session` 改为返回携带绑定决策的 `FrontObserveOutcome`，
`poll` 返回本轮处理的规范消息数，`FrontSyncStatus` 增加活跃绑定 display name；既有 13 个
集成测试更新后全部通过。
4、新增 `front_sync/sync_engine.py`：`FrontSyncEngine.cycle` 把探针观察、门禁、轮询与
CLI 可用性汇总为不含正文的 `FrontSyncCycleReport`；`confirm_binding` 提供一次性选择入口：
首次/重名创建绑定（保存 display name 与证据摘要，预览只存 SHA-256），改名只更新既有绑定；
探针不可用按非前台失败关闭。
5、新增 `notalone-front-sync` 命令（`enable/disable/status/confirm-binding/contacts`），
账号范围取 owner 的 active 微信渠道身份；输出只有状态、计数、展示名称与候选标识。
6、端到端集成测试 14 个：首次确认入库与自动通过、重名一次选择、A→B→A 切换隔离与补读、
回复检索范围隔离、关闭窗口跳过、与导入重叠跨来源去重、撤销停读、群聊/媒体失败关闭、
CLI/探针失败关闭、改名一次确认、确认入口错误路径、展示输出不泄漏正文与预览。
7、设计偏差（如实记录）：规格 Decision 2 的“不确定时保留临时未归属观察并超时清理”
在本纵切中改为直接失败关闭：识别不确定时不写入任何观察记录，不产生需要清理的未归属数据；
未归属观察的保留与清理留到真实需要时再引入。头像备用证据（Decision 40/41）未接入：
探针 JSON 契约暂不输出头像指纹，绑定字段保留但本轮不产生真实指纹；元数据不一致路径已实现。

验证结果：

- `conda run -n NotAlone python -m unittest tests.integration.front_sync tests.unit.front_sync -v`：
  47/47 通过。
- `conda run -n NotAlone python -m unittest discover -s tests -q`：413 通过，2 跳过；
  `compileall` 通过；`swift test` 16/16；探针与命令入口的参数冒烟通过（未读取真实聊天）。
- 真实 `wechat-cli` 与真实微信未在本轮读取聊天内容。

剩余风险：

- 经授权的真实微信冒烟（切换两个联系人、标题不可读、非前台，只记录计数/状态/字段）需要
  屏幕录制授权与用户手动操作，尚未执行；探针 `--json` 输出的真实微信字段验证留到该冒烟。
- `--follow` 长进程评估仍未进行；当前一次性轮询在消息密集时延迟取决于调用方的轮询间隔。
- 命令是单进程单次循环，还没有常驻调度与产品 UI；连续观察需要调用方按间隔重复运行 `status`。
