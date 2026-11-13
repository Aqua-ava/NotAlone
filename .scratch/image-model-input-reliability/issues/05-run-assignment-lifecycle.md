# 05 运行占用释放与过期运行退休

Triage: ready-for-agent
State: resolved
Type: task

- 范围：
  1. `backend-ts/src/memory/sqlite/runs.ts` 的 `current_assigned_items` 只计仍在进行的运行；失败、放弃、过期运行释放占用的消息，使其可被后续历史运行领取。
  2. 范围代数变化且无法继续（`memory_extraction_scope_stale`）的暂停运行自动退休，同时放开 `documents/later-schedule.ts` 的 `scopeBlocked`。
  3. 开关暂停状态 `pausedBySwitch` 落库（现仅内存）。**先核实**是否有历史运行确实由此暂停，无证据不下结论。
- 需先确认（spec 决策 4、5）：迁移是否允许退休已有过期运行；待确认候选／"上一轮未完成"门槛是否继续阻断补图。未获确认前只做不涉及迁移的部分，并停在决策点。
- 约束：迁移前核对调用账本无未知调用；不手工改用户库；退休运行保留来源与可删除路径；联系人范围数据始终按 `owner_id + contact_id` 隔离。
- 测试：过期运行退休后 L2/L3 解锁；失败运行释放后可重新领取；开关暂停重启后恢复；`sqlite-memory-control`、`sqlite-sync-retirement` 相关回归。
- 完成条件：写入 `## Answer`。

## Comments

## Answer

占用释放、过期运行退休、L2/L3领取解锁及合成全链路工程验证完成，真实残留运行已由产品逻辑处理。此前整份L3门槛导致的阻塞已按用户新增“逐条核验、合格条目发布”决定整改：2026-11-12最终真实样本L3正式发布15条、拒绝1条新提案，调度成功、运行完成，桌面验收通过，本issue改为resolved。下文保留原模型验收与整改的历史过程，最终状态以下文最新记录为准。

本地提交045594894、ae7d61991、c038cb0d0。runs与schedule-inputs共用物化占用集合；已失败/退休且完整账本、候选和效果占位均释放的运行不再占用目标或contact_busy，later-schedule同步放开安全终态。合法暂停、待确认、在途和未知保护保持。

产品recover每次有界处理128个永久范围失配暂停轮，先核完整调用链、关联后续任务及占位无prepared/sending/unknown或未结算状态，再退休并保留来源、成功步骤和历史；包含owner反馈版本永久失配。无历史证据证明旧轮因pausedBySwitch暂停，依用户规则未新增落库改动或推断归因。未手工修改用户库。

caa7caf05将scopeBlocked释放资格仅在一次同步扫描内按run复用，先筛当前范围任务；同一只读副本readContact7513→1291ms、scopeBlocked6885→42ms，原统计一致；增长3→101次释放资格查询修为恒1。退休13项与增长2项共15/15通过。f8163e32d使manual收尾只持久登记、不在schedulingStarted之前派发全owner后续；runtime2/2通过。已有退休/晚图/schedule16/16、控制/删除/提取47项、6000/6001条目标增长及类型检查通过。

97c1690ba补齐独立后续文档运行的来源内容冻结，保存原图身份但不准备/上传图片；全部snapshot在建立运行前复验，失效不留preparing半轮。图片生命周期、文档调度、删除、终态及增长组合49项通过，追加半轮1项通过。fa5347005已提交文档来源复核缓存修改：同副本claimScene首写前来源核验到first write boundary为12003→1771ms（并非完整claimScene或整份文档耗时），该段来源SQL4226→267、来源核验耗时10898→879ms；getter阶段队列413ms；增长重复查询21/201→恒1，保留10/100记忆池和跨动作撤权/删除拒绝；typecheck及45项绿。工程证据不替代L3真实复验；当前原120分钟已截止。

产品initialize已将c296e552退休为revoked/released，d8b8510d保持failed且released；sample unknown0，其他范围原4条unknown未改。主Agent按用户委托经Computer Use正常拒绝6条人工候选；当次核对pending0/rejected6/auto0，原44条已采纳记录和原始资料保留。随后真实样本14/14图片成功证明（9本轮新处理、5既有），本轮L1六次新调用已知且结算，实际处理卡9图及35文全部成功。

隔离重试Computer Use闭环已通过；最后一次L3仍未通过，临时接线/.env已核对还原。已结束命令核对auto0、sample-only全库审计及其他unknown4不变；不得用L2成功或合成通过代替L3通过。

