# 18：前台定位与人工消歧

Type: task
State: claimed
Triage: ready-for-agent
Blocked by: 09, 16
Spec: ../spec.md

## 交付行为

复用 Mac 原生探针定位微信前台会话，唯一验证绑定可定位联系人，其余要求手动确认。

覆盖规格用户故事：17、18、45。

## 验收条件

- [ ] 只在微信前台、会话可见时读取最小定位区域，原始帧仅在内存处理。
- [ ] 重名、改名、低置信度、失败或失效绑定不猜联系人、不生成；已有草稿按联系人切换规则处理。
- [ ] 小窗获得焦点后前台定位暂停，已确认 CLI 同步独立；核验新宿主 helper 路径、签名及权限归属并更新台账。

## 测试与范围

- 当前 `sync/status` 与最近有效观察仅是历史报告，不用于自动选择联系人。按规格的独立空对象 `POST /api/sync/foreground/observe` 取得一次新观察，固定当前运行身份、唯一active绑定与质量门槛；不调用正文同步、补齐、确认或通用请求。
- 小窗show/focus前最多等待1500ms；超时仍打开，观察一次消费，连接、焦点、范围或编辑改变时失效。保留手动草稿与同联系人状态，模糊或失败要求当前范围的明确人工确认后生成。
- 新定位采集仅覆盖必要区域，旧完整窗口内存捕获不能证明满足本任务；未知区域/质量安全暂停。普通合成探针验证控制流程和公共HTTP，不证明真实最小截图、签名或权限。
- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Comments

- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。

- 2026-10-09：从固定集成 `e1bfe74c298a37c2275c597b7f5e2f5e104df1d4` 在独占 `codex/mac-app-18-foreground-locator` 领取，09/16 已 resolved。按当前 STATIC ONLY 只读核对真实 sync/front、probe/resolver、联系人切换与窗口路径；`GET /api/sync/status` 是无观察时间的 cycle 缓存，人工验证 `last_valid_observation` 为历史，不能据此自动选联系人；`/api/sync/check` 同时触发后台正文安全对账，不能偷偷作为前台定位调用。现有探针 JSON 没有定位置信度，旧 native 或历史 App 证据不能冒充当前唯一验证绑定。先向主 Agent 提交独立只读观察、trusted 焦点 generation/一次消费与人工消歧的最小协议方案，新增 HTTP/contracts 及共享文件所有权待明确。首片只准备“helper获得焦点后前台定位暂停、已确认CLI总开关保持、手动联系人及编辑不被旧观察覆盖”的公开页面失败接缝设计；尚未写运行用例、没有运行red/green、没有生产或测试实现。未启动后端/PG/浏览器/App/探针、未读取图帧/私人资料、未安装/打包/签名或外部操作。第三条原生验收、所有验收勾选及 Answer 保持未完成；后续按一次垂直切片推进。

- 2026-10-09（首条公开失败接缝静态准备）：仅新增专属合成probe脚本、复用已验证BindingFixture生命周期的暂停夹具与一条公开页面场景，真实HTTP确认本轮合成绑定并开启CLI总开关，probe返回微信不在前台，断言小窗显示定位暂停、手选联系人与草稿保持、真实sync/status开关仍true和foreground_phase为waiting_foreground。不调用sync/check、不提供图帧或模拟业务成功；未登记host/CLI入口，未运行red/green或任何服务。类型与构建、差异和二十票检查通过。新fresh observe/当前绑定质量与trusted窗口时效方案已交主Agent，规格补齐及生产接口仍待裁定，不先实现高风险seam，不写Answer或勾验收。

- 2026-10-09：只读核对发现缺少新观察公共接缝、探针未投影OCR质量且旧路径先捕获完整窗口。主Agent按本任务已有定位/人工消歧范围明确规格中的最小只读接线、保守质量门禁、1500ms可信show前预算与草稿保留；不新增业务表、读取授权或同步算法。普通页面与纯合成原生逻辑可继续，实际App/微信探针、签名与权限仍暂停；尚无本任务运行red/green，不沿用历史证明。

