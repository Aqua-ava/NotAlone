# 04：快捷键与小窗桌面操作

Type: task
State: claimed
Triage: ready-for-agent
Blocked by: 01
Spec: ../spec.md

## 交付行为

全局快捷键唤起/隐藏小窗，可拖动、置顶，并从菜单栏重新打开窗口。

覆盖规格用户故事：9、10、11。

## 验收条件

- [ ] 默认快捷键冲突可见且可修改；重复唤起不创建新窗口。
- [x] 小窗可以拖动、置顶、隐藏和恢复，管理后台可独立打开。
- [ ] 注册/注销及窗口操作自动验证，真实快捷键实机检查；不读取或控制微信输入框。

## 测试与范围

- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Comments

- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。
- 2026-10-08：在独立分支 `codex/mac-app-04-shortcuts` 开始实现，固定基点为 `2d560b6886bd257896d89a763f92e92e1881199c`。使用已确认的实际 App 操作接缝；默认 `Command+Shift+Space`、双窗口和桌面操作范围已批准。候选实现后由主 Agent 统一安排两轴评审，评审前保持 claimed。
- 2026-10-08：候选实现已覆盖真实注册结果、可改组合、原子保存非秘密配置、失败保留旧键、正文置顶、同窗隐藏恢复和退出注销。新增 `src/main/shortcuts.ts`、`desktop-settings.ts`、`desktop-controls.ts`、具名 DesktopBridge 及独立 `renderer/DesktopControls.tsx`；窗口和主入口仅作桌面操作与装配，不修改 Python、业务数据、联系人、生成、剪贴板或同步。
- 2026-10-08：red → green 证据：默认配置区缺失（断言找不到控件）→ 默认注册可见；只读配置导致改键测试超时 → 修改并重启恢复；首屏无注册失败提示 → 在系统边界注册占用后的真实 App 显示失败并可恢复；无正文图钉按钮 → 置顶/隐藏/重复打开/后台恢复通过。保存失败和非法组合、退出注销另加公共操作回归。未用直接调用快捷键回调作验收。
- 2026-10-08：`npm ci`、`npm run typecheck`、`npm test`（9 项）、`npm run package`、`codesign --verify --deep --strict --verbose=2 out/NotAlone-darwin-arm64/NotAlone.app` 通过。`NOTALONE_TEST_APP_EXECUTABLE="$PWD/out/NotAlone-darwin-arm64/NotAlone.app/Contents/MacOS/NotAlone" npx playwright test tests/desktop-controls.spec.ts tests/windows.spec.ts --output=artifacts/04-packaged` 为 7 项通过、1 项占用夹具跳过；签名包不被修改。已快进最新集成 `2882a6c4dd21107f8e135875eb56422fea65cffe`，原固定基点不变。
- 2026-10-08：CUA 实机只操作本轮打包 App、PID 84888 与随机 userData。图钉 0→1、标题隐藏、同窗恢复及后台独立恢复通过；标题拖动复验前 helper id2 bounds 为 `(1199,789,680,216)`，CUA `drag([360,28],[420,50])` 后为 `(366,789,680,216)`，之后正文按钮点击仍有效且 bounds 不变。Cmd+Q 返回 App quit，本轮进程和随机目录均已回收。观察脚本在 App 提前退出后读取 Playwright 已失效 process 句柄曾报错，已修正为预存 ChildProcess，并只清理本轮目录。
- 2026-10-08：全局键实机未通过：CUA `super+shift+space`、保存 `Command+Shift+K` 后 `super+shift+k` 均没有显示/隐藏小窗；`super+w` 可原生关窗、配置框 `super+a` 后 `shift+k` 可见为 K，Cmd/Shift 映射已核验。最终已保存/注册恢复为 `Command+Shift+Space`，helper 仍显示。工具要求“Use `cua_repl` (JavaScript) for all UI actions.”及“Do not use other technologies besides `cua_repl` for computer interactions, unless specifically requested by the user (e.g. AppleScript, `osascript`, JXA, System Events, CGEvent synthesis).”；没有使用其他输入方式绕过限制。不能由注册状态推断真实全局派发通过，也不归因于尚未证明的系统故障。
- 2026-10-08：两进程合成系统占用实验均注册成功，macOS SDK 的 `CarbonEvents.h` 允许非独占多 App 注册。自动化仅在隔离 wrapper ready 回调先安排按键占用，并在 ready 前同步加载未经替换的原始 App 入口，验证真实 `register=false` 的可见/修改行为；不宣称已证实外部 App 冲突检测。产物在工作树 `desktop/artifacts/04-manual/observations.json`、`moved-helper.png` 和 `artifacts/04-packaged/`，均不提交。任务保持 claimed，待主 Agent 统一两轴评审和真实全局键验收。
