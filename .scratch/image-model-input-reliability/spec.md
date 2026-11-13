# 图片进入记忆提取的可靠性（整体方案）

- 来源：2026-11-11 对验证样本联系人（王威）的 L1/L2/L3 全量试跑与只读排查。本文是通用方案，不针对单个联系人。
- 状态：阶段0根因取证及阶段1–5工程完成；阶段6部分通过：图片14/14成功证明（9本轮新处理、5既有）、真实处理卡与合成隔离重试交互通过、L2 gen3真实发布成功。L3 gen4/gen5及修后最后一次gen6均未发布，gen6失败document_profile_unverified。限定续作三次已用尽，账本累计46次预留/父96、执行硬cap46，active0/finally auto0，禁止再调用模型或放宽guard；整体任务不能标全通过。01/02/03/04/06/07已resolved，05为open/ready-for-agent；最终集成与临时资源清理已完成，源码为7d3ab2227；L3质量未通过的事实不变。
- 目标：任何联系人已保存的图片都能可靠进入记忆提取；失败可被隔离、可见、可恢复；一张坏图不拖死整批、整个任务和后续 L2/L3。

## 1. 已查实的事实

下表记录整改前现场，现行工程结果分别见issues的Answer；不得将下表旧缺陷误写为当前仍未实现。

| 现象 | 证据 |
| --- | --- |
| 14 张图均已保存可显示，PNG，0.02～2.06MB，合计 13.7MB | 本机库 `media_file` |
| 一次 8 张（约 10.7MB 原图，base64 约 14.3M 字符）失败 | `model_failure`：`providerCode=TRANSPORT`，无 HTTP 状态，`will_retry=false` |
| 3 张一批：6.66M 字符成功，5.68M 字符失败 | 不是简单的体积阈值 |
| 降到每批 1 张后第 4 张成功；单张 1280×1706、2.04MB（base64 2.72M 字符）连续 7 次以上失败，跨 3 次后台重启 | 稳定复现，不是偶发 |
| 仅捕获到一次底层错误：`fetch failed / UND_ERR_SOCKET / other side closed`，请求体只有 610 字符 | 来自严格核验通道，不能确认就是图片失败那一次，只算旁证 |
| TRANSPORT 由 DSH 库映射（`@deepseek-ai/dsh-llm-deepseek@0.2.1-rc.2`，`lib/index.js:2156`）；业务代码 `providerFailureSnapshot`（`backend-ts/src/memory/extraction/model.ts`）按设计丢弃 message/cause | 现在没有落库的根因信息 |
| 失败后不重试；一个批次失败，整个联系人任务失败，后续目标不再尝试 | `extraction_recovery.will_retry=false`；本目录外的 `memory-simulated-run-20261108/issues/05` |
| 任何运行（含失败、暂停、已过期）分走的消息，之后的历史运行永远不再领取 | `backend-ts/src/memory/sqlite/runs.ts` 的 `current_assigned_items` |
| 联系人名下只要有暂停或失败的运行，L2/L3 不执行 | `backend-ts/src/memory/sqlite/documents/later-schedule.ts` 的 `scopeBlocked` |
| 运行建立后才就绪的图片不进当前运行，且无补入机制 | `memory-simulated-run-20261108/issues/09` |
| 批次预算写死 8 张／32MiB，只按原图字节估算 | `backend-ts/src/memory/sqlite/content.ts:46` |

更正：试跑中第一批 3 张图的模型输出里**有**记忆文本，核验为 supported，只是任务后来失败，结果未落库；不能说"没有产生候选"。阶段0现已实证根因：本地两次PNG重编码使发送版本超过官方2MiB预算，普通错误被包装为TRANSPORT，发生在HTTP前；详见issue01。直接HTTP对照成功不能代替正式提取验收。

## 2. 已确认决策（2026-11-11 用户执行指令）

1. 允许仅在内存生成规范化版本，参数依据阶段0；来源仍用原file_id/sha256。
2. 允许批次二分直至单张，单张更小版本一次；每个不同请求独立记账，未知回执不盲重发同请求。
3. 单图降级仍失败隔离并继续，原因media_model_input_unavailable；连续同类失败有上限。
4. 允许产品逻辑迁移/退休过期暂停轮；先核对无未知调用，不手改用户库。
5. 待确认门槛保持；仅已失败/已退休且释放占用的轮次不再contact_busy。
6. 不增加正式单联系人入口；真实验收用既有HTTP路由，临时代码用后还原。

