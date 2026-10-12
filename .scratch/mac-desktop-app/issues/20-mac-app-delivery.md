# 20：本机 App 打包与完整交付验收

Type: task
State: claimed
Triage: needs-info
Blocked by: 03, 04, 10, 14, 15, 17, 18, 19
Spec: ../spec.md

## 交付行为

交付包含前端和所需完整 helper 的本机 .app，并用合成资料走通首启、导入、生成、复制、同步和退出。

覆盖规格用户故事：48。

## 验收条件

- [x] 实际 .app 由 Finder 启动，运行不依赖开发服务器或原型；Python/PostgreSQL 仍使用已配置本机环境。
- [ ] 核验完整 helper/动态库、受控路径、签名及权限记录，验收真实快捷键、剪贴板和退出停读。
- [ ] 自动化/相关后端检查及 Standards/Spec 两轴评审通过，记录产物位置、已通过和未验证的集成部分。
- [ ] 模型冒烟使用合成输入，真实微信只在既有明确确认范围验收；不处理未授权私人数据、不发送消息、不推送远端。

## 测试与范围

- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 最终实机须包含用户主动选择单联系人 JSONL 的真实系统文件选择器、最终签名包 UI 和调度门禁的正向 App 适配。任务 07 的自动化只控制必要原生对话框 I/O，并已分别记录源码 App 与真实 HTTP/PG 证据；不能据此声称上述三项已验收。当前真实桌面验收仍暂停，只由主 Agent 在用户认可的有限时段协调本项；不新增任务或改动依赖图。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Answer

### 2026-10-12 人工快捷键、系统导入及正常退出整场通过

同一新候选包在14:59:01–15:29:01有限`test:app`窗口、最多1次启动，实际1次。人工两步及反馈共用25分钟截止，主Agent只操作系统文件选择器，不发送本场快捷键或调用回调；系统选入单联系人合成JSONL、6条消息及全部导入步骤／最终核验通过。用户实际按Command+Shift+Y显示，再次按后明确确认“小窗已消失，只剩管理后台”；程序分别观察同一个helper显示和隐藏，保持1个小窗／2个App窗口，两次真人反馈在本场存活PID、nonce、租约及共同截止核验后写入独立0600收据。整场 **1／1通过、runner exit0、610.520秒（测试报告10.2分钟）**，公开菜单正常退出且App exit0。

第二次实际按键早于hide-request生成；显示收据写入后程序才进入hide阶段，已观察同一helper隐藏，随后用户对该状态明确澄清。记录这项顺序，不声称按键发生在hide提示之后，也不使用旧场反馈或机器观察代签。管理后台在验收开始时已打开、隐藏小窗后仍可见；本场验证用户所述“第二次按小窗消失”，没有独立验证其他App在前台时的焦点返回体验。

Root独立核对6个已记录进程（含App／自有后端／worker）退场、4个自有路径及精确测试库清除、限定测试库与基线相同、两租约absent；原默认目录身份相同，配置正文未读，退场后没有NotAlone CUA状态／置前动作。主包deep strict、4helper原SHA及strict、9份材料完整集合／SHA、ASAR及ZIP原SHA／大小保持。业务与配置只用合成资料，初始系统对话框所列其他文件名及原始UI不提交、未打开其他文件；没有真实微信、OCR、官方helper、外部模型、聊天发送或权限／TCC改动，不push。产品源码和包未改，新增功能冻结、OCR暂停。

当前同包非OCR完整App场景累计 **21个**（前轮20＋本场1），不把分批及失败后的补验写成某一原批次21／21。自最初非OCR窗口累计受控29次、另有先前工具意外默认实例1次，共30；三场后续人工各1次，前两场失败、迟到反馈和旧事故独立保留。[最终人工验收摘要](../../unfinished-work/mac-delivery-human-shortcut-final-20261012.json)为本场证据，原[20场摘要](../../unfinished-work/mac-delivery-non-ocr-20261012.json)、[第一人工场](../../unfinished-work/mac-delivery-human-shortcut-20261012.json)、[第二人工场](../../unfinished-work/mac-delivery-human-shortcut-retry-20261012.json)不覆盖。WCDB精确构建／二进制许可、真实渠道／模型质量和原18依赖保持；完整票claimed／needs-info、原四AC只勾第1条。固定`db2e231c`最终只读双轴：Standards新增硬违规／建议／证据越界0，Spec新增错误／范围越界0；98条相对链接、原状态／AC及仅文档改动核对通过，`git diff --check`通过。只做本地提交，不push。

### 2026-10-12 第二场人工复验：显示观察及迟到确认，收据先超时

同包在14:40:41–15:00:41有限`test:app`窗口实际1次启动，旧场退场与租约核对后才开始。系统文件选择／6条导入／所有任务核验及窗口前置通过；程序确已观察到小窗显示，失败转为随后4分钟等待用户收据超时。runner exit1、478.972秒（测试8.0分钟），14:48:40已退场；用户后来回复“小窗已出现”，与程序显示观察分列保留，不追补过期nonce收据或改写整场失败。隐藏阶段未运行，不能算同一小窗完整显示／隐藏／正常退出验收。

Root核对6个已记录进程（含App／自有后端／worker）消失、4个自有路径和精确测试库清除、限定测试库与基线一致、两租约absent；原目录身份相同、不读配置正文，未在退场后调用NotAlone的CUA。主包deep strict、ASAR／ZIP原SHA及归档大小保持，没有新增意外启动。只选合成文件；初始对话框所列其他文件名未提交，未打开其他文件；未读取微信、运行OCR／官方helper、调用外部模型、发送消息或修改权限／TCC。此前20场完整成功及失败历史不改。

本次红点是验收协调等待先结束：下一最小场人工显示／隐藏及反馈共用固定25分钟交互截止，测试总上限28分钟、受限runner预约30分钟／最多1次启动，所有分段等待只用该截止前剩余时间；程序窗口观察另写时间记录，不生成用户收据，Agent原限时保持。主Agent直接聊天提示并结束当前回复，用户反馈返回时先核验本场存活PID、nonce和共同截止，收到两次明确确认后正常菜单退出。产品及包字节不改，新增功能冻结、OCR暂停；[第二场人工摘要](../../unfinished-work/mac-delivery-human-shortcut-retry-20261012.json)不将准备记为通过。完整票仍claimed／needs-info、四AC只勾第1条；固定`be049b0b`两轴最终新增错误／重要建议／范围或证据越界0；类型检查、纯收据3／3（0.121秒）、91条相对链接及差异检查通过。真实下一场仍待，安全／后端旧次数不增加。仅本地提交，不push。

### 2026-10-12 实际键盘最小复验：显示阶段超时，未形成验收

用户明确回复“能配合，等提示再按”，沿本轮已有授权开启14:25:34–14:35:34（UTC+8）有限`test:app`窗口、最多1次，同一新包实际启动1次。产品、测试代码和包未改；仅既有`native-desktop-acceptance.spec.ts`人工模式，未使用Agent收据或调用快捷键回调。

CUA实际选择本轮单联系人合成JSONL，6条消息及全部任务步骤／最终核验通过；公开快捷键注册、菜单打开同一小窗及按钮隐藏的前置检查通过。随后提示用户只按一次Command+Shift+Y并等待显示反馈；180秒未观察到小窗，截至阶段结束也未收到明确按键反馈，实际按键是否执行／送达未确认。随后用户明确说明按键时App已经退出，该迟到反馈不证明运行中的快捷键故障。显示阶段超时，隐藏未运行，成功收据和整场结果均未写；runner exit1、235.663秒（测试报告3.9分钟），不能写成产品快捷键故障已证实或人工验收通过。已提示本场退出后先不要继续按键，不沿用迟到反馈为本场成功。

Root独立核对4个已记录进程（含App与协调进程）退场、4个自有路径与精确测试库不存在、限定库命名空间与基线相同、两租约absent；原默认目录身份相同且未检查配置正文，未对已退场App执行CUA状态／置前，没有新增意外启动。主包deep strict、ASAR与ZIP原SHA及归档大小保持，未重建。只选择合成资料；文件选择器初始展示其他文件名，未打开其他文件，原始UI及私人文件名不提交。未读取微信、运行官方CLI／OCR／探针、调用外部模型、发送消息、改变权限／TCC或push。本轮不新增安全／后端测试次数，沿用前轮通过结果。

[实际键盘复验摘要](../../unfinished-work/mac-delivery-human-shortcut-20261012.json)与原Agent失败、20场独立成功证据分列；快捷键显示／隐藏仍待可完成的实际输入与明确反馈，WCDB精确构建／二进制许可、真实渠道和原18依赖保持。完整票仍claimed／needs-info，四AC只勾第1条；新增功能冻结、OCR暂停。固定`f9c55805`文档双轴：Standards新增硬违规／重要建议／证据越界0，Spec新增错误／范围越界0，原缺项保留；87条相对链接、原状态／AC及仅文档改动核对通过，`git diff --check`通过。仅本地提交，不push。

