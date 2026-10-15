# 前台定位18：正式App集成续接

2026-10-15 用户要求继续正式App集成，完成可自主执行的修复和验证，需要人工验收时再通知。本轮承接18和持续跟随06，不重开已完成的可视预览验收，不修改识别质量、绑定唯一性、视觉范围或后台CLI授权。

## 反馈接缝

先复用原生元数据门，提供严格参数的 `--foreground-status --json` 诊断入口，在正式后端相同的短生命周期子进程调用方式下取得前台分类、前置检查和线程/GUI运行时布尔；不截图、OCR、读取标题/正文、CLI、数据库或模型。通过既有有限 `test:app` 启动，仅对照元数据，不操作微信或切换用户应用。

复现后再区分原生进程初始化、窗口/版本门、后端状态投影和助手暂停/恢复，按证据选择最小修复。合成OS输入、生产认证HTTP/隔离PG、生产助手控制器是既有自动验证接缝；真实正式包的OCR和联系人绑定只在准备完毕后交用户验收，未知不能标通过。

## 上一可视预览收尾

原可视窗口已正常退出，受限用例1/1通过（约5.3分钟）。输出机器采样635次、前置通过28次、人工一致23次、不一致0、未验证0、截图0、OCR0。人工“判定正确、很灵敏”的反馈保持，机器计数不外推全部场景。原记录的三个自有PID已不存在，共享租约absent；未创建业务库或用户数据目录，不读私人内容。

## 当前状态

已修复“前台未知被误写为微信非前台”的分类问题，并贯通正式HTTP及助手文案；尚不能认定它就是原实机场次的全部根因。最新正式候选包和自动验证已就绪，原18和06保持claimed、转ready-for-human，等待有限实机验收。

## 诊断与修复

1. 原生受控输入红灯：同一正式观察在前台未知时返回 `ok=true / wechat_in_front=false`。现改为固定 `foreground_application_unavailable` 失败，读取微信窗口、截图和OCR均不执行；确定是其他应用时仍正常暂停。正式观察、OCR预览和可视前台窗口共用该门禁。
2. 认证HTTP红灯：新原因被后端折叠为 `probe_failed`。现按固定错误码保留，助手显示“系统前台状态未知”，原确认门、唯一绑定、0.90和单帧预算不变。
3. 协调器红灯：原先只保存三布尔，不能区分未知与超时。现增加固定布尔投影；原始错误、标题和姓名不落盘，原前台放行条件不放宽。
4. 短生命周期元数据对照两场均能读取其他应用前台，`main_thread=true / application_initialized=false`，未证明缺少GUI初始化是根因，未据此修改NSApplication生命周期。首场用例通过但worker过早退出截断异步释放，runner以2保留锁；主Agent核验自有runner/worker及精确探针均消失后只释放本轮锁。为短探针暴露可等待的原收尾Promise，第二场1/1、runner0、租约absent。两场均无窗口、图像、OCR或外部应用操作。

## 自动验证

- `swift test --package-path native/macos`：73项，71通过、2项默认有限Vision实验跳过。
- Conda NotAlone：`python -m unittest discover -s tests/unit/front_sync -q` 75通过；`python -m unittest tests.unit.server.test_sync_host -q` 21通过，均禁用dotenv。
- 同环境 `node --test --test-concurrency=1 tests/single-frame-foreground-http.test.mjs tests/continuous-contact-follow-http.test.mjs tests/continuous-generation-combination-http.test.mjs`：4/4；覆盖未知状态、A/B内容恢复、失焦恢复、迟到/超时/停止/撤销和零隐式生成。随机库及自有后端清理已由各夹具确认，组合使用两次合成模型，无外部模型调用。
- `npm test` 53/53及类型检查通过；随后协调器增加分项诊断，针对性 `node --test tests/scheduling/acceptance-coordinator.test.mjs` 10/10、类型检查再次通过。
- 原生元数据有限入口 `tests/native-foreground-runtime.spec.ts` 修复收尾后1/1、runner0；只读取有限分类及两项运行时布尔。

## 正式候选包与评审

通过既有离线Electron44.7.0 arm64运行时执行 `npm run package -- --with-probe --output-directory <本轮忽略产物目录> --electron-zip-directory <既有离线运行时目录>`，构建退出0。候选App位于 `desktop/artifacts/foreground-app-integration-20261015/NotAlone-darwin-arm64/NotAlone.app`，尚未启动。`codesign --verify --deep --strict` 通过；manifest的14项构建源码摘要与当前文件逐项相同，`buildSourceDigest=32ebcfb9bdcfd96b1e55bfd613164ec8b144a3ab027ccf25b47a963e2bdc7adc`。

包内SHA256：`app.asar=9142008913e50d7868ce73980ba6397981f25d6b6d2abe0aec8a730eaf3636bb`；probe=`b343a855fd878756690713aa336642d38801d8f4f8395c5f1355081be9d26ae7`；Core=`7b9a5af3f8b596e5bcbde2933d7454d5db20b69e402f0f5acc21dd9296b7f757`。签名及源码一致性不代替运行时权限、真实OCR或联系人匹配证据。

针对本轮暂存差异的Standards与Spec独立只读评审均无待修问题；评审未运行App或读取私人材料。本轮正式App启动0次、外部模型0次、消息发送0次；两场元数据CLI诊断的计数与收尾已单列，不并入正式App验收。

## 待实机签收

准备最新正式候选包，复用既有单联系人认证HTTP/隔离PG及合成CLI/模型适配器。用户确认本轮测试会话和有限时段后，只验证名称到已确认绑定、助手获焦暂停与返回恢复、正式入口耗时及同包移动/缩放；不读取私人正文、不发送消息，不继承原生预览的集成成绩。权限缺失停在同一实例，不重复索取启动次数或降低门槛。

接口资料核对：[Apple frontmostApplication](https://developer.apple.com/documentation/appkit/nsworkspace/frontmostapplication)、[NSApplication](https://developer.apple.com/documentation/AppKit/NSApplication)。文档只说明接口，不证明现场根因；实际Swift6/Xcode SDK及本轮反馈以上述运行记录为准。
