# 冻结 v9 物理快捷键人工确认与程序时序结果

2026-10-16，用户同冻结 v9 物理按 `Command+Shift+Y` 显示小窗、再次按同一组合收起小窗，已获用户明确人工确认。用户还澄清第二次确为该组合键；不要求重做。程序验收因第二次隐藏发生在 hide 请求发布之前，按预期保留失败；人工功能确认与程序阶段结果分别记录。

## 同包与实际证据

本场沿现有 `native-focus-acceptance.spec.ts` 原 human mode：显式 `NOTALONE_NATIVE_DESKTOP_ACCEPTANCE=1`，unset diagnostic/agent mode，Conda `NotAlone`、禁 dotenv、空启动配置、cwd `/`、独立随机 userData，无后端/PG/微信/CLI/API/模型/发送/权限操作。新 30 分钟/max1 有限窗口为 `07:31:42.667Z–08:01:42.667Z`，实际仅一次 App 启动。

App 始终为冻结 `remaining-nine-final-20261016-v9/NotAlone-darwin-arm64/NotAlone.app`；ASAR SHA-256 `e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021`，前后 strict 验签 0、ASAR 未变，未重包或重签。Root 仅用 CUA 将自建空 Finder 置前，没有向 NotAlone 发 CUA 按键。显示/隐藏实际物理键来自用户。

以下时间为 UTC，本地时间加 8 小时：

| 证据 | 实际结果 |
| --- | --- |
| external-focus | Root 实际 Finder 动作及 agent 对应 nonce 收据；程序观察两窗 hidden/unfocused |
| `07:32:53.568Z`，before-show | manager ID1、helper ID2 均 visible=false/focused=false |
| `07:34:44.265Z`，shown | 同一 helper ID2 visible=true/focused=true，manager ID1 仍 hidden/unfocused |
| 用户反馈 | 第一次物理快捷键显示，第二次同快捷键消失；明确澄清第二次为 `Command+Shift+Y` |
| `07:35:57.022Z`，human-show 收据 | Root 按用户第一反馈写匹配 show nonce 的 `confirmed=true` |
| 随后 hideBaseline | 原断言收到同一 ID1/ID2 均 visible=false/focused=false；helper 已经被第二次物理键隐藏 |

Root 独立方法确认在 `07:36:44.714Z` 写入 `root-human-method-confirmation.json`：两次物理组合键、显示/隐藏均 confirmed，`repeatRequested=false`、`secondActionBeforeProgramHideRequest=true`、`automatedHidePhaseCertified=false`。该记录已存在并保持原样；没有覆盖旧 pending 或补造 human-hide nonce。它是人工方法确认，不是程序 gate 收据。

## 程序失败的边界

原 case 在 `native-focus-acceptance.spec.ts:75` 要求“发出隐藏请求前，同一小窗必须仍显示”；实际两窗已经隐藏，因此正确失败。`human-hide-request.json` 尚未创建，hide 程序观察和收据阶段未执行，正常菜单退出路径未执行，`focus-results.json` 未生成。不能将此前的 hidden 状态填成第二阶段通过，也不将该协调时序失败抵消用户同包物理显示/隐藏的人工验证。

runner 于 `07:35:57.565Z` exit 1：human case 1 failed，diagnostic case 1 did not run，约 4.1 分钟。失败后由既有 App fixture 收尾，未重启、未重复人类测试；不把 fixture 关闭当作正常菜单退出验收。

## 自有资源与证据位置

`07:39:03.693Z` 精确核验 runner 57372、worker 57376、App 57377 均 ESRCH；随机 userData、租约 absent；默认 userData 身份保持；无 App/backend/native 剩余进程。Root 实际只关闭本场 empty-finder 标签，保留原 v9 标签，之后按 dev/ino 与 empty 检查 rmdir 本场目录及未使用的空 control 目录。没有测试 PG 或后台服务需要清理。

本地现场在 [`desktop/artifacts/native-focus-human-v9-20261016-bc88ad55-8295-4e39-b811-5c9f9259a5cd/`](../../desktop/artifacts/native-focus-human-v9-20261016-bc88ad55-8295-4e39-b811-5c9f9259a5cd/)，包含 scope/controller/归属、原请求与收据、原生 shown/before-show 观察、原失败日志、`human-feedback-evidence-summary.json`、Root 方法确认及 `resource-verification.json`。最终两窗 hidden/unfocused 的来源是原断言实际 received 值，未在 App 退出后补做 UI 观察。

现场被忽略、不提交；报告没有私人聊天、联系人身份、凭据或画面。此前 CLI/WCDB 自有恢复 pair 与 6 个空目录已在上一场按身份/SHA 清理，原官方缓存保留；本次未使用。独立Standards／Spec均0项需修，不将人工确认扩为完整程序验收或整产品交付通过。