### 2026-10-12 非OCR交付验收：可独立执行项完成，实际键盘待验

沿用户连续授权，在同一带9份许可材料的候选包执行有限`test:app`，13:51:13–14:11:13（UTC+8），总上限由25调整为28，实际受控启动26、另有工具意外重开默认实例1，合计27。仅调整验收夹具和记录，`desktop/src`、`backend/src`、`native/macos`及签名包字节未改，新功能冻结、OCR暂停。

独立完成 **20个完整App场景**：后端认证复用／退出失败／超时／重复退出／响应丢失／旧握手目标／非法IPC／断线重试／重复启动共10；系统剪贴板复制当前编辑文本与复制收起1；机器账本／本人初始化／停读失败不改路径／失联后恢复4；合成CLI同步开关／补齐暂停失败重试／真实IPC拒绝／开启时正常退出4；同包生命周期单场1（10.5秒、2次启动，重开模型delta0、显式重试delta1）。剩余自动批次17场通过后在共享URL等待处失败，修正为同时兼容`/#helper`及`/index.html#helper`的公开hash后，仅两场同步复验2／2、9.6秒／exit0；组合20场通过不写成某一原批次整场通过。系统文件选择器由CUA实际选中本轮单联系人合成JSONL，6条入库与全部任务核验已在快捷键前通过；原生整场后续快捷键失败，导入只记分项证据。

快捷键独立Agent模式的纯协议3项由缺模块red到green，人工两字段与Agent三字段nonce收据互不代签，两模式冲突拒绝；默认跳过，真实按键不调用快捷键回调。CUA在Finder及App尝试系统按键后没有观察到小窗唤起，未写Agent收据／人工确认，**该整场未通过**。已询问用户是否方便用实际键盘配合两次显示／隐藏，以区分输入工具限制与App问题；这是操作条件与反馈，不索要新授权，回复前不另开等待场。

本轮另有一次明确记录的工具事故：原测试App退场后，CUA状态刷新／置前重新解析目标并意外重开同包默认配置实例，未经过`test:app`登记。公开页显示启动路径未配置、未连接后端；Root立即公开菜单退出并核对PID退场，不算受控验收。原目录dev/ino相同，Root未检查原配置正文，但**不宣称该次默认实例未触及配置／缓存**。原工具时间线、失败和单独清理回执保留在忽略目录；动作后不再观察已退场App，后续须先核对已知PID与阶段截止，再使用Finder／进程证据收尾。

其他原失败同样保留：首场候选编辑框未出现，20场未运行；加公开草稿就绪检查的最小生命周期复验通过，尚未证实首次产品根因，临时诊断日志已从源码删除。旧helper连接状态选择器误匹配前台定位暂停及连接状态，已用实际strict失败→正确状态范围的同场通过修正。App夹具在断言前记录自有实例，失败时仍有精确PID／目录线索；没有用这些测试修正新增产品功能。

类型检查、默认安全46／46（11.612秒、不运行App）、相关后端44／44（单测0.530秒，进程1.940秒）通过。共享URL修改另以普通页面`npm run test:pages -- --case sync-arguments --timeout-seconds 120`最小复验1／1、9.75秒／exit0（Electron未运行，非原生验收），拒绝6个helper／80个非法参数／4个旧范围请求且读取0；Root另核对该页后端退场与测试库清除、两租约absent。Root复核App场28个记录PID退场、29个自有目录不存在、7个记录测试库不存在，限定随机测试库命名空间与开场基线一致，无新残留；App／页面租约absent。运行后主包deep strict、4个helper原SHA／严格签名、9份材料集合／SHA、ASAR及归档SHA均保持，原包未重建。业务验收只用合成资料／配置；复制前覆盖已知合成占位，不读取或恢复原剪贴板，结束仅清除仍属本轮的已知文本。系统对话框初始列出默认目录文件名，未打开其他文件，原始UI／私人文件名不提交。受控CLI仅合成脚本，未执行官方CLI／探针、微信读取、OCR、外部模型、聊天发送、权限／TCC改动、push或部署。

[非OCR验收摘要](../../unfinished-work/mac-delivery-non-ocr-20261012.json)逐场区分通过、失败、未运行、意外默认实例和清理范围；产物仍为`desktop/artifacts/wcdb-notice-package-20261012.iecln6/NotAlone-macOS-arm64-with-notices.zip`，SHA-256 `05307269a90a450265a4416947929d27fc5c97ae5f3ba4bd554433d7da4841d3`。实际系统快捷键仍待物理键盘反馈，WCDB精确构建／二进制许可覆盖、真实渠道与原18依赖继续保留；完整票claimed／needs-info，原四条验收仍只勾第1条。固定基点`3677bf31`最终只读双轴：Standards新增代码／文档硬违规0、重要判断建议0，同时记录1次执行门禁违规；Spec新增代码／证据错误0、产品范围扩大0，同时记录该默认实例隔离事故及原缺项。83条改动文档相对链接、原状态／四AC及产品源码无改核对通过；`git diff --check`通过。仅本地提交，不push。

### 2026-10-12 新许可资源候选包Finder启动与退出收口

用户明确要求补完新候选包Finder启动／退出，功能冻结、OCR暂停，并沿用本轮连续授权。主Agent使用原`finder-package-acceptance.spec.ts`和受限`test:app`，测试与产品代码均未改。12:03:27–12:13:27首轮因Mac锁屏、CUA自动解锁失败，**实际App启动0**；等待场未通过、runner exit2及未确认清理历史保留，不能算App运行失败或验收通过。Root只中断核对过命令／cwd／租约的自有runner，随后确认无App、无本轮后端、无握手、自有worker组退出，按目录／租约身份恢复原目录并清理精确测试库、临时目录及该轮锁；未读取原配置正文。

用户回复“已解锁”后，主Agent确认Finder可操作，重设13:34:20–13:44:20（UTC+8）有限时段、最多2次启动，未重复索要授权。相同新候选包实际完成 **1／1、场景约1.6分钟／runner约1.7分钟（100.115秒）／exit0，实际1次启动**。真实CUA在已核对的新候选目录双击`.app`；管理页面显示`notalone://app/`资源与本机服务已连接，配置页机器环境已就绪、绝对Python可见；打开／隐藏输入小窗后从“NotAlone → 退出NotAlone”退出，观察到正在停读。测试先验证认证HTTP running，Root核对App／后端PID与握手退场后写入实际操作收据，夹具再恢复原目录、删除测试库并释放租约。

验收对象：`desktop/artifacts/wcdb-notice-package-20261012.iecln6/packaged/NotAlone-darwin-arm64/NotAlone.app`；归档仍为`NotAlone-macOS-arm64-with-notices.zip`，140277674 bytes、SHA-256 `05307269a90a450265a4416947929d27fc5c97ae5f3ba4bd554433d7da4841d3`。运行后主包deep strict、4个helper原SHA／严格签名、9份许可材料集合／SHA、ASAR及归档哈希再次通过，没有重建包或修改资源。Root使用新PG连接确认本轮精确自有库不存在；原userData目录dev/ino恢复，自有App／后端／runner／worker均退出，握手与暂存目录不存在，App及页面租约absent。前一锁屏场的清理已另证，失败记录不改写。

[新候选包Finder验收摘要](../../unfinished-work/wcdb-notice-finder-20261012.json)保存实际有限命令、同包身份、两场区别、运行后复核与清理结果；原始CUA状态、PID、测试库及临时目录只留在忽略产物目录。此次仅执行既有Finder场，不重跑或借用原包的生命周期／重开、微信渠道、快捷键、定位或权限验收；没有外部模型、私人配置／剪贴板读取、聊天发送、TCC／权限修改、push或部署。新包Finder启动与正常退出已完成；WCDB精确构建／二进制许可覆盖及原18／剩余渠道依赖继续未确认，完整票仍claimed／needs-info，原4条验收仅第1条已勾选。新增功能冻结、OCR暂停保持；79条本地链接与diff检查通过，Standards硬违规／重要判断0／0、Spec新增缺失／越界／错误0／0／0；两轴只读，未新增执行。

### 2026-10-12 WCDB来源与许可材料补查收口

用户要求补齐能独立核查的来源／许可缺项，新增功能冻结、OCR暂停，沿用本轮本地核查授权。范围仅公开固定发行与候选源码、完整许可原文、随App保留来源索引；不换WCDB、迁移CLI或新增产品能力，不联系发行者、不读取微信、运行OCR或调用模型。当前固定CLI与库两项SHA均匹配时，打包资源才纳入`notalone-third-party`；未知字节不套用当前材料。

