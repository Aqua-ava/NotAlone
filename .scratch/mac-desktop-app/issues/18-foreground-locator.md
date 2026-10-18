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

- [x] 只在微信前台、会话可见时读取最小定位区域，原始帧仅在内存处理。（2026-10-13 新D包F场实际到names，E场末次非前台停在context；仅认证采集边界，不代表可信名称／profile／绑定通过，见[实测](../../unfinished-work/goal-ocr-front-context-20261013.md)。）
- [x] 重名、改名、低置信度、失败或失效绑定不猜联系人、不生成；已有草稿按联系人切换规则处理。（2026-10-15：当前单帧公共HTTP6项验证重名/改名等拒绝门，117项组合验证内容隔离与竞争，当前签名包单联系人实机补充绑定与暂停恢复；不追认双真实联系人。）
- [ ] 小窗获得焦点后前台定位暂停，已确认 CLI 同步独立；核验新宿主 helper 路径、签名及权限归属并更新台账。

## 测试与范围

- 当前 `sync/status` 与最近有效观察仅是历史报告，不用于自动选择联系人。按规格的独立空对象 `POST /api/sync/foreground/observe` 取得一次新观察，固定当前运行身份、唯一active绑定与质量门槛；不调用正文同步、补齐、确认或通用请求。
- 小窗show/focus前最多等待1500ms；超时仍打开，观察一次消费，连接、焦点、范围或编辑改变时失效。保留手动草稿与同联系人状态，模糊或失败要求当前范围的明确人工确认后生成。
- 当前定位采集按 ADR-049：内存分析当前前台微信窗口、仅 OCR 两处名称，不再要求人工坐标；未知区域/质量安全暂停。上述已勾选采集边界是旧方案历史证据，不认证新版自动定位。普通合成探针不能证明真实窗口定位、签名或权限。
- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Comments

### 2026-10-16 同v9权限责任分项通过，真实组合焦点门仍失败

[Finder同包分项](../finder-v9-immediate-result-20261016.md)1／1通过，正式及辅助探针责任归属当前Finder宿主，helper源停止和正常退出通过；不认证成功捕获数或私聊身份。[真实CLI组合](../../foreground-contact-follow/real-cli-visual-v9-20261016.md)随后单场失败：微信新正式单帧通过，helper显示但70秒原生焦点门超时，未形成helper阶段，Finder未运行；停读和精确资源清理由夹具另证。第三AC继续未勾，正在同包只读采样定位焦点原因，旧失败保持。

### 2026-10-15 当前v5真实CLI与正式视觉组合通过

后台隐式视觉已去耦，本地后端 `6ce64a7e` 与当前v5包的v7场1/1、约4.2分钟通过：验收轮询通过时的快照为助手获焦新正式探针0、Finder两窗失焦且15轮采集/OCR均0，两窗口各有自然后台周期中新真实tail启动/exit0/范围接受；不把快照扩展到随后协调交接过渡。正常菜单退出、认证停读及5秒零新增读取通过。前两场焦点失败保留；不计独立顶部持续源、不认证新来信/双联系人/连续OS前台或身份。本场不替代独立Finder录屏预检，该路径明确 `screen_capture_permission_missing`，所以第三AC仍未全完成。数据范围、版本及精确清理见[真实组合报告](../../foreground-contact-follow/real-cli-visual-20261015.md)。

### 2026-10-15 当前签名包单联系人集成补验

用户已解锁并明确先完成单联系人，双真实联系人和来信保留未验证。按当前仓库规则，主Agent直接执行桌面验收，不再沿用历史另行预约或逐次启动确认。当前外置CLI模式`remaining-nine-final-20261015-v2`经严格签名及17项原生来源核对；正式v5场1/1、约5.7分钟、exit0，真实探针和认证后端取得预期单联系人的新鲜验证绑定，移动/缩放后重新匹配，访达前台采图/OCR为0，助手获焦停止新观察并保留草稿，返回私聊恢复。独立群聊场暂停生成并返回原私聊，完整通过。

