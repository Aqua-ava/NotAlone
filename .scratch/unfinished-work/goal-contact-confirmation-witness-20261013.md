# C 原包联系人确认的测试侧被动见证（2026-10-13）

Root已明确批准仅在既有联系人共享场景的显式诊断分支增加最小测试工具，实际 App 仍只由 Root 在 `test:app` 最多一次、至多5分钟的预约中执行。本片不改产品、C包、联系人权限、确认门、原选择动作或原断言，不实施自动重试，不触私有 React Fiber／IPC handler。

已约定接缝是官方 Main localhost Node Inspector 的 CDP 协议、管理页公开 DOM／联系人状态订阅。版本、C磁盘与运行时源码（只接受完全相同或固定Node CommonJS wrapper）、执行位置不符即拒绝诊断；guard、实际throw、return只记录数字／布尔，console仅接自有nonce、最多24条。管理页只保存合成联系人序号；DOM变更与收到的状态版本分别记录，精确React数字提交版本始终不认证。关键选择间隙不追加RPC。finally只移除自有日志点／观察器／会话，不关闭现有Inspector、不清其他断点；出现paused则诊断无效并保留记录。

本片先按批准的纯协议接缝作有意义负控：错误来源／版本、错误可执行位置、paused、非本场记录和收尾失败。它们只验证验收工具守卫；不作为原间歇失败复现、产品修复或真实 App 通过证据。后续模型预算、记忆质量、微信、OCR和Mac整体验收均独立。

准备阶段快照（本段只记录子Agent准备，早于末节Root实跑）：当时纯协议与类型验证已通过，待独立两轴和Root的一次真实场次；此准备片App／桌面／模型调用0。此时真实轮次尚未运行，Root原两次isolated通过仍不能解释原C失败。原[最终C组合记录](goal-final-c-acceptance-20261013.md)与[20原票](../mac-desktop-app/issues/20-mac-app-delivery.md)不改状态或验收条件。

本片只有四个路径：[测试工具](../../desktop/tests/contact-confirmation-witness.ts)、[纯协议控制](../../desktop/tests/contact-confirmation-witness.test.mjs)、[既有场景](../../desktop/tests/contact-session.spec.ts)和本文。`NOTALONE_TEST_CONTACT_CONFIRMATION_WITNESS=1`才连接现有Main Inspector并装配管理页观察器；默认路径没有新Inspector连接、观察器或App启动入口。设置发生在草稿／隐藏恢复／A→B→A序列之前，结束或原断言失败后收尾。关键的管理页恢复→选择B→等待管理页显示B之间没有新RPC或重试。原场景已有的合成截图、状态订阅和末尾观察收据保持原样；本工具不增加视觉帧。

C编译Main固定SHA-256为`2bc46df820508fbc193961061c412c6e27853b38939f5de0d45b653c6bd75be2`，CDP零基原语句为126／127／134（guard／实际throw／return）。磁盘摘要相同后，运行时源码只接受逐字相同或唯一固定CommonJS包裹；不修整源码、不改源、不换脚本或补命中。实际运行时还必须逐项等于Electron44.7.0、Chromium152.0.7977.130、Node24.21.0、V8`15.2.124.28-electron.0`。V8后缀来自已核C Framework静态字串，官方发行表为无后缀版本，二者不能代替实际`process.versions`校验。执行点必须来自相同scriptId、同一原语句行且实际落点完全相同；本次纯协议使用合成scriptId，并未证明C运行时一定提供这些位置或源码URL。