- 2026-10-09（新观察首片wrapper静态准备）：合入范围决定59a442b，保留原claim与首片记录；新增专属headless foregroundPaused wrapper，先复用真实BindingFixture的认证HTTP/PG确认合成绑定、开启CLI，验证空对象foreground/observe返回本次paused/null身份/最小投影且没有新增tail，再打开公共helper检查暂停提示、手选联系人与草稿保留、总开关独立。后台HTTP红断言与页面wrapper均尚未运行，现有端点不存在不能冒充实际red。只给主Agent foreground-paused的run/test-pages白名单与dispatch patch，不直接改共享接线；生产endpoint/窗口hooks/生成guard与原生采集未实施。typecheck/build与diff静态通过，无服务或原生执行；所有验收勾选、Answer仍空。

- 2026-10-09（首条真实公共red）：固定source f983d7db7940ff85f4027f40cc7bc474caa1c378，Conda NotAlone经受限test:pages单组foreground-paused、180秒预算运行一次。真实认证POST /api/sync/foreground/observe返回404而预期200，CLI exit1；这是缺少新端点的产品反馈，尚未到达UI断言，不计green。精确BindingFixture认证shutdown响应确认stopped，child49427 exit0/signalnull，cleanup=true；独立pg_database精确查询本轮notalone_binding_34625f994197434d8f4c66e4ffbf037a_test不存在，捕获9自有PID/group无存活，两lease absent，Chrome1、quiet6 active0/window0。日志/exit/resources/owned-identities/verification保存于外部context的18-first-red-f983d7d前缀；正常收尾后明确返还唯一运行权给主Agent，未启动第二轮。fixture停读不充当最新App原生退出证明；无实际probe/App/微信/权限/剪贴板执行。保持claimed/noAnswer，未勾验收，等待最小生产green与共享host/UI接线。

- 2026-10-09（paused首片最小生产候选，仅静态）：生产主题2996aab补独立空对象POST→SyncHost同循环锁200ms→本轮运行owner同步开关的专属read_bounded→只读fresh probe，统一monotonic截止1300ms，DB读后与probe开始前过期绝不晚采集。旧read/后台三参数及30s预算保持；新probe追加--minimal-region，旧native严格在采集前拒绝未知flag，不回退旧全窗路径；合成probe只接新四参数，真实原生最小采集/质量尚未实现，微信可见仍只manual-required空身份。新增专属controller/只读helper桥/preload/DTO/Panel，1500ms有界真实POST、singleflight、连接/范围/编辑/可信生命周期废弃未消费响应，不改变联系人或草稿；尚未接共享host/UI，不动ReplySession/自动确认。Context7不可用，核对psycopg安装3.3.4与项目>=3.3.4,<4，并查Psycopg官方Connection/conninfo及PostgreSQL libpq/statement_timeout文档；connect_timeout最低2s按host生效，专属门禁拒绝多host/service配置，查询/锁200ms，UI届满可有有界DB收尾但不再启动视觉采集。合入root361ceab可信窗口hook与flag契约，保留全部既有任务。类型/构建、8文件AST及diff静态通过；未启动任何服务/probe/App，不计green，claimed/noAnswer及实机待验保持。

- 2026-10-09（首片真实green）：FF共享装配ba881a4293b0f847ac435102bc4b04a9ddc4b8f2，在同一固定干净source经Conda NotAlone受限test:pages运行foreground-paused单组、180秒预算，唯一1场1/1、CLI exit0。真实认证HTTP+随机隔离PG与strict --session --json --minimal-region合成外部probe验证本次paused/null身份/最小投影/tail不增，再公共helper显示暂停，手选联系人和草稿保持、CLI总开关仍开启。PageHost经真实认证shutdown响应确认stopped，child57924 exit0/signalnull，cleanup=true；独立pg_database精确查询本轮notalone_binding_35f86bada3fa43ecb89fa24bfb562f78_test不存在，捕获11自有PID/group无存活、两lease absent，Chrome1、quiet9 active0/window0。证据保存在外部context的18-first-green-ba881a4日志/exit/resources/owned-identities/verification；首404失败证据继续保留。正常收尾即明确返还主Agent运行权，未启动第二轮、不修改17失败解析。本次只证明paused最小普通页面流程，首次/重名/改名/低质量/自动采纳/人工确认生成guard及最新App、真实最小采集、helper签名权限仍未闭环；所有验收勾选与Answer仍空，保持claimed。