最终7模块公共HTTP117/117覆盖内容隔离、草稿恢复、删除/撤销和旧响应竞争；会话重名与改名的实际消歧拒绝来自另一个单帧模块，不能用同名内部联系人的草稿隔离代签。本轮在desktop目录执行`NOTALONE_DISABLE_DOTENV=1 node --test --test-reporter=tap --test-concurrency=1 --test-timeout=20000 tests/single-frame-foreground-http.test.mjs`，当前6/6通过、0跳过/失败、23.799628875秒，实际Conda NotAlone运行；该模块包含模糊同名要求选择、改名拒绝、质量及已有绑定/手动门。日志为`desktop/artifacts/remaining-nine-final-ambiguity-20261015.log`。两组证据与当前实机共同完成第二AC。实机单联系人结果与合成错误分支分别计证，不称所有歧义场景都已实机复现。匿名计数、耗时、版本、失败保留和清理见[06最终报告](../../foreground-contact-follow/acceptance-06-final-20261015.md)，群聊见[独立验收](../../foreground-group-manual-acceptance/acceptance-20261015-final.md)。

第三AC仍未全满足：本场CLI为合成适配器，未完成当前包真实CLI与视觉同时运行的独立性组合；现有系统录屏条目指向旧Swift包，不能认证当前Electron宿主及探针责任归属。正式单帧观察可工作不替代权限身份核验。辅助顶部变化源已接入但持续流/实际切换加速尚未认证，另由事件票跟进，不把其启动或周期识别当作加速通过。整票保持claimed，下一步仍由Agent推进。