Testing Decisions：沿独立许可搬运／复核接缝验证完整9文件、未知CLI／库拒绝套用、已有目标保留、篡改／符号链接／额外文件拒绝；公开`test:package`继续验证合成输入离线签名打包和精确清理。最后用真实固定发行字节做离线候选包并静态核对原文／哈希、原二进制及严格签名，不运行产物。此前Finder／生命周期证据仍只属于此前包，不迁移到此次资源变化的新包。

已完成官方release／源码／CI／attestation补查：固定v1.6.25发行身份与Tencent v2.1.15候选源码及gitlinks确认；`Custom build`是版本宏未定义的默认值，不证明私改或微信提取。候选SQLCipher 4.1.0／SQLite 3.27.2、zstd 1.5.5、OpenSSL 1.0.2k不等于实际完整BOM，Tencent根LICENSE旧版本标注不能替代组件原文。稳定构建日志／digest证明未取得，精确源码／补丁／构建命令和二进制许可覆盖仍未确认。

材料原文与哈希固定在`desktop/third-party-notices/wcdb-v2.1.15/`；新增3项检查由缺模块red至green，默认类型／安全43／43（11.987秒）与显式`test:package`1／1（32.438秒）通过。随后双字节绑定增量3／3通过（81.95毫秒）。真实固定发行输入的离线`npm run package`成功，主包ad-hoc deep strict、9份资源原文／SHA、4个helper原字节／arm64／严格签名、主包仅allow-jit／ATS false／无额外权限声明全部核对。6份dist及整个ASAR与此前已Finder验收包完全同字节；新资源候选包本轮未启动，不借用旧包Finder结果。

候选App：`desktop/artifacts/wcdb-notice-package-20261012.iecln6/packaged/NotAlone-darwin-arm64/NotAlone.app`；归档`desktop/artifacts/wcdb-notice-package-20261012.iecln6/NotAlone-macOS-arm64-with-notices.zip`，140277674 bytes、SHA-256 `05307269a90a450265a4416947929d27fc5c97ae5f3ba4bd554433d7da4841d3`，ZIP完整性通过。App内9份材料随拖动保留；源码／许可收集完成，不宣称精确构建和当前二进制许可覆盖已关闭。此前已实机验收的原包及所有失败历史仍保留。

Standards硬违规／重要判断0／0、Spec新增缺失／越界／错误0／0／0，两轴仅只读。自有代码／文档diff检查通过；上游许可中的原空白原样保留，按来源SHA复核，不为格式检查改写原文。离线Electron归档与自有构建临时目录（含Node编译缓存）精确清理；包、日志和静态证据仅保留在忽略产物目录，研究笔记保持忽略，不强制提交。本轮实际App启动0，未执行CLI、库或探针，无真实微信／OCR／私人配置／外部模型／消息发送／push／部署。

[无敏感来源／许可摘要](../../unfinished-work/wcdb-source-license-20261012.json)记录固定公开来源、候选gitlinks、材料及新包哈希、实际命令／范围和剩余条件。能独立核查的本轮工作已完成；还缺绑定当前库SHA与稳定CLI revision的精确source tree／补丁、构建命令／工具链／宏、完整依赖BOM及对应许可声明。完整交付票继续claimed／needs-info，原验收勾选与OCR依赖不变，不重复查询相同失败路径或靠替换版本消除缺口。

### 2026-10-12 当前签名包与Finder启动收口

用户本轮指定的当前签名包与Finder启动两项已完成，原第1条据实勾选，State改为claimed，Triage仍needs-info。原四条验收文字及依赖图保持；完整交付票还缺WCDB精确构建／许可、18定位以及剩余渠道／原生链路，不把本次两项通过写成整票resolved。新增功能冻结，OCR继续暂停，后续操作沿用用户本轮授权，没有再逐次询问。

- 当前产品源码固定`b6fed39f`，后续仅增加验收夹具与记录，`desktop/src`、`backend/src`、`native/macos`无变更。离线 `npm run package -- --helper-directory <此前固定发行runtime> --helper-version 1.6.25 --helper-source https://github.com/r266-tech/wechat-cli-releases/releases/tag/v1.6.25 --with-probe --output-directory <本轮独立packaged> --electron-zip-directory <本轮离线归档>`成功。ASAR只含dist及最小清单，6份资源与最终当前dist逐字节一致；CLI/WCDB原发行字节与仓库探针／核心库共4文件的哈希、arm64和严格签名通过。运行前后主包deep strict均通过，主包仅allow-jit、helper无该权限；ATS任意加载false，无新增相机／麦克风／蓝牙声明。
- 同一包在10:40–11:00有限`test:app`窗口实际执行 `assistant-native-lifecycle.spec.ts`：1／1、14.4秒（runner14.7秒）／exit0、两次启动。小窗close继续、quit持久化中断、旧完成保留、迟到无效、同目录重开模型delta0及明确retry delta1全部保持，受控模型共4次；不是外部模型质量冒烟。
- `finder-package-acceptance.spec.ts`在同一有限入口预留1次真实Finder启动，由主Agent CUA实际双击最终`.app`。公开管理／配置页面显示`notalone://app/`资源、本机服务已连接、机器环境已就绪及配置的绝对Python；打开／隐藏输入小窗后，从公开菜单退出。认证HTTP running、App／后端PID退出及握手移除均核对；默认userData只整体暂存、不读取原文件，退场后原目录dev/ino恢复。完整复验 **1／1、约2.1分钟／exit0**，实际1次启动；此前约5.3分钟的一场因Root回执未赶上3分钟等待而exit1，操作与清理已完成但不算整场通过。仅协调等待改为5分钟，全场8分钟及原预约截止仍优先。
- 本轮合计4次实际App启动（包内生命周期2＋首次Finder1＋完整Finder复验1），未再启动。纯合成Finder目录保护2／2、完整TypeScript、默认安全40／40（12.744秒、不运行App）、diff及相对链接检查通过。两轴初评同一P2的未知后端清理问题已修正，复审0；最终证据另做两轴只读核对。
- Root新PG连接检查3份精确自有随机库均不存在，记录的6个自有App／后端PID均不存在，原目录身份恢复，测试userData／夹具／暂存目录无剩余，App与页面租约absent。原配置文件内容未读取，不修改业务库、TCC、权限或已安装App。没有真实微信、OCR、外部模型、聊天发送、push或部署。

产物：`desktop/artifacts/final-package-20261012.IgUojn/packaged/NotAlone-darwin-arm64/NotAlone.app`；归档`desktop/artifacts/final-package-20261012.IgUojn/NotAlone-macOS-arm64.zip`（140254252 bytes，SHA-256 `b7fdfbc3b6f9983282210c25ff88ff9902fc6bd943e3bbb56c850cd16c79acea`，ZIP完整性通过）。CLI发行许可／说明随归档同级保留；不声明缺失的WCDB构建／许可已完整。

[无敏感验收摘要](../../unfinished-work/final-package-finder-20261012.json)保存固定源码、实际命令、通过与失败分场、清理及完整交付边界；原始CUA画面、测试库名、PID和临时路径不提交。本包为**本机ad-hoc签名**，没有Developer ID／公证分发验收；源App旧结论、旧包及本次同一包结果分别保留。用户指定的这两项收尾完成，其余原20依赖继续按原范围处理。

## Comments

- 2026-10-12（实际键盘协调补正）：用户在上一场结束后回复“没有出现”，随后明确按键时App“已经退出了”；该反馈不能作为运行中的快捷键失败，也不补写旧nonce成功收据。沿既有授权再开同包最小场，最多1次启动，20分钟受限预约；人工模式窗口观察最多7分钟、反馈收据最多4分钟、整场18分钟，runner截止优先，Agent模式原限时保持。进入按键阶段后主Agent在聊天直接提示并结束当前回复，让用户及时切回桌面按键；App继续由受限runner保留，用户反馈到达时先核验PID、nonce及阶段／预约截止，超时后不再对退场App执行CUA。只调整验收协调，不新增产品功能，OCR暂停；最终真实显示／隐藏和正常退出仍须实际证据。类型检查与纯收据3／3（0.126秒）通过、真实App未包含在这两个命令中；固定`736bb65c`两轴复核唯一README旧时限缺项已修复，最终Standards硬违规／建议0、Spec新增finding0；87条相对链接及差异检查通过。本轮真实重试不因准备完成记为通过。

