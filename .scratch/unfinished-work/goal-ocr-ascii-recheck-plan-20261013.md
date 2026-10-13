# OCR 低置信 ASCII 同字复核：有限提案（2026-10-13）

本文件是 Root 在[已闭账 H1](goal-ocr-vision-language-control-20261013.md)安全失败后明确要求的新窄提案。前五节为实现前的预注册快照，当时未实现、编译、注册、激活或执行；末节追加当前必要接缝与0perform准备结果。H1的32次实际返回、AB／中文退化、40次永久关闭和F原因未知保持；不重开旧run，不自动接下一实验，不把本提案当修复或生产策略。

## 实际依据与可证伪假设

H1实际L01 Nora／L02 Ray的row在完整同字时由0.5升至1，但全局auto令原先正确的AB从1降至0.5、C02联系人乙从正确1变成错误约0.3。新假设只保留高分、非ASCII与不完整名字的原路径，低置信完整ASCII名字才允许一次同字复核。它能否改善两项固定症状、同时保持全部正／负控，必须由新有限场实际证明；H1六个未运行案仍是未知，不能补签。

## 最小共享识别接缝提案

使用现有[recognize](../../native/macos/Sources/NotAloneSyncCore/MinimalSessionCapture.swift)和`Name`后处理。预注册时拟在同模块增加内部可测试策略参数，默认仍为原baseline；三个生产调用不传新策略，继续accurate、revision3默认、`[zh-Hans,en-US]`、correction=false、auto=false。测试内部选择候选，不新增CLI／环境开关，不复制另一个生产识别器；该段记录的尚未修改状态是准备前历史。

候选每帧先执行原baseline识别，保留唯一行、完整候选与边界保护及原空白归一化。只有已有完整`Name.text`、名字符合`[A-Za-z0-9]+(?: [A-Za-z0-9]+)*`且原confidence有限、落在`[0,0.90)`，才可在**同一内存CGImage**上额外执行至多一次auto=true。基线≥0.90、含非ASCII／其它字符或无完整Name时原样返回，不发额外请求。

额外结果仍须通过同一个完整Name后处理，与基线完整`Name.text`逐字相同且其实际Vision confidence≥0.90才可采用；其它情况原样保留低分基线，最终保持拒绝。不得从词典、已确认联系人、候选列表最高分或模型标签造出名字／分数。不改变Capture、`image()`／sourceRect、前台／可见／几何门、三名字一致、原minimum0.90，也不新增采集或扩大像素区域。实验中的请求错误按下述停止规则收口，不用重试取得成功。

## 固定输入、预算与顺序

新准备身份`c8f4319c-9a3b-44ff-a738-6103c16bef43`；仅提案目录`/private/tmp/notalone-ocr-ascii-recheck-proposal-20261013-c8f4319c-9a3b-44ff-a738-6103c16bef43/`，0700／0600。`proposal-plan-v1.json` SHA为`5862ec15ab06a70f7f454bf27e0af5d10f8a074de8efc5e3b379491b722d10e1`，不是实际激活或预算登记。

保留H1全部12案、36帧、字体及逐图像素SHA：L01–L04、C01–C02、M01–M02、N01–N04，不删困难案、改字、缩放、纠正语言或重采样。只复用公开固定输入；旧H1 manifest只作为像素／字体父证据，新计划必须生成自己的封装manifest，不能借旧激活或余额。真实名字、F帧及图像文件不读取、不保存或上传。

每案每帧的固定顺序为：独立baseline false一次→候选臂baseline false一次→仅候选臂满足条件时auto true至多一次。最大`12×3×(1+1+1)=108 perform`，完整执行不要求消耗全部108次。新场总上限180秒；每次实际perform前持久预约并fsync，前后核单调截止，独占外层监督器覆盖准备／Vision／闭账，仅停止已记录自有进程组。剩余调用全部关闭，partial case记unknown、未开始case记unrun，不补位或重跑。

实际起止时点尚未指定，激活文件不存在。若Root决定实施，先固定最小接缝、专属实际Vision测试、独立协议负控、36图与配置／字体／SDK／源码／监督器摘要，完成0perform编译、最小相关回归与两轴，再由Root一次写新独占180秒激活窗口。没有完整冻结与收据时不得perform，旧closed不得重开。本提案没有模型HTTP、App、微信、真实capture、PG、桌面操作或发送。

## 负控、判定与停止