补充执行授权：用户已同意独立工作树并行推进；真实验收使用同一问题总账累计96次、120分钟，保留阶段0已用8次，不新建/清零账本。阶段6发送前仍核对实际剩余额度、期限、样本范围及总开关，文档记录不替代发送门禁。

原120分钟及后续唯一30分钟续作均按同一ledger记录，不清零次数。最终累计46次预留=阶段0保留8+合成4+样本34（L1新增6、裁决16、L2三次、三轮L3九次）。parent96不变；stage6-l3-contract执行硬cap46，限定三次额外调用已全部使用，active0、finally auto0。不得再发模型，不放宽guard；后续真实质量复验须新的明确授权。

## 3. 阶段

阶段 0 先做，其结论决定阶段 1 参数；阶段 4 与 1～3 独立，可并行；阶段 5 与统一诊断日志合并。

### 阶段 0：复现与取证（不改产品代码）→ issue 01
离线脚本，用官方 DSH 客户端或等价请求，对同一张失败图对照：原图 PNG、转 JPEG（质量 85）、长边缩到 1536 / 1024、同一请求带 1/2/3 张。记录是否 TRANSPORT、失败耗时（立即断开或久等）、底层 cause；另验证 keep-alive 假设（复用已被服务端关闭的连接）。该指定单图范围已获授权并完成，根因定为本地编码后体积触发，数据与版本依据见issue01。

### 阶段 1：模型输入图片规范化 → issue 02
在 `backend-ts/src/memory/content/image.ts` 的 `prepare()` 发送前转成"模型输入版本"：限长边、必要时重编码、限单张字节。数值由阶段 0 实测定。只在内存生成，不保存（ADR-170 不存缩略图）；引用依据仍记原图 `file_id` 与 `sha256`，运行追踪另记实际发送版本的宽高、格式、字节。批次预算改按规范化后字节算，把 `content.ts:46` 的 8 张／32MiB 收敛为同一处常量。需新增 ADR，同步 `architecture/current/memory-processing.md`（第 9 行相关表述）。注意 `architecture/` 被 git 忽略，改动不进提交，汇报时说明。

### 阶段 2：失败分类与有界降级 → issue 03
`model_failure` 增加脱敏传输类别（socket 关闭、重置、超时、TLS、DNS）、阶段（发送前／已发送未收到响应）、耗时、请求字节、图片张数；不存 message/cause 原文。对明确终端TRANSPORT，以及有当前原生请求身份且未收到首响应头的官方终态TIMEOUT，做**不同请求**的降级：批次对半拆分直至单张；单张仍失败再用更小规范化版本试一次；每次单独记账。非原生/无请求观察的超时、有HTTP响应、取消、未知回执或ACK丢失不进入图片降级，保持"未知回执不盲重发"规则。

### 阶段 3：单项隔离 → issue 04
单张图降级后仍失败：标记新原因码（暂定 `media_model_input_unavailable`），任务继续处理其余目标；不得用文字占位冒充图片（ADR-169）；界面处理状态显示"N 张图片未能送入模型"并可稍后重试。同时修复"一个批次失败拖垮整个联系人任务"；设连续同类失败上限（连续 N 次暂停），防止持续烧钱。

### 阶段 4：目标登记与运行生命周期 → issue 05、06
- 释放占用：`current_assigned_items` 只计入仍在进行的运行；失败、放弃、过期的运行释放其占用的消息。
- 退休过期暂停运行：范围代数已变、无法继续（`memory_extraction_scope_stale`）时自动标为已退休，同时放开 L2/L3 的 `scopeBlocked`。需迁移处理既有过期运行，迁移前核对账本无未知调用。
- 开关暂停恢复：`pausedBySwitch` 仅内存，重启即丢；需落库。**先核实**某历史轮是否正是这样暂停，没有证据前不下结论。
- 晚到图片补入：图片就绪事件触发该联系人"补图准入"，把运行建立后才就绪的图登记为新目标，批次有界；现行规则只让后启用的增量消息自动准入。
- 待确认候选／"上一轮未完成"门槛是否阻断补图：见决策 5。

### 阶段 5：可观测性 → issue 07
每次模型调用追踪带：图片 id、原始字节、发送字节、张数、请求总字节、失败类别、耗时，不含内容。接入另一会话的统一诊断日志（commit `57b0c1611`）。

