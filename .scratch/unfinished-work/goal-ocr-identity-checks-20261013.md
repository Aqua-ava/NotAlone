# OCR末次窗口身份差项诊断（2026-10-13）

本片由Root明确授权修复必要诊断：D场有限App实际138.708860125秒、exit1，选择保存后`context_code=identity_changed`；旧七字段中的front、selected、sole PID相同，front及sole均归为wechat_primary，实例数1。校验仍在context，没有Capture.setup、权限预检、视觉采集、OCR或profile。Root已记录Resources helper及父App身份和自有资源收尾，具体场次收据由Root保管；本片未读私人选择／聊天／截图，不把安装位置当签名认证，也不从相同PID推断末次resolve的所有字段一致。原失败和18／20未满足验收保留。

本片只修改既有原生诊断、Host验证和合成测试，另更新权限台账及[现行规格](../mac-desktop-app/spec.md)中原七字段的可选附项说明，共七path。预先确认的接缝是`CalibrationContext`已有上下文值的纯身份比较及`CalibrationContextDiagnostics.jsonObject()`，以及Host的`validatedContextDiagnostics`和0600结果保存。前台／采集、session调用、OCR参数、绑定、CLI同步、默认放行、数据模型及质量门不在本片变更范围；未操作Git暂存或提交，Root后续双轴、本地提交、冻结打包和现场另行处理。

## 可证伪边界与实现

当前失败仍有四个候选差异：PID在不同查询间变化、窗口编号变化、窗口原点变化、窗口尺寸变化。新输出只使已有末次resolve成功时的这四项可分辨：对应比较false才支持那一项差异，多个false可以并存；resolve失败不填四项，不把不可观察写为false。本片没有运行新实际场，尚不知道D场是哪项变化，也不称根因已修复。

- [原生诊断](../../native/macos/Sources/NotAloneSyncCore/RegionCalibration.swift)沿原来的front查询、实例查询和唯一一次诊断resolve，不增加OS读取或监听。保持原`matched`／`identity_changed`计算，随后仅使用其已有current，与原选择精确比较，附固定四布尔`identity_checks`。未修改`MinimalRegionLayout.contextMatches()`的PID／windowId／CGRect精确门；不容忍位移／缩放，不重新选择窗口，不补采帧。
- [Host诊断解析](../../desktop/src/main/foreground/calibration-profile.ts)兼容原七字段，并严格校验可选第八字段：只能四个固定boolean；matched要求全true，identity_changed要求至少一个false，其他context码不得带附项。未知字段、坐标／标题、null／数组、数字／字符串和不完整集合均拒绝。保留仅failed/context持久资格、0600原子写入和过期写保护；复制嵌套对象后再交下游，防原始输入后续修改污染已校验值。
- 四布尔来自同一current，旧front／sole来自各自查询；不强制与旧PID相等以伪造原子性。它们仅诊断，不授予采集、TCC、签名、绑定或联系人资格，不写profile。当前不可用分支仍只有原七字段，旧格式没有附项也不补造布尔。

## 实际验证

私有证据目录`/private/tmp/notalone-ocr-identity-20261013-kdfeTy/`为0700，快照、日志和metadata为0600。原生／Node测试只使用合成PID、窗口和几何，不执行真实helper、权限或任何App。这里列外层单调耗时，编译计入Swift耗时，不能把测试时间当视觉读取时间。

| 实际入口 | 结果与耗时 | 证明边界 |
| --- | --- | --- |
| `swift test --package-path native/macos --filter MinimalRegionLayoutTests/testIdentityDiagnosticsDistinguishExactDifferencesWithoutPersistingGeometry` | 首编译red，5.282480333秒，缺identityChecks符号／参数；最小实现后1项七组green，9.369278250秒 | 新纯比较／JSON接缝可运行；首red是编译缺口，不是实机身份根因 |
| `node --test --test-name-pattern=身份差项只接受 tests/helpers/calibration-progress.test.mjs`（desktop目录） | 旧白名单实际拒绝：red0.843355917秒；green0.203366459秒 | 接受可选附项、严格拒绝与旧七字段兼容；异常输入不覆盖旧0600结果，无profile |
| `node --test --test-name-pattern=输入后续修改 tests/helpers/calibration-progress.test.mjs` | 浅复制允许window_id及额外标题污染的实际断言red0.164652875秒；复制嵌套后1/1green0.273285250秒 | 已验证值不会随原输入后续修改变化 |
| `swift test --package-path native/macos --filter 'MinimalRegionLayoutTests\|SessionCaptureSafetyTests'` | 13/13，0失败，1.497259541秒 | 布局9＋session安全参数4，全部纯规则／合成输入，未调用OS捕获 |
| `node --test tests/helpers/calibration-progress.test.mjs` | 6/6，0失败，0.332246209秒 | 阶段／错误／数值／旧上下文／新增四布尔／mutation保存边界 |
| `npm run typecheck` | exit0，1.032585125秒 | 当前桌面类型，不代表打包／实际App通过 |
| `node scripts/test-safe.mjs` | 50/50、0fail／skip、exit0，22.611637458秒 | 既有完整安全调度组，只静态编译／签名和搬运仓库探针及合成C输入、调度合成进程，不执行其二进制或App |

另保留一次最小组筛选错误：`MinimalRegionLayoutTests\|ProbeArgumentsTests`实际只匹配布局9项，1.628964792秒、exit0；不存在ProbeArgumentsTests类，不能把该次称13项。只读查文件名也曾报不存在，该定位错误不是产品red；按实际SessionCaptureSafetyTests类名补跑得到上表13项，两个日志均保留。未知字段等负控在parser修复后首绿，与两个真实runtime red分别记录，不伪造每个控制首红。

完整桌面安全调度组实际日志和exit0收据为`desktop-safe-final.log/status.json`；不运行浏览器、Electron、微信、探针二进制或模型。必要源码字节与原基点diff由最终review metadata绑定，失败日志不删除。没有重跑已经绿的完整组，也不借这组绿签实际窗口／权限。

## 数据与收尾

新增持久信息只有四布尔，沿现有0600校验结果保存；没有新标题、姓名、路径、窗口几何、原始视觉帧、异常原文或模型数据。Node测试各自临时目录由finally回收，Swift构建缓存保留在已有忽略目录；完整安全组自己的构建／搬运目录以该组实际收尾为准，不能据exit0补造全机进程盘点。

本片子Agent实际App／浏览器／微信／真实CLI／真实helper／TCC／模型HTTP均0，没有发送消息或修改业务库。没有更改Info.plist／entitlement／签名／TCC归属；新的生产源码仍需Root冻结后生成新签名候选并在有限`test:app`／共享租约下验证。真实最小采集、名称质量、绑定／重名／低置信／失效／焦点和最终权限归属仍不能由此片合成证据代替。两轴及实际场次收据后续追加，原票状态和全部验收不改。
