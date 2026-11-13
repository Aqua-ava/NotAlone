# OCR 自动语言识别公开合成有限对照（2026-10-13）

## 预注册准备快照

本节及下方准备记录为首次激活前的历史快照，实际结果见末节。Root 已授权原18验收工具范围的 H1 一次有限公开合成对照；准备时实际 Vision perform 为0。F场低置信原因未定，不以本场代签微信、绑定、OCR实机、权限或签名。生产仍为 accurate、`[zh-Hans,en-US]`、语言纠正false、自动识别false；三处生产识别调用、Capture／image／Names和前台门保持。内部测试持有同次请求以读取其结果，没有产品CLI／环境开关。

唯一run为 `df6ab753-1eae-4d1b-a870-304689750ed3`。专属私有目录为 `/private/tmp/notalone-ocr-vision-language-20261013-df6ab753-1eae-4d1b-a870-304689750ed3/`，0700目录／0600证据。一次实际场180秒、至多72次真实Vision perform，每次前持久预约并同步文件，前后均核单调截止；外层独占进程组监督器按场次绝对期限停止，仅处理自有组。Root给出实际起止时点后才写独占激活收据。没有收据的普通测试仅跳过；已经存在请求日志不能重开，原失败保留。

## 固定输入与单一变量

每案按header、row、repeated-header三帧，逐帧baseline false／candidate true交替，共12×3×2=72调用上限。固定request revision3；运行时须核实际默认revision3、支持3、默认auto false／minHeight0／customWords空，以及accurate支持`zh-Hans`和`en-US`。不成立则0perform停止。SDK、真实编译输入、运行时OS／revision／支持值及字体PostScript、版本、字体文件SHA准确记录；绘制在内存中完成，图像只持久像素SHA，不保存PNG或帧。

| 案例 | 固定公开文字 | 控制 |
| --- | --- | --- |
| L01–L04 | Nora、Ray、AB、Q7 | 短Latin正控 |
| C01–C02 | 朋友甲、联系人乙 | 中文正控 |
| M01–M02 | 甲A1、A1乙 | 混合正控 |
| N01 | Nora | 顶部及复读帧空白 |
| N02 | Nora／Ray／Nora | 名字不一致 |
| N03 | Nora与Ray分两行 | 多行不得授予资格 |
| N04 | A1左侧x=-2 | 贴边／截断不得授予资格 |

header与复读物理像素180×50、row160×40，原pixel scale2。正控Helvetica24／22；中文和混合为PingFangSC-Regular24／22；多行为Helvetica14，两行间隔17像素。白底黑字、sRGB／RGBA、开启抗锯齿、居中；N04仅固定x=-2。相同内存CGImage同时用于两个策略，不重采样、补像素、扩大区域或混入语言纠正。原始视觉资料、真实名字与F图不读取，所有文字是上述独立公开合成常量。

## 判定、停止与不足

H1预测：在固定Latin样本中，baseline实际产生正确文字但小于0.90，candidate同字且三个原置信度均不低于0.90；固定中文／混合不退化，全部负控保持拒绝，才支持语言配置影响该合成症状。未复现、仅置信升高、所有样本未通过或未完成均不能签F修好。单帧实际Vision结果与原Name后处理、Names.validate相连，不把纯数值单测当语义实验；保留最低三值0.90、唯一行和边界门。

任何错误高置信、负控通过、中文／混合明确回退、非法confidence、来源／配置／图SHA变化、重复启动、存储／收据错误或超时立即停止并记录unknown／unrun。普通低分与未支持H1如实保留，不改标准答案、不追加样本或无限重跑。本场不自动接H2、不推广生产策略、不使用已确认联系人词典，不以候选置信度替真实身份。

## 来源与验证边界

