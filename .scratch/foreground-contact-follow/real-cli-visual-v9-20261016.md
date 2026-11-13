# v9真实CLI与正式视觉组合：helper焦点门超时

日期：2026-10-16，以下时刻均为台北时间。结论：同v9单场 **1项失败，约3.7分钟，runner exit1**。微信阶段的新正式单帧通过；helper阶段等待70秒后仍未满足程序窗口焦点门，Finder阶段未执行，不能认证本场CLI／视觉完整独立性。原fixture已认证停读并自动清理，另有精确自有资源复核；没有重启或追加观察补签。

## 冻结包、依赖修复与确认范围

App仍为 `desktop/artifacts/remaining-nine-final-20261016-v9/NotAlone-darwin-arm64/NotAlone.app`，未重新打包、重签或改源码。其Finder原生／权限责任分项见[独立同包通过场](../mac-desktop-app/finder-v9-immediate-result-20261016.md)；两场分别计证，不将Finder通过充当本场通过。

准备时发现旧私有scope指向的旧C目录已不存在，CLI和WCDB文件缺失；未将这解释为授权缺口，也未按缺失路径直接启动。仅在既有官方缓存 `desktop/artifacts/helper-upstream-20261010.onrvwc/runtime/` 找到与旧C历史收据一致的原始字节。经主Agent明确同意，用独占复制恢复到scope原批准路径，没有覆盖未知文件或下载新版本：

| 文件 | bytes | SHA-256 | 文件权限 |
| --- | ---: | --- | --- |
| `wechat-cli` | 9190002 | `59de512a52d7960aef70da6b42d199358429662919f5b4baababc5132a660355` | 0700 |
| `libWCDB.dylib` | 5120912 | `279ac6855ff2865caafa9718ae660e6e30a9667e4748ab064189ae633fd35fc3` | 0600 |

源和恢复文件的strict签名通过，6个新建目录及2个文件逐项记录dev／ino／权限／SHA。这只是恢复既有外置验收依赖缓存，不是恢复完整旧C App，也没有将第三方工具放进v9 bundle。来源／许可的历史未确认项不因字节恢复而改变。

run为 `462e87c0-3838-4aed-b99b-0d150015e29a`，租期14:44:34.725–14:52:34.725，最多且实际启动1次。新scope只更新起止和两份独立审计路径，locator、approved_texts、CLI／WCDB／sandbox路径逐项保持；`allow_incoming_test_text=false`、`long_running=false`。旧模板字节未改。现有 `load_scope` 静态guard通过后才启动，静态检查不执行CLI、不读数据库或key。

本场沿Conda NotAlone、禁dotenv、独立userData、随机隔离PG和已确认单联系人新基线，真实CLI只按原只读sandbox及白名单运行。没有安排来信、外部发送、模型调用、私人历史导入或第二联系人。App沿受控Electron入口启动，本场不重签Finder启动或TCC归属。

## 阶段与真实失败

主Agent在每次实际GUI动作后直接读取当前 `control-state.json`，核对阶段、存活PID和截止，将本场runId写入相应trigger；后台不代发。wechat触发时间为14:46:48.440，程序阶段起点为14:46:48.571；helper触发时间为14:47:45.414，程序阶段起点为14:47:45.605。

| 阶段 | 已保存的严格结果 |
| --- | --- |
| 微信 | 新正式观察starts1／completed1，pending0、invalid=false、ready=true；通过快照时两个App窗隐藏且失焦。 |
| helper | 70秒焦点等待超时，`phases.helper`未形成；最后快照helperVisible=true、helperFocused=false，manager隐藏且未获焦，allUnfocused=true。 |
| Finder | 未发布／执行本阶段trigger，未验证。 |
| 正常菜单退出 | 未执行本场用例的quit路径，不认证。 |

主Agent的Computer Use操作当场打开小窗，并观察到helper内容的焦点标记；随后只写trigger／文件，没有继续GUI操作。程序保存的最后窗口焦点与该当场观察分别保留，不能将截图扩成连续70秒获焦，也不能据此确定焦点变化、输入工具或产品的根因。

实际堆栈为 `real-sync-visual-independence-acceptance.spec.ts:130`：`expect.poll(...).toBe(true)` 等待70000ms，Expected true／Received false。helper阶段的回调先检查 `BrowserWindow.isFocused()`，未满足时返回false；本结果没有形成该阶段正式视觉证据，不能因为有真实tail完成就签同一helper阶段组合通过。runner于14:48:56.834结束，App随后由fixture自动收尾，没有重启。

