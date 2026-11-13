# 03 传输失败分类与有界降级

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 01

- 缺：issue 01 结论；spec 决策 2（降级重试及成本口径）。
- 范围：`backend-ts/src/memory/extraction/model.ts` 的 `providerFailureSnapshot` 增加脱敏传输类别、阶段、耗时、请求字节、图片张数，不存 message/cause 原文；对"未收到 HTTP 响应"的传输失败做不同请求的降级（批次对半拆分至单张；单张用更小规范化版本再试一次），每次单独记账。
- 约束：保持"未知回执不盲重发同一请求"规则（`extraction_recovery`）；调用账本必须能区分每次降级请求。
- 测试：本地 HTTP 假服务在大请求或指定摘要上关闭连接；对半拆分次数上限；账本条数；`sqlite-memory-model-port`、`sqlite-memory-extraction`。
- 完成条件：故障注入下任务可推进，账本无未知调用；写入 `## Answer`。

## Comments

## Answer

失败分类与降级工程、故障注入及真实L1正常路径完成；真实L2已成功，最后一次L3业务核验仍未通过，

本地提交761e30775、ae7d61991、e0a2d8667。失败快照记录脱敏传输类别、阶段、耗时、最终请求UTF-8字节及图片数，不保存message/cause原文。批次按原冻结图片树二分，单图只追加一次更小版本；每次E/V发送各有请求身份与账本，不重置预算。

可降级范围严格限定图片提取/来源核验：未取消、明确终态TRANSPORT，或当前原生请求已观察且首响应头尚未收到的官方终态TIMEOUT。TIMEOUT必须有fetch_started及undici当前请求身份，无headers_received/http_status；非原生/无观察超时、有HTTP头、取消、缺少终态或预约/结算ACK丢失均保持未知保护。失败账本不伪造HTTP响应、零费用或已确认发送。恢复沿固定槽位复用成功叶；局部准备失败不重新编号；终端回执后降级登记中断先从原账本补计划，不重发父窗。

工程验证：初版传输/dispatch/ledger20/20；降级计划与隔离10/10；调用链26/26；sqlite-image-recovery-resume独立2/2，均在隔离旧c6f98ebed源码实证red。实际Electron Node24.21.0/Undici7.29.1以该运行时执行transport-receipt21/21；源码已核对request:create及request:headers观察接点。后台类型检查通过。

4498fc52b新增本地条件式HTTP集成：正式SQLite提取→正式provider→锁定DSH适配器，仅含指定实际JPEG摘要的请求断连。4图、2图、单图primary三次失败后，单图degraded改变发送摘要而成功，健康兄弟继续；6个不同HTTP请求独立结算（3个终端传输失败、3个成功），无unknown/隔离或父窗重发。`node --test --test-concurrency=1 test/sqlite-image-conditional-http.test.mjs test/model-image-transport-receipt.test.mjs` 22/22通过，guard仅准本轮127.0.0.1合成供应商。

真实样本14张均有成功证明（本轮9、既有5），本轮L1六次新调用已知且结算，sample unknown0；这次正常路径未触发真实服务降级，不能代替上述故障注入。本issue的分类/降级验收已完成；后续L3质量调查见issue05，临时接线已校验还原，已结束运行的范围/总账已核对，先前helper红测和AUTH旧快照已修复。

阶段6最终真实结果：图片L1有14/14成功证明（本轮新处理9张、既有5张），真实处理卡9图/9图和35文/35文已通过Computer Use；L2 gen3真实published/succeeded。L3 gen4失败document_contradiction_basis_missing、gen5失败document_profile_unverified；a25dc2a8c修复矛盾引用exact2合同后，用户限定的最后一次gen6仍失败document_profile_unverified，未发布L3。模型调用及预算事实不等于业务核验或发布成功，整体阶段6只能判部分通过。

a25dc2a8c新增8项及既有L3 workspace11项，是实际四文件22项组合中的19项相关绿，不是单独执行19项命令；组合21通过1个旧失败，typecheck通过。另有4个基线失败（3旧裁决reason、1 profile unknown shutdown）已在frozen HEAD与mergeMain930后复现不变，不宣称全suite通过，不因此放宽核验。

最终安全快照：最后一次L3三次调用额度已用尽，同一问题账本累计46次预留/父总上限96；续作stage6-l3-contract执行硬cap46，active0、finally auto0，未新增unknown。全库新增样本调用34次，非样本及无法证明归属计数0；sample unknown0，其他范围原4条unknown不变。14图仍为9新+5既有。不得再发模型、不得放宽guard；任何后续真实复验需要新的明确授权。新round stage6-l3-contract按unchanged结案，旧stage6仅图片目标判improved；最终集成/清理已完成，见下方元数据。

最终集成与清理：main已快进到7d3ab2227，原3项WIP内容SHA完全保留；4份验收TEMP逐项与HEAD校验后还原，controller CAS clean。工作树.env软链接已删、main.env未改，工作树tracked clean，main status仅原3项WIP。backend与desktop typecheck均退出0；最终公开历史扫描覆盖3532 commits/26047 blobs/2061当前files、issues0，diffcheck0。已恢复main普通pnpm run dev（无acceptance/budget/manual/UI临时环境），HTTP与Computer Use均确认总开关关闭，CUA已正常结束。验收私有临时空间仅保留权限600的budget.sqlite，无图片或用户库副本；工具/备份目录、工作树自有.dev/app均清理。不再调用模型。