- 2026-10-09（下一manual-required公开red静态准备）：新增strict四参数合成probe，仅改变本轮自有JSON布尔前台输入，故意缺少最小区域与OCR质量；专属foregroundManual wrapper先复用真实认证HTTP/PG与原精确生命周期，再验证可见却manual-required/null身份/tail不新增、管理页旧选择和同联系人草稿保持、未经本次helper确认生成禁用且main返回明确确认门禁错误、同id确认恢复入口而不清草稿。本片只准备下一失败接缝，不实施确认/ReplySession guard，也不把按钮恢复资格当真实候选生成通过；尚未运行该场。paused首片1/1及原404证据保留。最小采集方案在外部context，官方sourceRect单窗口忽略限制与实际SDK静态typecheck已核对；尚无可追溯已验证微信layout profile，未知区域明确manual-required且零采集，默认三参数与fresh参数未来必须共用安全路径，不写native产品或扩大权限。types/build及AST/diff静态检查完成后提交，claimed/noAnswer、所有实机验收待完成。

- 2026-10-09（manual-required下一单场真实red）：FF固定登记c0a27e2b6674d2dabc790c7a9f418c9df18fa7f7，经Conda NotAlone受限test:pages仅foreground-manual单组、180秒预算运行一次，CLI exit1。真实认证HTTP可见但缺quality返回manual-required/null身份且tail不增；管理页旧选择与helper同联系人草稿关闭重开保持断言已过，随后“生成候选”按钮预期disabled、实际enabled形成产品red。main稳定确认拒绝与同id确认后的资格恢复断言尚未到达，不计通过、不提前实施green。认证PageHost shutdown确认stopped，child64947 exit0/signalnull、cleanup=true；独立pg_database精确查询本轮notalone_binding_c12e92f02a6a4190a079c60a3db2e446_test不存在，捕获15自有PID/group无存活、两lease absent，Chrome1、quiet16 active0/window0。日志/exit/resources/owned-identities/verification保存外部context18-manual-first-red-c0a27e2前缀；精确正常收尾后立即明确返还root唯一运行权，未启动第二轮。原paused1/1和首次404失败证据保留；无实际probe/App/微信/权限/剪贴板，原生采集区域方案待裁定、任务claimed/noAnswer及验收未勾选。

- 2026-10-09（manual-confirm首红最小green生产候选，仅静态）：按裁定新增helper-only foreground.confirm，严格唯一contactId/contactScopeRevision/foregroundRevision三字段、UUID与安全整数校验；主进程核当前连接代际/目录/范围/定位revision，取消未消费观察后调用既有联系人选择，以返回的新scope记录人工资格。manager旧选择不获得资格，同id不清草稿或候选；同scope人工确认的后续编辑、隐藏恢复保持，连接/范围变化撤销；可信focus/hide/closed更新定位revision，过时请求不可复用。公开confirmation/confirmedContactId/generationBlock、getGenerationBlock与原订阅；helper picker真实change一次选择并确认，ForegroundPanel提供同id确认入口。root回复门禁接口ef557af已合入，getter与事件订阅以及两个UI消费者仍由root串行接线，不修改来源删除行为。合并后types/build/diff静态通过，未运行第二轮，不记green；自动绑定/质量producer/native最小采集未实施，claimed/noAnswer。

- 2026-10-09（manual-confirm单场真实green）：FF固定共享装配c810f3764cb663edd420f29d3106291f678575ef，经Conda NotAlone受限test:pages仅foreground-manual单组、180秒预算运行一次，1/1、CLI exit0。真实认证HTTP可见但缺quality仍manual-required/null身份且tail不增，管理页旧选择与helper同联系人草稿关闭重开保持；生成按钮disabled，直接main生成返回明确“请先确认本次联系人”门禁拒绝，same-id确认后入口enabled且草稿保持。本场仅验证人工资格恢复，未调用模型生成候选，不把按钮enabled当真实生成通过。PageHost认证shutdown确认stopped，child67608 exit0/signalnull、cleanup=true；独立pg_database精确查询本轮notalone_binding_4723138c5c3744179c4891aacf1dea8d_test不存在，捕获12自有PID/group无存活，两lease absent，Chrome1、quiet9 active0/window0。日志/exit/resources/owned-identities/verification保存外部context18-manual-first-green-c810f37前缀，首按钮仍启用red与paused首片证据保留；正常精确收尾即明确返还root唯一运行权，不追加组/native。受控模型正向生成、自动绑定、真实最小采集/quality producer与最新App签名权限仍待验，任务claimed/noAnswer、验收未勾选。