- 2026-10-12（继续非OCR交付验收）：用户要求沿用授权补完可自行执行项，功能冻结、OCR暂停。沿原App／HTTP、系统对话框、系统按键／剪贴板和认证停读接缝，在同一带9份许可材料的候选包补验；业务与产品代码不扩展。既有快捷键现场场要求真实用户反馈，本轮新增独立Agent操作收据模式，由主Agent CUA实际发键并核对窗口，明确`humanShortcutAcceptanceRecorded=false`，不将机器观察冒充用户认可。两种收据按actor／nonce／严格字段区分，冲突模式拒绝；先做纯Node合成协议检查，再在有限`test:app`窗口执行。新包的首启配置、复制、同步开关／恢复／退出与生命周期按既有公共场景补证；外部模型质量、真实微信及OCR原范围不因合成验收扩大，完整票及原AC暂不改变。每场记录精确自有资源并复核清理，原包、旧失败与人工验收历史保留。

- 2026-10-12（用户要求最终签名包／Finder收尾）：新增功能冻结，OCR继续暂停；用户明确要求本轮连续完成、无需反复授权。限定实际启动在10:40–11:00、最多6次，仅合成资料与随机测试库。基点`b6fed39f`的当前源码离线重建本机arm64 ad-hoc包，采用此前核验的官方CLI 1.6.25原字节及仓库探针；新包递归严格验签与随包哈希通过。包内持续会话生命周期实际1／1、14.4秒（runner14.7秒）／exit0、两次启动，完整关闭／退出／重开／显式重试通过。Finder实机仍待，其他缺项及原四条验收保持。

  必要验收接缝补充为主Agent的Finder桌面打开 → 最终包 → 配置的绝对Python → 真实隔离PG：只在有限`test:app`活租约内计入一次外部启动，由CUA执行真实Finder打开及App公开控件；不以`open`命令代签Finder。默认userData若已有资料，只核验目录元数据并整体暂存，不读取内部文件，再在默认位置创建自有空测试目录；App／后端正常退场后按dev/ino恢复原目录。目录被替换、App未退场或恢复不确定时保留原备份／测试库／租约，不删除或终止未知资源。两项纯合成隔离保护检查实际先缺入口red，再green，完整类型通过。两轴初评各发现同一P2：查询异常／缺握手不能证明后端退场；已改为signal0仅ESRCH证明退出，放行Finder却未取得backendPid时一律保留现场，复审两轴0。新增内容只在测试夹具，不增加产品功能、权限或渠道读取。

- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。

- 2026-10-09（依赖阶段静态准备）：15/17已resolved，10/18及原生桌面验收继续待完成。root仅准备CLI构建输入与签名选择源码：新session安全政策加入硬编码Core清单，build_cli.sh默认明确ad-hoc、仅显式签名身份，不扫描私人证书。未执行脚本、构建包、签名或App。现打包仍缺完整可追溯wechat-cli/WCDB输入；用户绝对目录及版本来源请求待答，不能用合成CLI充当正式helper。外置旧probe仍可能沿后台三参数取整窗，最终受控helper须在执行前验证完整可信产物，不能运行未知probe探测能力或回退旧捕获。当前仅静态准备，20保持open、原依赖图不变，不写Answer或勾验收。

- 2026-10-09（上述静态准备验证）：实际命令zsh -n native/macos/scripts/build_cli.sh、git diff --check与二十任务字段/DAG/链接辅助检查均通过，仅解析脚本与仓库文档，没有执行build_cli.sh、codesign或任何原生程序。数据处理范围未增加，不读取聊天、帧、钥匙串或模型凭据；完整包/外置probe可信门禁与最终实机仍待。

- 2026-10-09（当前授权范围收尾）：原集成树停在 `194fab9`，后续源码与记录留在任务10树；已用 `git merge --ff-only d6a3e6ae398f084d794e2eec54f9084cf55f3e72` 无冲突整合到 `codex/mac-desktop-app`，保留工作树及全部历史，未改默认 main、未推送。受影响页面验证共 43/43，其中本次新增执行 23 场、保留等价源 20 场；类型检查、构建、`npm test` 安全调度 24/24、任务字段/DAG/链接检查通过。精确库及清理证据、固定增量双轴报告已保全于 `desktop/artifacts/acceptance-closeout-d6a3e6a`。

  本次执行（均在 Conda NotAlone、真实隔离 HTTP/PG、单 Chrome 范围内）：
  - `npm run test:pages -- --case reply-evidence --case message-events --timeout-seconds 300`：14/14。
  - `npm run test:pages -- --case import-submit-acceptance --case draft-rewrite --timeout-seconds 300`：5/5。
  - `npm run test:pages -- --case candidate-copy --timeout-seconds 300`：4/4。
  - `python /tmp/notalone-app-context.p9MPie/closeout-verify.py`：43 个精确测试库均不存在，页面/清理证据通过；脚本副本随上述本地产物保存。

  用户在本次交接中澄清 CLI/WCDB 完整目录及版本来源“没准备好”，不再视为待答或已备齐。20 保持 open/needs-info，10/18 仍未完成；真实 Electron、签名/打包、系统输入、剪贴板、微信及真实模型继续暂停。后续须先提供完整可追溯 helper 输入并完成18可信定位与20隔离验收准备，再安排具体原生时段。只处理合成资料，未迁移业务库、未访问私人数据、未启用外部 tracing 或发送消息。


