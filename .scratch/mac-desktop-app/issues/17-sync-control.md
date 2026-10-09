# 17：同步开关、停读与补齐

Type: task
State: claimed
Triage: ready-for-agent
Blocked by: 16
Spec: ../spec.md

## 交付行为

启停已确认范围的后台同步，查看补齐进度、暂停、失败与恢复。

覆盖规格用户故事：44、46。

## 验收条件

- [ ] 正文受运行时、总开关和 active 确认绑定共同门禁；关闭、撤销与退出停止新增读取。
- [ ] 恢复仅在原确认范围补齐，展示不完整、暂停、失败及显式重试；不推进失败游标或扩大范围。
- [ ] 与前台定位分别显示状态；权限/CLI 错误沿用安全说明，合成接缝不被描述成真实微信通道已验收。

## 测试与范围

- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Comments

- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。

- 2026-10-09：按主 Agent 安排从固定 `e1bfe74c298a37c2275c597b7f5e2f5e104df1d4` 的独立 `codex/mac-app-17-sync-switch` 领取。当前仅静态准备首条公开页面反馈与既有 HTTP 契约方案；复用任务16已确认范围和合成CLI生命周期，不重写同步算法。19独占运行，本树不启动PG／HTTP／浏览器／App；共享main／PageHost／renderer／受限登记仅交最小patch供主Agent串行处理。任务保持claimed，无Answer，验收条件未勾选。

- 2026-10-09（首片仅静态准备，未取得实际red）：新增单条共享公开场景及普通wrapper：在真实已确认A／未授权B范围中，经生产同步页的总开关开启、关闭，以真实sync状态／联系人消息接口与本轮合成CLI tail记录核对关闭成功后后续周期零新增读取，不直接读业务表。复用BindingFixture认证stopped、owned child正常退出和精确本轮库回收；未知沿既有marker／诊断保留。当前UI只有绑定授权管理、没有总开关控件，实际页面尚未运行，不能将静态缺项判断记为red／green。受限case `sync-switch`最小登记patch与后续getState／refresh／enable／disable的具名契约方案交主Agent，未编辑共享宿主、登记、BackendHost或ReplySession；先取得实际red再最小green，后续pause／retry／失败／迟到分片推进。类型、构建、42输入无原生入口的静态依赖编译、固定差异与20票字段／DAG／链接检查通过；本轮只复用获准node_modules软链，没有安装／下载或任何HTTP／PG／浏览器／App／模型／原生／私人数据操作，17继续claimed、无Answer。

- 2026-10-09（首场实际red）：合入主线59a442b，按冲突处理技能保留27项双方登记与消息事件；类型、构建、43输入纯依赖（原生入口0）及差异检查通过。固定源bc782d98252a51ed3c8a1d505dbcb0e14003be09在唯一授权时段执行Conda受限sync-switch单组180秒，实际11.8秒exit1：真实确认A／默认off／tail空通过，首个产品断言找不到“后台 CLI 同步”区域内“开启后台同步”按钮（5000ms），尚未进入启停写入断言，不能称green。正常PageHost认证stopped、owned backend exit0，精确本轮库drop及只读catalog absent；36 captured identities和owned groups无存活、双lease absent。Chrome1，quiet14 active0/window0，cleanuptrue；RSS采样browser869520/node168528/backend156832 KiB不是物理上限。证据context17-first-red-bc782d9-*。运行权立即归还主Agent；共享6文件外部接线patch仅供主Agent串行，未应用。18新观察契约独立，17仅展示最近同步报告，不猜当前联系人。下一turn推进已授权17自有新文件最小green，运行仍待另分配；无App／微信／原生／模型／安装／私人数据，仍claimed、验收未勾、无Answer。

- 2026-10-09（最小装配复核尚未green）：自有六模块28b0c19经root串行装配后FF固定源77da3d81f4baec3dda9a5aa009d70f07dfab09ee。类型、构建、49输入普通依赖（原生0）、10输入preload及28项登记检查通过。单次Conda受限sync-switch180秒实际12.4秒exit1：区域与开启按钮出现，初始“后台正文同步已关闭”未出现，尚未进入启停写入断言。正常cleanuptrue、PageHost认证stopped、owned child exit0；42 captured identities及groups无存活，精确本轮库已drop且只读catalog absent，双lease absent，立即返运行权。Chrome1 quiet14 active0/window0，RSS采样browser871600/node162480/backend183792 KiB非物理上限；完整context17-first-green-77da3d8-*失败证据保留。静态核验前后台有限enum与真实JSON来源一致，不放宽范围或解析。SyncHost初始化报告可能未播种，原面板进入时只读缓存；最小补一次真实状态刷新，不触发cycle/check或自动轮询，并在原场景增加真实报告enum与公开bridge初始关闭状态反馈。失败时具体公开state未采集，不将该时序宣称已实证唯一原因；修复只做静态检查，实际green等待下一授权。无App／原生／微信／模型，仍claimed、验收未勾、无Answer。