微信表格是通过时保存的有界快照，不覆盖其后到helper动作之间的全部交接。整场正式测量共84次启动／84次完成，固定分类76 paused／8 recognized，采集请求及顶部OCR各8；这些是整场计数，不能移入helper阶段、当作8次身份认证或掩盖该阶段未通过。独立辅助流没有纳入本入口的测量，`auxiliaryIncluded=false`保持。

## CLI实际计数与停读分账

只计审计 `started` 中正整数PID，实际CLI启动7次：version2、sessions_follow1、tail4；不把reserved／无PID行再算一次。4个tail均以相同记录PID结束、returncode0，并出现4条accepted。另有9条scope拒绝，不作为已执行读取或放宽范围的依据。

这些计数不证明helper阶段已满足视觉与CLI同时独立，也不证明来信、正向补齐、消息入库／重复计数、私聊身份或双联系人连续性。`emptyContactConfirmed`等最终状态断言尚未执行，不能追补其结果。

用例自身 `normalQuit=false`、`authenticatedStopped=false`、`ownedProcessesGone=false`保持；这是完整quit认证路径未到达。收尾夹具另记 `authenticatedStopped=true`、`stopSource=app-http-response`、backend exit0／signal null、`databaseDropped=true`、未确认资源为空，两者分开报告。

后台独立复核11个已记录controller／worker／App／backend／CLI PID全部ESRCH，userData与fixture目录不存在，精确随机 `notalone_real_sync_*_test` 库以只读SQL确认不存在，租约absent。清理后额外5秒实际CLI启动7→7、新增0。这不是本场正常菜单退出认证，也不扩称所有未记录后代或进程组。

首次精确库复核误用Finder测试库名前缀，在查询前被断言拒绝；对照现有real-sync支持代码的实际前缀后，只读查询通过，没有列举或删除未知数据库。

本场自建空 Finder 目录未进入 Finder 阶段、没有打开窗口；主 Agent 于15:00:08.901核对原dev／ino及空目录后用rmdir清理，`root-empty-finder-cleanup.json`记录目录已不存在。

恢复的CLI／WCDB依赖对按主Agent要求保留到整组桌面工作结束，当前是有明确归属的待清理资源；未删除原官方缓存或未知文件。其后续清理须再次核对创建身份和字节，不能直接递归删除旧C目录中的新增未知内容。

## 命令、原件与剩余项

实际从 `desktop/` 的Conda NotAlone环境执行；旧前台凭据变量预先清除：

```sh
NOTALONE_DISABLE_DOTENV=1 NOTALONE_REAL_SYNC_VISUAL_ACCEPTANCE=1 \
NOTALONE_TEST_REAL_SYNC_SCOPE=<本场私有scope绝对路径> \
NOTALONE_AUTOMATIC_CONTROL_DIRECTORY=<本场control绝对目录> \
NOTALONE_TEST_APP_EXECUTABLE=<已核v9绝对可执行路径> \
npm run test:app -- --interactive --coordinator root-v9-18-real-visual \
  --from 2026-10-16T06:44:34.725Z --until 2026-10-16T06:52:34.725Z --max-launches 1 \
  --output artifacts/real-sync-visual-v9-20261016-462e87c0-3838-4aed-b99b-0d150015e29a/playwright \
  -- tests/real-sync-visual-independence-acceptance.spec.ts
```

忽略原件：

- `desktop/artifacts/real-sync-visual-v9-20261016-462e87c0-3838-4aed-b99b-0d150015e29a/`：scope／static-scope-preflight、control与Root实际动作、run／runner-exit、双审计、Playwright结果／测量／收尾、`fixed-result-summary.json`、`root-cleanup-check.json`和`exact-database-final-check.json`。
- `desktop/artifacts/real-sync-v9-cli-repair-20261016-79d1f5b1-99d5-4234-a2c5-ece46719ee40/dependency-repair.json`：恢复源与目标的固定摘要、新建目录／文件身份和保留范围，不含联系人内容。

原始UI、私人scope、身份、正文和凭据不提交。18／20仍不能据本场收口；此前v5通过、同v9 Finder通过及本场失败分别保留。未改测试门或产品，未再启动。报告独立 Standards／Spec 均0项需修。
