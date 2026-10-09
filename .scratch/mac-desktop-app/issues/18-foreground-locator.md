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
