# v9接续：快捷键验收误判修正与单启动实测

日期：2026-10-16。结论：修正验收脚本让旧 hidden 状态冒充第二次按键成功的缺口；本次 Computer Use 实机场仍在显示阶段超时，**没有完成显示／隐藏／正常菜单退出验收**。用户此前确认实体按键显示的反馈保持，不将工具场失败解释成产品故障或补签实体隐藏。

## 代码与离线验证

[原实体场](finder-tcc-v6-and-keyboard-v9-result-20261016.md)在收到第二次隐藏反馈前已经 hidden；旧用例只查当前 hidden，可能误用旧状态。本次只修改[现有用例](../../desktop/tests/native-focus-acceptance.spec.ts)：show 对应 actor 收据完成后，立即检查精确两个窗口的身份、管理后台隐藏和同一小窗仍可见，通过后记录同一次快照，再发布 hide 请求。小窗 focused 仅保留实际状态，不要求用户反馈期间持续获焦；原 show 阶段获焦要求不变。

旧实际边界片段的离线回放在“show 收据完成后已经 hidden”时仍发布 hide，得到 request1／rejected=false；首修使其 request0／rejected=true。使用真实 Playwright expect 与 esbuild 转译实际用例片段，不添加产品接口或新的运行控制。首次未转译 TS 语法的脚本 SyntaxError 不算有效红灯。原 actor／nonce 收据门不变，窗口状态不能自动生成实际操作或人工收据。

首修额外要求小窗持续获焦，Spec 独审指出该要求超出原规格并会拒绝用户回 Codex 反馈的合法操作；随后移除该条件。同一实际源片段对可见但失焦场先红后绿，最终7项正负控通过：旧 hidden、错窗口身份、额外窗口、管理窗可见或获焦均拒绝，仍可见但失焦允许发布 hide，shown→hidden 正控保留实际 before-hide 快照顺序及焦点值。`npm run typecheck`、`node --test tests/packaging/native-shortcut-feedback.test.mjs`（3／3）和 `git diff --check` 均通过；Standards 与 Spec 最终增审各0项，P2关闭。

## 实际单启动场

run `1b0013da-62a6-4760-9c19-5c5dbde375a1`，固定 UTC 05:36:59.871–05:46:00.872，最多1次、实际1次。只运行 `tests/native-focus-acceptance.spec.ts`，agent 模式，不使用 human 收据。`test:app` 构建主树 dist，但实际 App 是指定的冻结 v9 包，不重打包或迁移旧包成绩。

App ASAR SHA-256 为 `e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021`，与旧 v9 相同，`codesign --verify --deep --strict` 通过。空启动配置、独立 userData、cwd=/、禁用 dotenv，无后端、CLI、原生探针、模型或微信读取；外部发送0。该场运行首修的 focused 基线版本，但显示失败使其尚未到达；后继移除隐藏前持续获焦条件只作离线验证，不声称已用于本场。

Agent 用 Computer Use 从 Finder 菜单进入自有空目录；一次快捷目录组合键没有打开定位框，随后实际改用菜单完成，没有把无效动作当作准备成功。App 管理后台和小窗创建后都隐藏，程序记录 manager1／helper2。Agent 实际点击空 Finder 标题置前，并看到空目录，才写对应 external-focus 操作收据。

取得新的 show 请求后，Agent 在该 Finder 实际按一次 `super+shift+y`，随后读取 Finder AX 和图像，未观察到小窗显示；没有重新获取 NotAlone 的 CUA App 或通过管理按钮制造显示。本次 actual-action 收据为 performed=true／observed=false，未伪造成功。程序继续在原180秒观察上限等待，最终仍记录 helper2 hidden／unfocused；负收据未被观察后阶段读取，不将其拒绝当作显示失败原因。

结果为 **1项失败、报告3.3分钟、runner code1／signal null**，UTC 05:40:20.974结束。终端另提示一项测试外错误，未提供另一具体错误栈；不据此声称整场所有收尾路径无错误。hide 请求、隐藏前基线及正常菜单退出均未执行，不能认证隐藏修正已被本次真实 App 覆盖。此结果也不能确定系统输入投递、快捷键回调或产品行为哪个环节有问题。

实际命令由 Node 生成当时有限时间及随机输出目录，再调用现有入口，关键参数如下：

```sh
NOTALONE_AGENT_NATIVE_DESKTOP_ACCEPTANCE=1 NOTALONE_NATIVE_DESKTOP_ACCEPTANCE=0 \
NOTALONE_DISABLE_DOTENV=1 NOTALONE_TEST_APP_EXECUTABLE=<本机已核v9可执行文件> \
node scripts/test-app.mjs --interactive --coordinator resume-shortcut-v9 \
  --from <本场起始ISO> --until <本场固定截止ISO> --max-launches 1 \
  --output artifacts/resume-shortcut-v9-1b0013da-62a6-4760-9c19-5c5dbde375a1 \
  tests/native-focus-acceptance.spec.ts
```

## 清理及原票状态

自有 App PID、worker PID、runner PID共3个均通过 `process.kill(pid,0)` 得到 ESRCH；精确 userData absent，公共 `test:app:status` 为 absent。Agent 用 Computer Use 关闭自有空 Finder 窗口，再确认该目录为非链接空目录后 rmdir；没有终止未知进程或清理其他数据。此检查只认证上述3个记录 PID和精确路径，不扩称全系统或所有未记录后代。

原件位于忽略的 `desktop/artifacts/resume-shortcut-v9-1b0013da-62a6-4760-9c19-5c5dbde375a1/`，包括固定 actor 请求与正／负收据、窗口基线、退出和含精确范围说明的独立清理检查。原始 UI、私人显示名与截图不提交。

[18](issues/18-foreground-locator.md)／[20](issues/20-mac-app-delivery.md)继续 claimed，未勾 AC不变；v6 Finder/TCC分项已独立审查收录，但不能拼成最终同包完整交付。本次没有新增模型预算或质量成绩，三记忆票与排除的15张任务保持。完成实体隐藏仍需一次独立、实际实体键盘对照，当前没有保持等待的 App。
