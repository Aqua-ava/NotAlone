# v9独立Finder两场失败与安全恢复

日期：2026-10-16，以下时刻均为台北时间。结论：两场均实际从Finder启动同一个冻结v9包，分别失败，不能合并为权限或交付通过。首场未完成微信前置协调；第二场进入45秒采样后，同一存活实例的新公共观察明确返回 `screen_capture_permission_missing`。两场均未取得可认证的TCC责任归属，已分别完成自有资源恢复；18／20原AC保持。

## 同包、入口与范围

包为 `desktop/artifacts/remaining-nine-final-20261016-v9/NotAlone-darwin-arm64/NotAlone.app`，ASAR SHA-256为 `e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021`。两场前后ASAR摘要一致，`codesign --verify --deep --strict`退出0，未重新打包。v9为ad-hoc、无Team，主包指定要求为 `cdhash H"2cc6342d29997cf5c1d830e7aeabc1a6694cbce8"`；v6的不同CDHash及既有许可不迁移为v9结论。

均使用现有 `tests/finder-native-permission-acceptance.spec.ts`，激活Conda NotAlone、禁用dotenv，各新建8分钟／最多1次启动的interactive租约。App由主Agent用Computer Use从Finder实际打开，后台核对精确可执行路径、唯一主进程及PPID1；没有用Electron启动代替Finder。首场另有下述不属于Computer Use的只读元数据诊断。默认userData整体隔离并保留原身份、随机隔离PG、合成空读取授权、不可用真实CLI与模型配置保持。没有真实CLI正文读取、私人历史导入、联系人扩权、模型请求、外部发送、权限修改或远端操作；Computer Use临时可见内容不保存或提交。

`test:app`构建工作树dist，但实际运行指定的冻结v9 App；未重新打包、改产品或测试源码。两场原始失败均保留，不将后续主Agent实际菜单退出补写为用例quit成功收据。

## 分场结果

| 项目 | 首场 | 第二场 |
| --- | --- | --- |
| run | `287a8111-88d9-4d74-b572-2654678cae5f` | `0c3e302b-610b-4c30-8c98-f99f1492f39d` |
| 固定租期 | 13:54:14.803–14:02:14.803 | 14:02:46.294–14:10:46.294 |
| 实际启动 | 1 | 1 |
| runner | exit2，13:59:08.516结束 | exit2，14:05:23.398结束 |
| 用例报告 | 1失败，约4.7分钟 | 1失败，约2.4分钟 |
| 采样 | 仅后端就绪后的1次初始进程快照，未进入45秒微信采样 | 累计301次＝初始1次＋45秒阶段300次进程快照 |
| 采到正式／辅助PID | 0／0 | 0／0 |
| 同实例新公共观察 | 13:59:00.584，HTTP200，`paused / wechat_not_in_front` | 14:05:38.953，HTTP200，`unavailable / screen_capture_permission_missing` |
| 用例helper／quit阶段 | 未进入 | 未进入 |

首场控制端额外诊断耗时，未形成微信前置动作的有效收据；180秒阶段等待结束后，finally以 `finder_cleanup_unconfirmed` 保留现场。已有同步状态为开启，仍不能把开启、管理窗关闭或微信Raise动作代签完整前置成立。该场不能诊断v9录屏权限是否可用，也不算45秒采样失败。

首场另尝试inline Swift查询前台应用及窗口元数据，20秒内未完成而失败，没有形成诊断结论；随后通过CGWindowList只读查询本场App PID、layer 0的窗口元数据，未取图像或名称。两种方法均非Computer Use操作或验收证据，未用于签署微信前置、权限或产品能力。主Agent随后停止这类自定义系统UI查询，后继桌面核验仅使用Computer Use。精确自有Swift源码匹配的进程复查为0，原件和无遗留检查留在忽略产物。