- 2026-10-09（native安全退化源码）：合入aeb476551147a4bd88f9533d37843e183f32769c的纯SessionInvocation政策；默认JSON、fresh minimal及旧text session在首个NSApplication/权限/窗口/捕获动作前统一返回minimal_region_layout_unverified，删除session全窗捕获与回退。实现树纯swiftc参数政策17组通过，CLI及测试目标仅静态编译通过；独立XCTest类型检查因框架路径失败，随后测试目标静态编译通过，未执行XCTest或原生程序，不虚构旧native red→green。root登记build_cli.sh新Core输入，并取消脚本自动证书查找、默认明确ad-hoc；原生权限和完整最小采集仍未验证。未知布局零采集是安全退化，不等于自动绑定已实现；claimed/noAnswer、验收未勾选。

- 2026-10-09（人工确认安全单场首跑green）：FF固定干净source 36bd86eaa681e91a1ae0c1f18f6da4f61850bf8f，经Conda NotAlone仅一次受限`npm run test:pages -- --case foreground-confirmation-safety --timeout-seconds 180`，唯一1场1/1、CLI exit0，7.63秒；现有生产门禁直接满足断言，没有编造red或追加重跑。真实生产页面、具名桥与隔离HTTP/PG验证helper人工确认A后，manager选择B撤销原资格；7个非法参数请求、3个旧scope/foreground revision请求和manager有效参数确认均被拒绝，B草稿保持，真实main生成入口仍拒绝并要求本次人工确认。默认同步始终off，新观察paused/unavailable身份null；仅A有本轮确认绑定，A/B消息均空、tail0，没有模型候选生成或正文读取。PageHost真实认证shutdown确认stopped，child79957 exit0/signalnull，unconfirmed=[]、cleanupConfirmed=true；独立只读pg_database查询精确本轮notalone_binding_e9a0efa9e62d4a44ae621f825c9525e7_test不存在。捕获31自有身份无存活匹配，6独占进程组均ESRCH，两lease独立复查absent；Chrome1、quiet6 active0/window0。日志、exit、resources、owned-identities、cleanup、精确catalog及独立收尾核验保存于外部context的18-confirmation-safety-first-36bd86e前缀。完成精确收尾后已明确归还唯一runtime；本轮不改production/registry、不执行native/App/微信探针或真实模型。原paused/manual red与green证据继续保留；人工资格与普通页面安全已证明，自动绑定、实际最小采集/quality producer和最新App签名权限仍待验，claimed/noAnswer、验收未勾选。

- 2026-10-09（两片独立双轴收束）：固定194fab918…fa398b6的native安全退化/构建输入/显式签名源码，独立Standards hard0/possible0、Spec0；固定fa398b6…36bd86e的公开人工确认安全测试/登记，两轴同样全0，P0–P3均0。评审未运行服务或原生程序；source36bd86e真实单场1/1及正常清理另有证据，不能把源码评审、纯17组或普通角色验证混写为实际ElectronIPC/native通过。近期来源删除full五种生成族经实际helper确认后走受控本地模型，证明人工资格可接入真实业务生成；这不是自动绑定、真实模型语义或native定位验收。18仍claimed/noAnswer，验收未勾选。

- 2026-10-09（生成资格适配收尾）：集成 `d6a3e6a` 与已通过首 20 场的 `94e50f7` 在 desktop/backend 无差异，保留该轮实际证据；本次追加依据/消息事件 14、导入/草稿 5、复制 4 场全部通过，共 43 个唯一场景，不重复计算历史复制。43 个精确库的只读 catalog 查询均不存在；各轮正常清理、自有进程无残留、两租约 absent。消息事件的 5 个库额外采用本轮 PID 匹配的建库与清理归属文件核验；其余 38 个保留认证停读/清理/退出见证。固定 `f958df4…a08b542` 测试适配的独立 Standards hard0/possible0、Spec0 既有报告已核实并归档；`npm test` 类型与安全调度 24/24 通过，三轮页面构建通过。证据在 `desktop/artifacts/acceptance-closeout-d6a3e6a`。本轮只补验和记录，未完成可信布局、成功自动定位或原生权限条件，18 保持 claimed/noAnswer。


- 2026-10-10（构建与纯政策验证）：用户要求补真实微信前置条件，明确ad-hoc构建探针与核心库、两者codesign严格校验通过；SessionCaptureSafetyTests实际4项通过（17组参数）。未执行probe session、App、微信观察或TCC动作；没有布局profile，minimal_region_layout_unverified保持，不能称定位已完成。CLI后台同步与OCR独立，已在验收记录分开直接同步路径与自动定位后续条件。18保持claimed，无新增验收勾选。

