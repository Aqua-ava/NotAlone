# 前台定位18：正式App集成续接

2026-10-15 用户要求继续正式App集成，完成可自主执行的修复和验证，需要人工验收时再通知。本轮承接18和持续跟随06，不重开已完成的可视预览验收，不修改识别质量、绑定唯一性、视觉范围或后台CLI授权。

## 反馈接缝

先复用原生元数据门，提供严格参数的 `--foreground-status --json` 诊断入口，在正式后端相同的短生命周期子进程调用方式下取得前台分类、前置检查和线程/GUI运行时布尔；不截图、OCR、读取标题/正文、CLI、数据库或模型。通过既有有限 `test:app` 启动，仅对照元数据，不操作微信或切换用户应用。

复现后再区分原生进程初始化、窗口/版本门、后端状态投影和助手暂停/恢复，按证据选择最小修复。合成OS输入、生产认证HTTP/隔离PG、生产助手控制器是既有自动验证接缝；真实正式包的OCR和联系人绑定只在准备完毕后交用户验收，未知不能标通过。

## 上一可视预览收尾

原可视窗口已正常退出，受限用例1/1通过（约5.3分钟）。输出机器采样635次、前置通过28次、人工一致23次、不一致0、未验证0、截图0、OCR0。人工“判定正确、很灵敏”的反馈保持，机器计数不外推全部场景。原记录的三个自有PID已不存在，共享租约absent；未创建业务库或用户数据目录，不读私人内容。

## 当前状态

已修复“前台未知被误写为微信非前台”的分类问题，并贯通正式HTTP及助手文案。首轮正式可视窗未获签收；后续已完成持续预览、具体失败原因及点击反馈修复和自动验证，新候选包准备完成。原现场匹配故障根因仍待实测，18和06保持claimed／ready-for-human。

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

## 可视实测方式

用户要求沿用刚才的可视窗口方式。本轮只扩展受限验收入口，在同一个正式App进程中展示独立验收浮窗；不修改产品窗口和探针算法。开始前由用户在窗口输入一位测试会话的准确名称并明确开始，才配置本轮合成CLI绑定和开启观察；未填写时无真实视觉采集。名称只进入本轮临时夹具，随隔离数据清理，不进入报告。

浮窗开始后不可获焦，使用macOS非激活panel及showInactive，显示正式助手公开状态的有限中文投影、观察时间新鲜度、预期绑定是否匹配、当前步骤和检查按钮。用户完成原位、移动、缩放、其他App前台和返回动作后点击检查；判断仍由原认证HTTP和正式控制器断言，不用按钮直接改判成功。与刚才一样提供人工前台核对，结果只累计一致/不一致/未验证数。关闭或结束只结束当前实例，仍受20分钟/最多1次及共享租约限制。

测试接缝沿用既有公开状态和协调信号：合成状态验证未知/暂停/过期不会显示匹配成功，临时信号验证旧轮次、旧步骤和closing不能驱动当前场次；真实App及不抢焦点体验只在用户本轮实测中确认。窗口无preload、Node、外网或业务调用能力，只消费固定动作；不直接启动探针、扩大采集或生成。

