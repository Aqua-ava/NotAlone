# v9系统快捷键两场复验

日期：2026-10-16（台北时间）。v9的系统快捷键仍未通过。第一场在实际按键前等待外部前台收据超时；第二场由Agent实际两次操作`Command+Shift+Y`后，未观察到同一小窗显示，程序显示断言180秒超时。隐藏快捷键步骤未执行，根因尚未定位，不能断言按键投递失败或产品回调失败。两场均无用户体验反馈，不迁移旧真人或旧包的通过结果。

## 版本、范围与原件

两场各实际启动1次`desktop/artifacts/remaining-nine-final-20261016-v9/NotAlone-darwin-arm64/NotAlone.app`，独立userData、空启动配置，后端未连接；不运行CLI、探针、微信读取或模型，不发送外部消息，不改变权限。ASAR只读重算均为`e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021`，本轮`codesign --verify --deep --strict --verbose=2`退出0。完整性检查不证明快捷键派发或TCC归属。

原件保留在两个忽略目录中：

- 场1：`desktop/artifacts/native-focus-v9-agent-20261016-255f5177-4624-4edc-bcf9-1589ae657fab/`。
- 场2：`desktop/artifacts/native-focus-v9-ready-20261016-ad7cbdbd-bcd7-42a0-9940-c91913d6b8e8/`。

各目录有`scope.json`、`owned-runner.json`、`run.log`、`runner-exit.json`、`root-cleanup-check.json`及Playwright单case原件；场2另有`actual-actions.json`及`archived-owned-lease/lease.json`。报告仅复制匿名状态、计数和时间，不提交截图、私有配置或机器路径值。

## 场1：外部前台准备超时，按键0

runId为`255f5177-4624-4edc-bcf9-1589ae657fab`。公开配置显示`Command+Shift+Y`已注册，按钮先打开并隐藏小窗，管理后台关闭为隐藏；`focus-owned.json`记录manager id1、helper id2、`backendConfigured=false`、`defaultUserDataUsed=false`。

主Agent创建并导航自有空Finder窗口耗时较长，未在external-focus收据等待的90秒内完成实际观察并写收据。程序仅生成`shortcut-agent-external-focus-observed.json`，它只证明两NotAlone窗口隐藏／未获焦，不证明Finder已置前，也不是Agent操作收据。[协调代码](../../desktop/tests/native-shortcut-coordination.ts)在该程序观察完成后等待对应actor的独立收据，实际89999ms超时；show步骤未进入，按键次数0。

`runner-exit.json`为code1／signal null；`root-cleanup-check.json`明确`keypressPerformed=false`、`externalFocusReceiptWritten=false`。这是准备／协调失败，不能作为快捷键产品故障。本场3个已记录PID及记录的runner进程组gone、独立userData absent；不扩大为所有未记录后代的独立认证。

## 场2：实际按键后显示未被观察到

runId为`ad7cbdbd-bcd7-42a0-9940-c91913d6b8e8`。沿用场1已经准备好的同一自有空Finder。主Agent通过Computer Use Raise并核实为空窗口，写入与本场external-focus请求nonce一致的`performed=true, observed=true`收据。程序随后记录`focus-before-show-observed.json`：manager id1与helper id2均`visible=false, focused=false`，进入show请求。

`actual-actions.json`和主Agent操作记录如下；UTC均为2026-10-15，两次操作都针对系统组合键，并未直接调用产品快捷键回调。表中时间是记录字段对应的动作时点，不能当成OS收到按键或产品回调的时间。

| 动作记录 | UTC | 结果 |
| --- | --- | --- |
| `firstKeyAt`，`pressKey('super+shift+y')` | 20:38:52.945Z | 操作后未见helper显示 |
| `secondKeyObservedAt`，同组合键保持150ms | 20:39:44.025Z | 操作后仍未见helper显示 |