- 2026-10-10（目标模式收尾核对）：人工确认、失效与焦点暂停的合成公开路径已有上述证据；剩余最小区域、质量 producer、成功自动定位及权限归属不能在缺少可信微信布局时实现或验收。下一步需用户认可有限观察范围和时段，故 Triage 同步为 ready-for-human；State 保持 claimed，未知布局仍在 OS 动作前拒绝，不写 Answer 或勾验收。

- 2026-10-10（独立上下文，校准接缝决定与公开red）：接手固定 `fb3fce2`，用户明确采用“先准备最小区域校准”。15:55–15:58（UTC+8）受限 `test:app`、预算1次，`native-foreground-calibration.spec.ts` 实际1场失败，报“公开菜单操作不可用”；旧源码确无校准入口，未运行probe或读取微信图帧。夹具完成退出，runner确认子进程组与登记收尾，随后只读 `test:app:status` 为absent。新增producer只保存待校验几何，不放开既有session门禁；最小采集、OCR quality、后端质量消费、小窗confirmed自动采用和最终宿主权限仍缺。原票保持claimed/ready-for-human，验收与Answer不变。

- 2026-10-10（校准候选与首跑收尾）：原生透明框选、主进程受限菜单/子进程及0600独立原子保存层已准备。Standards初审2项（职责混合、阻塞确认绕过时限）、Spec初审1项（退出失败后入口失效）已修复，两轴复核均0。`npm test` 安全38/38、原生session政策4/4、类型/构建、CLI/Core显式ad-hoc与严格签名通过，未据此宣称实机。16:05–16:15预算1次首跑仍报公开菜单不可用，probe未启动；测试缺少管理窗口就绪等待，现已补firstWindow/URL等待，是否解决原因仍待新轮验证。runner已正常收尾且租约absent，不自动重试。用户随后明确同意16:08–16:18预算1次，仅五处几何框选，无截图/权限；尚不计green。

- 2026-10-10（第二轮实际失败与辅助范围）：上述16:08–16:18预约的唯一测试已到达管理窗口并调用公开菜单；电脑控制再次点击菜单后观察到校准说明，框选子进程确已启动，但380秒内未产生选择文件，实际1场超时失败，不计green。用户在本聊天明确要求直接操控微信，并在“一次当前窗口截图并代框”的范围问题后再次要求直接操作；主 Agent 仅查看一次当前窗口用于坐标判断，未把画面、名称、正文写入仓库，不作为产品最小采集证据。微信AX只给窗口/菜单，坐标点击返回AXError.notImplemented；框选未完成，原因尚未定位，不伪称前台切换或修复成功。16:14后核验本轮runner/App/helper及已记录子进程均不存在，独立userData已删除，`test:app:status`为absent；失败即停、没有自动重启。后续由主 Agent 在新的有限预约操作，不要求用户手工代跑；整票claimed/ready-for-human、Answer及验收保持未完成。

- 2026-10-10（可访问坐标路径与实际到期）：在同一菜单增加无脚本沙箱坐标表单，由已获用户认可的操作者输入窗口尺寸与五处几何；原生stdin有界且严格校验，复用原几何规则并核对唯一版本、实际窗口尺寸及前后元数据。表单前台只查询元数据，不采集/控制微信，输出仍pending-only。类型、构建、Swift CLI/Core编译与严格签名、session政策4/4及独立双轴0通过后，在用户明确认可的16:21–16:31、预算1次实际启动；主Agent经CUA填写全部可访问字段并点击确认，未出现选区文件。到期CLI124、1 interrupted，不计green。App21834及已记录孩子已退出、userData删除、租约absent。用户再次明确要求直接操作/查看电脑，本轮仅额外查看隔离App管理画面，未写入仓库。现补显式诊断标志下的固定阶段代码与0600阶段文件，失败阶段立即使公开测试失败，不记录输入值/路径/原生原文；尚未新跑或定位根因，未释放session门禁或结票。

