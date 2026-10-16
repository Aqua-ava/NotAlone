# v9同实例即时协调的Finder分项验收

日期：2026-10-16，以下时刻均为台北时间。结论：现有Finder原生尝试、helper停止和正常退出用例 **1／1通过，约5.2分钟，runner exit0**。主Agent在最后微信动作后自行写入对应收据并立即调用公开观察；实际响应为 `unavailable / binding_verification_unavailable`。本场补充当前v9的Finder宿主及正式／辅助TCC责任归属证据，不认证私聊身份、真实CLI独立性、成功捕获计数或完整交付。此前失败均独立保留。

## 冻结对象与范围

run：`2333b311-e535-4472-a9cc-679cfd910d05`。固定租期14:29:46.643–14:37:46.643，最多且实际启动1次；runner于14:35:10.950正常结束。正式包为 `desktop/artifacts/remaining-nine-final-20261016-v9/NotAlone-darwin-arm64/NotAlone.app`，运行前deep／strict签名退出0，ASAR SHA-256保持 `e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021`。没有重新打包或重签。

启动前核对租约absent、无App／原生／受控后端占用，原默认userData身份已恢复。沿用Conda NotAlone、禁dotenv、整体隔离默认userData、随机PG、合成空读取授权及不可用真实CLI／模型。主Agent用Computer Use从Finder核对精确v9路径并实际打开；后台核对唯一精确主进程及PPID1后才写finder收据。`test:app`构建工作树dist，实际运行的是指定冻结包。

14:36:13另将包内manifest的18份原生来源摘要与当时工作树逐项比对，mismatch为0。此为该时点的字节比较，不把并行后继提交当成该冻结包的构建来源，也不据此重打包。

## 即时协调、固定响应与实际窗口动作

此前[登记后场](finder-v9-after-permission-20261016.md)的TCC时序早于45秒采样，提出协调延迟可能影响观察时点的假设；它没有证明因果。本场仅将最后微信动作后的wechat收据及独立公开观察改由主Agent直接执行，既有fixture、产品和截止不变，不把通过结果归因于唯一原因。

主Agent实际开启空范围同步、隐藏NotAlone、将微信窗口Raise并执行“隐藏其他”，之后直接运行收据／观察代码。收据于14:32:26.736写入，鉴权 `POST /api/sync/foreground/observe {}` 于14:32:26.740开始、14:32:27.417完成，HTTP200、`phase=unavailable`、`reason=binding_verification_unavailable`。收据到请求开始4ms，请求至完成677ms；没有单独精确计量最后GUI动作到收据的延迟。

调用复用现有安全 `readConnection` 读取本场临时握手，不打印token，只保存状态、固定phase／reason及键集合，没有保存身份、名称、正文或原始响应。准备时纯strip导入现有TypeScript构造参数属性失败，随后用Node现有 `--experimental-transform-types` 开关验证并执行；没有新增持久脚本或产品控制接口。

源码 `foreground_locator.py` 的该分支位于新原生观察和名称处理之后，在CLI／绑定异常且没有质量失败时返回此码。它与本夹具CLI不可用的安排一致；这是源码路径解释，不能仅凭投影区分具体CLI错误和绑定错误，也不能认证私聊、唯一绑定或生成资格。本场没有返回 `wechat_not_in_front` 或 `screen_capture_permission_missing`，不据此将整个产品签成成功。

45秒阶段结束后，主Agent实际从同实例公开菜单打开输入小窗，并点击非控件静态区域核对小窗获焦；所见前台定位暂停、联系人未确认、生成禁用。后台收到实际动作反馈后写helper收据，fixture确认已采辅助源PID停止才进入quit阶段。之后主Agent实际公开菜单退出，quit收据对应本场动作，原fixture完成退出和恢复；窗口状态没有自动代签操作者收据。

## 原生样本与独立TCC分账