- 2026-10-09（初始化修复静态准备）：原公开场景补充首份具名bridge报告的phase／enabled／busy／errorCode及前后台phase，失败时追加面板公开alert；不读取token、正文或控制器私有状态。`npm run typecheck`、`npm run build`、70输入headless runner及10输入renderer只编译依赖（原生入口0）、`git diff --check`通过；单独静态依赖命令曾因入口路径与输出format配置失败，改用实际tests/headless入口和ESM／IIFE后通过，未执行编译产物。本轮没有启动HTTP／PG／Chrome；进入面板的单次GET修复尚未复跑，不能称green，运行权仍由主Agent协调。

- 2026-10-09（总开关首片实际green）：最小刷新与公开诊断提交884410f，无冲突合入18记录0778b0e后的固定干净源6a0934f66d57a87f47de644b1298464efd729741，类型、构建、74输入runner／11输入renderer纯依赖（原生0）通过。唯一明确授权中，以Conda运行`npm run test:pages -- --case sync-switch --timeout-seconds 180`，实际8.6秒、CLI exit0、单场sync-switch-stops-reading 1/1；首份公开报告ready／enabledfalse／busynull／errorCodenull／backgrounddisabled／foregroundsync_disabled，真实HTTP开启与关闭、已确认A增量、未确认B零正文，以及关闭成功后的两次显式测试周期零新增tail均通过。正常cleanuptrue、PageHost认证stopped、owned backend61043 exit0；34 captured identities与owned groups无存活，精确本轮notalone_binding_77c1e33592604eb182472b487caedbe7_test已drop且只读catalog absent、双lease absent。Chrome1 quiet9 active0/window0，RSS采样browser863968/node181968/backend153248 KiB非物理上限；context17-rerun-6a0934f-*完整证据保存，旧77da失败不变且不补记green。运行权已明确归还主Agent，之后本轮没有再启动HTTP／PG／Chrome。仅此总开关普通接缝通过，补齐／暂停／失败／显式重试等后续切片与App／原生验收尚未完成；不推断最初失败的唯一原因，仍claimed、验收未勾、无Answer。

- 2026-10-09（补齐下一片仅静态准备）：无冲突合入主线b252130保留15来源删除及18前台观察全部接线与case。新增单条公开sync-backfill-retry场景：沿真实status、生产页面和既有合成CLI，空tail预期无法确认完整，暂停后空正文预期真实解析失败，恢复同local_id1再由用户显式重试补齐；以公开游标／消息和onlyA tail核对失败不推进、未确认B无正文。复用同一BindingFixture／PageHost生命周期，没有改共享fixture或同步算法，也没有预先新增UI／投影／控制器能力。类型、构建、83输入runner及55输入sync wrapper纯依赖（原生0）、差异与外部最小登记patch apply-check通过；该新场尚未运行，安排断言若失败须先如实区分接缝错误与产品red。当前既有UI没有历史补齐区域或暂停／重试入口，不能用静态缺项冒充实际red。主Agent仍协调运行权，本轮静态准备未再启动HTTP／PG／Chrome，仍claimed、验收未勾、无Answer。

- 2026-10-09（补齐首场实际red）：FF主Agent已登记且保留15多来源入口的固定干净源d54d19d6c3237dc109ca1c98b5c84527977b8153。唯一授权下运行Conda受限sync-backfill-retry单组180秒，实际12.4秒CLI exit1：真实开启及status安排通过，报告incomplete／cli_freshness_unknown、completed0、cursor null；首个产品断言5000ms找不到“历史补齐”内“无法确认补齐完整性”。尚未进入暂停／失败／重试断言，本轮不改产品、不追加green或其他组。正常cleanuptrue、PageHost认证stopped、owned backend64409 exit0；44 captured identities与owned groups无存活、精确本轮notalone_binding_095101cf7a214165bf96b65c2f954437_test已drop且只读catalog absent、双lease absent，运行权立即明确归还主Agent。Chrome1 quiet14 active0/window0，RSS采样browser871840/node185472/backend153520 KiB非物理上限；完整context17-backfill-red-d54d19d-*失败证据保留。外部observer此前替换case时误改工作树路径导致模块导入失败，尚未启动CLI或任何资源，独立保存prepare-failure，不计产品red；修正后仅执行上述一个实际CLI。之后仅记录与差异检查，无App／微信／原生／模型，仍claimed、验收未勾、无Answer。