- 2026-10-10（由Agent直接操作的坐标校准green）：用户再次明确要求直接操作电脑并查看，主Agent按该最新指示执行16:39–16:49（UTC+8）、最多1次App启动的有限几何轮次。当前微信窗口经电脑控制观察，五处坐标由CUA公开表单填写并提交；受限`test:app`实际1/1、exit0、30.9秒，0600待校验选择包含严格8字段及5区域，不含名称、正文或图帧。临时固定阶段记录确认表单提交、原生校验、保存成功；早期到期未保存原因仍未知，没有编造原因或宣称修复。成功后移除全部临时诊断，保留公开菜单/结果文件/正常退出的行为测试。App25954已正常菜单退出、独立userData删除，独立租约复查absent。现场画面不写仓库，未切换/滚动/发送微信、申请权限或释放session门禁；产物在`desktop/artifacts/mac18-calibration-direct-20261010-1639/`。本片校准可由Agent完成，Triage转ready-for-agent；整票仍claimed、验收未勾、无Answer，继续准备布局细条验证、真实最小采集与可信质量消费。

- 2026-10-10（最小采集与质量候选）：质量JSON测试实际red为缺少selected_row_name；实现后17/17通过，覆盖0.90门槛、非法值、缺字段/未知版本及未校验布局。原生布局首red为缺模块；实现后纯布局3项与参数4项共7/7通过。新增公开布局校验菜单、私有profile、display filter逐区sourceRect、细条前后摘要、两名完整一致及顶部复读；小帧仅内存。显式ad-hoc重建与严格签名、安全38/38通过，尚未运行真实捕获，不请求权限。后端绑定质量消费与小窗自动采用仍待完成，不能凭候选源码结票。

- 2026-10-10（直接操作的布局校验失败）：用户再次要求直接控制微信，主Agent执行17:06–17:16（UTC+8）、最多1次隔离App轮次，当前窗口菜单与公开表单均直接操作，五处pending几何保存成功。原生校验显示通用未完成说明、100秒内无profile；实际1场失败（2.1分钟），未保留原生具体码，原因仍未知，不能证明已捕获或质量通过。无系统权限请求/接受、会话切换/滚动/发送或私人画面落盘。runner报告cleanup_unconfirmed后，核验App41729、探针42006、runner与已记录孩子、已知App/worker组均缺席，隔离目录删除，精确租约人工核验释放且复查absent；未终止未知进程、未再启动。失败产物在`desktop/artifacts/mac18-minimal-layout-20261010-1706/`，不提交。

- 2026-10-10（质量门禁与失败诊断）：qualified_evidence首red为缺属性，green后解析18/18；定位、旧循环及当前绑定确认只消费已校验、双置信度至少0.90、两名一致的证据。已有active绑定仍拒绝未知/低质/异名并无新增tail的真实引擎/PG测试通过。共享旧测试库19场9项报source_processing_write_failed，不计green；新随机库完整47迁移后相关38/38通过并精确删除，未修改旧库。补原生固定阶段、白名单0600校验结果、具体中文失败说明及公开App即时结果断言，不记录名称或图帧；新诊断尚未新跑现场。纯Swift7/7、安全38/38、类型通过。整票仍claimed/ready-for-agent、验收未勾、无Answer；新观察唯一绑定与小窗自动采用、真实裁剪与最终权限仍待完成。

- 2026-10-10（失败失效的最终回归）：两轴发现宿主异常没有校验结果、探针异常可复用旧待确认候选，均已修正。真实隔离PG red确认坏质量的直接确认和探针错误分支仍可消费旧候选；green后正常低质量或异常均清pending，当前确认失败也停止旧前台tail，明确离开微信仍保留原TTL显式确认。相关完整40/40在新随机47迁移库通过并精确删除；主进程类型/构建、原生7/7、CLI/Core显式ad-hoc与严格签名通过。真实App没有新跑，原失败不计green；新增host失败结果仅保存calibration_unavailable/host，失败撤销profile。整票状态不变。

- 2026-10-10（可信新观察与自动采用）：真实认证HTTP首red为返回manual-required而预期confirmed；生产新观察在1300ms总预算内只查全类型CLI元数据（51项即不能证明唯一）及当前owner/channel/account的active绑定，不读取正文或缓存身份。唯一私聊、已确认名称与唯一绑定一致才返回UUID身份；同名未绑定私聊/群聊、改名、撤销、查询失败均人工确认。真实页面首red为联系人未自动选择；green后无编辑时自动采用，已有草稿/候选/要求时保留当前范围并具名确认。清空要求的迟到观察实际red仍confirmed，修复后取消。names-only共享匹配也拒绝绑定外同名及群聊。Conda NotAlone随机47迁移库相关后端93/93通过并精确删除；未修改原业务库、schema或同步授权范围。

