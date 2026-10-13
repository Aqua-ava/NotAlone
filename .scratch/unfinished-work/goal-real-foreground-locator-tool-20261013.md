# 真实单联系人前台定位验收工具准备

本切片依据原 Mac18/20、微信04及主 Agent 在 2026-10-13 的必要验收工具授权。只修改测试夹具、受控解释器和独立证据；生产定位器、探针、签名包、权限、绑定门、0.90 质量门和默认读取范围保持原样。当前 G 实际校准尚未完成，准备不是校准、真实 OCR、真实渠道或 TCC 通过证据。

## 有限入口与前置证据

新增单个默认跳过的 `real-foreground-locator-acceptance.spec.ts`。真实执行只由主 Agent 使用 `test:app --interactive --coordinator main-agent --from … --until … --max-launches 1`，场次至多 10 分钟、用例至多 420 秒；准备阶段 App/CLI/Vision/PG/HTTP/模型调用均为 0。旧真实正常退出夹具默认行为和原用例不变。

显式新模式要求主 Agent 新建 0600 私有凭据，绑定本次已认可单联系人的私有 scope、实际显示名、E App/ASAR/Resources 原生组摘要，以及 G 本场成功结果、原样 profile 和主 Agent 实际成功收据的摘要。输入不得含未经实际校准认证的 profile；缺失、失败、摘要漂移、包外探针、链接/硬链接、宽权限、过期范围都在启动 App 或创建测试库前拒绝。收据是主 Agent 对实际场次的证据声明，文件一致性不自行认证 TCC 责任归属或发行者。profile 不改 PID/windowId/geometry/sentinels，原样复制到自有隔离用户目录，并同样显式提供给预启动 Node→Python 后端。App 与后端均使用同一 E Resources 签名探针。

私有身份、profile 数值、CLI 元数据、正文、令牌、原始异常和视觉帧不得写进公开证据或源文件。Root 提供的凭据路径属于运行参数；本切片不读取现有真实 scope 或私人资料。

## 最小测试工具范围

1. `desktop/tests/real-sync-quit-fixture.ts`：只在显式新模式核验凭据、提供真实 probe/profile 和实际绑定显示名，保持旧默认占位探针。
2. `desktop/tests/fixtures/real-sync-python.py` 与 `backend/tests/unit/wechat_cli/test_acceptance_scope.py`：只增加新模式允许的实际显示名元数据查找；真实 query 截止不超过 0.25 秒，超时只终止已拥有的查询 PID/group。`sessions` 保留所有类型和重复条目，端侧丢弃 `summary`、`last_sender_display_name`；不以正文授权 locator 过滤成假唯一。tail/follow 继续仅认可 scope 与约定测试文字。
3. `backend/tests/integration/server/real_sync_quit_support.py`：显式新模式从已验证私有凭据读取绑定显示名；不扩大测试库归属与删除范围。
4. 新的私有文件验证 helper、合成负控与默认跳过的单用例：只经公开菜单、foreground/contact/binding bridge 和认证 HTTP；不新增产品 API、不替换正式 controller、不自动重试/切换/发送。
5. `desktop/tests/contact-http-proxy.ts`：显式新模式仅记录原认证 foreground observe 的固定阶段、布尔和计数；不延迟、不改响应，不保存原正文或身份。
6. 本证据文档。生产/native 文件与默认放行表均不在修改白名单。

## 实际检查点与停止条件

真实阶段由主 Agent 串行操作，并在各检查点将当前已授权微信会话置前，另写本次 nonce 对应的实际操作与新鲜观察收据：公开菜单触发真实 observe，核唯一已验证绑定；已有草稿时要求显式确认且保留草稿；撤销本轮绑定后定位不得自动确认；小窗前台暂停新的 fresh observe，同时已确认范围 CLI 后台读取独立；最后公开正常退出、认证停读、已记录自有进程消失与退出后 5 秒无新启动。

