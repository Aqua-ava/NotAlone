# 06 晚到图片补入

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 05

- 缺：spec 决策 5；与 05 的释放逻辑对齐后再做。
- 背景：`memory-simulated-run-20261108/issues/09`。运行建立后才就绪的图片不进当前运行，历史范围的晚到图没有补入机制。
- 范围：图片就绪事件触发该联系人的补图准入，把晚到图登记为新目标，批次有界；`manual` 模式下无调度器，需明确入口或在汇总里提示"仍有 N 张图片未纳入"。
- 约束：一次历史导入只属于一位联系人；不改变已冻结运行的目标集合语义。
- 测试：运行中途到达的图片在下一轮被领取；批次上限；不重复提取已成功项。
- 完成条件：写入 `## Answer`。

## Comments

## Answer

晚图准入工程及正式调度合成验证完成，当前已保存样本图片的HTTP/模型路径和处理卡已核对；真实L2已成功，L3尚未通过，最终收尾待完成，

本地提交045594894、5fd77ca42。图片保存沿现有同联系人changed唤醒，晚图由正式历史调度登记到下一轮，不扩张旧轮冻结集合；已成功目标不重做。manual或调度未运行时，queue.content.image提供有界unadmitted汇总，界面显示“仍有N张图片未纳入”；待确认候选、未知调用、来源和总开关门槛保持。

`node --test test/sqlite-memory-late-image-admission.test.mjs` 1/1，覆盖运行中图片就绪、首轮输入不变、dueHistoryContacts/startHistoryBatch下一轮只领取该图、成功后不重复准入。退休/晚图/schedule16/16、6000条占用/释放增长、桌面36项及类型检查通过。

真实样本14张已保存图片均有成功证明（本轮新处理9张、既有5张，未强制重做成功项）；本轮处理卡由Computer Use核对9图/9图及35文/35文成功。该现场覆盖当前已保存图片的正式路径，不能冒充运行中晚到图片的现场重演，后者证据来自上述真实SQLite合成调度集成。

本issue晚图准入与当前保存图片验收已完成；最后一次L3未通过的质量调查由issue05跟踪，临时接线已校验还原，已结束命令范围/开关核对通过。未扩张微信读取范围，也未宣称完整微信同步端到端验收。

阶段6最终真实结果：图片L1有14/14成功证明（本轮新处理9张、既有5张），真实处理卡9图/9图和35文/35文已通过Computer Use；L2 gen3真实published/succeeded。L3 gen4失败document_contradiction_basis_missing、gen5失败document_profile_unverified；a25dc2a8c修复矛盾引用exact2合同后，用户限定的最后一次gen6仍失败document_profile_unverified，未发布L3。模型调用及预算事实不等于业务核验或发布成功，整体阶段6只能判部分通过。

a25dc2a8c新增8项及既有L3 workspace11项，是实际四文件22项组合中的19项相关绿，不是单独执行19项命令；组合21通过1个旧失败，typecheck通过。另有4个基线失败（3旧裁决reason、1 profile unknown shutdown）已在frozen HEAD与mergeMain930后复现不变，不宣称全suite通过，不因此放宽核验。

最终安全快照：最后一次L3三次调用额度已用尽，同一问题账本累计46次预留/父总上限96；续作stage6-l3-contract执行硬cap46，active0、finally auto0，未新增unknown。全库新增样本调用34次，非样本及无法证明归属计数0；sample unknown0，其他范围原4条unknown不变。14图仍为9新+5既有。不得再发模型、不得放宽guard；任何后续真实复验需要新的明确授权。新round stage6-l3-contract按unchanged结案，旧stage6仅图片目标判improved；最终集成/清理已完成，见下方元数据。

最终集成与清理：main已快进到7d3ab2227，原3项WIP内容SHA完全保留；4份验收TEMP逐项与HEAD校验后还原，controller CAS clean。工作树.env软链接已删、main.env未改，工作树tracked clean，main status仅原3项WIP。backend与desktop typecheck均退出0；最终公开历史扫描覆盖3532 commits/26047 blobs/2061当前files、issues0，diffcheck0。已恢复main普通pnpm run dev（无acceptance/budget/manual/UI临时环境），HTTP与Computer Use均确认总开关关闭，CUA已正常结束。验收私有临时空间仅保留权限600的budget.sqlite，无图片或用户库副本；工具/备份目录、工作树自有.dev/app均清理。不再调用模型。