- 2026-10-15（可视窗反馈续修）：首轮正式可视窗被用户否定，接续修复为持续刷新、固定失败环节与原因、人工点击即时反馈和不依赖匹配的结束。旧界面接线及首个投影前结束动作的页面失败均已复现后修复。安全61/61、前台Python75/75、认证HTTP3/3及同HTML页面1/1通过，新正式候选包和严格签名／14项源码摘要核对完成；真实App未启动，原现场故障和本票AC不据此勾选，仍claimed／ready-for-human。详见[持续预览修复与验证](../../foreground-contact-follow/app-integration-18.md#2026-10-15-持续预览与反馈修复)。

- 2026-10-15（正式App集成续接）：用户签收可视前台判定后要求继续18。受控回归确认并修复“未取得系统前台应用被写成微信非前台”，正式原生观察改为固定未知失败，后端保留原因并由助手明确显示；不放松窗口、绑定、质量或单帧门。短进程元数据对照正常，但未证明该分类问题就是第四轮现场矛盾的全部根因。原生71通过/2默认跳过、前台Python75/75、host21/21、真实认证HTTP组合4/4、桌面安全53/53及后续协调器10/10通过。新正式arm64候选包构建、严格签名及14项源码摘要核对通过，尚未启动；两轴评审无待修项。原可视预览635次采样、23次人工一致/0不一致，进程与租约已清理，仍只证明该预览。当前可自主准备项已完成，转ready-for-human等待最新正式包的有限实机验收，不结票或补勾原AC。版本、命令、数据边界及剩余项见[本轮集成记录](../../foreground-contact-follow/app-integration-18.md)。

- 2026-10-14（自动定位可视化验收）：用户确认原位置、移动后及缩放后框选/OCR均正确，三项原生可视化验收通过；不再要求重复缩放。受限预览8分钟正常退出1/1。依据是用户直接反馈，不保存附图或联系人名字，不等同正式App联系人绑定、1秒预算或权限归属通过；此前偶发布局失败原因仍待查。详见[自动定位最新状态](../../automatic-foreground-locator/spec.md#最新验收状态)，本票保持claimed。

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

- 2026-10-10（22:02待现场认可）：当前源码为已验证的`6771495`，工作树干净且App租约absent；18:12–18:22的提议未获认可且已过期，旧问题的迟到答复不能启动该时段。离线核对当前stdin结束、阶段流和生产Resources解析，没有证明早期真实校验的根因，不据推测改原生门禁或重复已通过的组。下一轮请求为“收到本次明确同意后立即开始的10分钟”、最多1次隔离签名App、由主Agent直接操作并最多查看1次当前微信窗口；不切换/滚动会话、发送消息或请求/接受权限，具体起止时间在执行时写入test:app。待本次有效答复，Triage同步ready-for-human，State仍claimed；不要求用户代操作。

- 剩余证据：新签名宿主下真实前台条件、五处采集及OCR质量形成无图像verified profile；随后在用户已确认的绑定范围核验真实新观察与联系人采用/失效保护，以及小窗获焦暂停、CLI同步独立和实际helper权限归属。当前仅为第一项准备最小现场轮次，不把该有限认可扩展为真实联系人读取授权、权限授予或后续验收。全部验收及Answer保持未完成。

- 2026-10-10（22:06新有限轮次，锁屏阻断）：用户明确同意收到本次答复后立即开始10分钟、最多1次签名App，实际test:app起止为22:06:05–22:16:05（UTC+8）。App68283公开校准说明和坐标表单就绪；主Agent只查看1次当前微信窗口、填写五处几何并尝试提交，无微信会话切换/滚动、发送或权限请求/接受。未出现selection；后续电脑控制表单动作明确返回Mac锁定且无法解锁，已请用户手动解锁。180秒选区等待超时，实际1 failed/CLI1，无selection、校验结果或profile，探针是否执行未证明，不能把锁屏观察作为早期原生失败根因。App68283、worker68282、userData和租约核验absent，未重启或终止未知进程；无图像审计在desktop/artifacts/mac18-minimal-layout-20261010-2206，不提交。源码/测试未改，不重跑已通过组；待电脑解锁及下一轮独立有效时段认可，仍claimed/ready-for-human、验收未勾、无Answer。

- 下一轮前置顺序：用户的“已解锁”只证明解锁，不授予另一次启动。取得独立有效有限认可后，消耗App额度前先通过支持的电脑控制只读状态及当前微信窗口核对；接口报告锁定或不可操作时不启动。AX元数据或窗口Raise不能证明原生前台条件，后续仍以真实校验阶段为准。只读检查不得切换/滚动会话、发送消息或扩大已认可的窗口观察次数。

- 2026-10-10（22:57–23:12，真实窗口失败分类）：用户明确授权直接操作电脑收尾，本轮先限定 22:57–23:17、最多两次隔离 App。首轮公开提交通用失败，无 selection，正常菜单退出并以 SIGINT 收尾（130）；第二轮使用新增安全诊断包，实际 1 failed、24.4 秒、exit 1，明确 `selection / calibration_context_unavailable`，无 OCR/profile。补充分支白名单后，用户再明确同意十分钟、最多一次；23:11:25–23:21:25 唯一轮次实际 1 failed、23.5 秒、exit 1，明确 `calibration_windows_ambiguous`：同一微信 PID 的屏上 layer-0 窗口超过一个。CUA 窗口菜单只列一个主窗口；未猜测其他窗口类型，未放宽唯一性门禁。三轮均回收，最新租约 absent；未发送、滚动、切换会话、申请权限或保存原始图帧。
- 本轮选区失败从通用说明改为固定安全错误码、中文说明与 0600 结果；公开验收遇真实失败立即保留安全结果，不再无信息等待 180 秒。原生 read 保留 nil 失败契约和全部门禁。持久化白名单测试实际 red→green，npm test 类型及安全 40/40，原生 MinimalRegionLayoutTests 3/3，构建和 ad-hoc 严格签名通过，独立两轴均 0。无图像审计见忽略产物 `desktop/artifacts/mac18-context-verification-20261010-2311/`；不以这些验证结票。下一步先确认多窗口最小几何及主窗口判定，再验五处采集/OCR/profile、绑定采用和焦点保护；仍 claimed，真实验收与 Answer 保持未完成。

- 2026-10-10 23:30：受控元数据诊断确认同 PID 两个 layer-0 窗口为 52×20 与 1072×846；临时诊断已移除。仅排除宽≤100且高≤40极小辅助窗，其他未知窗口与多聊天窗口继续拒绝。公开纯边界 red→green、布局/门禁 9/9，签名包真实选区保存成功。23:24 与用户追加认可的 23:28:04–23:38:04（最多1次）均在一分钟后返回 context / wechat_not_in_front；未采集、申请权限或形成 profile，租约 absent。等待核实手动切前台时机；不把已修复选区当作定位通过，所有验收项保持未完成。

- 2026-10-10 23:34：用户亲自切微信前台，有限轮次23:34:28–23:44:28最多1次实际运行34.9秒。选区成功，原生已越过context/capture-setup/sentinels-before，停于names / quality_unverified。前台操作问题已在此轮排除；屏幕录制静默预检及最小区域采集执行，没有新权限申请、原始帧持久化或verified profile。runner退出1、租约absent。待区分名称单行/边界检查、两名称一致性或置信度原因，不降低阈值、不提前勾验收。

- 2026-10-10 23:39：新增四种固定名称失败码，原完整单行/双名称一致/0.90门槛不变，无识别正文或图像日志。原生分类red→green，布局安全10/10、桌面类型与安全40/40，独立Standards/Spec均0，签名包通过。用户明确同意23:39:06–23:49:06最多1次，保持原五区、手动前台，25.0秒明确names/session_name_confidence_low：完整名称及一致性通过，最低OCR置信度不足0.90。尚未区分图像采样与短名称评分原因，不能降低门槛；无profile，实际定位验收继续未完成，租约absent。

- 2026-10-13（持续目标诊断准备）：用户本轮解除OCR暂停，允许必要代码与验收工具修复，主Agent拥有串行桌面验收权；子Agent只准备代码与合成回归。最新已知现场失败仍是`names/session_name_confidence_low`，没有新的真实采集或profile。校验JSON及0600安全结果新增严格9字段的纯数值`name_quality`：三次OCR置信度、两处实际小帧宽高、像素缩放与名称采集/识别耗时；未知字段、字符串、非法/过量数值被拒绝。数值不进入profile、身份匹配或采纳门；session继续使用顶部与复读最低分及选中行0.90门槛，采集矩形、次数、前台与权限预检、OCR参数和内存帧政策保持。安全保存实际red缺分项→green3/3；Swift新增接缝编译red→相关11/11，Python probe/host39/39，完整桌面类型/安全47/47通过。尚未运行真实App/probe/微信、浏览器或模型，不宣称低置信度根因已修复。记录与下轮最小入口见`.scratch/unfinished-work/goal-ocr-20261013-diagnosis.md`；两轴、实际轮次与清理随后追加，所有验收与Answer仍未完成。

- 2026-10-13（末次前台上下文诊断准备）：Root第一片新包实际场次a选择保存成功，终态`context/wechat_not_in_front`，约2.5分钟、1 failed，未采集、识别或形成profile；具体时间/清理以Root台账为准。只读源码表明先要求唯一运行实例再核前台PID，不会凭CUA同bundle库存或最大窗口猜选。为下一有限场次增加failed/context严格7字段的固定App分类、PID、实例数与安全码，无路径、bundle原文、标题、名称或图帧；primary安装位置分类不是签名认证，多次查询不是原子前台证据，不授予采集/身份资格。原唯一实例、前台PID、窗口/几何、0.90门保持。新增安全保存实际red→green4/4，Swift纯接缝编译red→12/12，桌面类型/安全48/48及构建通过；子Agent实际App/probe/桌面/模型0，未以合成绿灯认证实机。现行spec同步，详细预测与代码索引见`.scratch/unfinished-work/goal-ocr-20261013-diagnosis.md`；两轴后再交Root冻结新包。所有验收和Answer仍未完成。

- 2026-10-13（解除暂停后的最小采集与低置信分项）：Root按有限test:app／共享租约串行执行C／D／E／F各1启动，保留前三场capture0与F低置信失败。必要身份四布尔诊断d166a0f3没有新OS查询或放松门，新D包ASAR376c9a53…／11native摘要32315b3e…及签名、六dist逐字核同。F入口96.388301375秒／exit1，实际到names：顶部180×50／0.5、行160×40／0.3000000119、复读0.5、scale2、634ms；固定代码路径先核三非空同名再因不足0.90停止，无profile／绑定。源路径推断3细条＋3名字共6成功最小调用，非独立帧计数。结合E实际非前台context停采，仅第1条采集边界获得实机证据；重名／改名／失效／生成保护、焦点与CLI独立及TCC责任归属仍未验，第2／3条不勾。实际预检成功不等签名权限归属已认证。F14个已记录PID和userData gone、leaseabsent、294包项／strict不变，其他历史个体资源覆盖不足保留；发送8／来信0不变。见[四场实测及收尾](../../unfinished-work/goal-ocr-front-context-20261013.md)，原失败、State／Triage／依赖保持。


- 2026-10-13（录屏权限归属独立核查）：Root只读查看实际系统设置已开启的NotAloneApp条目，并在Finder揭示旧Swift `macos_app/build/NotAloneApp.app`／`com.notalone.app`；当前D包为Electron `com.notalone.desktop`、ad-hoc／无Team，不能沿旧条目认证新包责任归属。未改权限／签名、未新启动／采集／模型／发送，也未保存图像或账号／证书主体；未知归属Finder窗口保留。F可用预检和采集边界证据保持，原第三AC仍未勾，其他AC／State不变。见[最小核查证据](../../unfinished-work/goal-ocr-permission-attribution-20261013.md)与[权限台账](../../../docs/macos-app-permissions-and-errors.md)。

### 2026-10-16 微信正向未达与用户暂缓现场验收

[同v9 Tab30场](../../foreground-contact-follow/real-cli-visual-v9-tab30-result-20261016.md)在微信25秒门原判失败：窗口内12次完整paused，采集/帧/OCR均0，无recognized或manual_required；未到helper、新自然tail、Tab或Finder，不能评价持焦或倒推名称不匹配。9个归属PID、准确随机库/fixture/userData/租约及恢复pair2文件6目录已清，默认目录只核metadata前后相等，ASAR/签名未变。既有Finder权限责任与源停止分项保留，AC3未勾，State claimed。

[后继置前计划](../real-cli-visual-v9-physical-front-plan-20261016.md)两轴0后，执行前坐标接口实际不支持，键盘路径未可靠选中原验收目标；没有新场资源。用户明确选择“稍后再做桌面验收”，因此下一处理角色改ready-for-human，等待其恢复现场后由Agent继续；原范围授权保持，不将工具缺口解释成缺少授权，不自动启动。

### 2026-10-18 恢复后的当前版本阶段结果

本轮已恢复真实桌面验收授权，当前稳定产品基线 0702940 新包已构建并核严格签名。新包实际提示缺少屏幕录制权限，选择稍后；系统既有 NotAlone 开关 on 仍不能证明当前包获准，用户已明确允许本次重新登记并开启，待下一桌面窗口执行；尚未授予新权限。a68ad7eb 修复包后端已实测测量器 installed 恰 1，仅签启动器，不签视觉计数；当前正式识别/助手停采/CLI 独立组合或权限责任验收仍未完成。既有历史分项及原 AC 保持，见[本轮阶段结果](../../real-chat-app-e2e/result-20261018.md)。


### 2026-10-18 当前包权限核验仍待

录屏重新登记已获范围授权，但系统添加要求本机解锁，未完成并安全撤回；没有授予新权限。当前包 installed 已实测，正向截图/OCR、助手停采与 CLI 组合仍无通过证据；CLI 接入在当前 App 责任链也发生 AppData 批准等待，不能以其他宿主的空窗口预检代签权限责任。App/后端与自有 CLI 已停，原目录恢复，原 AC 保持，见[本轮结果](../../real-chat-app-e2e/result-20261018.md)。

### 2026-10-18 Agent 快速验收最新结果

当前包已按批准路径处理录屏登记，但启动仍有缺权限用途提示，本段选择稍后，正式前台识别及助手焦点组合未通过。重复系统密码框已定位为验收中途撤销再登记 FDA 的 Agent 流程错误并修正，未改变产品门禁。CLI 接入元数据与绑定已恢复，第 01 条本机收取但 CLI 未返回正文，先由 Agent 定位；普通验收不再等待用户。原 AC 未新增勾选，见[最新阶段结果](../../real-chat-app-e2e/result-20261018.md)。