- 2026-10-10（授权变更门禁）：Standards发现关闭同步/解绑未撤销旧小窗资格；真实公开页面red为关闭后生成仍enabled。有效解绑、关闭或暂停请求开始及finally收尾都撤销旧资格/在途观察，重叠期间禁止新观察和生成，保留编辑，重新开启不恢复旧资格。公开foreground-verified扩展唯一绑定、草稿与联系人保护、编辑失效、同名私聊/群聊、改名、关闭恢复、真实传输暂停disable期间的门禁和公开解绑，最终1/1通过。后端60402认证stopped、exit0/signalnull，随机库notalone_binding_2bbd2817a5d7451c8df0739842e79f15_test已删除；Chrome1、quiet12 active0/window0、cleanupConfirmed=true。此前foreground-manual与foreground-confirmation-safety完整2/2通过；它们不是本次最后门禁改动后的重新全量结果。CLI重新开启本来允许已确认范围补齐，相关定位断言以重新开启后的tail水位证明没有新增正文读取，不把整个授权开关场景称为零tail。

- 2026-10-10（17:50独立现场轮次）：用户明确认可17:50–18:00（UTC+8）、最多1次隔离App，由主Agent直接操作。经CUA查看一次当前微信窗口并填写五处坐标，0600 pending几何保存成功；随后公开校验等待100秒无结果/profile，实际1场失败（2.3分钟），具体阶段仍未知。App59022、runner59016、worker59021及其已知进程组、仓库探针缺席，userData删除，精确租约核验后释放并复查absent；未终止未知进程或自动重启。未切换/滚动会话、发送消息、请求或接受权限、保存画面或名称。二进制包含阶段字段，不能因时间戳早于提交而断言旧构建导致失败。产物在desktop/artifacts/mac18-minimal-layout-20261010-1750，不提交。

- 2026-10-10（失败诊断准备）：新增原生固定阶段stderr流与8192字节/白名单/去重接收，原子0600进度仅含running与阶段；失败保留，开始下一次时清除。公开App先等非host原生阶段或终态失败，再给结果预算，finally保留无图像阶段；host只证明宿主准备。Node该边界实际red为receiver缺失，green1/1覆盖拆包、未知原文、过量拒绝、失败保留与重启清除。npm test安全39/39（不运行App/浏览器/探针）、Swift纯布局/参数7/7、类型与diff、CLI/Core重新显式ad-hoc编译与严格签名通过。该诊断尚未新跑现场，不声称真实捕获原因已修复。双轴前轮发现的授权P1/竞态P2已修正并复核0，新增诊断归因P2也已改为非host等待。整票继续claimed/ready-for-agent、所有验收未勾、无Answer；真实profile、裁剪、自动定位及最终权限仍待验。

- 2026-10-10（18:05独立轮次与隔离配置修正）：用户明确认可18:05–18:15、最多1次隔离App。公开`package --with-probe`从生产源码`a0d07f1`构建新ad-hoc签名包并递归严格核验；只含仓库探针，不含CLI/WCDB，不作为完整交付。唯一App65655打开公开校准说明后，Spec评审发现测试的空appEnvironment仍被实际isolatedAppEnvironment补入unavailable-probe，未沿Resources路径。主Agent立即取消并菜单退出，在任何坐标、探针或微信观察前停止；自有runner65648 SIGINT收尾，实际1 interrupted/CLI130，不计green。本轮App/runner/worker65654、userData与租约均缺席，未重启、截图、操作微信、请求/接受权限或终止未知进程；忽略产物在desktop/artifacts/mac18-minimal-layout-20261010-1805。

- 2026-10-10（实际配置回归red→green）：Node检查加载真实现场spec选项但仅登记注册器，绝不执行App回调；再经过真实隔离环境和生产启动配置。实际red明确返回unavailable-probe而非Resources；签名分支改为显式NOTALONE_SYNC_PROBE空字符串后，类型与完整npm test安全39/39通过，并核对开发路径、CLI仍隔离、核心库变化时停用。上述实际包另经Node静态配置检查确认Resources探针选择，未执行App/helper、权限API或后端；离线Electron ZIP及检查临时目录已清理。最终Standards Hard0/Possible0、Spec P0–P3均0；真实新宿主profile、裁剪、质量、自动定位与权限仍待，整票claimed/ready-for-agent、验收与Answer不变。
