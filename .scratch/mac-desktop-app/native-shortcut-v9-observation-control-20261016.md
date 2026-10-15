# v9快捷键观察方式对照记录

日期：2026-10-16（台北时间）。继[前两场v9复验](native-shortcut-v9-20261016.md)后，新增场3与场4均未通过。场3实际按一次系统组合键后又使用`cua.getApp`及AX观察，最终管理后台可见／获焦、小窗隐藏，显示断言超时；该观察过程可能干扰窗口状态，但没有OS因果证据。场4尝试提前绑定App以避免按键后重新获取，尚未实际按键就因外部前台收据超时结束，不能据此排除场3的观察干扰，也不能认定当前产品快捷键故障根因。

两场仅Agent操作，无用户体验反馈。旧失败与旧包／真人通过记录分别保留，当前v9快捷键仍未验证通过；没有启动物理键盘人工对照，用户意愿问题仍pending。

## 版本、范围与原件

两场各实际启动1次冻结v9包`desktop/artifacts/remaining-nine-final-20261016-v9/NotAlone-darwin-arm64/NotAlone.app`，独立userData、空配置、后端未连接。ASAR仍为`e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021`；主Agent本轮`codesign --verify --deep --strict`退出0。完整性结果不认证系统按键送达、产品回调或TCC归属。

原件位于两个忽略目录：

- 场3：`desktop/artifacts/native-focus-v9-no-auth-20261016-16ba5631-894d-4410-b5c6-416e8c19ba52/`。
- 场4：`desktop/artifacts/native-focus-v9-prebound-20261016-2d1c25af-eb1b-482a-886a-6787ea9f13ea/`。

两目录均有scope、owned、`root-preparation.json`、`run.log`、`runner-exit.json`及Playwright协调／窗口原件。场3另有`external-focus-action.json`、`actual-actions.json`、`root-process-cleanup-check.json`、`root-finder-cleanup-check.json`及归档租约；场4以`root-cleanup-check.json`记录独立收尾。本报告只读原件，不复制截图、机器路径、私人配置或凭据，不改当前main16的79文件冻结集合。

## 场3：取消空认证框后，按键及观察未取得显示证据

runId为`16ba5631-894d-4410-b5c6-416e8c19ba52`。启动前，主Agent经Computer Use发现此前自建系统设置留下的空认证框并点击取消，未输入密码、选择App或修改TCC。实际沿Conda NotAlone的Python subprocess读取`/usr/sbin/ioreg -a -l -w0 -r -c IOHIDSystem`及`/usr/sbin/ioreg -a -l -w0 -d 1`，用`plistlib`在内存解析，仅递归取key同时含secure和input的字段，两次均输出`secure_input_properties=[]`。这只描述有限范围的查询结果，不能推断属性不存在、系统未启用secure input，或认证框／secure input导致此前失败。

主Agent创建自有空Finder标签页，执行Finder“隐藏其他”，实际核实空窗口后写external-focus Agent收据。收据与本场请求nonce匹配，`performed=true, observed=true`。程序`focus-before-show-observed.json`在2026-10-15 UTC 21:46:00.510Z记录manager id1、helper id2均隐藏／未获焦，随后进入show步骤。

`actual-actions.json`记录`keypressCount=1`、`key=super+shift+y`、`firstKeyAt=1792100778255`，即UTC 21:46:18.255Z。实际按键发生于Finder前台；之后主Agent重新`cua.getApp`获取当前存活v9包并读取AX，未见小窗，动作记录的后续`observationAt`为21:46:48.627Z。这些时刻是动作记录，不是系统送达或产品回调时间。

程序show观察180000ms超时，最终错误快照为manager id1的`visible=true, focused=true`，helper id2的`visible=false, focused=false`。与show请求nonce一致的负Agent收据为`performed=true, observed=false`；失败发生在[用例](../../desktop/tests/native-focus-acceptance.spec.ts)观察回调，尚未到[协调代码](../../desktop/tests/native-shortcut-coordination.ts)随后读取show收据的步骤。没有hide请求、显示成功状态或最终`focus-results.json`，也未执行用例末尾正常菜单退出认证。

`run.log`记录单case失败约4.1分钟、`app_test_cleanup_unconfirmed`；runner最终code2／signal null，结束UTC 21:49:00.731Z。管理后台在观察期间出现是已记录事实；“按键后的获取App／AX操作造成该变化”仍只是可能解释。本场既不能证明纯快捷键产品故障，也不能证明取消认证框已经排除了系统输入干扰。