后续处理建议：State已置open、Triage保持ready-for-agent。该标签按五标签定义表示信息完整、下一步可由Agent做无模型的离线质量调查；先核gen6已有提案/核验拒绝及保存边界，不放宽guard。若需再做真实模型复验，必须先取得新的明确授权，最后一次限额已用尽。生命周期自身的解锁已通过，但不据此将全链路L3发布判通过。生命周期代码完成，整体验收L3未通过按此保守口径保留后续任务。

阶段6最终真实结果：图片L1有14/14成功证明（本轮新处理9张、既有5张），真实处理卡9图/9图和35文/35文已通过Computer Use；L2 gen3真实published/succeeded。L3 gen4失败document_contradiction_basis_missing、gen5失败document_profile_unverified；a25dc2a8c修复矛盾引用exact2合同后，用户限定的最后一次gen6仍失败document_profile_unverified，未发布L3。模型调用及预算事实不等于业务核验或发布成功，整体阶段6只能判部分通过。

a25dc2a8c新增8项及既有L3 workspace11项，是实际四文件22项组合中的19项相关绿，不是单独执行19项命令；组合21通过1个旧失败，typecheck通过。另有4个基线失败（3旧裁决reason、1 profile unknown shutdown）已在frozen HEAD与mergeMain930后复现不变，不宣称全suite通过，不因此放宽核验。

最终安全快照：最后一次L3三次调用额度已用尽，同一问题账本累计46次预留/父总上限96；续作stage6-l3-contract执行硬cap46，active0、finally auto0，未新增unknown。全库新增样本调用34次，非样本及无法证明归属计数0；sample unknown0，其他范围原4条unknown不变。14图仍为9新+5既有。不得再发模型、不得放宽guard；任何后续真实复验需要新的明确授权。新round stage6-l3-contract按unchanged结案，旧stage6仅图片目标判improved；最终集成/清理已完成，见下方元数据。

最终独立复核：gen6的16条画像核验为15 supported、1 unsupported inference，guard未放宽；3次模型调用全部succeeded/settled、效果占位已释放、active0，所以新round以unchanged结案，未发布L3。当前L2发布7个scene、0个profile。新增样本34次调用均succeeded/settled，foreign/unproven0、sample unknown0、其他原4条unknown不变、auto0；独立只读副本已删除。

最终集成与清理：main已快进到7d3ab2227，原3项WIP内容SHA完全保留；4份验收TEMP逐项与HEAD校验后还原，controller CAS clean。工作树.env软链接已删、main.env未改，工作树tracked clean，main status仅原3项WIP。backend与desktop typecheck均退出0；最终公开历史扫描覆盖3532 commits/26047 blobs/2061当前files、issues0，diffcheck0。已恢复main普通pnpm run dev（无acceptance/budget/manual/UI临时环境），HTTP与Computer Use均确认总开关关闭，CUA已正常结束。验收私有临时空间仅保留权限600的budget.sqlite，无图片或用户库副本；工具/备份目录、工作树自有.dev/app均清理。不再调用模型。

2026-11-12用户新增决定：L3逐条核验，支持条目可组成正式版本，不再让一个不支持项阻断全部；此决定替代上文整份guard策略，不降低单条、来源、协议或版本要求。工程整改已提交9ef56ccce/574841932/f5586567b/4ff0680f0/8efa19bb6，详细验证见.scratch/l3-item-publication/spec.md。初次真实显式零模型回放保存15通过/1拒绝，随后publish因15秒超时中断；旧开发实例又因讨论关闭缺陷停读未确认，正常退出未成功。这些曾使任务保留open/ready-for-human，现均已恢复，不再作为未完成项。

最终真实结果：用户明确授权主Agent重启已核实归属的旧开发实例后，新pnpm dev实例经产品startup恢复发布同一个已保存成功attempt，recoveryPath=product_startup_publish_saved_profile，secondReplayRequest=false。同task/run的published=true、profileEntries15、selection=15通过/1拒绝/0保留、schedule=succeeded、run=completed、profile step=succeeded；原attempt1失败记录不改，attempt2成功不改，没有新增attempt。global model_call仍647条、账本行hash及原始6个输入输出包hash与恢复前完全一致，新增模型调用0、auto前后0、onlySample=true、sampleUnknown0、activeCalls0。原索引14的拒绝项未进入正式版本，后续15、16索引未移位。

Computer Use已实际操作王威“长期概览”，核对1篇正式概览、15条通过/1条未通过提示、15条正文依据入口及总开关关闭，正常结束。94相关回归、36项回放/中断、20项发布缓存边界/增长/永久worker失联恢复及19项关闭/删除等工程验证通过，具体命令与范围见新spec。临时HTTP上轮已还原，本轮未安装；http.ts/runtime.ts/.env与HEAD一致，实验用户库未手改、副本已删除，不打包、不推送。State=resolved；本issue、ADR181与新spec位于git忽略目录，不进入提交。工作区其他会话media改动未触碰。