## 4. 测试与验收

- 单元／故障注入：规范化（透明 PNG、超大尺寸、GIF、EXIF 方向、边界字节）；批次预算与降级梯度；单项隔离；本地 HTTP 假服务对大请求或指定摘要关闭连接，复现 `other side closed`。
- 生命周期：晚到图补入；过期运行退休后 L2/L3 解锁。开关暂停落库仅在先查实历史由pausedBySwitch造成后实施；本次无该历史证据，按用户决策未新增持久化，不将其列为已完成改动或未完成实现。
- 回归：`sqlite-image-memory`、`multimodal-memory-flow`、`sqlite-memory-image-eligibility`、`sqlite-memory-content-availability`、`sqlite-memory-model-port`、`sqlite-memory-extraction`、`sqlite-memory-control`，图片删除闭包；按 `scaling-and-data-lifecycle.md` 做增长与删除检查。
- 真实验收（已授权，仍须样本与同一问题总账门禁）：先用同尺寸同体积的合成大图过真实模型，再用真实 14 张。通过标准：每张要么提取成功，要么被隔离并有原因；任务不整体失败；之后 L2/L3 能执行。已记录4次同尺寸近体积合成图正式模型调用；其PNG1280×1706、2,039,224字节（与目标2,043,188字节差0.194%），实体复杂度来自像素而非尾部填充。样本当前14/14图片成功（9张本轮新处理、5张既有成功），隔离0、待处理0、missingTrace0；样本6次新调用已知且结算，unknown0。全库新run输入/贡献/联系人及调用来源的非样本计数均0，其他范围原4条unknown不变；此前已结束命令的finally核对总开关0。原失败图本轮E/V实际发送1134×1512 JPEG207,252B，原sha匹配且success/settled。实际处理卡本轮9图/9图及35文/35文已通过Computer Use核对；真实L2 gen3已published/succeeded；L3 gen4失败document_contradiction_basis_missing、gen5失败document_profile_unverified，两次各三次调用均known，不写作L3通过。重试入口Computer Use已通过合成视图闭环：1隔离→点击→pending1/等待提取，提示/按钮消失、成功0，无真实POST或模型调用，控制器CAS已还原。

追加工程验证：caa7caf05在同次同步扫描复用运行释放资格，真实只读副本readContact 7513→1291ms、scopeBlocked热点6885→42ms，原统计一致；releaseQueries增长3→101修复后恒1，增长2项及退休13项共15项绿。f8163e32d保留manual收尾登记并禁止未启动调度时派发后续，runtime 2项绿。e39bf0930以规范化JPEG像素及原图来源替代旧PNG字节快照，profile相关8项绿。

追加工程验证：97c1690ba修复独立后续文档轮只写run_input却未冻结图片内容身份的问题。L2/L3仅冻结原file_id、sha256、mediaGeneration、格式和原始字节，不准备或上传原始图片；全部内容snapshot在建立运行前复验。新增合成用例实证独立L2/L3成功、文档请求不含图片、当前摘要变更拒绝、正式清图擦除派生文档/追踪/冻结身份，以及snapshot失效不留下preparing半轮。图片生命周期、文档调度、删除、终态及增长组合49项通过；追加半轮用例1项通过；后台typecheck与diff检查通过。这是工程证据，不能写作真实L2/L3验收成功。

4498fc52b补齐条件式本地HTTP故障注入：真实SQLite提取经正式provider和锁定DSH适配器，仅在请求含指定实际JPEG摘要时关闭连接；4图父窗、2图子窗、单图primary依次失败，单图degraded改变摘要后成功，6个不同HTTP请求各自独立结算（3个终端传输失败、3个成功），0unknown、0隔离且父窗不重发。`node --test --test-concurrency=1 test/sqlite-image-conditional-http.test.mjs test/model-image-transport-receipt.test.mjs` 22/22通过；guard只准本轮127.0.0.1供应商，未使用真实模型或用户库。

fa5347005已提交文档来源复核缓存修改：同一只读副本claimScene首写前来源核验到first write boundary为12003→1771ms（并非完整claimScene或整份文档耗时），该段来源SQL4226→267、来源核验耗时10898→879ms；getter阶段队列413ms；增长21/201→恒1，保留10/100记忆池并验证跨动作撤权/删除拒绝；typecheck及45项通过。真实L2已成功；L3最终仍未通过，不据工程或调用次数写为L3发布成功。