必要协议控制覆盖：高分／非ASCII／无完整Name不调用auto；低分候选不同字、高分不同字、低分同字或空Name均原样保留基线；只有低分完整ASCII＋同字实际≥0.90允许一次额外返回；第二次额外请求、非法confidence、过期／不完整／重复收据必须拒绝。它们只验证独立策略与请求边界，不替代Vision语义对照，不能用提示字符串测试制造假红。

新场须全部12案完成，四个N负控全部保持原Name门拒绝；所有baseline已接受正例都保持同字与原门，所有高分／非ASCII／无完整Name的候选快路径保持原值。L01和L02两个预先指定的正确低分症状都须在新独立baseline复现，条件臂完整同字且三帧均≥0.90，才支持该窄合成假设。未复现、只完成部分、仅一个改善、任何正控损失均不签假设成功，不改通过条件。

任何实际识别错误高置信、负控通过、原接受正控损失、快路径被改变、额外次数超1、Vision请求异常、confidence／配置／字体／图／来源漂移、存储／收据错误或截止立即停止并保存closed／unknown／unrun。生产最低0.90和质量门保持；合成完成只能支持该固定控制，不能认证F因果、真实微信／绑定／权限／签名、一般OCR质量或生产已投用。后续实际场与是否采用候选由Root根据新证据独立决定。

## 必要内部接缝与首次准备结果（v1历史，实际Vision0）

Root在两轴提案均0后批准仅三路径准备：原识别源、[同文件有限测试](../../native/macos/Tests/NotAloneSyncProbeTests/VisionLanguageControlTests.swift)和本记录。新增内部`recognizeName`默认`.baseline`，候选仅由专属测试显式选择`.conditionalASCIIRecheck`；原`recognize`本体和三个生产调用逐字保留。非候选路径不作新后处理；候选先原baseline，再以同一CGImage最多一次auto复核，实际候选Name、confidence和pixelSize不重写。非法分数或图像尺寸变化抛错，不重试。共享有限session复用原绘图、配置、Name门、计数和收尾，H1有效closed仍先于当前源／测试SHA与任何Vision查询跳过；只有H3完整闭账不要求耗尽108最大额，H1原completed=72严格条件不变。

协议最小首红是已可编译的baseline-only接缝实际返回`[false]`／0.5，而同字复核应为`[false,true]`／1.0：1方法、2断言fail、0.095秒（suite外层0.103秒），编译4.51秒；不是编译缺符号或Vision语义红。最小实现后1方法绿0.011秒（外层0.021秒），编译7.69秒。其余快路径／默认原值、异字低分或空候选回退、非法confidence／变尺寸、请求异常传播四方法第一次运行即绿，未伪造红；初5方法全绿0.007秒（外层0.027秒、编译6.66秒）。最终重新编译与最小相关组：原布局9＋session安全4＋新协议5通过，H1旧实际入口1项正确closed skip，合计19方法、1skip、0fail，0.010秒（外层0.019秒）。这些fake Name只是独立策略控制，不是实际Vision置信结果。

新私有运行准备目录为`/private/tmp/notalone-ocr-ascii-recheck-20261013-c8f4319c-9a3b-44ff-a738-6103c16bef43/`；原proposal目录完整保留。新`plan.json` SHA `27a5bde8ad3bbb33681d42c11945a9cdb293150f02420664fcf516dbe9eff181`，源码SHA `fc92691fe94b909fa6294f43b5b53fd8f7e5cbb9de32a61d8c30db4b1d97ee19`，测试SHA `475237222e7b9e3c1bf8b496c1b3dd5d2d5630b8ee31bbb6d84efd7df03fe633`，已编译测试可执行SHA `565bcede7c69a8ef0e006e8efffce4147cb0d50799a8d233a82d547cb5d180fe`。监督器SHA `c8ccc4a957f40d273f4a0f16b1dec64f55587b0fc1a9c69ac1b525d1d69d78c4`，先核固定源／测试／可执行字节，actual拒既有attempts或completion，不借preparation。所有baseline、候选首次baseline、optional-auto统一逐perform预约／fsync，独立arm和sequence对齐；每个候选最多2请求，optional最多1。后处理、计数、请求／字体／图像漂移或存储异常一律停，未知收尾不写成功。