[Apple WWDC22](https://developer.apple.com/videos/play/wwdc2022/10024/)说明revision3准确模式的自动语言识别可能选错；[官方文本识别说明](https://developer.apple.com/documentation/vision/recognizing-text-in-images)说明语言顺序与语言纠正；[候选confidence定义](https://developer.apple.com/documentation/vision/vnrecognizedtext/confidence)是0–1原值。Context7本会话工具目录没有可调用项，已按AGENTS核官方正文和安装SDK头。SDK15.5的`VNRecognizeTextRequest.h` SHA为`a580685905d8e4c1f2ea618f5222a13ce97ce12d48b9081fd0cc99f301e7c100`；minHeight默认0已经不降分辨率，不能把设0称修复。F实际前置通过、低置信拒绝及其采集次数推断仍单列；本场无真实capture、probe、App、桌面、微信、PG或ECNU，Root独占全部实机。

准备源码／图像manifest冻结、实际命令与结果、原布局／会话最小回归、两轴及资源收尾将在下方追加；当前尚未运行，不伪造OCR首红。普通编译／材料读取失败将和实际模型结果分开记录。Root负责本地提交，本Agent不操作GitIndex。

## 第一次v3准备快照（真实perform为0）

`swift build --build-tests --package-path native/macos`三个准备版本均首次通过（3.56／2.30／3.41秒编译器报告），不是OCR语义首红或收益。v1／v2未激活计划和日志保留；v3仅准备收尾日期解析、部分执行与未运行区分，以及同次request配置守卫。生产文件SHA `3ec3ba28a74df4a561f4fb8c132a6bc98fcff8f78c95c49cc97f5b2eacf553d5`；仅逆向去掉内部接缝后，逐字节恢复旧SHA `a03518466fdfeffcd8012cf560c4255bfb415298da114554dc4cc5abe401b86f`，三处调用、全部Capture／image／Names／前台门没有改动。

专属`swift test --skip-build --package-path native/macos --filter VisionLanguageControlTests/testFixedPublicSyntheticLanguageControl`在无激活收据时仅构建内存图及fixture manifest：1项明确skip／0失败，case耗时0.701秒、监督器3.078253083秒，exit0，**0perform**。实际编译SDK输入为MacOSX15.5、Swift6.1.2（swiftlang-6.1.2.1.2）；运行OS15.7.5、实际default／current revision均3、支持1／2／3。原API默认auto false、minHeight0、语言纠正true、语言`en_US`；生产既有显式accurate／`zh-Hans,en-US`／纠正false保持，不把框架默认与产品配置混淆。

全部12案／36图已固定，fixture manifest SHA `b13a2fb89606db8b366bbbff23289ae725f3a4c6b2d8cafae33ef0ba3eb3ecd2`。Helvetica实际版本17.0d1e1，字体文件SHA `25eceb458d4baf628ee0b6a135a9f8ac5ec7b2826646720834bd2bf00dfc825a`；PingFangSC-Regular20.0d4e1、SHA `6bccdb1a967b2ae7e856927eb559591b2ce05656b0d4ad2764b9c9429f12c0b7`。字体全部来自系统本地字体，未下载；图只在端侧内存，保存SHA／配置／上述公开文字和安全数值，不保存图像。实际场重建后必须逐字节匹配此manifest及源码／test／plan SHA，否则0perform拒绝。

准备监督器两个已记录自有PID45373／45431及其进程组均实际gone；完整OS进程覆盖false，没有声明所有系统Vision服务已退出。实际场尚无激活、attempts或completion；两轴和Root最后时点确认后才进入唯一场次。`swift test --skip-build --package-path native/macos --filter 'MinimalRegionLayoutTests|SessionCaptureSafetyTests'`实际13／13、0失败、报告0.014秒，独立于本场Vision对照或实机F。首次文档草稿误写第三次编译耗时，已按原日志纠正；原草稿及一次未匹配补丁的0写失败保留，不计产品或OCR首红。

## v4闭账守卫和最后准备（真实perform仍为0）

新增测试侧前置闭账守卫：同run的closed completion在任何Vision查询前跳过；仅有attempts而无有效completion时拒绝重开。原收据、计数、失败和激活审计不删除，不让后续普通Swift全套重跑本实验。生产文件没有再改；test SHA `0eb4d4cc4c1456a3b3d313d40e63642e60acd8477540b14e842b782c94bbd6b6`，准备编译exit0／2.79秒。

因plan绑定test SHA，保留v3 plan／manifest／log后按v4执行一次必要的**0perform**图像准备，1项明确skip／exit0，监督器4.473885333秒；实际新自有PID47302／47355及进程组均gone，完整进程覆盖仍false。新plan SHA `5dc3471dc063755d2684e5067ebb3951ab873ae859d9ab0586f7a9626ce9fad8`、manifest SHA `be2e8d62d8808930dc13eae7e6de377bd04b4755250e0fc8d3727f9a89f50e03`。新旧36图的全部像素SHA、字体与实际runtime字段逐值相同；只更新plan身份，不称第二次OCR实验或收益。当前仍没有激活收据、attempts或completion；双轴和Root时点确认待收口，不自动进行H2或真实场。

Root独核发现四份build及一份最小回归重定向log最初为0644，目录一直0700；仅核本目录自有单链接regular文件后改0600，`private-mode-correction-v1.json`逐文件保存前后模式。初始模式不隐藏，不把目录保护当文件0600证据；修正快照所列25份记录全部600，修正收据自身600，后续实际记录仍逐个核查。

## Standards P2最小收口及v6冻结（真实perform仍为0）

独立Standards发现v4闭账检查位于当前source／testSHA之后：后续合法改源会先触发freezeChanged，普通全套不能走旧closed skip。Root授权后将有效同run闭账判断前移到源码摘要和任何Vision查询之前；强类型解码全部关键收据／case字段，并核closed、状态、有限计数、分母划分及safe布尔，半截／非法收据或只有日志无closed仍拒绝。活跃场原plan／manifest／source／72／180门全部保留，不改生产策略或控制图片。

v5／v6准备编译exit0，2.78／2.27秒；没有编译失败，没有OCR红绿。v6专属准备仅1skip／0perform，case0.633秒／driver2.007367125秒、exit0，自有PID51511／51523及组gone；完整进程覆盖false。旧v3／v4准备和文件保持，新旧36图像像素／字体／runtime逐值相同。最终test SHA `985adb54a7499e4bb451f1d6e4bc3d613c548bb840eac26acaca3a8e7b65f675`、plan SHA `12f18b1fe68a7203b9c00af37fd06745a23ccbe631dcc08f619261ff28b828da`、manifest SHA `17166c5eb96e3c928a4200aa25286740633fba133510b968acf88da9e6bd1cfc`。源码仍`3ec3ba28…`，实际激活／attempts／completion均无，最终两轴与Root时点未收口前不启动实际对照。

## Root唯一实际H1结果：安全停止，候选不支持投产

准备阶段最终独立Spec／Standards均0未解决项；Root最后独核后以独占收据激活一次。窗口为UTC `2026-10-13T02:53:26.765Z`–`02:56:26.765Z`（台北10:53:26.765–10:56:26.765），上限180秒／72perform。唯一实际命令为 `node /private/tmp/notalone-ocr-vision-language-20261013-df6ab753-1eae-4d1b-a870-304689750ed3/supervisor.mjs actual`，Root session85317。实际监督器于UTC02:53:36.983–02:53:41.783运行，driver单调耗时4.800352625秒，Vision循环单调耗时1.374304459秒；exit1、没有超时或外层信号，按预注册`nonLatinRegression`立即停止。

持久日志70事件为32次连续预约、32次逐条对应返回、5个完整case和1个closed；无在途未返回perform。12案分母不变，L01–L04及C01完成，C02仅两次header返回，其整案保持unknown；M01、M02、N01–N04共6案未运行。未调用的40次（C02剩4次、6未运行案各6次）永久关闭，不补跑、不重新激活H1，不自动启动后续实验。

| 完整案 | 实际baseline三帧最低confidence／原Name门 | 实际auto候选三帧最低confidence／原Name门 | 文字比较 |
| --- | --- | --- | --- |
| L01 Nora | 0.5／拒绝 | 1／通过 | 全部同字；差项在row |
| L02 Ray | 0.5／拒绝 | 1／通过 | 全部同字；差项在row |
| L03 AB | 1／通过 | 0.5／拒绝 | 全部同字，候选三个值均退化 |
| L04 Q7 | 1／通过 | 1／通过 | 全部同字 |
| C01 朋友甲 | 1／通过 | 1／通过 | 全部同字 |

C02联系人乙的首header：baseline实际confidence1且exact，auto候选实际0.30000001192092896且不exact，触发中文回退停止。C02剩余四次及所有混合／负控未运行，不能从已执行部分签中文／混合无退化、负控通过或72次完整验收。本场证明语言配置能够影响这些合成图片的实际结果，同时直接否定全局启用auto候选的安全条件；不采用“只保留改善样本”的统计，不降低0.90，不改生产默认false，也不认定F低置信根因或修复成功。

源／test／plan／fixture／supervisor与激活前冻结逐字节一致。`activation.json` SHA `d7fa53ff9be0a79daf65ecc6161bb9ee25d1a71a7730fdee6d59b351275bdaf6`；`attempts.jsonl` SHA `bbfe2ca4789f6ca2c6160447e214783983987386418ec02b32d9d747390643f8`；`completion.json` SHA `406c699cb83d26bad177e3800d7bce11da8bac40978e7b7341476a85acd1bea0`；`actual-supervisor.json` SHA `06946527934cea458a0d5b64cb94d8eedc75d0175d05db0c7660f76484b9e442`；Root实际收尾`root-terminal-v1.json` SHA `93a77c7cdf39afd442c43d0671c6ace5bcb642e6087bf72e05d0be979a473bd7`。证据均在上述专属私有目录，目录0700、实际文件0600，原准备／失败／收据保持。

两个已记录自有PID52613／52659及两个已记录自有group当前gone，外层监督器清理完成；完整OS进程覆盖false，未认证全部Vision系统服务退出。没有创建App共享租约，没有App／桌面／微信／真实capture／PG／ECNU调用、测试文字发送或原始帧文件；图只在内存处理。此前13项布局／会话安全回归和准备跳过仍各自记录，不拿它们替代本次真实Vision失败或实机F验收。后续若提出新的窄候选，必须另作新固定计划／预算／激活，H1已闭账不可重开。