Agent保存与show请求nonce一致的负收据`performed=true, observed=false`。程序show阶段的windowState轮询179999ms后仍未匹配helper显示且获焦的目标，最终错误快照为两窗均隐藏／未获焦；没有`focus-shown-observed.json`、hide请求或`focus-results.json`。因此只能说明操作后与程序检查中未取得目标显示观察，不能补签隐藏、同窗切换、管理后台全程隐藏或系统输入送达。

负收据是独立实际操作证据；本次失败首先发生在[用例](../../desktop/tests/native-focus-acceptance.spec.ts)的show观察回调，尚未进入随后读取show收据的步骤，不把“收据被拒绝”写成断言根因。`run.log`保留`1 failed`、显示观察超时和`app_test_cleanup_unconfirmed`；runner最终code2／signal null。没有走用例末尾正常菜单退出断言，后续资源清理不等于该断言通过。

## 实际命令与独立收尾

两场从`desktop/`沿Agent模式和冻结v9包运行，`NOTALONE_AGENT_NATIVE_DESKTOP_ACCEPTANCE=1`，`NOTALONE_TEST_APP_EXECUTABLE`仅由端侧指向上述包。本节按`run.log`保留实际命令，将输出目录的`***`展开为各本场目录；本文未重跑它们。

```sh
npm run test:app -- --interactive --coordinator root-v9-native-focus \
  --from 2026-10-15T20:33:30.909Z --until 2026-10-15T20:40:30.909Z \
  --max-launches 1 \
  --output artifacts/native-focus-v9-agent-20261016-255f5177-4624-4edc-bcf9-1589ae657fab/playwright \
  tests/native-focus-acceptance.spec.ts

npm run test:app -- --interactive --coordinator root-v9-focus-ready \
  --from 2026-10-15T20:37:47.478Z --until 2026-10-15T20:44:47.478Z \
  --max-launches 1 \
  --output artifacts/native-focus-v9-ready-20261016-ad7cbdbd-bcd7-42a0-9940-c91913d6b8e8/playwright \
  tests/native-focus-acceptance.spec.ts
```

场2调度器原先因收尾未获确认而保留interactive租约。主Agent随后核对5个本场已记录PID、唯一记录进程组均gone、userData absent，并核对没有v9路径进程；仅确认lease id `08548f69-1ffa-449c-862c-1edd497afffa`、coordinator `root-v9-focus-ready`及归属runner PID已gone后，将该自有租约rename到本场`archived-owned-lease/`，没有删除或抢占未知锁。归档保留原失败和租约内容，不改写runner exit2。

主Agent再通过Computer Use关闭自己新建的空Finder窗口，确认对应目录为空、属当前用户且非符号链接后只执行rmdir；`root-cleanup-check.json`记录窗口已关、目录absent、leaseArchived=true及sharedLeaseAbsent=true。这个独立收尾没有操作微信、业务数据或未知窗口。

本次文档核验重新只读检查场1的3个记录PID、场2的5个记录PID（由owned、归档租约及run.log中的worker记录定位），它们与各自记录的runner进程组均gone；两独立userData absent、v9路径进程数0、共享interactive租约absent，场2两份收据的nonce／布尔匹配。只使用Node文件读取、存在性检查及`ps -axo pid=,ppid=,pgid=,stat=,comm=`，仅输出上述匿名布尔与计数，没有终止进程、删除资源或启动新场。静态完整性检查实际命令为：

```sh
shasum -a 256 \
  desktop/artifacts/remaining-nine-final-20261016-v9/NotAlone-darwin-arm64/NotAlone.app/Contents/Resources/app.asar
codesign --verify --deep --strict --verbose=2 \
  desktop/artifacts/remaining-nine-final-20261016-v9/NotAlone-darwin-arm64/NotAlone.app
```

两场失败及[此前v5复验](native-shortcut-current-20261016.md)分别保留。当前尚无v9系统快捷键通过或用户体验反馈；本次只新增结果记录，未改产品代码、票面或进度。

结果独立复核：Standards／Spec各0项，仅只读原件。主Agent据此更新当前票据记录，快捷键仍未通过，不以资源清理代替正常退出或显示断言。