第二场主Agent实际开启空范围同步，使用App菜单隐藏NotAlone，再将微信窗口Raise并点击微信“隐藏其他”；随后只读取微信，未再激活NotAlone。对应run收据写入后才开始45秒采样。阶段结束未采到正式单帧及独立源PID，无法满足既有尝试门；这不证明绝对零次极短尝试，也未确定没有采到进程的全部原因。累计计数301包含后端就绪时的1次初始快照，纯阶段为300次；该分账由后继核对同一fixture计数位置后明确，不改变原失败。finally错误覆盖了先前断言，不能只从末尾清理堆栈反推根因。

第二场新 `POST /api/sync/foreground/observe {}` 发生在runner结束之后、同一Finder App及其后端仍存活、原租期内，返回上述明确权限错误。它认证的是该同实例独立启动路径的录屏预检未通过，不是采集成功或联系人识别；不能把它描述为45秒采样期间取得的响应。两次观察只保存HTTP状态、phase、reason和固定键集合，不保存名称、身份、正文或原始响应。

## TCC、退出与恢复

TCC查询仅过滤 `tccd`、`AUTHREQ_ATTRIBUTION` 和本场精确App PID，内存解析后只保存允许的应用标识／数值PID投影，不保存原始日志。首场没有取得匹配归属投影；第二场查询exit0、JSON可解析且查询行0。两场均不能认证responsible/accessing身份、授权决策或拒绝的底层原因；v6已有责任归属不补入本场。`permission_missing`与TCC归属未知分别记录。

每场失败后，主Agent实际从同实例公开菜单退出；随后后台核对精确App、后端及已记录runner进程退场、握手消失，再核对原目录和备份dev／ino，整体恢复默认userData。没有读取原配置正文。仅删除本场精确随机 `_test` 库，另以只读SQL确认不存在；自有临时目录移除。核对本场lease ID、runner与coordinator且runner已退场后，将失败租约归档到本场产物，未接管未知锁。

首场核对7个已记录PID全部gone，第二场4个；这是各自已记录范围，不认证所有未记录后代或全系统进程。两个精确测试库分别不存在，两场原默认目录身份均恢复，`test:app:status`分别为absent。没有在收尾后重新读取NotAlone UI或重启App。

## 命令与后继接缝

两场分别从 `desktop/` 执行以下现有入口，输出目录及时间按表中实际值设置：

```sh
conda activate NotAlone
NOTALONE_DISABLE_DOTENV=1 NOTALONE_FINDER_NATIVE_PERMISSION_ACCEPTANCE=1 \
NOTALONE_FINDER_NATIVE_SECONDS=45 NOTALONE_TEST_APP_EXECUTABLE=<已核v9绝对可执行路径> \
npm run test:app -- --interactive --coordinator <本场协调者> \
  --from <本场起始ISO> --until <本场固定截止ISO> --max-launches 1 \
  --output <本场产物目录>/playwright -- tests/finder-native-permission-acceptance.spec.ts
```

忽略原件目录：

- `desktop/artifacts/closeout18-v9-finder-20261016-287a8111-88d9-4d74-b572-2654678cae5f/`
- `desktop/artifacts/closeout18-v9-finder-retry-20261016-0c3e302b-610b-4c30-8c98-f99f1492f39d/`

各目录保留scope、controller-owned、run／runner-exit、Playwright coordination及失败结果、固定观察投影、TCC最小投影、原目录恢复回执、精确库清理回执、`root-cleanup-check.json`及归档的自有失败lease。第二场另保留实际finder／wechat收据副本。私人身份、原始UI和截图不入仓库。

后继须在精确v9权限实际可用后，使用新的独立scope／租约／隔离资源，从Finder重新执行完整场；上述失败不延时或追补通过。路径与签名不变也不能省略同实例公共观察与TCC归属核验。Finder场通过后，18还须用同v9的 `real-sync-visual-independence-acceptance.spec.ts` 复验正式定位暂停与既有单联系人真实CLI独立；当前没有启动该场，没有扩展双联系人或来信范围。

本文与权限台账分别记录本轮失败，不改变原18／20验收结论。