- 2026-10-09（后续用户认可的有限桌面时段）：在 `032d70f` 源码树，用户确认长时段后限定 22:58:43–23:58:43（UTC+8）、最多两次启动，仅运行窗口与资料展示各一项。源码 Electron 实际 2/2 通过（9.8 秒），夹具正常清理且预约租约 absent；记录及确切命令见 [有限桌面验收](../../observation-model-smoke/acceptance.md#后续有限桌面验收)。该许可仅覆盖本轮两项，不解除其他任务暂停或扩大微信范围；未运行最终签名包、微信、剪贴板及系统文件选择。任务 20 仍 open/needs-info，完整 helper 与任务 18 等前置条件未因此完成。


- 2026-10-10（真实微信前置梳理）：用户要求先补可直接完成部分。固定4654aec构建桌面arm64 ad-hoc包并通过递归严格签名；仅前端资源，不含wechat-cli/WCDB，因此不是完整交付。同步构建本仓库探针／核心库并校验签名，未运行App或微信。PATH／项目helper配置／默认桌面启动配置均未找到可用CLI入口，只核查既有位置不扫描其他个人目录。完整可追溯CLI/WCDB仍需提供，随后补随包集成。已明确手工确认绑定的CLI同步不依赖OCR，首轮可用隔离库、单联系人和禁用模型的路径；未配置或启用真实同步。详见[前置核查](../../observation-model-smoke/acceptance.md#2026-10-10真实微信验收前置核查与已补齐项)。20保持open/needs-info。

- 2026-10-10（目标模式：重复核查准备）：用户要求继续自主推进并按完成结果优化下一步。将既有完整 helper 输入检查整理为公开 `npm run check:helpers` 接缝；只接受显式绝对目录、版本声明、公开 HTTPS 来源与目标架构，检查固定 CLI/WCDB 和 Mach-O 声明的目录内依赖、文件类型、SHA-256、架构及严格签名。未知来源不试运行，外部依赖/符号链接不自动追读，版本声明不当作实测版本；输出明确静态通过不等于渠道或 App 验收。此工具是原票前置核查的必要实现选择，不决定随包布局或运行时接口、不改依赖图；完整输入缺失，本票保持 `open / needs-info`，不勾原验收项。

  公开 CLI TDD：缺命令 red → 参数拒绝 green；脚本冒充 CLI red → 格式拒绝 green；完整合成 Mach-O 运行时 red → 静态通过 green；动态库改名 CLI 原先错误通过 red → EXECUTE/DYLIB 类型核对 green。6 项具名检查包含缺依赖、越界链接、错误架构、损坏签名和参数/输出脱敏，全部通过。`npm test` 类型及 30/30 安全检查通过（原 24 项 + 6 项），`git diff --check` 通过。只用临时合成 C 文件和自有签名夹具，逐组精确清理；没有运行生成二进制、Electron、微信、探针、数据库、模型或读取私人配置。固定基点 `04404be`，两轴评审及本地提交随后补齐。

- 2026-10-10（静态核查两轴修复）：初版固定提交 `85f42784de74f37206e85fb172a0b71a94d10759`，Standards 硬违规/可选建议均 0；Spec 发现 P1：外部或未知 RPATH 被跳过，有内部副本时可能错误静态通过。公开 CLI 合成回归先复现错误退出 0，再改为保守拒绝外部/未知搜索候选；搜索候选的符号链接同样不跳过，不读外部正文。新增真实 Mach-O 搜索顺序两场（首个外部路径/未知前缀，随后内部路径），7 项核查组通过；最终安全组与增量复核随后补齐。本票完整输入与现场条件仍缺，不提前关闭。

  修复后最终 `npm test` 的类型检查和 31/31 安全检查通过（24 项调度 + 7 项静态核查）。未因文档维护重跑模型、数据库、普通页面或原生 App；继续只构建/签名自有合成 C 文件，生成二进制未执行，精确临时目录正常清理。

- 2026-10-10（静态准备评审收口）：固定增量 `85f42784de74f37206e85fb172a0b71a94d10759 → 6a3efcdfad0412d8c989be2ddc111b2fcf355db3` 独立 Standards 硬违规/判断建议 0/0，Spec 新问题 0，原 RPATH P1 已关闭。评审只读，不新增执行。此结论仅关闭核查工具的实现与修复；完整真实输入、随包接线及最终原生验收仍缺，本票继续 open/needs-info，原依赖和验收条件保留。

- 2026-10-10（用户要求继续：随包接线切片）：重新核对后，正式输入缺失不阻止用合成 Mach-O 实现 CLI/WCDB 的受控搬运和默认启动路径。继续本票内的必要实现：公开 `prepare:helpers` 只拷贝静态核查通过的固定文件/声明依赖，保留相对布局、哈希及未核验版本/来源声明，搬运后复核；`package` 仅在显式目录/版本/来源参数齐备时纳入 `Contents/Resources/notalone-helpers`，不扫描 PATH 或用户目录。Finder 启动在没有明确配置时使用包内已核验 CLI；显式配置保持优先，包内文件缺失/变化时不可用，不加载未知探针。本片不自动安装 helper、不修改绑定/开关、探针参数政策、权限或数据 schema；只完成 CLI 侧接线，完整探针及最终包仍按原条件验收。测试接缝是公开准备 CLI 与现有启动诊断 `getPaths`/后端启动环境，只在 Node 和自有合成文件运行，不启动 App/Python/微信。Context7 不可用，已核对官方 Packager extraResource、Electron resourcesPath/isPackaged 与安装版本 20.3.0/44.7.0；签名跳过已核验输入以保留原二进制，不注入 Electron JIT entitlement，主包签名和最终严格核查保留。先逐片 red → green，不新增任务或关闭本票。

  准备命令不存在时实际 red（退出 1 而非 0），实现后同一公开场景 green；启动诊断原先返回空 CLI 路径形成第二个 red，最小默认值接线后 green。覆盖源目录移除后仍可取得包内 CLI、字节变化、缺库/越界链接/重复清单停用、显式配置优先；搬运拒绝已有目标和不能迁移的绝对依赖，失败后自有半成品清理、已有文件保留。绝对依赖夹具初次用 install_name_tool 修改失败，不算产品 red；改为链接时声明真实绝对依赖后完成实际拒绝检查。`npm run typecheck`、`npm run build`、Node 三个脚本语法检查与 `git diff --check` 通过；最终 `npm test` 35/35（24 项调度、11 项 helper/启动配置）通过。未生成含 helper 的 App 或运行实际 Packager 拷贝/签名，不能称新签名策略已实测；没有启动 Electron、Python、数据库、微信、探针或执行合成二进制。仅自有 Node/C 临时文件，逐场精确清理；固定基点 d242562，两轴评审随后补齐。

- 2026-10-10（随包接线评审修复）：固定 `d242562 → 4cdbf7e`，Standards 硬违规 0、P3 重复文件集合比较建议 1；Spec P1 发现默认 CLI 经设置表单保存后被当作显式路径，短路后续完整性核验。沿公开 `getPaths → savePaths → 修改 CLI/删除库 → getPaths/启动环境` 复现实际 red；路径解析改为识别当前包内 helper 命名空间，保存值及环境值指向该组时仍核验全部文件，损坏时返回未配置路径，同场 green。外部显式路径优先不变，未执行输入或启动 Python。合并搬运、Packager 拷贝、最终包三处文件集合/哈希比较，保留各阶段检查。`npm run typecheck`、脚本语法、`git diff --check` 和最终 `npm test` 35/35 通过；增量两轴复核随后补齐。完整输入、实际 Packager 和最终原生验收仍缺，不关闭原票。

- 2026-10-10（继续仓库探针侧）：CLI 增量 `4cdbf7e → 5f1cf47` Standards 硬违规/建议 0/0、Spec 新问题 0，原 P1 关闭。继续本票的探针随包实现：公开 `prepare:probe` 只从仓库固定 7 份 Swift 源码和构建脚本创建自有快照，显式 ad-hoc 静态构建、记录来源摘要，逐文件核查与搬运；不接受外部探针目录，不运行生成 CLI、权限检查或采集。`package --with-probe` 才将此组纳入独立 `notalone-probe` 资源目录并复核；仅包内默认及指向它的配置沿现有启动路径接缝核验，外部配置保留既有优先级。`--session` 的未知布局失败关闭与后端参数不变，不扩展采集或现场授权。测试接缝为公开准备命令、`getPaths/savePaths` 和启动环境，实际 Swift 仅编译/签名，不执行；先 red → green，原票完整渠道输入及最终 App 仍待。

  公开准备入口缺失形成实际 red（退出 1），实现仓库快照构建和静态搬运后该部分 green；同一公开链路的启动诊断原先仍返回空探针，形成第二个 red，接入共享包内路径核验后完整场景 green。保存后损坏核心库时返回未配置路径；环境值指向损坏组同样拒绝，恢复文件后重新可用，外部显式配置保持优先。已有目标和外部输入拒绝，重复打包开关在图标/打包/编译前拒绝；未执行 Packager 生成新包，不能称其新 hook 或签名策略已实测。`npm test` 类型与 37/37 安全检查、`npm run build`、Node 脚本语法、`zsh -n` 与 `git diff --check` 通过。只编译/签名仓库 Swift 与自有合成 C 文件，临时源码、模块缓存和产物精确清理，未运行任何生成二进制、App、Python、数据库、微信或模型。固定基点 5f1cf47，两轴评审随后补齐；本票仍 open/needs-info。

- 2026-10-10（探针构建评审修复）：固定 `5f1cf47 → 30e634c`，Standards 硬违规 P1 1、可选建议 0，Spec P1 1，均指向构建 zsh 仍可能读取用户 `.zshenv`；前版清空环境不能证明未继承启动配置。将本票测试接缝补到必要的 shell 进程适配边界：生产构建调用共用 `repositoryBuildInvocation`，用本轮合成脚本/`.zshenv` 实际调用系统 zsh，red 阶段显式把配置目录指向自有目录，不接触真实个人文件；哨兵原先被执行形成实际 red。加 `-f` 和自有 `ZDOTDIR` 后同场 green，签名身份和模块缓存保持本轮固定值；不修改 HOME。完整安全组及增量两轴复核随后补齐。未改变探针参数政策、数据范围或现场验收条件。

  修复后 `npm test` 类型与 38/38 安全检查通过（24 项调度 + 14 项 helper/启动配置），包括实际仓库 Swift 重新构建/签名/搬运与 shell 哨兵拒绝。`node --check desktop/scripts/prepare-probe.mjs`、`git diff --check` 通过；未因构建工具修复重跑 App、普通页面、数据库或模型，临时夹具和编译缓存正常精确清理。

- 2026-10-10（本轮实现评审收口）：固定增量 `30e634c → a197b38` Standards 硬违规/建议 0/0、Spec 新问题 0，原 shell P1 两轴均关闭。CLI 保存路径 P1 在先前 `4cdbf7e → 5f1cf47` 已关闭；本轮两组构建/搬运/默认路径实现及修复完成。只读评审不新增运行。原票仍 `open / needs-info`：真实完整 CLI/WCDB 与来源、实际 Packager 及新最终包、Finder/权限/复制/微信等现场证据和 10/18 依赖尚缺，不勾原验收项。总清单据此调整下一步，不自动安装 CLI，不扩大用户已确认的数据或桌面范围。

- 2026-10-10（目标续跑：离线构建验证）：复核当前源码，Packager 拷贝 hook/签名保留仍只有静态证据，但可以在自有目录用合成 CLI 和仓库探针验证构建，不需要现场或正式 CLI。继续原票公开 `package` 命令接缝：增加显式离线 Electron ZIP 目录和不存在的输出目录，避免联网、覆盖历史产物或启动 App；沿生产 Packager 实际复制两组文件、签名及严格核查，再从实际包 Resources 调用现有 Node 启动诊断/环境。检查包使用当前编译资源和合成 CLI，不作为正式渠道交付，不操作 Finder/权限/微信/剪贴板。显式 `test:package` 只构建检查包，普通 `npm test` 继续排除 App 包构建；先公开命令 red → green，原依赖与现场验收保留。Context7 无可用工具，已核对 Packager 官方 electronZipDir/out 约定及安装 20.3.0 源码：指定 ZIP 目录时不进入下载分支，缺档直接拒绝。

  实际公开打包命令先因新参数未支持退出 1，形成 red；接入独立输出/离线 ZIP 后第一次实际构建因夹具归档带入 AppleDouble 元数据导致 framework 严格签名失败，改为 `ditto --norsrc` 修正自有 ZIP，未修改签名规则或已安装 Electron。最终 `npm run test:package` 1/1 通过（23.943s）：真实 Packager 复制两组、原 CLI 字节保留、manifest 哈希、各文件与主包严格签名、helper 无 JIT entitlement、实际包 Resources 下 Node 路径及环境均通过，且已有输出拒绝/保留、缺档失败后自有输出清理。生成包和输入从未执行，临时包/ZIP/编译缓存精确清理，没有访问数据库、微信、模型、TCC 或系统输入。

  曾用名称过滤排除构建用例但实测未生效，导致默认组也构建检查包并通过 39 项；该轮不算默认无构建证据。评审阶段将构建用例移至独立 `tests/packaging/command.test.mjs`、共享合成 C 夹具，默认入口恢复固定安全文件列表。最终 `npm test` 类型及 38/38 通过（8.634s），输出中无构建用例；脚本语法、`git diff --check` 通过。仅构建工具/测试接线变化，不重跑已通过的页面、真实 App 或后端业务；固定基点 ea317cf，双轴评审随后补齐。本票完整真实输入与现场依赖仍缺，保持 open/needs-info。

- 2026-10-10（离线构建评审收口）：固定增量 `ea317cf → 5d980fc` 独立 Standards 硬违规/建议 0/0、Spec 新问题 0。两轴确认独立输出的独占创建/身份核对清理、离线固定版本归档检查、两组搬运/最终核查及默认测试与显式构建测试的隔离符合原范围；只读评审未新增执行。实际合成包构建已有证据，剩余条件优化为正式 CLI/WCDB 来源与输入、正式输入包、10/18 依赖及有限时段下的 Finder/权限/复制/微信等原生验收。本票继续 `open / needs-info`，四项原验收不勾选；总清单同步本轮证据与下一步，不扩展数据、外部调用、桌面或远端 Git 授权。

- 2026-10-10（用户授权自行查找输入）：用户明确答复“你可以直接找下吧”。从仓库记录的维护者查到当前官方源码 `r266-tech/wx-cli` 与其指向的发行仓库 `r266-tech/wechat-cli-releases`；旧仓返回 451，当前发行仓库无历史 v1.6.20，采用其非预发布 v1.6.25 作为待验证输入，不迁移至 v2 RC。已下载固定 arm64 ZIP、checksum、manifest，三者匹配 GitHub API 摘要，CLI/WCDB 字节及组件 SHA-256 匹配，公开静态核查通过。只从归档提取必需二进制与许可证/说明，未执行安装器、wxkey、CLI 或初始化，不读取私人资料；WCDB 版本及构建时间在上游 manifest 中为 unknown，来源与运行可用性仍分开记录。

  核对旧依赖修复票 09 与现行启动配置时，发现包内 CLI 未显式固定 WCDB 库，且整份环境继承可能保留指向外部库的覆盖。继续原票受控启动接缝的必要兼容修复：测试沿既有公开 `loadBackendConfiguration → backendEnvironment` 和 Node `getPaths/savePaths`，合成环境只声明自有外部库路径，验证包内选择固定已核验库、损坏组停用且不保留覆盖、外部显式 CLI 仍保持其配置优先。先 red → green；不运行任何 CLI/库，不改变绑定、权限或后端领域接口。随后用取得的固定发行输入离线重建候选 App，只构建/签名/静态检查，最终原生/微信及原依赖仍未完成。

  实际公开 Node 场景先因 `WECHAT_CLI_WCDB_LIB` 为 undefined 而失败；整组解析同时返回受控库位置后同场通过。进一步合成检查四个覆盖清理、保存后仍固定库、损坏后无覆盖及外部配置优先，直接通过；没有把后续断言写成未运行的 red。最终 `npm test` 类型及 38/38 通过（13.134s）、`npm run build` 通过。实际生产打包命令使用固定输入与 `--with-probe`、独立输出、已安装 Electron 构造的离线 ZIP，通过签名及随包复核；在实际 Resources 下运行 Node 检查，四文件哈希/严格签名、主包 deep strict、原 CLI/WCDB 的上游组件哈希、包内路径及四个库覆盖隔离均通过。

  候选产物为 `desktop/artifacts/helper-upstream-20261010.onrvwc/packaged/NotAlone-darwin-arm64/NotAlone.app`；`candidate-verification.json`、`download-verification.json`、原 ZIP/checksum/manifest 与 `package.log` 同目录保留。发行包所附 CLI LICENSE 和 THIRD_PARTY_NOTICES 保留在候选 `.app` 同级目录；稳定包未提供完整 WCDB 版本/许可集合，不宣称重新分发材料完整。仅这次任务自有忽略产物保留供后续有限验收，不覆盖现有 App；临时 Node 检查目录与离线 Electron ZIP 已精确清理。未执行下载二进制、wxkey、安装器或 App，不初始化、读取聊天、改密钥/Keychain/TCC，也未调用模型。CLI 版本迁移的只读/事件契约、WCDB 精确来源、10/18 与现场验收继续待；本票仍 open/needs-info，四项验收不勾选。固定基点 a7bb6a0，双轴评审随后补齐。

- 2026-10-10（官方输入与库环境修复评审收口）：固定 `a7bb6a0 → c48d59b`，独立 Standards 硬违规/建议 0/0、Spec 新问题 0。两轴确认仅已核验包内组返回 WCDB 路径，失效组仍触发覆盖清理，外置显式配置保持原环境；沿用旧票 09 的库注入要求，未以候选构建替代运行冒烟。只读评审未新增执行。49 条本地文档链接、总清单 8/3/4 分类、原票 open/needs-info 与四项未勾核对、`git diff --check` 通过。本票继续未完成，稳定版契约/WCDB 来源、10/18 和现场证据保留；只做本地提交，不上传二进制或私密数据。

- 2026-10-10（继续稳定输入契约与 WCDB 来源核对）：用户要求无需人在场先推进，真实微信/原生继续暂放。稳定 CLI 的 Go build info 与发行 commit 一致；WCDB 的 LC_ID 为 2.1.15，SQLite/SQLCipher 字符串与腾讯固定源码吻合，但官方资产只含源码而无对应 WCDB 二进制，且库的版本函数为 Custom build，不把线索升格为可复现来源。取得官方源归档并核对 API 摘要，定向保留许可及版本材料；稳定 ZIP 的 README、llms.txt、manifest 生成脚本按声明哈希核对。旧源码有限公开路径仍不可取得，不采用 v2 RC 补证。

  在自有目录先验证 OS 默认拒绝的五项边界：目录外读写、网络、其他程序执行、Keychain 服务查找均被拒绝；初始 `/bin/cat` 被 dyld 拒绝启动，核对本机 Apple `dyld-support.sb` 后只补齐加载规则，合成 canary 全部通过。随后该隔离内执行稳定 CLI 的 version/tools/schema/help 元数据命令，版本 1.6.25、38 项 schema 与 tail 参数声明返回；未执行 App/安装器/wxkey 或读取真实微信。合成 tail 数据调用因环境未定义 HOME 返回失败，不能记为数据读取/纯只读初始化已验证，不修改或重定向 HOME。

  同字节 schema 确认 `read_events` 的 `include_media_paths` 默认 true；当前 v1 文字同步不能依赖严格只读来代替关闭媒体补齐。继续受控参数修复：沿既有 `LocalWechatCli` 的 CommandRunner/FollowProcessRunner 公开接缝，逐个 red → green 固定一次性 tail、单会话 follow、全局 sessions follow 的 `--include-media-paths false`；不按文字类型过滤而丢失非文字计数/游标，不扩展接口或新建任务。稳定版元数据只证明参数声明，缺配置的失败不证明实际消息行为；不支持参数的外置版本按现有命令错误失败，不能静默退回媒体默认。原票四项验收及原依赖仍待。

  实际三个公开命令断言分别因缺少关闭参数 red，再各自 green；baseline/cursor 的已有命令断言同步更新后直接通过。Conda `NotAlone` 内运行 `python -m unittest tests.unit.wechat_cli.test_adapter tests.unit.wechat_cli.test_global_session_stream tests.unit.wechat_cli.test_normalizer tests.unit.front_sync.test_cli_background_sync -v`，75/75 通过，包括非文字计数/水位、全局只投影定位信息、已确认范围、关闭/恢复与失败降级；`git diff --check` 通过。只处理公开资料和合成数据，未连接数据库、外部模型或真实微信；没有重跑已通过的桌面构建组。固定本轮基点 `7b46360`，Standards/Spec 复核待补。

  原始证据保留于 `desktop/artifacts/helper-provenance-20261010.GT1GQm/`：腾讯官方 `wcdb-2.1.15.zip` 为 83197863 bytes，SHA-256 `5b7294459f7f8b85ce373fcd5f3d7a3c004743feb9d51d3c39096a0815834c56` 匹配发行 API；`download-verification.json` 记录首次超时及断点续传结果，`provenance-evidence.json` 记录 CLI/库静态证据、9 份定向材料哈希和执行边界。`sandbox-boundaries.json`、四份 stable 元数据 JSON 与两个失败 tail JSON 保留；临时 canary 可执行文件及合成读写夹具精确清理，保留 canary 源码/profile 供复核。研究笔记与目录在忽略的 `research/` 同步，不强行提交。

  本轮有限官方路径已核对：维护者现行新仓历史从 v2 开始、精确稳定 commit 不可取、发行 tag 只有 README、Go 官方 proxy/checksum 同版本查询失败。下一步条件是取得绑定原字节的稳定 CLI 源码和 WCDB 构建/许可材料，或在明确范围内补初始化/实际事件/游标/JSONL 警告证据；不以重复下载同一源码归档、RC 源码或普通页面代替。需要人在场的真实渠道、Finder/文件选择/快捷键/剪贴板/退出与 10/18 依赖继续暂放；本票仍 `open / needs-info`，四项验收不勾选。

- 2026-10-10（稳定来源补查与媒体参数修复收口）：固定 `7b46360 → 65cfe8f` 的独立 Standards 硬违规/判断建议 0/0，Spec 新问题 0；两轴确认三个入口沿既有进程接缝关闭媒体补齐、保留非文字计数及水位，且文档没有把 schema/HOME 失败/版本线索记为渠道或精确构建验收。两轴只读未新增运行。147 条本地链接、总清单 8/3/4 分类、本票 open/needs-info 与四项未勾、夹具精确清理及 `git diff --check` 通过。评审副本保留在上述自有忽略目录的 `review-results.json`；来源缺口和现场条件保持，只做本地提交。

- 2026-10-10（用户要求继续：签名临时文件清理）：核对上一轮自有候选构建目录，发现 250 个 `tmp-entitlements-*` 残留，不能按此前“临时检查目录已清理”推导签名材料也全部清理。安装的 `@electron/osx-sign 2.7.1` 与官方类型/源码均确认：entitlements 数组会为每个签名文件创建系统临时目录；路径参数可复用已有 plist。继续原票公开 `package` 命令与既有 `test:package` 接缝，以一次 red → green 验证命令返回后本轮临时文件清空、调用者既有文件保留、App 仍只含 allow-jit 且 helper 不获该权限；不增加参数、权限或来源声明，不运行 App/CLI/探针、数据库或模型。旧候选保持原字节，旧残留只在逐项核验自有普通 plist 后精确清理；本票四项验收和依赖不变。

  沿已约定公开 CLI 接缝，给打包子进程单独的自有 TMPDIR，并预置不应删除的目录/哨兵；命令成功返回后的残留断言实际 red（250 !== 0，27.231s）。改为 staging 内单份 plist 路径后，同一 `npm run test:package` 1/1 green（26.095s）：本轮临时文件为 0、哨兵保留、主 App entitlement 精确等于 `{allow-jit: true}`，两组 helper 哈希/严格签名/无 JIT 与 Node 包内路径通过；占用输出保留和缺离线归档失败清理仍通过。主 App 及生成 helper 从未执行，临时检查包/ZIP/编译缓存随夹具 finally 清理。未覆盖旧候选包，不需要因这次构建清理改动重建已保留的官方候选。

  Context7 不可用，已对照[官方类型](https://github.com/electron/osx-sign/blob/main/src/types.ts)与[签名实现](https://github.com/electron/osx-sign/blob/main/src/sign.ts)，再核对安装的 2.7.1 类型和数组转临时文件路径源码。旧残留先记录每个自有目录 dev/ino、文件集合与 SHA-256（250 份均为同一仅 allow-jit plist），再次核对后逐文件 unlink、逐目录 rmdir，不用全局或递归删除；旧候选四运行时哈希未变。证据保留在 `desktop/artifacts/package-cleanup-20261010.Tp699L/` 的 `red-result.json`、`green-result.json`、`previous-residue-inventory.json` 和 `previous-residue-cleanup.json`；固定本轮基点 `e23812f`，最终安全组及独立双轴复核随后补齐。

  最终 `npm test` 类型检查和默认 38/38 安全组通过（10.457s），该命令未构建 App；显式构建验证仍只记为 `test:package` 1/1。`git diff --check` 通过；没有为打包脚本改动重跑不相关的 Python/数据库/模型或原生组。安全组日志 `safe-result.json` 保存在同一自有目录。只处理公开编译资源、仓库源码和合成资料，未增加权限、读取范围、外部模型或远端 Git 操作。

- 2026-10-10（签名临时文件修复收口）：固定 `e23812f → 9f77aa3` 独立 Standards 硬违规/判断建议 0/0，Spec 新问题 0。两轴确认 staging 内 plist 内容和权限不变、现有 finally 清理、公共命令接缝与证据一致，没有新增执行能力或把构建当作现场验收。评审只读未新增运行，结果副本保存于本轮自有忽略目录的 `review-results.json`。4 份改动文档的 56 条本地链接、原票 open/needs-info 与四项未勾、总清单 8/3/4 分类及 `git diff --check` 通过。下一步仍按精确上游材料、有限现场时段、模型预算或资源关联条件推进；不重复已通过构建或新增无需求工具。

- 2026-10-10（本次有限复制／调度时段）：任务 10 在源码 App 中完成真实系统剪贴板与输入小窗隐藏／恢复；本票保留的官方输入候选 App 首次以独立配置通过统一 test:app 启动，管理窗口就绪后按短预约到期收尾，runner 预期退出 124、自有 PID/userData 回收、租约 absent。该路径不是 Finder 启动，后端未连接、CLI／探针不可用；没有初始化或运行微信渠道，不构成完整包复制、文件选择、快捷键、权限或产品停读验收。任务 10 已收口，任务 18 及本票来源／数据／最终系统验收继续未完成；State 保持 open/needs-info，四项原验收不勾选。证据见 `desktop/artifacts/native-copy-scheduling-20261010-1500/`。

- 2026-10-10（第二次有限现场：签名包原生能力补验）：用户“现在就可以”授权当前现场后，明确 15:23–15:43（UTC+8）、最多两次启动。保留的官方输入候选包实际完成 `candidate-copy.spec.ts` 1/1（5.8 秒）与 `native-desktop-acceptance.spec.ts` 1/1（3.8 分钟），总 2/2、runner 退出 0；后者沿既有 App/HTTP 公共接缝使用生产系统文件选择器，选择本轮单联系人合成 JSONL，真实隔离 HTTP/PG 完成 6 条消息及全部导入任务核验。外部模型由本地合成模型替换，不能据此宣称语义质量达标。新增验收场景仅显式 flag 启用，默认全量跳过，不调用快捷键回调或替换对话框。

  用户物理 `Command+Shift+Y` 第一次唤起并确认“小窗出现了”；程序观察第二次阶段同一窗口隐藏、仍为两个窗口，随即正常菜单退出。用户反馈“不行了，现在小窗都不能呼出来了”，与 15:30:34 的退场核查及当前 PID 不存在的记录相符；这是时序解释，不把程序状态写成人工认可隐藏体验。测试原先未提前说明确认隐藏后会退出，现只补明确提示，未因提示修改重跑真实 App。启动额度已全部用完；快捷键退出后注销，现场隐藏体验仍待下轮确认。

  实际命令（Conda `NotAlone`，`desktop/` 下）：`NOTALONE_NATIVE_DESKTOP_ACCEPTANCE=1 NOTALONE_TEST_APP_EXECUTABLE=/Users/local-user/learn/NotAlone/desktop/artifacts/helper-upstream-20261010.onrvwc/packaged/NotAlone-darwin-arm64/NotAlone.app/Contents/MacOS/NotAlone npm run test:app -- --interactive --coordinator main-agent --from 2026-10-10T15:23:00+08:00 --until 2026-10-10T15:43:00+08:00 --max-launches 2 --output artifacts/native-system-20261010-1523/results -- tests/candidate-copy.spec.ts tests/native-desktop-acceptance.spec.ts`。源测试输出、精确资源归属及程序结果保留在 `desktop/artifacts/native-system-20261010-1523/`，人工反馈另记 `verification.json`。末次自有 PID 已退出，userData/夹具目录已清理，`test:app:status` 为 absent；库由自有夹具正常退出清理，未另做 PG 目录查询。只处理合成资料，未读取原私人剪贴板；系统文件选择器初始默认目录展示文件名，但未打开其他文件。

  Finder 仍缺与最终包匹配的受控隔离启动路径，不能通过启动默认业务配置冒充验收；微信测试会话虽已准备，现有最小采集生产路径仍缺，CUA 全窗/整棵 AX 及旧整窗后裁剪均不在允许范围，本轮没有读取微信。WCDB 精确构建/许可、初始化/真实同步、定位/权限与退出停读仍缺；State/Triage、原依赖及四项验收全部保留。最终签名/类型/安全检查与独立两轴评审随后补齐。

  补提示后的 `npm test` 类型检查及 38/38 安全组通过（10.65 秒），没有再启动 App 或重跑原生组；候选包实机前后 `codesign --verify --deep --strict --verbose=2` 均通过，`npm run test:app:status` 再次 absent。4 份改动文档的 65 条本地链接、总清单 13 项（讨论8/实现3/验收2）、本票 open/needs-info 与四项未勾、`git diff --check` 均通过。分开的用户反馈和末次自有资源只读复查已写入上述忽略目录的 `verification.json`，独立双轴复核随后补齐；未新增权限、私人数据、模型预算或远端操作。

  固定 `8af1e8e → af273be` 初评 Standards 硬违规/建议 0/0；Spec 指出 P2：原生结果的 `systemShortcutHide: true` 只根据窗口不可见，不能证明隐藏来源。已改为 `helperShownObserved`/`helperHiddenObserved`，并明确 `humanShortcutAcceptanceRecorded: false`；机器结果不代替用户反馈。原运行 JSON 不改写，`verification.json` 另说明旧字段仅表示窗口状态；只修正证据字段及提示，没有再次启动 App，类型检查与增量复核随后补齐。

- 2026-10-10（用户继续：人工验收反馈收口准备）：原流程观察到隐藏就退出，用户反馈来时 App 已停止，影响人工验收。只修改本票既有原生场景的配合流程：显示/隐藏各在状态观察后生成随机请求并等待协调者依据对应用户反馈写入布尔收据，两次明确确认后才写入人工验收结果并正常菜单退出；缺失、否定或非法收据不通过，不根据窗口状态自动确认。响应仅本轮自有输出路径、普通文件、不跟随符号链接、最大 1 KiB，旧请求不能复用；每步反馈最多 90 秒、单场 8 分钟与预约截止优先，失败继续自有夹具/门禁收尾。没有改产品功能、后台数据/权限、公共 App/HTTP 接缝或依赖图，也没有新增自主 Harness；这只是原人工场景的必要协调 I/O。现不再次启动 App，新流程实际现场仍待新的有限预约，原 2/2 历史记录与隐藏未确认不变。本票仍 open/needs-info、四项原验收未勾；最小类型/静态检查及两轴评审随后补齐。

- 2026-10-12（其他App前台焦点分项准备）：用户确认继续补焦点及记忆评测方案，允许并发准备；主Agent独占真实桌面，新增功能冻结、OCR暂停。新增独立focus场沿原公开窗口／注册／系统键盘／菜单接缝，不重复导入业务；同一签名候选包、空隔离启动配置，Python与项目路径缺失，CLI／探针不存在，验证后端尚未连接。管理后台先隐藏，主Agent在自有空白Finder窗口实际置前后写独立Agent准备收据；另两组nonce只由实际输入actor产生，程序记录不能代签用户。记录同helper显示及focused、第二次隐藏、manager仍隐藏、窗口身份及正常退出；不将原规格没有要求的“必然恢复外部App焦点”新加为产品门槛。共享收据协调抽出复用，产品／候选包未改；类型和纯收据3／3通过，尚未运行本场App或标通过。实际时段、启动计数、原始证据与精确清理待运行后补记，原State、Blocked by及四条AC保持。

- 2026-10-12（焦点预检等待解锁）：同一候选包strict签名、ASAR／ZIP原SHA／大小及两组helper和9份来源材料离线基线已确认，test:app:status为absent，未发现存活NotAlone实例。CUA选择Finder时报告Mac锁屏、无法自动解锁，实际NotAlone启动0，没有进入预约或写任何操作收据；主Agent已请求手动解锁，未反复问授权。两个独立预审均0新增问题，仅认可准备及范围，实机仍待。自有空目录留待验收，不读取默认配置正文或微信；没有后端、OCR、模型或业务库操作，旧21场结果及全部未完成条件保持。

- 2026-10-12（锁屏等待场收尾）：手动解锁尚未确认，实际App启动保持0，没有模型／微信／业务库操作；自有空Finder目录经当前owner／非符号链接／空目录核对后rmdir清理，租约absent，不保留运行资源。准备证据与场景边界见[摘要](../../unfinished-work/mac-focus-preparation-20261012.json)，解锁后再创建新的自有目录并声明有限窗口；不是一次失败的App场，也不增加原21个完整场景。类型、纯收据3／3、候选strict和字节复核及两轴预审通过，正式焦点结果继续未签。

- 2026-10-12（其他App前台小窗分项整场通过）：主Agent沿持续授权执行两场、各最多1次且实际1次启动，产品／候选包未改。首场16:35:35–17:05:35显示分项通过，用户澄清用按钮或关窗隐藏，human-hide收据拒绝，runner exit1／767.591秒；保留失败，不认定产品快捷键故障，也不将按钮行为算成实际第二次按键。复验16:50:47–17:20:47，管理后台和小窗先隐藏，主Agent实际把自有空白Finder窗口置前并写独立Agent收据；用户两次实际Command+Shift+Y分别明确确认“小窗出现，保持显示”“小窗消失，管理后台没出现”。程序记录同一helper显示且focused、两窗最终hidden／unfocused、窗口数保持2，真人收据与机器观察分开，核对存活实例、三组不同nonce及共同截止后才写入。公开菜单退出且App exit0，**1／1、585.149秒／runner exit0**；没有认证系统必然恢复原外部App焦点。当前同包非OCR完整场景累计22个（旧21＋本场1），各场失败与旧工具事故不改写。

  Root核对两场共20个已记录自有进程退场、两个独立userData清除、空Finder窗口／目录关闭清理及两租约absent；复验前记录真实默认目录dev／ino，退场后相同，仅查元数据、不读配置正文。首场默认目录原基线未记录对应路径，身份前后认证不完整，不能代签；后场重新录基线，旧记录不覆盖。运行后主包deep strict、4helper strict／SHA、15资源文件完整集合（含9份来源材料）、ASAR及ZIP原SHA／大小保持。只观察本轮自有空Finder，导航预备时所见其他文件名及原始UI不提交、未打开其他文件；后端未配置，未执行业务库、微信／官方CLI／探针、OCR、模型、聊天发送或权限／TCC修改，退场后不再查询NotAlone的CUA。详见[焦点最终摘要](../../unfinished-work/mac-focus-final-20261012.json)，原准备启动0和历史场保留。完整票仍claimed／needs-info、四AC仅第1条勾选，WCDB精确构建／二进制许可、真实渠道／模型质量及原18依赖保持；新增功能冻结、OCR暂停。固定`e7b97d8c`独立只读双轴：Standards新增硬违规／重要建议／证据越界0，Spec新增缺失／错误／范围越界0；113条相对链接／14个锚点、202原票统计、原State／Triage／依赖／AC及历史Answer保持、准备启动0摘要和纯文档范围、`git diff --check`均核对通过。类型和纯收据3／3沿用本场准备已过结果，不新增安全／后端测试次数。只做本地提交，不push。

- 2026-10-12（真实CLI运行与退出分项、来源补核）：同一候选包新增完整非OCR场景1／1、报告1.2m／runner exit0，累计完整场景22→23。Root在自有空Finder实际置前并写独立收据后，正式线程另一次真实有界tail启动并接受，实际不要求新消息；正常菜单退出、App exit0、原认证stopped、后端及CLI消失，5秒无新增调用。首两场各启动1次的脚本失败分别保留，第三场17:51:14–18:06:14有限max1／actual1；三场20自有进程、测试库／隔离目录／空Finder／两租约收尾确认，当前新增意外启动0。默认目录身份、主包及4helper严格签名、15资源／ASAR／ZIP保持；产品和包未重建。会话列表请求被scope边界拒绝，不能代签列表初始化；真实来信、双联系人、模型质量和OCR均不代签。见[真实同步退出摘要](../../unfinished-work/mac-real-sync-quit-final-20261012.json)。[WCDB有限补核](../../unfinished-work/wcdb-provenance-followup-20261012.md)确认相同库与9材料字节，当前精确源码／Actions匿名端点451、attestation404，仅表示本次不可取；精确源码、patch、构建和BOM许可仍未取得。新增功能冻结、OCR暂停，本票claimed／needs-info、原依赖、历史Answer及AC1／4保持。