适配器按[Electron官方BaseWindow文档](https://www.electronjs.org/docs/latest/api/base-window)核对macOS `panel`、`showInactive` 与 `setFocusable`，并与实际安装44.7.0类型声明对照；macOS关闭focusable不会主动释放已有焦点，因此开始时先隐藏再显示。两条可视投影/信号安全回归先因缺少新入口失败，再实现通过；真实非激活体验仍待同一正式包现场验证。产品源码与包内资源未修改，继续使用前述候选包，不增加启动次数。

首次安全套件类型及56/56通过。两轴增量评审发现失败留窗无stage时结束按钮无效、关闭时机与异步监控失败可能无法结束等待；分别补实际失败回归再修复。结束请求由原协调器校验存活和租约并仅写本轮finish，closing不再写入；配置期关闭统一取消，监控异常也请求结束，不静默标通过。随后相关协调/投影14/14及类型检查通过。可视模式补充助手暂停步骤指引，原手动信号模式保持。

修复后的Standards和Spec增量复核均无待修项；实机尚未启动，浮窗非激活体验及正式匹配只按下一实际场次记录。

## 首轮可视正式App实测与用户否定反馈

2026-10-15 10:35:16–10:55:16有限预约、最多1次，实际启动1次，约10.3分钟后退出。用户在窗内确认会话并启动，baseline触发文件存在；前置门曾同时满足助手失焦、微信前台及新观察，说明按钮并非未接线，也不证明已匹配。随后匹配32次采样/约29.4秒未通过，末次为unavailable、probeAvailable=false，无已确认或建议联系人；该时点wechatInFront=false属于失败投影，不能作为系统实际非微信证据。后续移动缩放等步骤未运行。

人工按钮16次均记未验证，监控自身未失败。用户明确反馈窗口没用、点击没效果；本轮可视体验不签收。原界面只给泛化不可用状态，且分步检查后进入失败留窗，未提供足够直接反馈。具体原生失败原因未保存，不能从本轮报告补造。真实CLI正文0、模型0、发送0；正常菜单退出未通过。认证停读、自有后端exit0、随机库已删除、自有App与独立用户目录消失，租约absent。

改进范围：改为持续自动更新的正式状态预览，不再要求分步“本步检查”；人工点击即时显示收到及能否核对，固定原生失败原因必须经HTTP保留并显示所属层。未知码继续泛化，不透传原始错误。先以合成原生错误→真实认证HTTP→正式公开状态的回归及实际预览HTML的无头点击回归锁定反馈，再交下一有限实机；本轮已消耗的1次额度不复用。

接口资料核对：[Apple frontmostApplication](https://developer.apple.com/documentation/appkit/nsworkspace/frontmostapplication)、[NSApplication](https://developer.apple.com/documentation/AppKit/NSApplication)。文档只说明接口，不证明现场根因；实际Swift6/Xcode SDK及本轮反馈以上述运行记录为准。

## 2026-10-15 持续预览与反馈修复

从前轮未完成改动续接，保留用户否定反馈。实际复现命令为 `npm run test:pages -- --case foreground-visual-preview --timeout-seconds 90`：旧窗口点击后找不到“已收到”反馈，且仍有“本步检查”；新HTML尚未接入实际窗口。修复后实际窗口和无头页面共用同一HTML及渲染函数，可视模式持续显示正式公开状态，不再等待匹配成功或阶段信号才继续展示。

固定原生错误经认证HTTP保留，并在助手和浮窗显示固定中文原因；浮窗同时显示失败环节。未知原文继续折叠，不显示或持久化私密错误；失败结果中的 `wechat_in_front=false` 不被当作确定的其他应用前台。首轮原生原因已经丢失，此次合成低置信度用例不证明旧现场就是低置信度。

新增页面回归又复现“状态尚未接通时结束按钮可点击，动作可能因没有场次标识而丢失”。现仅在首个正式状态投影到达后启用按钮，点击立即反馈；结束不依赖步骤，优先进入有界动作队列，经当前场次协调器结束，重绘不会重新启用已点击的结束按钮。进入正式助手沿原菜单实现，失败继续显示且可关闭；场次、租约、默认间隔和失败退避保持。仅聚合正式状态变化、绑定成功、暂停、白名单失败及人工核对计数。

自动验证：

- `npm test`：末次类型及61项安全检查通过；未运行App、浏览器或探针。
- Conda NotAlone、禁用dotenv的 `python -m unittest discover -s tests/unit/front_sync -q`：75项通过。
- 同环境 `node --test --test-concurrency=1 tests/single-frame-foreground-http.test.mjs`：3/3通过，包括固定原因、未知原文屏蔽、无联系人资格及无正文读取；自有后端退出0、认证停读、3个随机隔离库删除已确认。
- 扩展后的 `test:pages -- --case foreground-visual-preview --timeout-seconds 90`：1/1通过；同一实际HTML覆盖填写确认、即时反馈、具体失败、成功状态、助手暂停、未知原文屏蔽和结束后不再启用。最终一场1个无头Chrome，2次静默采样、前台激活0、屏上窗口0、清理确认；Electron及原生验收均未运行。中途一次被其他工作树租约拒绝，未抢占或解除他方锁，待其释放后复验。

新候选包位于 `desktop/artifacts/foreground-live-preview-20261015/NotAlone-darwin-arm64/NotAlone.app`；通过既有离线Electron44.7.0运行时构建，严格签名校验通过，14项原生构建源码摘要与当前文件相同。`app.asar=46c6777da9f69ce31a3af830c62412b3a997eb4a8d9cf8e82e8d8eb977efc6c6`；原生probe／Core及`buildSourceDigest`与前述正式候选一致。构建没有启动App或探针。

本轮正式App启动0、私人正文读取0、外部模型0、消息发送0；未新增图像持久化、数据迁移或后台能力。持续预览报告显式标记 `diagnosticOnly`、`manualAcceptanceRequired`，生命周期通过不代替18／06联系人匹配、移动缩放、暂停恢复、帧数、耗时及权限归属签收。前轮20分钟／1次额度已消耗，下一实测仍须新的有限时段；会话名称沿窗口输入确认，不要求在聊天中提供身份。

接口核对：无可用Context7，回退核对[Playwright Page.evaluate](https://playwright.dev/docs/api/class-page#page-evaluate)、[Electron BaseWindow](https://www.electronjs.org/docs/latest/api/base-window)与安装的Playwright1.64.0／Electron44.7.0类型；文档和页面验证不能代替实际非激活浮窗及原生识别证据。

Standards独立评审0项；Spec独立评审发现正常离开微信被记为识别失败，已补实际失败回归后修复：仅unavailable／manual-required投影失败，正常暂停不累计失败，关闭同步不据false推断其他应用前台。针对性安全6/6、类型及含正常暂停的同HTML页面1/1复验通过，Spec增量复核遗留0。该修复仅影响验收脚本，不改变候选包生产资源；包内main／preload／renderer入口3项与当前构建逐字一致。

末次完整安全复验61/61通过。此前一次完整复验60/61，唯一失败为全局页面状态用例在其他工作树持有租约时要求absent；未修改该测试或他方锁，待其释放后整套复验通过。未将此并发干扰解释成产品故障。
