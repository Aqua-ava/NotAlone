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

- [x] 默认快捷键冲突可见且可修改；重复唤起不创建新窗口。
- [x] 小窗可以拖动、置顶、隐藏和恢复，管理后台可独立打开。
- [x] 注册/注销及窗口操作自动验证，真实快捷键实机检查；不读取或控制微信输入框。

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
- 2026-10-08：两轴初评 Standards 明确违规 0、possible smell 0；Spec 明确 bug/范围扩大 0，提示“整体隐藏后只恢复目标窗口”存在潜在缺口。新增实际 App 反馈回路后，原生隐藏及仅恢复 helper 的断言 red（manager 实际仍显示）；CUA 在本轮签名包 PID 3753 点击“隐藏 NotAlone”，观察两窗 true → 整体隐藏时两窗 false → 只选小窗后两窗 true，准确复现缺口。`MenuItem.click()` 对 macOS `hide` role 未生效仅是测试技术限制，自动化改用确认公开菜单项后执行官方 `Menu.sendActionToFirstResponder('hide:')`，不调用产品私有方法或快捷键回调。
- 2026-10-08：最小修正在 `AppWindows.open` 的整体隐藏恢复分支先隐藏非目标窗口，再执行 `app.show()` 并恢复目标。新增回归 green 覆盖两窗双向独立恢复；重建签名包 CUA PID 10854 实际菜单复验也通过：仅 helper 时 manager=false/helper=true，仅 manager 时 helper=false/manager=true；窗口 ID 1/2 与 bounds 全程不变。两轮隔离 App 均正常退出，随机 userData 已回收；首轮退出后 CUA 读取状态曾意外重新启动同路径 App PID 4551，该实例不计入验收，已原生菜单退出，之后不再对退出实例读取 CUA。产物分别为 `desktop/artifacts/04-native-hide-manual/observations.json` 与 `desktop/artifacts/04-native-hide-green-manual/observations.json`，均不提交。
- 2026-10-08：增量 `npm run typecheck`、`npm test`（10 项通过）、`npm run package`、严格签名校验通过；打包 App `tests/desktop-controls.spec.ts tests/windows.spec.ts` 为 8 项通过、1 项占用夹具跳过。已合入集成 `86f4ba2ca708a5920f4a7b52dbc9ce720a54b9b9`（merge `f0a7fad573da91c44ce22485f8fd8633390fcca0`），固定基点不变。修复只影响本 App 窗口恢复，不增加权限、持久化或业务读取；全局快捷键真实派发仍未通过，本轮未发送系统按键，保持 claimed 等主 Agent 增量复查。
- 2026-10-08：续接聊天使用已保存的任务 03 签名 App，在全新 userData、无后端路径和独立 env/info 下复验系统按键。CUA `super+shift+space` 未创建小窗；修改为 `Control+Alt+F9` 后显示注册成功，`ctrl+alt+F9` 也未创建小窗。只记录未验证，不据此归因于产品或系统。已恢复默认 `Command+Shift+Space`，CUA `super+q` 正常退出本轮 PID 44472，随后清理自己的 userData；未读取真实配置、聊天、模型或剪贴板。最初观察脚本因工作目录错误退出并完成隔离 App 清理，改从 desktop 执行后的这轮才作为按键观察；App 退出后的 Node 观察宿主需另行结束，不计作产品退出失败。
- 2026-10-08：上述非私密观察保存在集成工作树 `desktop/artifacts/continuation-shortcut/observations.json`（其中 `registered` 仅检查默认键，切换备用键时为 false 不代表备用键注册失败）。CUA 文档仍要求替代输入技术须用户明确请求；已在续接聊天异步询问仅两次隔离 App 的 CGEvent 按键验收或用户亲自按键，目前等待答复，未经答复不执行替代技术。任务继续 claimed，不以注册和 CUA 普通菜单键成功冒充全局派发验收。
- 2026-10-08：用户在续接聊天明确允许“两次隔离按键验收”。使用已保存的任务 03 ad-hoc 签名 App，在全新随机 userData、空后端配置、独立 env/info 及不存在的 CLI/探针路径下启动 PID 55929；CUA 先点击公开“打开输入小窗”。独立 CGEvent 程序只在目标 App 前台、既有事件派发预检通过、计数递增且上限为 2 时发送 `Command+Shift+Space`，未请求或改变 TCC。前台不符的两次预检退出未发送按键，不计入两次实际派发；没有重试已经派发的按键。
- 2026-10-08：两次真实系统派发通过：第一次小窗 id2 从 visible=true 变为 false，第二次同一 id2 恢复 true；位置与尺寸始终为 `(620,390,680,300)`，管理后台 id1 始终独立可见。CUA 窗口树和只读 Electron 窗口观察分别核验，实际派发计数文件为 2。CUA `super+q` 后确认 PID 55929 退出，观察宿主正常结束并清理本轮 userData。证据位于集成工作树 `desktop/artifacts/continuation-cgevent/`；仅包含隔离窗口状态、计数和本轮脚本，不含聊天、凭据或私人配置。本次没有读取剪贴板或微信、启动业务后端、输入正文或外部发送。真实系统按键缺口已补齐，仍不宣称外部 App 的非独占冲突检测；候选保持 claimed，等待窗口恢复修复的增量两轴评审后写 Answer。