| 项目 | 实际结果 | 限度 |
| --- | ---: | --- |
| 全场进程快照 | 287 | 含初始1次和45秒阶段286次 |
| 采到正式单帧PID | 6 | 均为已核 `--single-frame` 参数，不等于6次成功OCR |
| 采到辅助源PID | 6 | 不认证持续覆盖、续租或唯一进程全程存活 |
| 含辅助源的快照 | 267 | 是快照计数，不转换为精确持续时间 |
| legacy／未知参数PID | 0／0 | 只针对实际被采到的进程 |

同一App退出后，后台按精确App PID过滤 `tccd / AUTHREQ_ATTRIBUTION`，内存解析并只保存允许的应用标识及PID投影。52条全部归属当前Finder实例的responsible `com.notalone.desktop`：正式探针28条／14个不同PID，独立辅助源24条／12个不同PID；不是Codex责任链。这是整个匹配时段的归属行，不能将14／12全部写成45秒阶段实际捕获的PID，也不能把52行当调用、采图或授权成功次数。

fixture原有 `nativeCaptureSuccessCertified=false`、`tccAttributionCertified=false`、`identityCertified=false`、`streamCoverageCertified=false` 均未修改。独立 `root-cleanup-tcc-check.json` 另记录本场准确责任归属；该账单不改变fixture字段，也不认证授权决策、成功帧数、私聊或全部视觉资源。没有追加观察或在退出后重启。

## 原fixture恢复与精确自有复核

原fixture的complete、normalQuitReceipt、appGone、backendGone、nativeGone、handshakeGone、originalUserDataRestored、cleanupConfirmed均为true，正常释放本场租约并删除随机测试库和自有临时目录。

后台独立核对fixture、TCC、runner及worker记录合并后的30个不同PID全部ESRCH；握手和自有目录不存在，原默认userData的dev／ino与原记录一致，配置正文未读取。对本场精确随机 `_test` 库执行只读SQL确认不存在；`test:app:status=absent`。范围只限已记录PID／精确路径，不扩称所有未记录后代或进程组认证。

没有真实CLI读取、私人历史导入、联系人扩权、模型请求、聊天发送、权限更改或远端操作。权限登记属于[前一独立场](finder-v9-after-permission-20261016.md)前的动作，本场不重复登记或迁移旧包结论。原始UI和截图不提交。

## 命令、原件与剩余项

从 `desktop/` 的Conda NotAlone环境实际执行：

```sh
NOTALONE_DISABLE_DOTENV=1 NOTALONE_FINDER_NATIVE_PERMISSION_ACCEPTANCE=1 \
NOTALONE_FINDER_NATIVE_SECONDS=45 NOTALONE_TEST_APP_EXECUTABLE=<已核v9绝对可执行路径> \
npm run test:app -- --interactive --coordinator root-v9-18-finder-immediate \
  --from 2026-10-16T06:29:46.643Z --until 2026-10-16T06:37:46.643Z --max-launches 1 \
  --output artifacts/closeout18-v9-finder-immediate-20261016-2333b311-e535-4472-a9cc-679cfd910d05/playwright \
  -- tests/finder-native-permission-acceptance.spec.ts
```

忽略原件为 `desktop/artifacts/closeout18-v9-finder-immediate-20261016-2333b311-e535-4472-a9cc-679cfd910d05/`：scope／controller-owned、实际finder／wechat／helper／quit收据、`root-immediate-observation.json`、run／runner-exit及Playwright完整结果、TCC固定投影、`root-cleanup-tcc-check.json`、`exact-database-final-check.json`、`native-live-source-comparison.json`。

本场只补当前同v9的Finder原生尝试、helper源停止、正常退出与责任归属分项；18仍需同v9单联系人真实CLI／正式视觉独立性组合，20真实快捷键第二次隐藏等缺项保持。本场结束时尚未启动该真实CLI场，也不补签双联系人、来信或总体模型质量。此前失败保持，后继验收另场记录。