2026-10-13 UTC03:37:26.565–03:37:28.320首次监督准备实际exit0、单调1.754893083秒。专属入口因缺激活按`fixture_preparation_only_zero_perform` skip，测试0.680秒；只查询配置支持并在内存绘制36图，perform0。新manifest与H1父证据的完整runtime／36逐图metadata（像素SHA、字体、尺寸、负控、预期公开文本）完全相同；每次真正识别前仍需新激活及再次同值核验。编译工具为Apple Swift6.1.2（swiftlang6.1.2.1.2／clang1700.0.13.5）、macOS SDK15.5；实际OS／Vision revision／语言支持和系统字体由manifest记录，字体未替换。图像不落盘、不读取F图或真实姓名。

`legacy-preservation-proof-v1.json` SHA `f4b05ae70b22723c9cb1eb0d56296682a9978d71dbd9b52043393eee6235a12f`证明去新wrapper后逐字恢复已提交H1源；H1closed条件去唯一H3分支后逐字原样，原绘图／runtime／gate／finish函数逐字同，旧plan／激活／32次记录／completion／Root终态SHA不改。新prepare已记录两个自有PID67729／67740及进程组gone；完整OS进程覆盖false。私有目录0700、实际所有准备文件0600，收据与失败日志保留，没有删除未知资源。

当前新activation／attempts／completion均不存在，实际Vision0、App／微信／capture／模型HTTP／PG／发送均0；没有修改原18AC或将候选投用。两轴最终审核和Root独占180秒绝对窗口仍待；唯一实际入口为`node <本私有目录>/supervisor.mjs actual`，只选择新`VisionLanguageControlTests/testFixedPublicSyntheticASCIIRecheckControl`，不得使用H1过滤器或临时换窗口补位。当前准备结果不支持新假设成功、F修好或TCC／绑定／签名认证。

## UTF-8字节边界修复与最终v2准备（尚未实际识别）

v1自核发现Swift `String ==`会将ASCII `K`与规范等价Kelvin符号`\u{212A}`视为相同，新候选应逐UTF-8字节相同。先追加真实纯协议负控：基线K／0.5，额外Kelvin／1；实际旧guard返回字节`[226,132,170]`／1而应原样返回`[75]`／0.5，两断言真fail、0.098秒（suite外层0.105秒、编译3.37秒）。只将新候选guard改为`candidateText.utf8.elementsEqual(text.utf8)`，不改原`recognize`、`Names`或生产调用。固定12案／36图没有新增、删除、改写或重新定义通过条件。

修复后当前源的最小组实际20方法／1旧H1closed skip／19pass／0fail，0.008秒（外层0.016秒），编译2.41秒；其中原布局9、安全4、新独立协议6。新UTF-8负控绿，其余协议／原门全部保持。v1两份计划／manifest和prepare日志／收据按原SHA改名保留，映射见`preparation-transition-v2.json`；没有删除失败、改写旧实际H1证据或消耗它的40余量。

当前新`plan.json` SHA `15905abfc8c101134c5d0a43f515c12d4e1ea50c696233400b7b2e13d27232e7`；源SHA `e548868a7a7474208b1c5495c61c01d681ec49d4b07637ef80d3156fa1a0ae25`，测试SHA `4f33530f23058324e5b7cd383a89885800f8df52d9270bcee40355107e361699`，编译可执行SHA `47b5a477008970db69697cc4f6517a4af32690d1cc9e7a4996bbf7f30179487f`。监督器仍为`c8ccc4a9…`原字节，只从新计划核上述冻结，不改108／180／独占与逐预约规则。新0perform准备、manifest及自有收尾由最终v2元数据绑定；H1有效closed跳过仍早于源SHA和Vision查询。

v2监督准备实际UTC03:44:11.594–03:44:13.176，exit0／单调1.582070000秒；专属入口1skip、0fail、0.660秒（外层0.669秒），未激活且perform0。manifest SHA `b86edf3471a9b9a55a04e644b846bf6a9b93bbe17c12395974c202b1c51f7dbb`，所有36图及runtime／字体与v1和H1父证据完全相同；只有新run封装和源码计划绑定变化。两个已记录PID69056／69067及组gone，完整进程覆盖false；全部自有文件仍0600、目录0700。两次prepare都只是0perform配置查询及内存固定绘图，不把1skip当识别通过。