阶段6最终验收结论与限制：
- 图片输入与L1部分通过：14/14成功证明（9新、5旧），L1六次新调用known；原失败图E/V1134×1512 JPEG207,252B、原sha匹配。Computer Use真实处理卡9图/9图、35文/35文通过。
- L2 gen3真实published/succeeded；L3 gen4失败document_contradiction_basis_missing、gen5失败document_profile_unverified，exact2修复a25dc2a8c后的最后一次gen6仍失败document_profile_unverified，限定三次模型调用已用尽，未发布L3。调用完成不等于业务核验通过，阶段6只能判部分通过。
- 合成隔离视图的Computer Use重试闭环通过：1隔离→点击→pending1/等待提取、提示/按钮消失、成功0；无真实POST/noModel，CAS临时接线已还原，不冒充样本真实隔离/重新提取。
- 原L1统一日志已滚动，不能补造历史证据；SQLite追踪与账本按现存范围报告。追加真实合成E/V即时导出2call/2image，字段齐/missing0/content0/rejected0/dropped0并清理，只证明当前通道。
- 最终active0、finally auto0；全库新增样本调用34、foreign/unproven0、sample unknown0、其他原4条unknown不变。账本46次预留/父96、执行cap46，授权用尽，不再调用模型或放宽guard。
- 最终4TEMP/.env及开发实例还原、公开历史/工作树检查已完成，详见下文元数据。issue05保守以open/ready-for-agent跟踪L3离线质量调查和未来新授权，01/02/03/04/06/07按对应工程/验收结果resolved。新round以unchanged结案，旧stage6仅图片目标improved；不宣称阶段6整体通过。

## 5. 整改前现场残留及已核对的产品处理结果（未手工改库）

- 验证样本联系人名下失败运行 `d8b8510d`，占 48 条消息（13 张图 + 35 条文字）。
- 图片提取状态 5 张成功、9 张待提取。
- 另有 50 条文字被 11-03 的已过期暂停运行 `c296e552` 占着（`memory_extraction_scope_stale`，无法 continue）。
- 总开关 `memory_auto_processing` 已关；后台处理模式已回 automatic。
产品initialize已将c296e552退休为revoked/released，d8b8510d保持failed且已released；样本unknown=0，其他范围原4条unknown不变。用户随后委托主Agent处理6条人工pending，经Computer Use正常拒绝后pending=0/rejected=6/auto=0，原始资料及44条已采纳记录保留。上述残留释放与候选处理结果独立于已通过的14图L1、L2证据；L3仍未通过。原期限结束核对auto0、sample unknown0、其他unknown4不变、非样本新来源0；用户已明确续时后仅允许最后一次L3/≤3calls，继续复验全部门禁并记录最终快照。

## 6. 拆分建议

- 阶段 0 → 1 → 2 → 3：同一会话（内容与模型调用链）。
- 阶段 4：另一会话（运行生命周期）。
- 阶段 5：并入统一诊断日志。
- 写同一批文件（`runs.ts`、`content.ts`）的会话不要并行。

## 7. 最终集成与清理元数据

最终独立复核：gen6的16条画像核验为15 supported、1 unsupported inference，guard未放宽；3次模型调用全部succeeded/settled、效果占位已释放、active0，所以新round以unchanged结案，未发布L3。当前L2发布7个scene、0个profile。新增样本34次调用均succeeded/settled，foreign/unproven0、sample unknown0、其他原4条unknown不变、auto0；独立只读副本已删除。

最终集成与清理：main已快进到7d3ab2227，原3项WIP内容SHA完全保留；4份验收TEMP逐项与HEAD校验后还原，controller CAS clean。工作树.env软链接已删、main.env未改，工作树tracked clean，main status仅原3项WIP。backend与desktop typecheck均退出0；最终公开历史扫描覆盖3532 commits/26047 blobs/2061当前files、issues0，diffcheck0。已恢复main普通pnpm run dev（无acceptance/budget/manual/UI临时环境），HTTP与Computer Use均确认总开关关闭，CUA已正常结束。验收私有临时空间仅保留权限600的budget.sqlite，无图片或用户库副本；工具/备份目录、工作树自有.dev/app均清理。不再调用模型。