任何 profile/context/权限/身份/质量失败、元数据超时/歧义、非约定正文、范围届满、额外隐式调用或收尾不确定即停止，不进入下一实际场。不发送消息、不生成候选回复；是否安排新增约定测试文字另由主 Agent 沿当前发送上限执行。低置信度/重名合成控制与实际单联系人观察分列，不能代替双联系人、来信事件或实际 TCC 链证明。仅从冻结源代码推断的 helper 前台采集前拒绝必须标为推断，不冒称独立帧计数。

## 验证与当前记录

准备先以已有公开合成对象验证：旧模式元数据仍拒绝；新模式全部同名私聊/群聊均保留；内容摘要被丢弃；非认可关键字/宽列表拒绝；查询超时只回收自有对象；G 失败/缺失、错误摘要/包成员、私有文件边界拒绝。随后最小 TypeScript/相关纯 Python 回归和独立两轴评审。当前这些新增控制尚未运行；不把预注册或编译当实际通过。

读取路由中的一次错误路径 `desktop/src/main/backend/calibration-profile.ts` 与不存在的 `foreground-observation-http.test.mjs` 已纠正为实际 `foreground/calibration-profile.ts` 和既有测试入口；均为只读工具失败，未启动产品或形成产品 red。

## 已实施的测试接线与准备验证

上述“尚未运行”是修改前的准备快照。当前九路径仅属于测试工具：五个既有夹具/支持文件、`real-foreground-credential.ts`、`real-foreground-credential.test.mjs`、默认跳过的 `real-foreground-locator-acceptance.spec.ts` 及本记录。生产/native 源、E App 和原真实退出用例未改。

私有凭据入口为 `NOTALONE_TEST_FOREGROUND_CREDENTIAL`，显式新模式为 `NOTALONE_REAL_FOREGROUND_LOCATOR_ACCEPTANCE=1`。完整键集合为 `schemaVersion=1`、`purpose=real-foreground-locator-acceptance`、`displayName`、`scopePath`、`scopeSha256`、`appExecutablePath`、`appExecutableSha256`、`profilePath`、`profileSha256`、`verificationResultPath`、`verificationResultSha256`、`calibrationReceiptPath`、`calibrationReceiptSha256`。Root 收据须使用 `kind=root-foreground-layout-verification`、`candidate=E`，实际单次启动及原生校验成功/原样从 App 取得 profile 的严格布尔声明，明确 `probeSubstituted=false`，并绑定同一 App、profile、结果和 E 原生/ASAR摘要。此收据由 Root 根据实际 G 生成，不由该夹具代写。只有完整原始成功证据及固定 E 字节均一致才进入后端准备。

App 与预启动后端均设置同一个 E Resources 探针；后端读取自有隔离副本，App 在第一条公开定位操作前将同一原字节复制到自有 userData。没有改 profile 的 PID、窗口、几何或细条摘要。E 主可执行文件、ASAR、Core、probe 字节以及原生组摘要被固定，沿既有生产包内验证器读取原 manifest，不执行二进制。Node 生成的私有 target 投影有独立摘要，Python 校验该摘要和原 scope 摘要，名称或范围漂移即拒绝。新模式要求新的空审计账本及最多 600 秒 scope/剩余租约；旧默认 30 分钟/可选75分钟正文范围不变。

真实候选查找只允许认可名称的 `sessions --keyword … --type-filter all --limit 51` 及同名 `resolve-chat`，所有原类型/重复候选保留，正文 tail 与全局事件游标仍沿原范围。查询的单调 0.25 秒预算从实际进程预写前起算，启动前/返回后再核期限；超时只回收自有查询。元数据账本仅记录数量、类型分项和同名数量，无名称、用户名、摘要、发送者或参数。重名私聊/群聊的合成对象确实进入当前生产 `ForegroundLocator.observe_fresh` 并返回 `ambiguous_requires_selection`，不以计数测试替代实际重名或双联系人。