Root最终激活需`O_EXCL`创建0600 `activation.json`，仅映射：`runId`为本run，`planSHA`／`fixtureSHA`为当前新计划和manifest完整SHA，`sourceSHA`／`testSHA`为上方当前值，`requestLimit=108`、`sceneSeconds=180`；`startUTC`和`endUTC`须带毫秒，严格相差180秒且由Root给唯一实际时点。初次actual命令仍只`node <本私有目录>/supervisor.mjs actual`；当前没有该文件／attempts／completion、实际perform仍0。最终两轴与Root时点核对前，不实际执行，也不以这些协议和准备结果认证新假设、F、真实捕帧、绑定、TCC或生产。

## Root唯一实际H3终态（2026-10-13 UTC03:53，当前证据）

本节为当前真实终态；以上v1／v2的未激活、0perform与待两轴语句均保留为当时准备快照，不代表现在。两轴最终未解决均0后，Root独占激活UTC03:53:07.022–03:56:07.022（台北11:53:07.022–11:56:07.022），严格180秒，activation SHA `082bb2919c26e8b63b07f2ac593d2cbdde38d402a08412b60d39c15d1c358869`。唯一命令为上方固定新过滤器的监督器actual；实际UTC03:53:11.436起、03:53:17.133退出，exit0、无signal或timeout。外层单调5.697139417秒与Vision循环3.089163083秒分别记录，不把180秒预约长度冒充运行时长。

实际79／108识别全部逐次预约和返回对应，独立baseline36、候选首次baseline36、optional-auto7，没有漏计候选首次识别。207条事件精确为79 reserved＋79 returned＋36 arm_result＋12 case_completed＋1 closed；每个sequence1–79、case／frame／auto／arm逐值相同。12案completed、0unknown、0unrun；剩余29永久关闭，不重开、不补位、不借旧H1余40。此记录不启动任何后续实验。

| 固定案 | 独立baseline | 条件候选 | 本场结论 |
| --- | --- | --- | --- |
| L01／L02 | 全文exact，最低0.5，原门拒绝 | 全文exact，最低1，原门接受 | 两项预指定低分症状复现并改善 |
| L03／L04／C01／C02 | 全文exact，最低1，接受 | 全文exact，最低1，接受 | 原先已接受正控保持 |
| M01 | 全文exact，最低0.5，拒绝 | 全文exact，最低0.5，拒绝 | 混合名仍未达到质量门 |
| M02 | 全文exact=false，最低0.5，拒绝 | 全文exact=false，最低0.5，拒绝 | 混合名低分／错误保留，没有通过 |
| N01／N03／N04 | 名字不可读，最低0，拒绝 | 名字不可读，最低0，拒绝 | 三项结构负控保持拒绝 |
| N02 | 全文各自exact，最低0.5，名字不一致拒绝 | 最低1，仍名字不一致拒绝 | 高分不能绕过三名字一致门 |

该固定对照支持预注册的窄假设：两项指定Latin症状改善，四负控保持拒绝，全部baseline已接受正控保持。它不代表所有positive识别正确或合格：M01／M02均仍最低0.5，M02的exact=false保留，未被成功退出掩盖。本场无已记录错误高置信，当前生产三个调用仍是原baseline；没有把候选接入产品，也没有证明F实机原因、真实微信绑定／低分消歧／失效／焦点或TCC／签名。

实际completion SHA `37af674c39b30607efa8748f2aa6139dbd824ae8434aa690bec7e29becea4cf6`，attempts SHA `a5f2a96ddf8f348aba13a493f808f8ede0e3e2d896ab042685399b231658609e`，actual-supervisor SHA `891d5f099be7da5257b796c41ea31f759bdfdeb775178057864e00202bfac70d`。Root新鲜终态`root-terminal-v1.json` SHA `1ff18dfa9f8cdf0f0b2cf9578dd0495ed873b37d677ae39e7a546854fdd825a6`已核两个PID71361／71372及两个已记录进程组gone；完整OS／Vision服务覆盖false。Root首次事件探针误用`kind`得到207个null，仅采集器字段错误、没有写入或识别；按实际`event`核正，原失败备注保留，不当OCR红。

源／测试SHA仍`e548868a…`／`4f33530f…`，本次只追加本节及私有postrun元数据；不编译、不重跑、不改旧封存或原18AC。原H1安全失败32次与新H3窄对照79次合计111次公开合成Vision实际识别，各自闭账及余量分开保存；这些计数不包含实机F的路径推断，也不把配置查询或协议fake算识别。原帧只在内存，当前记录为安全数值／布尔／公开固定案；本场App／微信／真实capture／模型HTTP／PG／发送全部0。只签已核自有资源，未知进程不操作；私有实际文件0600、目录0700，证据保留。
