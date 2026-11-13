# v9录屏条目重新登记后的Finder实测

日期：2026-10-16，以下时刻均为台北时间。结论：本场Finder验收失败，唯一独立公共观察返回 `paused / wechat_not_in_front`，重新登记后的录屏可用性仍未知；不能沿用登记前的 `permission_missing` 判定当前许可仍缺。本场另外取得正式探针及辅助源归属当前Finder App的TCC实证，责任归属与授权／采集结果分开记录。全部自有资源已恢复，18／20原AC不变。

## 登记动作与冻结包

用户明确同意登记v9录屏后，主Agent用Computer Use只移除Electron的NotAlone条目，旧NotAloneApp条目未动；在系统选择器定位精确v9 `.app`、核对URL后点击打开，列表NotAlone为on，没有出现密码／Touch ID表单。系统“在访达中显示”仍解析到旧工作树路径，因此只记录精确v9选择和开关状态，不把这项UI动作当作实际保存的csreq或录屏成功证明。该动作收据留在本场忽略产物。

实际运行包为 `desktop/artifacts/remaining-nine-final-20261016-v9/NotAlone-darwin-arm64/NotAlone.app`。运行前重核deep／strict签名退出0、ASAR SHA-256为 `e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021`；指定主包cdhash保持 `2cc6342d29997cf5c1d830e7aeabc1a6694cbce8`。没有重新打包或改产品／测试源码。

run为 `4f33f248-440c-4984-b18a-0225645e2dfd`，固定租期14:18:33.409–14:26:33.409，最多且实际启动1次。启动前租约absent、无App／native／受控后端占用，原默认userData身份与上一场恢复记录一致；未读取原配置正文。沿用Conda NotAlone、禁dotenv、整体隔离默认userData、随机PG、合成空读取授权和不可用真实CLI／模型。实际App由主Agent从Finder打开，精确可执行路径唯一、PPID1；不是Electron自动启动。

## 公共观察与采样

主Agent实际开启空范围同步、使用App菜单隐藏NotAlone，再将微信窗口Raise并点击微信“隐藏其他”，之后不读取NotAlone AX。后台收到这些实际动作反馈后，于14:21:50.311写入对应run的wechat收据；收据不由程序状态自动生成。

按主Agent要求，后台在同一存活Finder App和后端内另外调用一次鉴权 `POST /api/sync/foreground/observe {}`：14:21:50.319开始、14:21:50.453完成，HTTP200、`phase=paused`、`reason=wechat_not_in_front`。完成时fixture处于 `observing_wechat`；这是独立请求，不是fixture自身发起的观察。只保存状态、phase、reason和固定键集合，没有保存名称、身份、正文或原始响应。

fixture全场 `observationSamples=266`，包含后端就绪后的1次初始快照及45秒阶段内265次快照；正式探针和辅助源PID均未被采到，未满足既有原生尝试门。计数0不证明绝对零次尝试，也不能用于判断重新登记后的录屏权限。历史两场报告中的301同属这个累计计数，含1次初始快照；不把累计数全部当作纯45秒阶段样本。

主Agent在采样期间另作微信Raise／“隐藏其他”的纠正尝试，所见为空白白窗，不保存图像或聊天；采样后又经微信窗口菜单执行 `makeKeyAndOrderFront`。这些只记实际动作，不认证OS前台，也没有在最后一次纠正后追加probe或覆盖先前响应。

用例1项失败，runner code2／signal未另认证，14:22:37.685结束。finally以 `finder_cleanup_unconfirmed` 保留现场，未进入用例helper／quit认证；该finally错误不代表最初失败根因已完整诊断。主Agent后来实际菜单退出与程序用例通过分别记录，未补写helper／quit成功收据。

## 本场TCC责任归属

收尾时仅按 `tccd`、`AUTHREQ_ATTRIBUTION` 和本场精确App PID查询，内存解析后保存固定标识／数值PID投影；没有保存原始日志。查询exit0、JSON可解析，18条均匹配同一Finder App责任身份：

| accessing标识 | 归属行 | 不同native PID |
| --- | ---: | ---: |
| `com.notalone.sync-probe.cli` | 10 | 5 |
| `com.notalone.sync-probe.header-change` | 8 | 4 |

所有行的responsible均为本场 `com.notalone.desktop`，不是Codex。行数不是调用／采图次数，9个PID也不代表9次成功捕获。归属时段为14:20:45.780–14:21:17.914，早于14:21:50.311开始的45秒阶段，因此不与阶段内零PID样本矛盾；不能将准备期归属行移入后续阶段作为覆盖证明。

这补齐本场正式探针与辅助源的宿主责任归属分项，不认证授权决策、实际采集、OCR、私聊识别或持续源覆盖。唯一公共观察停在前台门，因而既不能判定新许可成功，也不能判定新许可仍缺；[登记前两场](finder-v9-two-attempts-20261016.md)的失败继续独立保留。

## 精确恢复与原件

主Agent实际从同实例公开菜单退出后，后台先核对4个已记录controller／worker／App／backend PID及握手退场，再核对目录与备份dev／ino，整体恢复原默认userData；未读取配置正文。仅删除本场精确随机 `_test` 库，并用只读SQL确认不存在；自有临时目录移除。核对本场lease ID、runner、coordinator且runner已gone后，将失败租约归档到本场产物，`test:app:status=absent`。

后继TCC投影追加了9个不同native PID，逐一核对也全部ESRCH；联合回执共13个不同已记录PID均gone，不扩称所有未记录后代或全系统清理。没有重启App、真实CLI正文读取、私人历史导入、联系人扩权、模型调用、聊天发送或远端操作。原始UI、图像和身份不入Git；本场有上述明确范围的系统权限列表操作，不写成“零权限变化”。

忽略原件目录为 `desktop/artifacts/closeout18-v9-finder-after-permission-20261016-4f33f248-440c-4984-b18a-0225645e2dfd/`，包括：

- `execution-scope.json`、`controller-owned.json`、`root-permission-action.json`和finder／wechat实际动作及收据副本。
- `fresh-observation-projection.json`、两次纠正动作记录、run／runner-exit及Playwright coordination／失败结果。
- `tcc-owned-attribution.json`、`tcc-attribution-check.json`，仅含本场固定归属投影。
- 原目录恢复、精确库清理、`root-cleanup-check.json`、`combined-final-cleanup-check.json`及归档的自有失败lease。

实际命令从 `desktop/` 的Conda NotAlone环境执行：

```sh
NOTALONE_DISABLE_DOTENV=1 NOTALONE_FINDER_NATIVE_PERMISSION_ACCEPTANCE=1 \
NOTALONE_FINDER_NATIVE_SECONDS=45 NOTALONE_TEST_APP_EXECUTABLE=<已核v9绝对可执行路径> \
npm run test:app -- --interactive --coordinator root-v9-18-finder-after-permission \
  --from 2026-10-16T06:18:33.409Z --until 2026-10-16T06:26:33.409Z --max-launches 1 \
  --output artifacts/closeout18-v9-finder-after-permission-20261016-4f33f248-440c-4984-b18a-0225645e2dfd/playwright \
  -- tests/finder-native-permission-acceptance.spec.ts
```

本场没有继续启动或开启真实CLI视觉组合；可信前台条件和新登记许可的实际可用性仍需后继新场分别核实。本主题仅纠正旧报告采样计数口径，旧失败结论及原票验收状态未改；新增权限操作和本场结果分别记录。