公开传输代理仅观察原认证 fresh 请求与返回，均上限4，保留固定结果码/布尔；失败或多出请求不可签为通过。单用例的三个手动前台检查点分别为首次定位、已有草稿再次定位、撤销后再次定位；另一次真实 helper 前台 backend observe 用于验证暂停。保留原所有产品门，没有自动重试、候选生成或发送。CLI 完成读取、去重/引用/消息数量、正常菜单退出、认证停读、已记录 PID/group 消失及5秒无新启动分列。未知响应/账本不能归零；不完整收据不签通过。TCC 两条责任链、完整 OS/帧计数覆盖和对方来信/双联系人仍为未认证。

实际最小反馈如下：

- 新模式同名控制首次真实 `acceptance_session_listing_blocked` red，修后同名私聊和群聊均保留且预览两个字段为 `None`。这是测试工具行为 red，不是供应商/OCR red。
- 0.25 秒控制顺序旧30秒版本实际失败 `CliCommandError not raised`（1项／0.002秒），修后受控 timeout 与自有 `-9` 收尾通过（1项／0.004秒）。更早一次误将异步调度尚未加载源码的日志命名为 red，却得到 green；该日志保留，不充作 red，之后已按顺序取得上述真实反馈。
- 当前相关模块20／20通过（0.398秒），外层拒绝 socket/DNS/subprocess/根 `.env` 的守卫记录尝试0；其中新增迟到结果、错误关键字/宽列表、同名 resolver、私有目标漂移控制首次即绿，不虚构 red。
- 专属 Node 四项文件/协议控制全部通过；完整 G/E 控制使用 E 已核公开字节的端侧临时副本和合成 profile/Root 声明，仅验证文件合同，不代表真正 G。没有执行/载入 App、probe 或动态库。默认缺少显式静态包参数时该项跳过；其余控制不依赖产物。
- `npm run typecheck` 最小通过。两 Python 工具源码 mypy 首次2项错误（新增可选字段与动态路径展开的类型推断、原 runner 联合类型），经显式字段和等价分支收束后2文件通过；不是产品/OCR语义 red。首轮19项 Python 和3项 Node先绿也保留。

准备期间 App、真实微信 CLI、Vision、PostgreSQL、HTTP、模型、外部发送和根 `.env` 读取均为0；只有普通编译/纯文件/合成进程控制。类型和控制通过不能签真实 observe/绑定、权限或实际 Capture。G 未成功时禁止 Root 用该工具启动，实际场另由 Root 登记起止和唯一启动。私有日志初始重定向产生0644，已仅对自有 UID/regular/nlink1 文件改0600并记录；不声明未知文件或全 OS 清理。

## 2026-10-13 新窗口恢复回归

用户明确恢复后，保留九路径现有修改，仅补两处验收工具窄修：三个置前检查点从 `human` 改为 `agent`，沿既有收据协议要求主 Agent 的实际 Computer Use 操作、新鲜观察和本次 nonce，程序窗口状态不代签；受控 Python 解释器用 `setattr` 接入原构造器，动态接缝行为不变。未改产品定位、原生探针、E 包、质量门或批准范围。

[暂停记录](goal-pause-20261013.md)已核实旧私有日志目录缺失。上节历史红绿和耗时仅保留当时报告，本次不补造、不恢复原日志，也不将新绿当历史失败的重新认证。本次另外建立 0700 端侧目录，原命令日志和收据均0600，失败、更正和最终回归各自保存；只使用公开合成输入及固定E的公开文件字节，不执行或载入该包及helper。