官方依据：[Electron44.7.0版本表](https://releases.electronjs.org/release/v44.7.0)、[Main调试与窗口调试的区别](https://www.electronjs.org/docs/latest/tutorial/debugging-main-process)、[Node24.21.0 Inspector](https://raw.githubusercontent.com/nodejs/node/v24.21.0/doc/api/inspector.md)、[CDP协议源码](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/js_protocol.pdl)、[Chrome非暂停日志点](https://developer.chrome.com/docs/devtools/javascript/breakpoints)、[DOM MutationObserver](https://dom.spec.whatwg.org/#interface-mutationobserver)、[React Profiler](https://react.dev/reference/react/Profiler)。Context7本轮不可用，已按AGENTS使用官方一手材料；协议文档不是实际Node目标可用性证据。C原包没有可用的React公开Profiler提交见证，所以`exactReactCommittedRevisionCertified`始终false，收到状态revision、管理页DOM变更及Main实际确认记录分别报告，不能把它们称为React数字提交版本。

Main只保留本场nonce的严格固定JSON字段：固定phase、提交／当前scope和foreground、当前contact／state数字revision、generation有效布尔以及实际return后的selected数字revision。其他console只计忽略，不保存内容。每套记录最多24条，超量、缺实际分支、自有非法字段或数字、paused、任何收尾未确认均拒签；不根据代算revision推导actual accepted。若paused不记录callFrames、不resume、不关闭别人Inspector，只移除本场安装的断点并关闭本场外部WebSocket。管理页记录至多24条，仅合成联系人序号、DOM选中／标题序号、收到的数字版本和相对时间；finally只断开本场观察器及公开订阅。

实际最小验证（均为Node合成，不运行App／微信CLI／模型）：

- 来源／版本拒绝负控首红，外层0.142911792秒；位置负控3项中1红，0.119068667秒；paused负控4项中1红，0.094726125秒；外来console负控5项中1红，0.129747500秒。逐片补守卫后通过，保留各首红日志，不把追加初绿控制写成红绿。
- 最后`node --test tests/contact-confirmation-witness.test.mjs`实际11/11、skip0、exit0，TAP0.180911042秒／外层0.211030417秒。覆盖错误源码／版本、固定包裹、错误／迁移执行点、paused、foreign nonce、自有额外身份字段／非法数字／24上限、guard配实际分支、清理失败、外部或带凭据地址及固定错误码。地址负控在构造WebSocket前拒绝；没有真实正向WebSocket、Main或DOM执行。
- `node node_modules/typescript/bin/tsc --noEmit`实际exit0、外层0.394545583秒。两条最小命令均在`desktop/`执行，独立并行；没有执行普通安全全套、打包或重启App。
- 原场景快照SHA`5f5f69f025071300c7cd7e3de4f7d5b5fed226ebc2454b672af457dbd2cfcf08`。只去掉新import及包裹后恰好多出的两空格缩进，原prefix和动作／断言尾段逐字一致；尾段SHA两侧`c7237f6041794e7c16f9da602c18a09f887a4c8caddd20599e0862a217c9ce06`。第一次保存证明的JS辅助脚本因TypeScript7编译API不存在失败，明确`proofCompleted=false`保留；随后使用字节比较完成证明，该工具失败不算产品或场景red。旧证明与最后v2证明的截取边界不同，均保留，不覆盖历史。

首红、两次最后合成验证、原始快照、字节证明及评审固定diff索引均保留于[本片证据目录](../../desktop/artifacts/goal-contact-confirm-witness-20261013-UTjSbq/)。最晚命令见`final-v2-protocol.json`／`final-v2-typecheck.json`，动作证明见`original-scenario-preservation-v2.json`。测试在内存构建helper并导入，不创建App、数据库、监听端口或实际WebSocket；没有读取env／真实联系人／provider正文或发送消息。证据文件按0600保存，合成证据保留供复核，不删除失败记录。

Root下一步仍须使用[工程受限入口](../../docs/agents/engineering.md)和[桌面命令](../../desktop/README.md)，明确本场起止时间（≤5分钟）、`--max-launches 1`、当前C可执行文件及独立output，仅`tests/contact-session.spec.ts --grep '两个窗口共享本次联系人'`，开启本片显式flag。实际版本、MainURL／源码包裹、执行点、外部多client协议和公开DOM订阅任何一项不符合就结束并记录失效，不能在本场猜位置／换来源后重试。仅安装成功不能认证通过：必须原场景断言通过、实际guard及throw／return配对、诊断与夹具各自收尾有证据。日志点和观察器本身可能影响时序；一次通过也不证明原C失败的原因或稳定修复。OCR、真实微信来信／双联系人、语义质量、WCDB材料及Mac整票缺项继续独立。

## Root 一次 C 原包实跑终态

Root于台北05:49:39.382993–05:54:39.382993预登记max1，严格经`npm run test:app`、指定C可执行文件、唯一原场景grep及显式诊断flag运行，session78201。实际1 App／1 passed，Playwright用例5.9秒、报告6.2秒，受限命令壁钟7.126580917秒／exit0；外层含终态核查7.890474625秒，不把清理时间算作场景运行。模型／微信CLI／发送／OCR capture均0。运行前四已审SHA吻合、共享租约absent、C280常规文件及ASAR／deep strict签名核过；本次未重新打包。

实际Inspector来源逐字unwrapped，运行时四版本和磁盘Main摘要逐项符合预注册，实际三个位置126:13、127:6、134:4，没有猜位／source fallback／paused。诊断valid=true、actual guard/returned两对；第一次submitted scope=2／foreground=12，入口current同为2／12，实际return selected scope=3／contact revision=6；第二次submitted scope=4／foreground=15，入口current同为4／15，实际return scope=4／contact revision=11。return时前台状态已经变化，由guard后的正式确认动作引起，不倒推入口失配。没有actual throw。外来console仅忽略计数1，正文未保存。

管理页10条有界DOM／公开状态记录，序号由甲→乙→甲，actual state received revision=6之后DOM乙可见，原草稿清空／恢复等所有断言保留且实际通过。收到的revision与DOM观察分别保存；没有可用React公开Profiler，`exactReactCommittedRevisionCertified=false`保持。Main本场日志点／WebSocket和DOM订阅的cleanupConfirmed均true，记录没有overflow。

[实际场证据](../../desktop/artifacts/goal-contact-witness-real-20261013-c/)保留session-plan、runner原日志／terminal、confirmation-witness、selection-observations、App归属收据及原场景合成截图；默认权限0700／0600，图片未提交。Root记录的16个本场PID和1个userData路径均gone，共享租约absent；运行前后C280文件与符号链接快照完全相同、deep strict exit0。原夹具虽执行finally清理，但本次未持久化精确数据库名和独立后端退出收据，`whole_backend_pid_database_receipt_coverage=false`／`individual_exact_database_receipts=0`，不能把16 PID取样扩写为整个历史进程／库全面认证。没有删除未知库或操作其他App。

本场通过只证明本次入口revision一致、实际接受和两窗公开DOM传播；Inspector日志点／观察器可能改变时序，原组合场联系人间歇失败根因仍unknown。原失败和两个先前isolated通过保留，不循环重跑以凑稳定性、不自行修产品门。C全目标实际App计数由282增为283。真实微信来信／双联系人、实际OCR／TCC、WCDB精确源码许可链与Mac整票仍未满足，不由这次合成联系人替代。

实际证据追加后的独立两轴与本地提交待收口；模型唯一run仍active期间不动Git index／提交或模型冻结源码。