## 场4：提前绑定App的对照未到按键阶段

runId为`2d1c25af-eb1b-482a-886a-6787ea9f13ea`。为避免场3的按键后重新获取App，主Agent在external-focus准备期间先绑定`cua.getApp`，实际点击管理后台关闭按钮，再返回同一自有空Finder。此场Finder“隐藏其他”为disabled，没有点击该项，随后取消菜单；未把未执行的菜单动作记成前台保证。

协调程序在UTC 21:51:29.602Z写两NotAlone窗口隐藏／未获焦的程序观察记录，但未获得有效Agent external-focus收据，90000ms等待超时。主Agent随后准备写收据，先校验本场PID得到`ESRCH`，因此未写迟到收据；原请求的响应文件确实不存在。程序观察文件不能替代实际Agent收据。

`run.log`记录单case失败约1.5分钟；runner最终code1／signal null，结束UTC 21:52:59.106Z。按键0，show、hide及正常菜单退出认证均未进入，没有最终成功结果。本场是准备／协调失败，不是“提前绑定后快捷键仍失败”的有效对照。

## 实际启动时段与命令

以下时刻均为2026-10-15 UTC，台北日期已为2026-10-16。两场scope各8分钟、maxLaunches1；实际启动命令从`desktop/`运行，Agent模式和v9包绝对执行路径只由端侧环境提供。按`run.log`将输出目录中的`***`展开为实际本场目录，本文没有重新运行：

```sh
npm run test:app -- --interactive --coordinator root-v9-no-auth-focus \
  --from 2026-10-15T21:44:51.769Z --until 2026-10-15T21:52:51.769Z \
  --max-launches 1 \
  --output artifacts/native-focus-v9-no-auth-20261016-16ba5631-894d-4410-b5c6-416e8c19ba52/playwright \
  tests/native-focus-acceptance.spec.ts

npm run test:app -- --interactive --coordinator root-v9-prebound-focus \
  --from 2026-10-15T21:51:25.380Z --until 2026-10-15T21:59:25.380Z \
  --max-launches 1 \
  --output artifacts/native-focus-v9-prebound-20261016-2d1c25af-eb1b-482a-886a-6787ea9f13ea/playwright \
  tests/native-focus-acceptance.spec.ts
```

## 独立收尾与当前缺口

场3的`root-process-cleanup-check.json`在UTC 21:50:54.412Z记录5个已归属PID及自有runner进程组gone、userData absent、v9路径进程0，`normalQuitCertified=false`、`keyboardDeliveryCauseProven=false`。主Agent核对唯一lease id `c8364f0c-b711-497e-a433-ceea0acdb11d`、coordinator `root-v9-no-auth-focus`及归属runner PID 49975已gone后，仅将该本场租约rename到本场`archived-owned-lease/`，没有删除或接管未知锁；原exit2与收尾未确认记录保持。

场4的`root-cleanup-check.json`在UTC 21:58:58.751Z记录4个已归属PID及自有runner进程组gone、userData／共享租约absent、v9路径进程0，`lateReceiptWriteRejectedBeforeWrite=true`、`keypressCount=0`、`normalQuitCertified=false`、`originalRunnerExit=1`。这些独立存在性核验不改写原失败，也不扩大为所有未记录后代的完整认证。

两场共用的自建空Finder标签页由主Agent通过Computer Use关闭，原v5包标签保留。主Agent核对共享自有目录属当前用户、非符号链接且为空后执行rmdir；场3的`root-finder-cleanup-check.json`及场4回执共同记录同一次清理，自有标签页／目录已不存在，不计为两次独立资源清理。

本次整理只读核对了时间、阶段文件是否存在、两个场3收据nonce／布尔、末态、退出码与上述收尾回执，未再运行GUI、`ioreg`、测试、CLI、探针或模型。没有后端配置、真实微信读取、聊天发送、密码输入或权限变更；物理键盘对照及用户反馈仍缺。本报告不改变原票据、进度、冻结依赖或任何生产行为，也不把观察过程的可能干扰写成已证根因。

独立Standards／Spec均0项；审查覆盖本报告、20票末段及进度表对应增量，只读两场原件，没有扩大验收结论。