| 新实际命令 | 结果 | 命令外层单调耗时 |
| --- | --- | --- |
| Conda `NotAlone` 受守卫 `tests.unit.wechat_cli.test_acceptance_scope` | 首次20／20，unittest 0.813秒；最终20／20，unittest 0.306秒；两次均0跳过 | 首次1.149634167秒；最终0.454321459秒 |
| `NOTALONE_STATIC_E_APP=<固定E目录> node --test tests/real-foreground-credential.test.mjs` | 4／4，含完整合成G/E文件合同，0跳过 | 0.474271084秒 |
| `node --test tests/packaging/native-shortcut-feedback.test.mjs` | Agent／human隔离、旧nonce及否定观察等3／3，0跳过 | 0.282385833秒 |
| `npm run typecheck` | TypeScript检查通过 | 1.343086542秒 |
| 两工具源码 `python -m mypy --follow-imports=silent` | 首次缺 `MYPYPATH`，6项import-untyped配置错误；使用 `MYPYPATH=backend/src` 后2项原动态构造器类型错误；最小等价接线后2文件通过 | 首次1.865991667秒；更正路径1.812398292秒；最终1.261002458秒 |

两次 Python 外层守卫均真实记录 socket、DNS、subprocess 和根 `.env` 尝试为0；测试中的进程返回、超时和退出均为明确合成对象。Node校准声明及profile均为合成文件，固定E仅用于文件校验；成功合同不认证实际G。新增检查没有实际App、微信CLI、Vision、PostgreSQL、模型HTTP或发送。原20／4项历史日志缺失与本次新的20／4项证据须分开读。

最终冻结包含这九路径当前字节、限定差异、八份新命令结果（含失败）及日志摘要；两轴交由 Root 在该冻结上分别检查，完成前不提交或启动。原18、微信04和Mac20现场AC保持未完成：仍需实际G／同E成功定位、草稿保护、撤销后拒绝自动定位、helper焦点与后台同步独立、权限责任链及最终组合；双联系人、对方来信、60分钟真实到达也不由本工具代签。

## 2026-10-13 冻结复核发现的账本失败关闭修复

Spec P2 指向新定位用例的缺账与空集合误签：旧共用 `audit()` 把 `ENOENT` 作为空数组，退出后 `every` 和同数量检查可以同时成立；元数据记录缺失也会输出空数组而保留 `metadataError=null`。仅在显式前台定位新模式接入严格读取，旧真实退出模式的原读取分支及两个原用例保持。严格接缝复用现有纯 Node 凭据测试入口，未增加九路径以外的产品或测试源码。

新模式每次读取自有 0600 账本时拒绝缺失、空文件、过量、链接、身份漂移、半行、非法 PID、未知事件／字段／状态及无效数量；已读行以原行摘要冻结，之后只接受保留全部已知行的追加。退出前必须保存非空实际启动 PID 集合和已知行摘要；退出后保留退出前全部记录，再核当前所有记录 PID／group 消失。五秒复查和最终收据阶段都拒绝任何新 `started`，包括尚无 PID 的 `reserved`。缺少明确 `metadata` 行必记固定 `metadata_count_unverified` 并保持 `partialOrFailed=true`，不将未知数量签为零。

三条垂直反馈均在本次独立取得：先抽出与旧空账／同数量／空元数据检查等价的纯文件接缝取得实际断言红灯，再逐片修复；不是产品、真实 CLI 或旧历史红灯。缺账／空账 red 外层0.145885875秒、green0.227627333秒；非空PID／保留已知行及退出后预约 red0.130577667秒、green0.219159708秒；缺元数据 red0.134796875秒、green0.135516959秒。原始失败和输出均分别保留在本次0700私有产物目录，文件0600；旧缺失日志仍未恢复。

最终 `node --test tests/real-foreground-credential.test.mjs` 17／17、零跳过，外层0.465338167秒（Node报告0.404027667秒），包含固定E公开字节的完整合成文件合同；没有执行或载入E及helper。`npm run typecheck` 通过，外层0.604804625秒。`git diff --check` 对四个工具源码无错误。此次纯文件和编译验证未读取根 `.env`，实际App、微信CLI、Vision、PostgreSQL、模型HTTP及发送均0。原任务现场AC继续保持未完成；新九路径冻结与原v1分列，由Root完成两轴复核和本地提交。