- 2026-10-09（补齐最小产品片仅静态）：取得上述实际red后，仅扩展17六个自有模块：投影既有有限补齐phase、非负安全计数及稳定失败码，新增历史补齐状态／进度／安全错误说明与显式暂停、重试按钮。两具名操作仅manager、只接受当前scopeRevision，向既有背压互斥HTTP端点发送固定空对象；复用单操作／Abort／连接代际／范围／epoch门禁，结果不改总开关且迟到不发布旧报告。暂停与总开关停止分别说明，失败不折算为零消息或完成；不增加算法、自动重试、轮询、cycle/check、正文／token／游标或当前联系人投影，也未改共享AppBridge／host登记。类型、构建、83输入runner／12输入renderer纯依赖（原生0）、六handler角色／固定路径／无调度只读检查与差异检查通过；附加AST脚本因安装的TS7未提供旧编译器API而退出，未作为验证通过记录，改用只读登记检查且不替代类型或行为验收。新产品片尚未实际green，运行权已归还且本轮未再启动HTTP／PG／Chrome，仍claimed、验收未勾、无Answer。

- 2026-10-09（补齐首片实际green）：最小产品425ad2b经主Agent合入15／18新接线后，FF固定干净源5dc209335d221bf082a23e2360c6abe7b668eb07；合后类型／构建／差异／DAG已由主Agent核验。唯一明确授权中运行Conda受限sync-backfill-retry单组180秒，实际7.7秒CLI exit0，sync-backfill-retries-confirmed-scope 1/1：真实不完整／cli_freshness_unknown提示、用户暂停且总开关仍on、空正文真实解析失败／cli_output_invalid且cursor null与A无消息、修正同ID1后只读状态仍失败、用户显式重试完整／A唯一消息／B空／全部tail仅A，最后生产页面关闭均通过。本轮未追加另一场，不把旧source总开关通过写成当前source累计通过。正常cleanuptrue、PageHost认证stopped、owned backend66905 exit0；39 captured identities与owned groups无存活，精确本轮notalone_binding_b2289cc2fa3b4240a2d66e68fcf5c794_test已drop且只读catalog absent、双lease absent。Chrome1 quiet9 active0/window0，RSS采样browser862400/node186800/backend152000 KiB非物理上限；context17-backfill-green-5dc2093-*完整证据保存，所有旧red及observer准备失败不变。运行权已立即明确归还主Agent，之后本轮只记录与差异检查，无额外HTTP／PG／Chrome／App／原生／微信／模型；尚未进行最终全相关场景、两轴评审或原生验收，仍claimed、验收未勾、无Answer。

- 2026-10-09（最后公共安全矩阵仅静态）：保留1aed真实证据并无冲突合入主线c810f376的前台人工确认接线。新增单条sync-arguments公开场景，预期helper六具名操作被拒、管理页四写操作的80项缺参数／非法值／额外owner/contact/url/path/role命名字段被拒，以及通过公开联系人桥切范围后四个旧scopeRevision请求被拒；随后用真实sync/status仍off、A/B无消息且tail0核对没有启动正文读取。非空请求只改变单个命名对象，不增加额外位置参数，不从renderer伪造宿主角色或调用控制器／传输内部接口，也没有纯镜像检查、HTTP成功mock或产品改动。复用原认证生命周期；类型、构建、84输入runner／56输入sync wrapper纯依赖（原生0）、差异及外部最小登记patch apply-check通过。新安全场尚未运行，80等仅为准备数量，不能称实际拒绝通过；所有共享registry保持原样，登记交主Agent串行。当前无runtime授权，本轮没有HTTP／PG／Chrome／App／原生／微信／模型，最终同源两行为＋安全场与独立两轴尚待，仍claimed、验收未勾、无Answer。
