# 03 私聊历史支持档核验

> 2026-10-30 当前状态：官方 622 原生历史／身份重验／新进程完整重扫已通过；实际 `pnpm run dev` App 已验证指定会话的持久化、读回与同进程 tail。全联系人批量读到 19,927 条文字时被暂停（非最终总量）：native 目录监测把 SQLite sidecar 创建／删除误判为 `source_changed`，留下 24 条围栏。总开关已暂停，当前 0 个 native 进程；等待 native 修复构建与核实恢复。App 新进程续读和稳定日常运行仍未最终验证；89 条原有隔离文字仍不具有普通历史资格。

## 2026-10-30 官方 622 构建的真实历史与增量实测

在已授权的单个私聊来源上，原生端报告 `continuity='same-source-instances-normal-use-v1'`，重新核验账号、SQLite 文件和分片／表实例身份后启动新进程完整重扫，没有沿用旧进程的 opaque cursor，既有本地删除排除继续生效。15 页共观察到 234 条记录：117 条通过当前精确状态规则的文字记录完成正文读取，并确认用户指定的测试文字已找到；114 条状态未知及 3 条已撤回记录只保留无正文状态，未因这些记录阻断后续增量。完整重扫检测到的 `absent` 本次没有独立记录数，按无正文终态处理。随后 15 页 tail 返回 `caughtUp=true`、新增 0 条。

这些数值仅为本次本机实测聚合计数，仓库不保存联系人姓名、消息正文、消息 ID 或账号标识。它证明当前官方 622 原生路径在该授权来源上的身份重验、完整重扫与 tail 行为；没有证明 App 端存储／状态／界面整合、其他联系人的同步、媒体读取、删除链或打包制品验收。正常使用重启的支持范围与相同标识原地回滚限制见 [ADR-127](../../architecture/adr/127-sqlite-history-normal-use-restart-rescan.md)。

## 2026-10-30 实际 App 持久化、同进程追尾与暂停检查点

在正常 `pnpm run dev` App 路径批量读取本机获准范围时，累计入库计数达到 19,927 条文字后暂停；这是进行中的过程量，不是最终总量。指定验收会话中，App 持久化并读回 117 条正文，另有 114 条 unknown 和 3 条 recalled 保持无正文；用户指定的测试文字已找到，117 个 `message_id` 全部唯一。该会话完成 15 页历史读取，再在同一进程完成 15 页 tail，共 30 页；随后空闲扫描没有产生重复新消息。由此验证了此会话范围内的 App 持久化、读回和同进程追尾，不代表新进程续读或稳定日常运行已通过。

批量读取过程中，native 目录监测把 SQLite sidecar 文件的创建／删除误报为 `source_changed`，生成了 24 条持久失证围栏。App 总读取开关已暂停，目前没有运行中的 native 进程。待 native 修复构建后再核验来源身份和既有排除项，再决定是否恢复；当前不把围栏清除或后续新进程恢复写成已通过。

同一 SQLite 只读事务／WAL 快照内对比修复前后的 API 查询；两版聚合结果一致。联系人目录的来源 `EXISTS` 补齐 `contact_id`（[actions.ts:14](../../backend-ts/src/contacts/sqlite/actions.ts#L14)）；coverage 与消息列表也补齐联系人关联（[read.ts:30,55](../../backend-ts/src/history/sqlite/read.ts#L30)）。查询可用现有 `capture_record_message(owner_id,contact_id,message_id)` 索引（[schema.ts:66](../../backend-ts/src/history/sqlite/schema.ts#L66)），无 schema migration。

| 查询 | 结果规模 | 修复前 | 修复后 | 校验 |
| --- | ---: | ---: | ---: | --- |
| directory 非空联系人统计 | 137 个联系人 | 10.075 秒 | 0.035 秒 | 计数一致；EXPLAIN 从仅用 `owner_id` 改为完整关联键 |
| 285 个活联系人的 coverage | 可见消息合计 12,660 条 | 10.901 秒 | 0.031 秒 | 同一只读快照结果一致 |

定向验证（Node 24）：`node --test test/sqlite-contact-binding.test.mjs test/sqlite-history-http.test.mjs test/sqlite-history-guard.test.mjs test/sqlite-private-history.test.mjs` 96/96 通过；`pnpm --dir backend-ts exec tsc --noEmit` 通过。SQL 仅输出聚合计数、耗时和 EXPLAIN，不包含联系人标识或正文。以上为本机实际 App 验证，未运行打包版。

## 2026-10-30 撤回实测结论与证据复用

撤回元数据观察已完成，后续正文同步工作复用下文“用户操作下的发送与撤回元数据观察”和“最终开发制品的状态观察与微信重启复验”的既有实机证据，不再将同一撤回观察列为待测试项，也不重复要求用户发送或撤回测试消息。

已验证范围：同一条本人发送的消息由 `type=1/status=2` 变为 `type=10000/status=4`，本地主键与 server ID 保持一致；观察只读取元数据，未读取正文。该结论不扩展为全部消息状态已认证，也不等同于 App 已同步正文及关联资料的撤回清理、历史／增量同步和跨重启恢复均已通过；这些能力按各自证据单独核验。

## 2026-10-30 新来信的受控元数据与界面核对

在已添加并获准读取的一位私聊联系人范围内，使用当前开发 CLI 的 `observeReceivedTestMetadataSelected('arm')` 建立基线，锁定数为 0；检查 8 个分片、2 个目标消息表。用户确认对方发送约定测试文字后，`next` 只锁定一条新增的 `sender=contact/type=1/status=3` 记录，server ID 已分配。两次 `current` 复查均保持同一本地消息身份与原始状态；随后在实际微信界面核对到已打开的指定私聊及该测试来信。未将基线前的旧消息作为本次样本，未由 Agent 发送消息，没有再次安排撤回。

本次 CLI SHA-256 为 `e42553aaf20a8114818b451ccffb08b7cbd66c9f61397a20b1a8d1fd7cf2f3c0`，WCDB 为 `4f05cafc4626a142afca1818f0a88c4092a13d5f4c83e30cd5125b558ba0417d`，微信版本为 `4.0.6/29387`。观察器只读取元数据，未调用正文分页、媒体读取或模型，结束后显式关闭；截图只用于当前界面核对，不作为仓库产物保存。

这一证据补齐了本次新来信的精确组合观察；不能据旧隔离仓的 `contact/type=1/status=4` 汇总把所有状态 4 解释为正常来信，也不能从消息已显示推导已读状态的数字含义。状态分类仅接受已观察的完整类型、方向和状态组合，未知组合继续不读正文。消息分片／表实例的连续性、跨重启可信映射和完整正文同步仍按独立证据核验，未因这次来信直接开放普通历史。

## 2026-10-30 正文能力状态与首次／增量调度修复（官方 622 实测前检查点）

以下段落记录原生真实读取通过前的检查点；其中关于真实 profile、跨重启正向恢复及正文条数的状态已由本节首部的官方 622 实测更新，App 集成状态仍待验。

原生 profile 已纳入上述三组精确状态规则，报告标记 `observed_subset_only`；整体 `status`、状态能力、来源生命周期、完整历史和增量能力仍为 `unverified`。匿名规则与制品记录见 [observed-states-v1](../../backend-ts/src/history/sqlite/support-profiles/wechat-4.0.6-29387-observed-states-v1.json)。没有把未知状态或旧隔离文字放入正常历史。

状态接口不再永远写死正文不可用，也不根据消息数推断可用。`SqliteHistoryService.bodyAvailable()` 仅复验当前授权下已经存在的活守卫及明确支持的结构、状态、来源、恢复、快照、覆盖和增量能力，不发起新的微信读取；关闭、撤销或失去守卫后返回不可用。已知支持缺口会原样映射为固定错误码，未登记的底层错误不会泄露。首次覆盖尚未建立时也显示实际阻塞原因；正文能力未开放时，界面显示能力核验而非正在同步新消息。

修复同一宿主中首次历史与增量协调器竞争同一联系人：宿主明确由首次协调器负责初读，增量协调器等覆盖完成后才进入 tail；独立使用增量协调器的原有补历史行为保留。回归先复现重复读取，再验证等待期间零首次／tail 调用、完成后只读 tail。

验证：七个相关后台文件通过109项，界面状态文件通过4项，两端 `tsc --noEmit` 通过；固定源码的 CLI／WCDB 两包 `go test -json -race -count=1 -p 2 -run '(?i)notalone' ./cmd/wechat-cli ./internal/wcdb` 通过224项、跳过1项既有安装程序版本测试。测试源码与最终构建源码154个文件摘要一致，最终 CLI 为 `b1eecd3302ffcdec7591e3f56f439028df9de83d9c30aeb6b35c41fa95297663`。复用现有 Node 24、DSH `0.2.1-rc.2` 与 Cordis `4.0.5`；核对安装类型声明及固定源码 `687f282e8625c6b8d11ff58211a90524be2e4317` 的插件合同，本次未改变 DSH API 或插件生命周期。

最终工具已接入 `pnpm run dev` 开发实例，并核对真实微信中的测试来信和 App 的连接／读取开关。未制作或运行打包版；保留原读取开关和285个联系人授权，真实普通消息仍为0条，未调用模型或发送消息。剩余阻断是当前来源协议不能证明跨守卫／重启后的消息身份与排除项映射，以及尚未认证的完整状态、快照与分片覆盖；同一切面的元数据、相同文件摘要或新增测试来信均不能代替这些证明。

## 2026-10-30 状态组合规则与同一守卫内续读（代码与合成验证）

普通历史不再使用状态数字白名单。可信本机 profile 的规则精确匹配完整 `local_type`、发送方向和状态值，独立要求 `StatusSemanticsVerified`，并可要求已分配的服务端身份。sent 仅对应 owner，received 仅对应 contact；未知方向只可分类为非最终状态。高位类型不继承低32位类型的资格，方向矛盾或重复规则拒绝建立快照。只有已认证的 sent/received 会进入普通文字正文查询；pending、failed、recalled、deleted、unknown 保留未核验元数据，不查询正文。隔离入口继续使用原有独立授权。

历史与增量的 `sync_capture` 重放现在同时校验响应摘要、联系人、goal、read_epoch、输入游标和输出游标，且先校验 goal 的操作类型。跨目标、跨联系人或跨历史／增量接口不能凭同一捕获 ID 返回成功；同一目标的原响应仍幂等。合成覆盖旧游标拒绝和删除排除重放，已删来源不会恢复。

正式 `SqliteHistoryService` 合成用例验证：1000页预算用尽后保持不完整，下一次调用在同一个活守卫、同一个固定目标中从已提交游标继续，最终共1001页、2条消息，无重复；真实数据库重开后的旧守卫不能续读，service 在创建渠道或请求页之前拒绝（两者调用次数均为0）。这不是跨重启的正向恢复证明。

最终开发 CLI SHA-256 为 `637be9f5861a0401606beef9e026d7ebf8d1049601fa29f1d40d22a02f1af35d`，WCDB 字节保持 `4f05cafc4626a142afca1818f0a88c4092a13d5f4c83e30cd5125b558ba0417d`。从最终构建源码运行 `go test -json -race -count=1 -p 2 -run '(?i)notalone' ./cmd/wechat-cli ./internal/wcdb`：207项通过、1项既有安装程序版本测试跳过。后台六个相关测试文件累计102项通过；新增夹具修正随机联系人顺序后，单例连续10次通过，相关两文件18项复验通过，其余84项复用有效结果。backend-ts与desktop的 `tsc --noEmit` 通过。独立 Standards／Spec 审查均无阻断，夹具修正另经 Spec 窄复核。

复用 `pnpm run dev` 实际 App，设置中的隔离入口仍显示89条和未核验标记，未打开正文或执行删除。当前隔离开发配置的业务后端未连接，SQLite诊断就绪；此次界面复核仅证明独立隔离入口与计数仍可见，不作为正常历史集成通过的证据。

本轮未启动真实微信读者，未安排来信、发送或撤回，也未读取或改写原89条隔离文字。真实 profile 仍无状态认证规则，开发 manifest 继续 `realWechatVerified=false`；接收状态、非最终状态的真实语义及跨启动可信映射仍未认证，普通历史门禁保持关闭。

## 2026-10-30 用户操作下的发送与撤回元数据观察

用户明确授权对单个私聊进行只读元数据观察，并亲自在同一会话发送并保留 A，再发送和撤回 B。A 发送后重新建立基线；基线锁定数为 0。B 发送后观察器锁定一条本人发送的新增记录：原始 type 为 `1`、status 为 `2`，已分配 server ID；用户撤回 B 后，观察到同一条记录的 type 为 `10000`、status 为 `4`，本地主键和 server ID 均保持一致。观察器正常关闭，未发现本次观察进程残留。

本次只观察已选择会话的元数据，未读取正文、source/XML 或媒体，未调用模型、未由 Agent 发送或撤回；匿名证据留在本机，不包含原始身份和消息正文。结果只证明本次受控操作的前后观察，未观察到 pending 或 server ID 分配过程，也不能推广为全部状态语义或跨重启来源连续性。开发制品仍为 ad-hoc、`realWechatVerified=false`，`normalHistory` 和支持档继续 `unverified`，不放宽正常 target/page 门禁。用户后续另授权仅该会话文字历史及隔离本机测试，仍不得读取媒体、访问其他联系人或调用模型。

## 2026-10-30 最终开发制品的状态观察与微信重启复验

受控 `observe-test-metadata` 原先在通用守卫入口之前直接返回，只有文件守卫，没有绑定微信进程生命周期。`07864e41` 将它接入既有会话级进程与目录双队列守卫，在 arm 前、inspect 后、观察返回前及错误路径复验；同 PID 的旧启动时间、阶段间退出、采集期间退出均拒绝继续。普通单次 `observe-metadata`、状态支持档及正文门禁未放宽。

本次单独取得一个固定私聊与固定测试文字的发送／撤回授权。微信气泡菜单的 Computer Use 操作仍返回 `AXError.notImplemented`；因此由 Agent 发送一次获准测试文字，由用户手动撤回。观察器先核对原隔离范围摘要并 arm（锁定数0），之后只关联唯一新增的本人文字元数据：发送后 `type=1/status=2`，发送者类别为 owner，server ID 已分配；用户撤回后，同一本地出现键与 server ID 保持，`type=10000/status=4`，发送者类别变为 unknown。UI 同时显示该条已撤回。未读取消息正文、source/XML 或媒体，也未将基线前的消息当成本次样本。

随后通过微信菜单正常退出，原生读者随源进程退出而结束；旧客户端的 current 请求被拒绝为 `history_native_unavailable`。重新进入原微信账号后，旧客户端仍拒绝；重新创建的仅元数据客户端与原隔离仓身份摘要匹配。该实测只认证旧观察会失效，不认证跨重启正向续读。原隔离仓仍为89条、不可保存0条，快照更新时间未变、normalHistory=false；本次测试消息没有被追加到隔离仓或正常历史。

复验使用锁定源码新建的开发制品：CLI SHA-256 `e4799c7d7d25d11038a03656e40c081f616c514b4f4d32745d15d320736ed243`，WCDB 仍为 `4f05cafc4626a142afca1818f0a88c4092a13d5f4c83e30cd5125b558ba0417d`。manifest 继续 `realWechatVerified=false`，不替换正式安装配置。最终制品源码 `go test -race -run '(?i)notalone'` 在 CLI/WCDB 两包通过169项，1项既有安装程序版本测试跳过；15项后台持久守卫测试通过。一次未筛选的上游套件有8项因只读叠加拒绝其预期的写入、Keychain 授权、ASR 或图片解码路径而失败，未计作本次相关通过项，也未为通过它们放宽只读策略。独立 Standards／Spec 审查无代码阻断，文档的历史“待实现围栏”和“跳过撤回”描述已按阶段澄清。

仍缺少 pending、发送失败、服务端别名分配过程、全部历史状态语义与重启后的可信恢复映射；不能据此把89条未核验文字升格为正常历史。观察器关闭后受控 CLI 读者为0，微信已恢复运行；本次无模型调用。

## 2026-10-30 接收方向的受控观察（代码与合成验证）

对既有、已授权的89条隔离文字只读汇总元数据，得到75条 `sender=owner/type=1/status=2` 和14条 `sender=contact/type=1/status=4`；未读取正文，仓内计数和更新时间不变。这是原始字段分组，不是正常消息资格认证；相同数字4也出现在此前的撤回观察中，不能脱离类型和方向判断。

新增 `observe-received-test-metadata`，使用独立的 `selected-received-test-lifecycle-metadata-v1` 许可、响应format、观察状态和 TypeScript `observeReceivedTestMetadataSelected()` 入口。它只锁定同一已选联系人唯一新增的文字元数据，拒绝方向错误、多条新增、身份映射歧义或来源失效；没有新增时返回原锁定数，不伪称已收到。本人和对方观察不能互借基线。arm与next都会复验对应方向的唯一身份映射；current只复查已锁定的本地身份，允许记录消失或类型、状态、sender变为未知，保持 `unverified` 和 `normalHistory=false`。

最终开发制品 CLI SHA-256 为 `8b748db325f8d120f29b77a2c077bd964d721d8dd1035cc097bcb5886088a25c`，WCDB 字节不变，manifest 保持 `realWechatVerified=false`。在最终制品源码运行 CLI/WCDB 两包 `go test -race -run '(?i)notalone'`，190项通过、1项既有安装程序版本测试跳过；`wechat-history-native-client` 与既有 owner 生命周期两文件34项通过，backend-ts及desktop的 `tsc --noEmit` 通过。另补上预取消请求的立即清理，两方向观察均关闭watch和来源守卫，防止保留到会话退出；先红后绿验证。独立 Standards／Spec 复核无阻断。

按本轮用户要求，仅实现与合成验证，没有安排新的真实接收消息，也没有启用真实接收观察器。原14条对方文字仍未核验，不能据此声称接收状态语义已通过实测。后续真实样本须在观察器就绪后由已选联系人发来，再读取该唯一新行的元数据；本入口不具有外部发送能力，也不放宽普通历史门禁。

## 来源实例变化停读（合成验证）

> 该检查点记录当时状态：持久失证停读已实现，正常重启后的正向恢复尚未认证；后续 ADR-127 及官方 622 原生验证见本文件首节。

读取正文前固定联系人范围的来源代次及完整目标分片／表实例集合，来源或集合变化时另行提交持久围栏并停止；没有可证明基线的旧目标与排除同样停读。接收页时在事务内复验，围栏不会因为目标随后恢复或数据库重启而自动清除。集合变化包括新增分片，因此合法新增分片也会保守停读，不能宣称正常增量已完成。相同实例摘要不能证明期间没有不可观察的变化；未知状态、实际微信支持档及普通正文读取仍保持未认证。

对 5 万条合成排除记录、8 个表实例的同工作负载，原逐行加载和匹配三次耗时 19.79／17.92／18.34 ms；新固定集合检查三次耗时 0.12／0.03／0.01 ms（内存 SQLite，单次检查，不代表真实微信端到端性能）。覆盖状态从持久围栏投影为未完成并关闭自动回复资格；身份及来源只限合成数据。

隔离合成库经 `pnpm run dev` 实际打开同步设置：失证联系人显示“聊天来源已无法确认连续，正文读取保持关闭”，增量显示停读；另一个合成联系人保持独立状态。正常退出后 `dev:status` 为 stopped／空 PID，隔离库已清理。渠道失证与关闭读取交错时，根据已经记录的原联系人／会话／来源范围持久化围栏，不依赖已经失效的读取令牌；该动作不读取正文。

仍未解决：同一来源摘要在进程失去守卫后再次出现，不能证明关闭或崩溃期间来源未被替换或恢复。当前已实现持久失证停读，尚缺跨守卫生命周期的可信续证；该切片不得称为完整来源连续性保护，也不能用于放行真实正文。

针对该缺口，独立合成原型在本地分支 `codex/fsevents-continuity-prototype@870dfcbf` 验证 FSEvents 跨进程回放。替换文件可见事件，但一次普通写入在 HistoryDone 后才到达；同一 SQLite 文件的普通更新与删除后显式插入相同主键，具有相同 inode／schema_version，回放事件类别均为创建、删除、修改。实验只证明上述合成反例，不能推断微信实际发生过重建；因此文件事件与摘要尚不足以认证微信消息身份，未修改读取门禁。Apple 对丢事件、事件卷 UUID 和同步刷新分别有明确边界，详见原型记录。

日期：2026-10-29。覆盖现存只读制品核对、同配套库的原生合成检查，以及本票新增隔离开发 CLI 的指定私聊结构复验。没有安装、初始化或替换用户组件，原制品与 v5 阶段未读取真实消息行；后续只投影获准范围的消息元数据，未读取正文或媒体，没有迁移／恢复实验或模型。获准受控发送及停止结果见 v7。原工具与新增窄操作是不同制品，分别记录；结构通过不能放行未知状态和来源连续性。

## 原有制品与运行证据

| 制品 | 大小 | SHA-256 |
| --- | ---: | --- |
| bin/wechat-cli | 8495824 | d566d4842b656ca5b07a8af0c1fdada5c225724e9e7fda28e409b06f117d0655 |
| lib/libWCDB.dylib | 4490832 | 4f05cafc4626a142afca1818f0a88c4092a13d5f4c83e30cd5125b558ba0417d |

文件为普通非符号链接arm64，codesign --verify --strict均为0，与既有静态构建审计的字节一致。工具根缺组件manifest和旁侧公开源码，未宣称完整发行、可重现构建、公证或干净机器通过。固定补丁命令白名单仅status/sessions/resolve-chat/tail/watch/help/version，强制只读且禁止自动刷新。静态核对没有发现inspect_message_schema、message_metadata_barrier、table_xinfo、index_xinfo、source_generation或sqlite_schema入口；不以普通消息查询后删输出充当无正文结构检查。

在既有配置所指的同一CLI上执行有界status --include-debug --strict-read-only，退出0、strict_read_only=true、live_read_ok=true、readiness=degraded；既有parseConfiguredWechatAccount接受候选，但不授予来源连续性或正文资格。stdout/stderr仅在端侧进程内存解析，不保存账号标识、配置或路径。DYLD_PRINT_LIBRARIES观测到一条预期配套WCDB加载，未见其他WCDB；该结论只覆盖此次status进程。

## 最终配套WCDB字节的原生合成检查

复用既有wechat-wcdb-native-probe-v3.py，以本次配套dylib为唯一显式参数。脚本通过ctypes调用该库导出的sqlite3函数，仅新建并清理自有临时合成数据库；没有以Python内置SQLite代替。库内sqliteVersion=3.27.2，12/12断言组通过：加密错误密钥拒绝、只读禁写、两分片完整身份与精确大整数/正文列authorizer、WAL固定快照、持续变动拒绝、静止后重试、observer/reader短获取窗口及扫描期间正常提交、窗口内提交拒绝、新分片失效、短暂命名空间变化正向观测、文件替换失效、interrupt后语句/连接释放。

这些结果将既有12项机制证据绑定到本次实际配套库字节，不认证当前微信schema、消息状态、迁移映射或来源命名空间连续性。kqueue正向观测不证明事件永不丢失，持续提交时仍只承诺有界拒绝，不承诺必定取得共同切面。既有14项生命周期仍是合成状态规则，本轮未冒称重跑真实状态转移。

## 原有制品阶段的桌面与缺证结论

dev:status为stopped，无本工作树dev进程；未启动、重启或关闭开发实例。Computer Use核对实际微信窗口已在用户指定目标，未切换到他人、滚动、输入或发送。没有将窗口名作为稳定会话身份，没有持久化截图。

上述原有CLI没有受控消息schema窄操作；这一阶段尚缺实际目标的schema、声明主键、完整分片/表实例、消息状态语义、来源连续性及可靠历史目标/游标证明。新增窄操作补证见下节，原工具本身未替换。因此真实身份适配器继续unverified，未经02正常逐人确认创建真实读取许可，也未读取真实正文或媒体。组件准备与安装仍搁置；不能绕过白名单、扫描密钥或用tail补证。03的正常合成服务、来源删除和界面检查与该真实门槛分别报告，票保持claimed。


## 新增窄操作开发制品与本机结构复验

新增 `desktop/wechat-history/` 在锁定上游源码和严格只读补丁上增加 `notalone-history`。仅从既有 schema2 配置取得明确账号根目录；缺失、不规范目录或账号切换在打开来源前拒绝，不调用上游自动账号目录发现。元数据只解析用户指定的一个精确私聊，重名或无匹配失败；消息结构查询只查该目标的 sqlite_master、PRAGMA table_xinfo/index_list/index_xinfo 和触发器摘要，不读消息行、source/XML 或其他会话数据。

构建通过 `desktop/scripts/build-history-cli.mjs`，校验锁定源码、Go 归档、严格只读补丁和现存 WCDB 字节，离线输出到新的开发目录。构建不会运行完整组件准备，也不覆盖现工具或私人配置。当前支持档与制品摘要见[窄操作三值报告](../../backend-ts/src/history/sqlite/support-profiles/wechat-4.0.6-29387-narrow-v1.json)；原有工具报告保留在[原制品报告](../../backend-ts/src/history/sqlite/support-profiles/wechat-4.0.6-29387.json)。新 CLI 的开发签名完整性通过，manifest 的 realWechatVerified 仍为 false。

使用正式 `NarrowWechatClient` 对唯一获准对象执行 resolve → inspect → support，随后正常 target 在客户端门禁拒绝。检查 8 个分片，其中 2 张目标表；均为 17 列、声明 `local_id INTEGER PRIMARY KEY AUTOINCREMENT`、4 个非唯一索引、0 触发器。`server_id` 没有唯一索引约束，不能据它猜测全局或会话唯一语义。支持报告分别保留 13 项三值：当前版本、完整结构、声明主键、自动分配规则和状态列已核验；状态语义、来源生命周期、重启连续性、恢复映射及正常历史仍未验证。没有进入真实 snapshot/消息分页，也没有按类型读取正文样本；缺证时不扩大读取来制造正常路径结论。

最后一次开发构建自己的 fresh archive 源码上运行原生定向测试与 race：60 个用例／子用例、2 包通过，0 失败、0 跳过。覆盖精确整数、同秒与分片、共同固定快照期间持续写入、DDL／表实例变化、游标重放、取消与真实关闭、命名空间变化、失败守卫回收、缺账号根目录拒绝、NUL 与坏 UTF-8 尾部、Zstd 限额及单元 8 MiB 上限。单次查询超限不返回部分行；有效文字按完整字节读取，坏 UTF-8 不以静默截断或替换成为正常正文。每页最多 16 条，客户端 page 响应上限 8 MiB，其余响应 2 MiB；超时及取消等待子进程退出。

这些合成机制不证明真实微信的状态转移或没有原位恢复。kqueue、dev/ino、birthtime、schema_version、rootpage 和建表摘要只能检测部分变化；旧游标或旧出现身份不能因此自动跨启动／恢复续用。此检查点时真实正常历史保持关闭，03 仍未完成；随后用户采纳 ADR-127，受限的正常重启完整重扫已通过官方 622 原生验证，App 集成仍待验。公共宿主的非空合成服务／HTTP／SQLite／05 删除路径与实际 App 界面证据仍需分层核验，不能由本节代签。


## v6 单条元数据观察（未授予正文资格）

在已有单一对象最小只读授权内，新增独立 `observe-metadata`。严格 resolve/inspect 后，七个类型家族各调用一次；每次固定全部分片 reader，只投影一条 local/server 身份、原始 type/status、sender 类别和 create_time 元数据。切面探针只返回常量，不额外读取任意消息编号。不会调用普通 Page/projectRows，不查询正文、source/XML 或媒体，不写普通捕获，不授予生成、完整覆盖或普通 target/page。

正式客户端实际检查仍为微信 4.0.6/build29387、8 分片、2 张目标表。文字、图片、文件家族、表情及其他类型各匹配一条，共 5 条；语音与视频均未匹配，报告未观察，不报告不支持或完整。原始状态观察到 2、4，只能说明本次字段值，不能解释为完成、已送达或已撤回。每次观察只证明当次固定快照，不把七次调用冒充同一个历史切面。观察后普通 target 仍被 history_support_unverified 门禁拒绝，全部 reader 和子进程关闭。

新开发字节与匿名结果见[v6 元数据报告](../../backend-ts/src/history/sqlite/support-profiles/wechat-4.0.6-29387-metadata-v1.json)。源码/配置依赖仍为同一上游、Go、只读补丁及 WCDB；新增 Go 观察入口、受影响快照和协议从 fresh archive 执行定向 race，共 43 用例／子用例通过、0失败0跳过，typed 相关 8/8、后台类型检查通过。未变化的原生底座 60 项沿 v5 与相同 WCDB 字节复用；v5 摘要不代表 v6。严格开发签名核验退出 0。

审查先修复两处后才执行真实观察：原固定切面探针会多读任意 local_id；客户端未核对原始 type 低32位与请求类型。现在探针仅返回常量，七类夹具使用各自合法原值，错类型／精度失真／额外正文或 XML 字段均拒绝。无正文列的合成表、最多一条、缺分片、DDL、取消和 Close 排空均有证据。

原始来源键、账号、发送者名称和时间没有保存。未发送、撤回、重发或删除外部消息，未增加媒体样本或其他联系人。下一项状态校准需要另行确认精确对象、固定测试文字及发送／撤回动作；现有样本不代替状态转移。迁移／恢复实验继续范围外，普通本次固定快照、跨新快照、重启和恢复分别报告，未证能力仍为 unverified。

## v7 受控状态观察（关联歧义即停止）

另获精确对象、固定两条文字及仅撤回第二条一次的人类授权后，增加 `observe-test-metadata`。一次 arm 只读取所选会话各分片 MAX 主键标量；next 在共同固定快照先有界计数，全部分片仅一条新增 owner/text 行才锁定分片／表实例／主键，最多两条。current 仅复查已锁主键，允许类型／状态变化或缺失，不用新系统行顶替。每阶段关闭全部 reader，长期目录守卫保留至结束。十分钟／二十次调用上限，歧义或读取失败永久终止，关闭先取消并排空；不调用 Page、正文、source/XML、媒体或产品发送能力。

正式客户端确认同一微信版本、8 分片与 2 张目标表，arm 成功。Computer Use 核对精确私聊和固定第一条文字后仅发送一次，实际界面显示绿色气泡、输入框清空。随后 next 返回 history_identity_ambiguous，未返回可锁定记录，客户端及 native 关闭。按停止条件，第二条未发、未撤回、未重发、未扩读旧消息猜关联。现有错误不能区分多行、sender 映射或类型条件，原因保留未分类，不能宣称微信不支持。

新字节见[匿名受控观察记录](../../backend-ts/src/history/sqlite/support-profiles/wechat-4.0.6-29387-controlled-state-v1.json)。fresh archive 定向原生 race 28 顶层／含子用例 57 项通过，0失败0跳过；typed 两文件组合28项、后台类型检查通过。合成验证含 Close 取消与实际 reader 排空、空 MAX、跨分片同主键、同期多行、未知 sender／type、schema／文件变化、缺失行不顶替及歧义后不可复活。双轴复核的资源与失败重试问题已修复。

本次只证明第一条在实际 UI 发送成功；pending、server 别名补齐及撤回语义仍未验证，普通历史保持门禁。迁移／恢复继续排除，公共首次触发和合成 App 展示／删除验收继续推进。

## v8 本人类别修复与发送前校验

锁定上游 795071fa 的 main.go:8440–8453 用 selfWxid() 区分账号目录设备后缀，既有本人消息分类同样复用该函数。三处窄投影此前直接比较完整 cfg.Wxid，合成设备后缀用例能复现本人变 unknown。现仅发送者类别使用官方派生值，账号隔离键及 sourceGeneration 不变。不能据此倒推 v7 的具体失败原因，也不回找第一条身份。

arm 新增所选现存分片 Name2Id 的 canonical/raw 精确有界计数；未知、重复或冲突在发送之前终止，不枚举用户名或返回原始账号。另以固定原因码区分新增多行、sender、type 和主键门禁；错误仍永久关闭观察。新字节及匿名预检见[v8 发送前校验](../../backend-ts/src/history/sqlite/support-profiles/wechat-4.0.6-29387-controlled-preflight-v2.json)。实际正式客户端 resolve/inspect/support 后，8 分片／2 目标表的发送者预检和 arm 通过，lockedCount=0，随后 reader 与子进程关闭；未发送、撤回或读取正文。

设备后缀三投影先红后绿，相关原生 race 26 顶层／含子例 71 项通过；新五类固定原因码均验证客户端拒绝后排空。另从 v8 fresh archive 运行更广定向回归并保存本地日志。实际预检只证明本次元数据映射可证，不认证正在运行微信当前登录账号、消息状态或普通历史资格。第二条操作仍须独立桌面时段及新基线。

后续取得短桌面时段后，先核对所选会话、第一条保留状态和空输入框。Computer Use 对消息气泡的单独坐标点击直接返回 AXError.notImplemented，聊天区无可操作 AX 节点，键盘菜单也未打开撤回入口。第二条尚未输入或发送，未开启新基线，未回撤第一条；确认无观察器和开发实例后释放桌面。此项为实际操作能力缺口，已有固定发送／撤回授权仍有效，不能写成缺少授权或状态测试通过。

## v9／v10 工具配置账号的元数据认证

按 ADR-095:16–19 和 ADR-110:7–11，认证对象是已配置工具账号；前台登录账号不是此证据。固定 inspect-account-schema 只读取 contact／SessionTable 声明、完整列和索引 xinfo、主键及触发器摘要。实际微信仍为 4.0.6/build29387：SessionTable 为19列、3索引、username主键，contact为22列、1索引、id主键；均非自动递增、无触发器。两次配置账号及来源守卫复验通过，未投影名单或聊天记录。

正式 metadata-account 支持档按上述完整结构、当前程序版本和配套 WCDB 字节匹配，再固定 SELECT 1 LIMIT 1 核验会话可读性，前后重核结构、配置及两份持有中来源实例。v10 正式客户端多次 accountMetadata 证据完全一致；与唯一获准私聊 resolve 的完整配置账号、sourceGeneration 相同，metadataStatus/configuredAccount 为 verified，连续性只声明 held-contact-session-instances。普通历史支持仍 unverified，target 实际被门禁拒绝。全部读者及子进程已关闭，无整名单、正文、source/XML、发送或撤回。匿名结构和资格绑定见[配置账号元数据支持档](../../backend-ts/src/history/sqlite/support-profiles/wechat-4.0.6-29387-account-metadata-v1.json)。

metadata-sessions 是独立许可的固定窄操作，仅必要私聊身份与名称，服务端5000界，超量整批拒绝；明确非私聊先排除，可能私聊仍须唯一 contact、合法 verify_flag 和官方分类。真实整名单本次未读，不以合成列表冒称端到端认证。正式空库 ContactService 与合成原生进程8项通过；未知版本、重复、缺失、夹带正文、账号／来源变化及关闭取消均有覆盖。失败后显式重检重新创建客户端，本次操作不自动重试，旧授权不恢复；该恢复缺陷及非私聊缺 contact 反例均先红后绿，独立复核收敛。

v10 fresh archive 的定向原生 race 共37顶层／含子例91项通过，0失败0跳过；之后名单提前分类仅补受影响定向 race，客户端恢复仅补新增两例及类型检查。真实资格绑定 v10 字节，后续新制品须按实际字节复验；未变化底座沿既有证据复用，不重复宣称重跑。

包含上述修复的 v11 已 fresh build 并通过严格开发签名核验。正式 createWechatContactMetadata 端口实际两次读取工具配置账号，assurance 均 verified、证据相等，随后端口及原生进程关闭；未调用名单或正文。新字节和端口结果已追加到同一支持档的 formalPortVerification，旧 v9／v10 证据保留各自制品绑定。

## 首次自动入口的正式宿主验证

实际合入公共基线 af98a3ba，保留迁移1至9、唯一共享模型、讨论／记忆／媒体消费者以及关闭失败保留SQLite的合同。联系人确认成功和开启读取只唤醒后台派发；关闭读取等待历史及微信媒体排空，撤销按联系人停止所有媒体，退出先排空首次协调器。宿主显式传入配置工具路径，不自动寻找或替换组件。

hooks、覆盖状态、关闭顺序、正式 launchDsh/profile、既有非空 history 和 media 宿主相关组合24项通过，后台类型检查通过。正式初次入口用合成原生子进程及空库，经真实 HTTP 账号确认、名单同意、联系人确认和开启读取自动形成 capture／source／message／coverage，未调用手动同步接口、未预植消息或goal。启动场景只经正式联系人服务准备持久开关；未知支持保持not_started和原因，零 target/page，body_available仍false。来源删除、显示和实际 App 不由该合成结果代签。

DSH查证：声明、锁及实际解析核心均为0.2.1-rc.2；核对安装 cmdline lib/types/index.d.ts:48 的 onReady(void listener) 成功启动一次／返回disposer，以及 lib/index.js:50–73 的effect释放。对应官方固定源码687f282e8625c6b8d11ff58211a90524be2e4317 packages/boot/cmdline/src/index.ts:52、123–145。本次只复用公开生命周期，不宣称整个npm制品已与源码逐字复现。

## v11 人工发送态观察（撤回按用户指令跳过）

重新核对获准私聊与保留的第一条后，用 v11 正式客户端核验工具配置账号、所选私聊的账号／来源相等和当前8分片2表，成功开启新基线，锁定数为0。观察器就绪后，由人类手动发送固定第二条一次并确认尚未撤回；随后 next 在共同固定快照唯一锁定1条本人文字记录：originalType 为1、原始 status 为2、serverId 已分配、local 主键精确保留。没有读取正文、source/XML、媒体或其他私聊，也没有追溯关联第一条。匿名结果绑定本次 v11 CLI／overlay／WCDB，见[v11 人工发送态报告](../../backend-ts/src/history/sqlite/support-profiles/wechat-4.0.6-29387-controlled-state-v2.json)。

人类随后明确指示撤回测试先跳过，由其以后手动处理。观察器立即 close，退出0；实际观察器及原生子进程均已消失，未执行 current 或其他消息读取，第一、第二条均未再操作。这是本次发送后快照的原始字段观察，不证明 status=2 的通用送达含义，也未观察 pending、server 别名补齐或撤回转移。上述能力及来源生命周期继续 unverified，普通正文门禁不放宽；不把跳过写成缺授权或渠道不支持。

## 20 公共旧路由接线待办

当前桌面来源管理通过 `GET /api/contacts/:id/sources` 列举来源（`desktop/src/main/sources/controller.ts:80`），SQLite 宿主尚无该列表路由；`SqliteDeletionHttp` 只承接具名来源 DELETE、删除状态与任务查询，不能由其成功推断来源列表可用。20 切换前须复核并接回来源列表公共合同，保持联系人隔离和删除资格。本票实际 App 删除验收使用已知合成 sourceId 调用正式 DELETE，再刷新实际消息列表验证旧正文撤下；此证据不认证通用来源管理列表。

## 合成实际 App 展示、来源删除与目录计数

独立测试根保留两位已确认的合成联系人，各8条记录（2条文字、6类非文字占位），总读取开关关闭。夹具用于已保存资料展示，不替代前述空库正式 HTTP 自动派发4项。只用 `pnpm run dev --user-data-dir <合成根>`，复用已安装44.7.0 Electron dist，以最小环境和独立后台进程运行；同 scope 的 dev:status 返回 development，监督器、App、DSH 后台实际存活并握手。前两次失败启动没有计为通过；只清理已确认归属的本次失效控制套接字后，复用18已成功的后台方式完成正向检查，未改产品启动或租约门禁。

Computer Use 实际操作管理后台和输入小窗：乙显示历史不完整及继续前警告；分别首次选择乙、甲，展开最近聊天并刷新，均显示8条、六类非文字占位、时间未知和顺序未核验，甲初始状态为完整。切换联系人时旧列表立即撤下。没有发起生成或点击媒体操作；这里的非文字是自建占位资料，不是本轮已暂缓的真实媒体验收。

对甲的一条已知合成 sourceId 调用正式 DELETE，删除操作 completed。正式消息端点由8条变7条，恰好移除所选文字，其余7条身份保留；实际输入小窗点击刷新后，AX 与画面中旧正文撤下，其余7条保留。刷新同步状态后，甲为1条文字、6条占位；来源删除使旧 goal 失效，展示不完整，没有把旧完整覆盖当作当前资格。

实际目录曾固定显示0条，消息端点却有8条。736f8297 修复 identity.directory 的硬编码：只聚合当前 owner/contact 的可见消息，消息可用且至少一条来源为 normalized/available 才计入，与历史读取谓词一致，不读取正文。两历史表不存在时继续返回0，兼容仅身份能力的结构版本3；未改宿主、registry、已发布迁移、正文能力或 source_count。source_count 仍是现合同的0，不能解释为真实来源数量已接回，来源列表与真实计数仍由20承接。

正式 HTTP 红例先复现0不等于8，修复后验证8→来源 fence 立即7→完成7→逐来源删尽0，另一联系人保持3、其他 owner 目录为空，以及无历史表的身份兼容。private-history/contact-binding/hooks 相关41项及后台类型通过；独立 Standards 与 Spec 均0问题，Spec另跑两项新增用例2/2。逐来源删尽不作为06正式清空入口的验收。

正常开发监督器因后台源保存安全重载后，实际管理后台显示甲7、乙8，甲摘要7及覆盖1条文字/6条占位；重新进入甲并刷新，仍只有7条，被删正文未恢复。随后 CUA 正常 Cmd+Q；同 scope 状态 stopped/pids[]，监督器、App、DSH 后台 PID 均消失，专有握手被移除，立即释放桌面。没有重开受控观察器、操作 B、调用模型或读取真实媒体。

截至官方 622 原生实测前，真实普通历史仍全部拒绝 target/page：状态语义、pending、撤回、别名转移及消息来源生命周期仍 unverified，配置账号 metadata 认证不能替代这些能力。以上只补齐合成路径和资料显示；该阶段继续 claimed，不能 resolved 或标记 Goal complete。

## 固定快照与持久排除的连续性评估（ADR-127 采纳前检查点）

现有账号 sourceGeneration 由配置账号及持有的 contact.db/session.db 实例生成，不包含消息分片实例（`desktop/wechat-history/cmd/notalone_account_metadata.go:131`）。消息读取的独立 observer 在同一连接上对固定 reader 的短获取窗口前后比较 data_version，能够检测该窗口的其他连接提交；SQLite 官方明确该值只可在同一连接的不同时间比较，不能将不同连接或重启后的值相等作为连续性证明（[SQLite PRAGMA data_version](https://www.sqlite.org/pragma.html#pragma_data_version)）。固定快照及持有期间的 guard 不证明快照之间的来源身份，也不能认证当前未验证的消息状态语义。

已删除来源的 local 排除键包含 sourceGeneration、分片、表实例及 localId（`backend-ts/src/history/sqlite/normalize.ts:19`）；正式接收查询按该键或已认证 server 别名匹配（`backend-ts/src/history/sqlite/actions.ts:59`）。在纯内存合成 SQLite 上调用正式 normalize 并执行该生产查询：原键命中；仅改变合成账号来源代次，或保持账号代次而改变合成表实例，旧 local 排除均不命中。serverId=0，不提供 server 别名。此实验只说明键匹配的条件，未证明现有正常路径能绕过门禁或真实微信发生了这种变化。账号代次变化已有独立认证拒绝（`backend-ts/src/contacts/sqlite/actions.ts:72`），但它不等于消息分片连续性证明。

读取正文前，按 owner/contact 持久记录正在使用的来源证据与失证围栏；保留既有精确排除，在同一提交事务内复验授权、数据代次、围栏和当前快照资格。发生无法证明的分片/表实例变化、读取中断或重启后无法续证时，旧排除和围栏必须保留，停止该范围并报告缺口；不能通过新来源代次、重选或后台重试自动清除。围栏需在可能读取之前持久生效，不能只在会回滚的失败事务中写入，也不能仅靠进程内状态保证崩溃后仍生效。该检查点中的 `history_continuity_scope`、`history_continuity_fence`、`history_guard_lease` 和运行代次复验已实现失证停读，并有异常重开、迟到页及失证写入失败的合成验证；当时尚无跨守卫可信续证。后续用户采纳 ADR-127，官方 622 原生新进程完整重扫验证见本文件首节；App 集成仍待验。

以下是 ADR-127 采纳前的结论：当时证据不足以将此方向作为正常可用实现，失去连接后的连续性和旧排除到新实例的身份映射也不可证明。永久阻断不能满足04无声缺口／合法新消息续读和06精确边界后继续新消息的正向承诺；只保留固定快照而放行正文，或以时间、最大 localId、重新确认账号和哈希代替映射，均不能解决该缺口。用户随后采纳了 ADR-127 的精确身份核验与完整重扫范围；相同身份标识下无法辨认的原地回滚仍明确不在保证内。其后的官方 622 原生验证结果见本文件首节。

## 2026-10-29 票03第1/2条双次真实 metadata 复核（仍未认证）

本轮只做两次真实、只读的 metadata 快照，目标是判断票03第1/2条的历史范围、状态语义、来源连续性和覆盖能否认证。正式 `backend-launch.json` 当前指向已安装 CLI `d566d4842b656ca5b07a8af0c1fdada5c225724e9e7fda28e409b06f117d0655`；该制品调用 `notalone-history` 时在打开来源前以 `notalone_command_disabled`、退出码 2 拒绝，因此不具备本轮所需的 metadata 入口，不能作为已安装正式支持档的证据。两次真实快照使用保留的开发只读制品 `d555fdcedf100eba62e8dbc4dbcde50901b3f1b8198f6a6a44e62cfb66c26327`；其 manifest 明确为 `notalone-history-cli-development`、ad-hoc development、`realWechatVerified=false`，不能替代正式安装制品认证。正式配置路径的这一次拒绝没有打开 SQLite 来源，不计为真实读取。

每次快照均只请求 `metadata-account` → `inspect-account-schema` → 精确目标 `resolve` → `inspect` → 单条文字 `observe-metadata` → `support`。没有请求 `target/page`，没有读取 `message_content`、source/XML、媒体、整份联系人名单或会话列表，没有发送、撤回、模型调用或产品数据库写入。两次结果只在端侧解析并落为不含账号、联系人名称、原始消息ID、时间戳或原始分片路径的摘要；目标名称、账号键、会话键和来源代次只保留相等关系，不进入本文件。

两次可比较字段一致，未观察到差异：

- 账号：`wechat-account-metadata-v1` 均为 `verified`，程序 `4.0.6/build 29387`，`configuredAccount=verified`，`continuity=held-contact-session-instances`，`normalHistory=false`；CLI 与 WCDB 摘要分别为上述 `d555…` 和 `4f05cafc4626a142afca1818f0a88c4092a13d5f4c83e30cd5125b558ba0417d`。账号和来源代次在两次独立进程间相等；期间只正常退出并重开 NotAlone App，WeChat 进程没有重启。
- 账号结构：`session` 19 列，声明主键 `username`，schema version 11，3 个索引；`contact` 22 列，声明主键 `id`，schema version 22，1 个索引；账号结构摘要 `9b7f2d14a94a21b4`。两张表的实例摘要、列和索引在两次间一致。
- 消息结构：检查 8 个分片，其中 2 个目标消息表；均为 17 列、声明主键 `local_id`、`AUTOINCREMENT`，各有 1 个组合索引和 3 个单列非唯一索引（含 `server_id`，不提供唯一约束）。两个表实例摘要分别为 `12ff3e6af6323b82`（schema version 229/rootpage 310）和 `6da1a20246f3e94b`（schema version 695/rootpage 6893）；消息 schema 摘要 `c79d35e6b8a272a9`。完整分片集合、表实例、主键和索引在两次间一致。
- 单条可观察状态：两次均匹配同一文字元数据位置，`localIdHash=d4735e3a265e16ee`，`serverId` 为正整数、`originalType=1`、原始 `status=4`、发送方类别为 `contact`、`createTime` 为正整数；报告均为 `statusSemantics=unverified`、`normalHistory=false`、`observationScope=single-fixed-snapshot`。同一原值不能证明状态4的业务含义，也不能覆盖发送、撤回、别名补齐或删除状态。

认证结论：可以认证本次两个时刻的当前账号结构、精确目标、8 分片中的 2 个消息表实例、`local_id` 声明主键、表结构及一个原始状态值在两次间相同；不能据此认证票03第1/2条要求的真实历史范围、状态语义、来源生命周期、跨重启来源连续性或覆盖。`support` 仍返回 `unverified`、`history_message_state_unverified`，其中 `normalHistory`、`statusSemantics`、`sourceLifecycle`、`restartContinuity`、`recoveryMapping`、`snapshotBarrier`、`partitionCoverage` 全为 `unverified`。相同固定切面无法证明变化间映射；当前保留的正式 CLI 又缺少 metadata 入口，开发制品也不能冒充正式支持档。

因此本轮不放宽真实正文门禁、不修改 support profile、不把全拒绝写成正常历史可用，票03保持 claimed。数据影响仅为上述只读 metadata 查询；没有读取正文或其他私人资料，没有向指定目标或任何其他对象发送消息。两次快照后 App 以正常 Cmd+Q 退出；`dev:status` 返回 `stopped`/空 PID，任务自有 App/监督器/DSH 进程和开发握手均已清理，WeChat 保持原运行状态。

## 2026-10-30 较早的合并基线审计、接线复核与真实缺口

本轮只做分支合并、只读代码审计、既有证据有效期复核与最小相关重跑；没有启动实际 App、没有读取真实微信正文或元数据、没有发送或撤回、没有迁移／恢复实验、没有模型调用。以下“已过”只指票内已勾选的约定实现与合成／正式服务证据，不等于真实渠道认证。

### 分支与合并审计

- 独立工作树（路径不记录）原为 detached HEAD `e6998001`（父 `a11e04a0`，仅在本文追加双次 metadata 复核段），工作区 clean。恢复为本地分支 `dsh/sqlite-rebuild-03`，未 reset／clean／覆盖。
- 实际执行 `git merge codex/sqlite-rebuild-integration`（基线 `33e7dedc`），无冲突，生成 merge commit `28d78174`；工作区保持 clean，未 push。
- 合并后与基线双向差：`git rev-list --count 33e7dedc..HEAD` = 2（`e6998001` 文档提交 + merge commit），反向 = 0；追加本节前 `git diff --stat 33e7dedc..HEAD` 只有本文 +17 行。
- `git diff --stat a11e04a0..33e7dedc -- backend-ts/src/history` 为空：03 源码已随基线全部集成，旧工作树不作为当前产品状态。
- 集成侧对 03 接线的实际影响：`backend-ts/src/sqlite-host-plugin.ts` 仅新增记忆管理路由（当前文件 `:170`、`:186`），history 服务、协调器、启动唤醒、关闭顺序行未变；桌面历史／消息 UI 文件自合成 App 证据提交 `2f18f7a1` 起 `git diff --stat` 为空。其他集成增量属记忆裁决、候选回复等相邻票，不在本票范围。

### 首次自动入口接线（当前树证据）

- `backend-ts/src/sqlite-host-plugin.ts:123-127`：能力含 `history` 时创建 `SqliteHistoryService` 与 `FirstHistoryCoordinator`，`contacts.setReadStart(()=>firstHistory.wake())`；`:142` 停读时 `firstHistory.stop(contactId)` 并等待媒体停读；`:208` 在 appReady 发布握手后 `firstHistory.wake()`；`:94` 关闭顺序先 `firstHistory` 再 `history`、`contacts`、模型与 SQLite。
- `backend-ts/src/history/sqlite/coordinator.ts:31` 注释明确只由启动、明确确认或开启操作唤醒，首次历史结束后不派发增量、不轮询；`:51-57` wake 清理取消键并重新调度；`:152-168` 单人 stop／整体 close 先取消并等待真实 reader 排空。
- 复核判定：公共首次自动入口的“合成原生子进程 + 正式 HTTP 授权 + 空库”证据仍有效。`sqlite-history-startup-host.test.mjs` 覆盖全新启动不预灌、账号确认 / 名单同意 / 联系人确认 / 开启读取后自动首次 capture，且不调用 `/history/sync`、不预植消息或 goal；未知支持档保持缺口并零 target/page。仍不能把该合成结果当真实支持档已验收。

### 版本化能力报告复核

- `backend-ts/src/history/sqlite/contracts.ts:4-13`：`HistorySupportReport` 固定 `protocol:'private-history-v1'`、`profileId`、`adapterVersion`，`status` 为 `supported|unsupported|unverified` 三值，并含 `serverAliasSemantics`、13 项三值 `capabilities`、`identity`、`statusSemantics`、`continuity`。
- `backend-ts/src/history/wechat/native-client.ts:209-235` 解析并逐项校验 13 项能力键，缺省或越界拒绝；`statusSemantics`／`continuity` 在非 `supported` 时只接受固定未认证文本。
- 版本化制品报告：`support-profiles/wechat-4.0.6-29387-narrow-v1.json`（`format`／`revision:2`／`profileId`＋13 项三值）、`-account-metadata-v1.json`、`-metadata-v1.json`、`-controlled-state-v2.json`；支持档当前 `status:unverified`、`canReadHistory:false`，`statusSemantics`／`sourceLifecycle`／`restartContinuity`／`recoveryMapping`／`snapshotBarrier`／`partitionCoverage`／`normalHistory` 均为 `unverified`。
- 宿主运行能力报告 `sqlite-host-plugin.ts:158-163`：`wechatBodySync`／`wechatHistory` 在 history 能力存在时为 `typescript`，`wechatIncremental` 仍 `unavailable`。未发现“字段存在即冒充已认证”的记录。

### 来源删除注册复核

- `backend-ts/src/storage/sqlite/deletion/registration.ts:17-26`：`installedHistoryDomain` 在正式 `historyDeletionDomain.collect` 之上，为 `source` 删除追加早期读者 holder 键（`historyReaderHolderKey(contactId, accepted_data_generation)` 及前置代次），覆盖 inspect/target 尚无 goal 的读者；`:39-40` 已把 `history` 加入 domains 与 requiredDomains。
- `backend-ts/src/history/sqlite/service.ts:15,45-48`：读取前先登记 `history:read_<contactId>_<generation>`（`coversAllSources:true`），有 goal 后再登记 `history:<goalId>`，finally 逆序释放并等待真实关闭；`:94-95` stop／close 排空。
- `backend-ts/src/history/sqlite/deletion.ts:32-77`：fence 写持久来源排除／删除围栏并把旧 `capture_record`／`read_goal` 置失效，collect 只按固定操作账本收集，clear 校验 owner、identity 与 planned target，verify 拒绝残留行。
- 复核判定：写入／删除注册合同与早读者排空已有合成和正式 HTTP 证据（本轮重跑见下）；真实来源删除链仍未运行（无真实捕获），`contact_history` 精确截断属 06，来源列表 GET 属 20。

### 本轮最小重跑与证据复用

| 验证 | 命令／来源 | 本次结果 | 复用理由 |
| --- | --- | --- | --- |
| 后台类型检查 | `cd backend-ts && pnpm run typecheck`（`tsc --noEmit`） | 退出 0，无错误输出 | 合并后必跑的编译门禁 |
| 03 相关模块 | `ELECTRON_RUN_AS_NODE=1 <Electron 44.7.0> --test` 13 个文件：`sqlite-private-history`、`sqlite-history-http`、`sqlite-contact-binding`、`sqlite-storage`、`sqlite-deletion`、`sqlite-history-host`、`sqlite-history-hooks`、`sqlite-first-history-coordinator`、`sqlite-history-sync-status`、`sqlite-history-source-holder`、`sqlite-wechat-history-channel`、`sqlite-host-close`、`sqlite-history-startup-host` | tests 109 / pass 109 / fail 0 / skipped 0 | 合并树一次性覆盖服务、HTTP、删除注册、hook、协调器、宿主启动 |
| 对照：同一批（除 startup-host 外 12 文件）用普通 `node` | 同一命令去 `ELECTRON_RUN_AS_NODE` | pass 101，仅 2 个启动宿主用例失败：`No usable native binding found for node-addon-require-builtin-darwin-arm64` | 环境限制：DSH runtime node（TeamID `NAN929V4UM`、hardened runtime）无法加载 pnpm 的 ad-hoc `require_builtin.node`；主仓与工作树同缺本地构建，与本次合并和 03 代码无关。改用 Electron 44.7.0 自带 Node v24.21.0（与真实 App 后台启动方式一致）后 4/4 通过 |
| PG 依赖宿主测试 `wechat-history-status-host.test.mjs` | 需要本机 PostgreSQL | 未运行：连接 `/tmp/.s.PGSQL.5432` ENOENT | 本地无 PG；该文件不在既有一组 03 证据内，条件未变 |
| 合成实际 App 展示／删除／覆盖／目录计数 | 提交 `2f18f7a1` 记录，CUA 实操 | 复用 | 历史与消息 UI、backend history 源码自该提交起未变；集成只改相邻记忆模块 |
| 空库正式 HTTP 自动首次派发（startup 4 项） | 本轮 `sqlite-history-startup-host.test.mjs` 4/4 | 重新通过 | 合并后重跑，替代旧计数 |
| 真实 metadata 双次快照与 v6 单条类型观察 | `e6998001` 段、`metadata-v1.json`、v9／v10／v11 支持档 | 复用，未重跑 | 制品字节、账号配置、WCDB 与目标对象相等关系未变，WeChat 进程未重启；条件未变不重跑 |
| 公开历史检查 | `node scripts/check_public_history.mjs --ref HEAD --working-tree` | 提交前后执行，见提交回报 | 提交后必跑 |

### metadata-only 只读诊断判定

- 已授权诊断（七种类型各最多一条，仅来源键、type/status/serverId/sender 类别/create_time）已在 v6 执行：文字、图片、文件家族、表情、其他共 5 条匹配；语音与视频未匹配，报告“未观察”，未报告不支持或完整；原始状态只观察到 2、4。
- 本轮不重跑。原因：读取对象、开发只读制品（`d555f…`）、配套 WCDB（`4f05ca…`）、账号与目标相等关系均未变化，重复同一固定切面不会产生新的观察；语音／视频“未观察”是该单一授权会话快照内没有匹配行，不是探测失败，也不能由同一对象重跑补成“完整”。
- 若要关闭语音／视频类型观察缺口，需要另一个包含该类型消息的已授权私聊快照（新的对象级授权），而不是本票本轮可自行扩大的读取范围。本次未读取 `message_content`／source／XML／媒体，未写普通 captures，未提升 `normalHistory`，无匹配项按“未观察”记账。

### 12 条验收逐条判定

判定说明：“实现＋合成已验”指票内已勾选的约定行为有正式服务／合成／受控 HTTP 证据；真实列仍标注未认证。真实普通历史、真实状态语义与来源生命周期、真实删除链保持未过。

| # | 验收条 | 判定 | 已有证据 | 还缺的证据／所需授权或制品 |
| --- | --- | --- | --- | --- |
| 1 | 首次历史限于已选联系人及本机可读消息，共用规范化，不恢复手动导入 | 指定会话 App 持久化／读回已过；批量范围未完成 | 正常 `pnpm run dev` 中指定会话15页历史＋同进程15页tail；批量读取在19,927条过程量暂停，非最终总量 | native sidecar 监测误报修复后恢复并完成批量；不据指定会话外推其他联系人 |
| 2 | 版本化能力报告区分已支持／不支持／未验证；核验 schema、主键、分片／表实例、状态字段、来源连续性 | 原生与 App 日常重启身份重验已过 | 13项三值报告；8分片2表17列；指定会话端到端读回和增量入库 | 旁车及信号误报已修复并复核恢复；未观察状态和同标识原地回滚仍按 ADR-127 限制 |
| 3 | 内部消息身份、来源出现键、服务端别名、续读位置分开；大整数、serverId=0、合法补齐 | 实现＋合成已验；指定会话 App 身份去重已过 | 117个 `message_id` 唯一；15页历史＋15页同进程tail及空闲扫描无重复新消息 | 新进程重扫幂等与稳定日常去重仍待实机验收 |
| 4 | 跨分片同 local_id、排序变化、同秒、乱序、多页重复无歧义 | 实现＋合成已验 | 分片／排序／多页测试与合成 DSH 分页 | 真实多分片分页与乱序样本 |
| 5 | 身份不足隔离，不进入正常聊天／记忆／生成，不能绕过授权 | 实现＋合成已验 | 隔离记录与实际读取谓词测试；获准范围89条隔离文字 | 正常历史来源资格仍待认证 |
| 6 | 文字存正文；非文字为空并保留类型与位置；不下载媒体、不触发记忆或模型 | 指定会话 App 正文持久化／读回已过；媒体仍未验 | 117条经认证文字；114条 unknown、3条 recalled 无正文；指定测试文字已找到 | 非文字 UI、语音／视频端到端路径仍需另行验收 |
| 7 | 捕获／来源／消息／游标／覆盖具名事务原子提交，提交前复验 | 实现＋合成已验 | 事务与迟到页测试、正式宿主删除闭包测试 | 真实读取下的原子提交观察 |
| 8 | 分页／分片缺失／身份冲突／中断显示真实覆盖不足，进行中阻止生成 | 实现＋合成已验 | 覆盖显示与正文可用性解耦、警告 UI、生成阻断测试 | 真实覆盖不足场景观察；依赖真实 target/page |
| 9 | 保存完整来源关联、删除目标注册、迟到写入资格保护；05 合同替身验证 | 实现＋合成＋正式 HTTP 已验；真实删除链未过 | 删除域注册、早读者 holder、正式 DELETE 合成 App 8→7、来源列表属 20 | 真实来源删除需先有真实捕获；`contact_history` 精确截断属 06；sources GET 属 20 |
| 10 | 合成源覆盖正常／重复／冲突／中断与界面反馈；真实未核验时保持门禁 | App 历史、同进程增量、新进程续读和新增来信去重已过 | 指定会话117→118；最早来源为增量目标；后续复扫仍仅1条新增 | 仅覆盖已认证状态及 ADR-127 日常范围，不外推未知状态、媒体或原位回滚 |
| 11 | 复用 WCDB 原生 12 项与生命周期 14 项声明范围；研究摘要不等于产品字节；不做迁移／恢复 | 已过（限定字节与声明范围） | 配套 dylib 12/12 原生合成；v5–v11 支持档 | 无新增；不扩到迁移／恢复 |
| 12 | 显式统一 ADR-100 及旧 baseline 阅读入口与本轮首次历史目标 | 已过（文档／入口） | ADR-100／113 与旧 baseline 条款统一记录 | 无新增 |

### 精确真实缺口与所需授权／制品

1. App 真实普通历史接线（第 1 条）：指定验收会话的 SQLite 持久化、正文读回、同进程 tail 和重启去重已通过。较早在 19,927 条时暂停的来源误报已修复并复核恢复；最终运行数据见下方最新追加，不能将过程计数作为全量完成证明。
2. 状态语义与来源生命周期（第 2 条）：当前精确 profile 只认证已观察的状态组合；本次 117 条认证文字读取成功，114 条 unknown 和 3 条 recalled 未读正文并继续推进增量。其余状态组合、来源删除链与媒体语义不因该样本自动认证；无新样本时保持 unverified。
3. 跨启动／实例连续性：App 新进程已完成身份重验、完整重扫及指定会话身份去重；旁车和系统信号误停均修复，旧误报经 metadata-only 复核后恢复。最终读取器运行观察未产生新围栏。该观察不替代长期可靠性保证；相同身份标识的原地回滚仍排除在 ADR-127 之外。
4. 真实覆盖（第 1／8 条）：指定会话历史 15 页和同进程 tail 完整结束，重启后没有重复消息；正式新增来信已自动增量入库，后续复扫无重复。全联系人继续补齐，未知状态仍使历史保持不完整，不能宣称所有本机消息已受信任读取。
5. 真实删除链（第 9 条后半）：需先有真实捕获与来源，传递依赖第 1 项；`contact_history` 精确截断属 06，来源列表 GET 属 20，不在本票扩大范围。
6. 语音／视频类型元数据：需另一个包含该类型消息的已授权私聊快照；同一对象重跑不会产生新观察。
7. App／制品：正常 `pnpm run dev` 已验证持久化、读回、同进程 tail、新进程恢复及受控新增来信自动入库。没有运行或宣称打包制品通过。

### 2026-10-30 日常续读实现与后续实机收尾

- 最终开发 CLI SHA-256：`9a9712f15f775761b02c7e0dba9807cf5eaa3887f89de4b769a0df4c88325eb5`。正式构建、严格签名和 overlay 一致性核验均通过；manifest 保持开发制品，不宣称发布版验收。
- 修复 APFS 目录条目计数随 SQLite 旁车增减导致的误停，以及 `kevent` 被线程信号以 `EINTR` 中断导致的误停。目录写入仅触发数据库名单与实例复核；等待中断后重试，其余错误、文件替换、分片增减与进程变化仍停读。真实线程信号隔离复现修复前首次即误停，修复后连续 100 次通过。最终原生 race：222 pass、1 skip（未提供安装程序版本环境），真实 WCDB 旁车生命周期已执行。
- 旧来源标识曾混入目录条目计数。本机一次性升级先只读核对新旧账号元数据文件及分片／表实例：240 个既有读取范围一致，45 个无目标和消息的空范围重新初始化。保留 19,927 条既有消息及全部捕获，不改消息 ID 和原始来源；增加同一物理来源的稳定身份别名。升级已先在数据库副本演练并备份；当时来源排除和清空边界均为空。此记录只覆盖本机开发状态修复，不提供通用备份恢复保证。
- 获准恢复的旧误报及后续复现的信号误报，均在精确 metadata-only 重验后清除；正式读取仍重新取得守卫并完整重扫。最终读取器的运行观察未产生新来源围栏。App 重启后指定会话仍为相同的 117 个消息 ID，旧指定文字可经正式消息 HTTP 读回；15 页历史后交接独立增量。未知旧行保持历史不完整，不阻止已核验新消息续读。
- 正常 `pnpm run dev` 已开启 285 个现有授权会话，历史补齐过程已超过 33,000 条文字，非最终全量数字；未知状态不读正文。暂停和能力未就绪分别显示，不再误称功能未开放。重复历史读取不会复活已经交接关闭的快照。
- 后端相关组 187/187；最后服务边界修复后最小相关组 115/115；桌面相关组 22/22，两端 TypeScript 检查通过。该阶段新增来信当时待验，随后完成，见下节。复用已确认撤回证据，不发送外部消息，不调用模型。

### 2026-10-30 正式新增来信验收完成

- 准备时经正式只读 API 核对唯一已授权私聊、活守卫和增量检查点，基线为 117 个消息 ID、75 页已接受增量；已存在的同文字消息单独记入基线，防止将旧消息误认作新来信。基线只保存身份与检查点，不保存其他正文。
- 用户随后让该联系人发送一条指定文字。正式消息 API 返回唯一新增记录，消息数从 117 增为 118；最早规范来源属于 `incremental` 目标，捕获发生在准备之后，发送方为 `contact`、原始类型 `1`、状态 `3`、`messageState=received`、`stateAssurance=verified`。没有用手动历史同步导入该测试消息，没有由开发 Agent 发送、回复或撤回消息。
- 按渠道秒级消息时间与首个正式捕获时间计算，本次入库约 36.7 秒；此数值是单次观测，不是延迟保证。之后增量页数由 90 推进至 105，新增匹配内部消息仍为 1，规范来源仍为 1，没有重复入库，且该会话没有来源围栏。
- Computer Use 刷新实际开发 App，指定联系人目录及详情均显示 118 条。由此完成“正式运行后新增文字自动增量入库及后续复扫去重”的剩余验收。旧状态未核验、未测试媒体语义及 ADR-127 原位回滚排除继续有效，不因本次结果扩张。
- 本次仅补充文档验收记录，复用已通过的产品代码检查；只读复核和实际 App 刷新不触发模型，不修改微信原数据。私有诊断及身份基线留在本机临时目录，不提交正文、账号或联系人标识。

### 较早合并审计的数据影响与资源清理

该轮改动只有本验证文档与票内追加评论，无产品代码、schema、支持档或配置变更；未启动实际 App／监督器／受控观察器／模型；未读取真实微信正文、名单或媒体，未发送或撤回消息；未改迁移／恢复。分支仅本地，未 push、未建 PR。临时产物仅为 `/tmp` 下的测试日志与被终止测试进程的子进程，测试夹具在用例内自清理；未发现遗留 `notalone-dsh-host-*` 目录或本票自有进程。


### 2026-10-30 剩余五个会话与全范围历史收尾

> 阶段说明：18:26的历史遍历快照通过后曾出现worker_failed，当时保持claimed。后续独立修复排队预算，并由安全诊断定位大联系人状态查询瓶颈；最终修复及完成结果见本文末节。最早无诊断的故障不追认为已完整归因。

用户要求补齐剩余五个会话后再完结。此前功能和指定新增来信验收不代表全部历史都已遍历。本轮在正常 `pnpm run dev` 实例完成核验，未运行打包版。

| 原剩余项 | 最终历史页数 | 完成分片 | 已保存文字 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 1：快照提前关闭 | 984 | 7/7 | 6,466 | 遍历结束，未核验状态继续隔离 |
| 2：单轮页预算耗尽 | 1,844 | 6/6 | 12,285 | 跨过1,000页预算自动接续并结束 |
| 3：展示名包含控制字符 | 1 | 1/1 | 0 | 按稳定渠道身份读取；未核验状态继续隔离 |
| 4：快照提前关闭 | 1,255 | 2/2 | 7,906 | 跨预算自动接续并结束 |
| 5：全部分片缺少目标表 | 1 | 8/8 | 0 | 固定共同快照证明全部缺表，空终页正式接受 |

- 2026-10-30 18:26（本地时间）逐个通过正式历史API，再核对最新目标、当前运行代次活守卫、最终制品和来源围栏：285/285个已授权会话均完成物理遍历，285个活守卫，0个来源围栏；总开关开启，正文能力可用，正常保存61,388条文字、0条非文字占位。本轮未删除或重建业务资料、解除排除或手改读取目标。全范围复查出现过一次瞬时原生超时，经正常已开启入口重新唤醒后完成，读取代次未改变。
- 物理遍历与状态语义认证分开：284个会话仍有未核验状态，继续显示“部分历史尚未核验”并隔离，不能将上述数字解释为微信所有状态的正文均已导入；1个空范围为正常完整。空会话未来出现新表须重新核验，本轮未认证其自动增量提升。其他设备缺失历史、媒体、未知状态及同标识原位还原仍不在已通过范围。
- Computer Use在实际App核对空会话显示“当前范围内暂无可读历史”，并准确提示新消息需重新核验；选择大历史会话后，显示12,285条已保存文字及未核验状态隔离提示。未发送外部消息或调用模型。

实现与证据：

- 原生快照改为两分钟空闲租约，只有成功的有界非终页读取续期，支持或目标查询不续期。关闭、空闲过期、来源变化和原生页数限制仍有效。历史1,000页、增量200页单轮预算保留，有进度的接续优先于未打开的会话；没有进度不空转，并发仍为2。
- 缺表支持档 `wechat-4.0.6-29387-absent-private-target-v1` 只接受固定版本及全部已检查分片的完整缺表证明，要求命名空间、实例、共同无提交窗口与固定读者核验。目标表、主键和消息数组保持JSON空数组，空终页关闭后不遗留已关闭快照；不假称支持增量。真实窄客户端support→target→page→support链通过，8/8分片、0记录、无resumeCursor。
- 最终CLI SHA-256：`f8ca1697f5b00aa72fcfbcc3944d570511e79150ac5ffbf4c8145ec97b74afce`；overlay：`cf8ba298da34a5cbb7f5a565eddd72d00a71810c6dbe808446eb33597646fac4`；manifest：`e1786b8ecbe1e49352885727cbce2d546b5a590e5bd2c4b1afd42933c0535431`。官方构建、严格签名及逐文件overlay一致性通过，保持开发制品标记。
- 同一285联系人覆盖工作负载14,159→2,029毫秒；页数查询增加contact_id并使用已有索引，284个既有历史目标的新旧计数零差异。未更换计数语义或删除捕获。大库完整性检查保留，打开预算独立60秒，探针和认证握手75秒，普通动作仍15秒；原库正常重开成功。停读写失败后先使存储失能，真实关闭后才允许重试结算资源。详见[启动记录](../guides/macos-app-permissions-and-errors.md#2026-10-30-历史库增长后的开发启动核验)。
- backend-ts目录执行 `node --test` 的历史/增量/HTTP/守卫/渠道/窄客户端11个相关文件，累计211例通过。首次扩检的两条旧来源删除夹具缺少合成状态认证，补齐显式stateAssurance后2/2复验通过，生产门禁未放宽。另 `node --test test/sqlite-storage.test.mjs` 10/10；desktop目录执行 `node --test tests/sqlite-development.test.mjs tests/backend-startup-budget.test.mjs` 7/7、`node --test tests/incremental-sync-status.test.mjs` 5/5；两端 `pnpm run typecheck` 通过。真实WCDB下 `go test -race -p 2 -run '^TestNot[Aa]lone' -count=1 ./cmd/wechat-cli` 通过。JSON/RPC、预算接续、停读重试与空历史展示均保留red→green证据。
- 独立审查：Standards 0项；Spec 0项，未发现新增规范问题或范围偏离。实现审查不替代本节逐个实机证明。
- 实现本地提交 `bd20e110`。清理本轮无引用中间staging约274MiB，保留当前构建、回滚构建、业务数据库和备份；未推送。公开检查沿用17处既有未跟踪本机路径命中，未新增，不能记作整个工作区公开检查通过。


### 持续运行复验与串行队列预算修复

18:26快照通过后，后续业务API出现worker_failed；当时没有动作开始诊断，实机首因未能确认，不能把合成复现当成该次实机根因。任务继续保持claimed，未据此最终结案。

- 在隔离合成Worker中复现独立缺陷：三个各6秒的同步动作在串行队列等待，旧主线程从发送起计时，于15.16秒误杀合法队列。Worker改为实际执行前发送开始确认，主线程从确认起监督该动作，同一负载18.21秒完成，随后存储检查正常。真正20秒的单动作仍于15.14秒终止，后排动作一并拒绝；没有自动重放或放宽事务、租约和删除资格。
- 新增只读诊断只保留首个固定原因、内部动作名、在途及排队数量，不含输入、SQL、正文、联系人身份或错误文本。正常关闭保持null；诊断动作名仅说明失效时正在执行的动作，不自动解释为已证明根因。认证runtime/status可供本机定位。
- GET全范围状态只共享在途Promise，完成或失败后立即清除，后续查询重新核验，不形成持久缓存或扩大读取权限。真实开发实例并行三个状态请求均200，响应886/878/877毫秒，共享同一快照，正常文字数61,388，总开关和正文能力均开启，存储诊断为null。
- 新时序5例、存储与守卫41例、官方宿主/读取钩子/状态/首次启动18例及两端类型检查通过。追加Standards和Spec代码审查均0项；证据措辞问题已修正。实现本地提交9e551eb0。该阶段仍需全范围重验和持续读取，最终结果见末节。


### 大联系人状态查询故障定位与修复

后续六分钟观察没有通过：诊断明确记录action_timeout、history.clearStatus、pendingCount=6、queuedCount=5。大联系人切换自动查询清空状态时，单动作超过15秒并使Worker失能；这提供了实际触发动作证据。此前缺少诊断的最早worker_failed不追认为已完整归因。

- clear-actions中的消息来源EXISTS只有owner_id与message_id条件，漏contact_id。现有索引为owner_id、contact_id、message_id，旧计划每条消息只能按owner前缀查找，造成重复账号范围扫描。补齐联系人条件后使用完整三列查找，复合外键保证计数语义等价，没有修改删除规则或移除资料。
- 同一个实机元数据目标，修复前30秒仍未返回并有界终止；修复后347.5毫秒返回。独立集合JOIN基准确认12,285条消息、94,752条来源、8个目标计数全部一致。新增合成回归检查实际SQLite执行计划与计数，red→green；相关22例与后台类型检查通过，Standards独立复核0项。旧的“未配置渠道不存在boundarySnapshot方法”断言更新为调用明确拒绝，未放宽生产门禁。
- 本地实现945b38c3。新开发实例早期并行执行两次正式GET清空状态与一次全范围状态请求：清空状态117/222毫秒，计数一致；全范围983毫秒，总开关和正文能力开启，存储诊断null。Computer Use再次切换同一大联系人，资料与消息数正常显示；未调用POST清空接口或删除数据。
- 该修复阶段先保持claimed，随后完成全范围来源重验和交互后的持续读取观察，结果见末节。


### 2026-10-30 最终持续运行与全范围验收

- 19:26:32（本地时间）经正式HTTP逐个核对285个授权会话，再核对最新目标、当前运行代次守卫及制品：285/285完成本机历史物理遍历，285个有效活守卫、285个最终CLI制品证明、0个来源围栏、0个待完成项。原5项仍分别为984、1,844、1、1,255、1页，全部目标分片已完成，历史待续游标均为空，受支持的增量检查点独立保留。正常保存文字为61,389条，非文字占位0条，总开关与正文能力均开启。
- 修复后的实际App再次切换此前会触发失败的大联系人，显示12,285条已保存文字及未核验状态提示；正式清空状态GET在全量重扫后再次200返回，耗时93毫秒，消息12,285、来源124,248，后台诊断null。没有调用POST清空或执行资料删除。
- 19:17:20–19:23:20在同一修复后运行代次完成六分钟持续读取观察：存储诊断始终null、来源围栏0，增量检查点推进2,228页，消息ID集合保持一致。观察期间历史重扫尚在推进，当前守卫从232增加到253；随后19:25:30全范围达到285，再完成上述正式API核验。此记录不把重扫中的观察窗口写成全程285守卫已就绪。
- “遍历结束”与“所有状态正文均可读取”分开。284个会话仍含未核验状态，继续隔离并显示“部分历史尚未核验”，不进入正常正文、记忆或生成；1个空范围通过完整缺表证明。空会话未来新表需重新核验、其他设备缺失历史、媒体、未知状态及同标识原位还原的支持边界均未扩大。
- 03/04在本轮历史补齐及运行稳定性范围内恢复resolved。源代码本地提交bd20e110、9e551eb0、945b38c3，验证和状态记录另作本地提交；没有推送或打包，也没有外部发送或模型调用。既有指定新增来信、撤回、去重与生命周期证据按原范围复用，不要求用户重复发送。

## 正常历史文字补齐与特殊记录修正（2026-10-30，实施中）

用户在收尾后明确要求正常历史文字完整导入、撤回等特殊记录正确处理，并在实机全部验证后才完结。此前19:26的285/285仅证明物理遍历，61,389条文字不代表所有正常文字均已导入。03／04重新保持claimed。

- 当前授权来源按最新完整历史目标及后续增量、精确来源键去重，只读审计发现58,623条待补文字：对方type1/status4为58,364条，本人type1/status3为259条；另31,764条非文字／系统记录。旧认证撤回不计入待补正文。没有为审计查询未知正文。
- 实际微信界面核对本人正常发送气泡及另一位已授权联系人现存的两条正常历史来信，与方向、日期、数量和正服务端标识对应。这只补证当前版本正常文字规则，不解释原始3／4为“已读”，不外推高位类型或其他状态。正式导入后的精确来源与界面文字比对仍待完成。
- 正常文字规则扩为owner/type1/status2／3、contact/type1/status3／4，均要求正服务端标识。非文字元数据独立输出metadataOnly，正文为空且状态语义保持未核验；系统10000不再一概叫撤回，引用／链接等49家族不一概叫文件。未读取XML、引用正文、媒体载荷或触发模型。
- 临时状态隔离可在同绑定、同来源代次／分片／表实例／localId、相同内容并重新认证后恢复同一消息ID；旧捕获不改写，解释版本递增。当时曾按完整扫描确认消失处理旧来源；该规则已由 ADR-128 修订，微信端消失不再撤下已保存消息。撤回、系统替换、用户删除及清空抑制保持，旧冻结输入不因恢复而复活。独立系统元数据单独计数，不混成正常聊天文字或未完成缺口。
- 原生公共snapshot／RPC测试经历红绿验证；全套定向race为240项通过、0失败，1项既有安装版本检查跳过。没有穿透WCDB私有连接安装authorizer：测试证明输出不含非文字载荷，静态SQL检查证明正文查询仅使用已认证文字的精确ID列表，不投影source/XML列。
- 新开发CLI SHA-256为`3dfa2bcbd88e123fd26db4eff64b58bb4ffbdf2d338fc2b4c1d30409ab00d47e`；overlay为`f99aaa6c72b77edb40506068bc8821ce7ea39421b51905a1bc42f45c51b9a94d`；配套WCDB仍为`4f05cafc4626a142afca1818f0a88c4092a13d5f4c83e30cd5125b558ba0417d`。官方锁定构建入口、产物哈希和两项开发签名检查通过；manifest仍标realWechatVerified=false，不宣称发行认证或打包验收。

本节尚未完成实际App全量重扫、逐来源完整性／特殊记录核对及最后界面验收，不能作为本任务完结依据。


## 消息去重接线：正常文字与非文字观察（2026-10-30，实施中）

- 同日先前受控微信界面观察支持本人文字状态 2／3 和对方文字状态 3／4；四种情况均须存在已分配的服务端消息标识。这里不将数字解释为已读，也不推广到其他类型或状态。
- 已识别的非文字只传递无正文类型信息，不凭系统类型或状态推断撤回；无法确认发送方的系统项不作为聊天正文或生成依据。原有同一来源的使用资格保护继续有效。
- 本次开发 CLI 按锁定来源构建，制品与支持档的哈希一致；原生合成检查通过 216 项、跳过 1 项。本记录不代表真实微信全量重扫、App 聊天／清空或发行包验收已经完成。
