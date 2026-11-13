# 04 单项隔离：一张图失败不拖垮整个任务

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 03

- 缺：spec 决策 3（隔离继续还是整任务失败）。
- 范围：降级后仍失败的图片标记 `media_model_input_unavailable`（暂定），任务继续处理其余目标；处理状态显示"N 张图片未能送入模型"，可稍后重试；设连续同类失败上限（连续 N 次暂停），防止持续烧钱。关联 `memory-simulated-run-20261108/issues/05`。
- 约束：不得用文字占位冒充图片（ADR-169）；隔离项保留来源与删除路径，删除联系人／图片时一并清理。
- 测试：混入一张必失败的图，其余目标全部完成、任务 completed；重试入口；删除闭包。
- 完成条件：写入 `## Answer`。

## Comments

## Answer

隔离工程及合成故障验证完成，真实L1和实际处理卡已核对；隔离重试Computer Use闭环已通过，最后一次真实L3已知失败，

本地提交5fd77ca42、ae7d61991。局部读取/规范化不可用或单图降级耗尽，以media_model_input_unavailable记录原file_id/sha256和来源依赖；processing_item标失败、隔离单列，不冒充成功。读取失败后复验冻结授权和来源，删除/换图/撤销仍按失效合同阻断；其他目标及适用L2/L3可继续，连续三次同类隔离持久暂停。

当前轮与旧轮均有有界显式图片重试，使用控制版本和幂等身份，复验总开关、候选、未知账本、活动租约和来源；保留原成功步骤并继续本人贡献。界面中文显示隔离数和“稍后重试图片”，关闭总开关时禁用，不增加普通单联系人运行入口。

工程验证：隔离调用链21/21；持久隔离9/9、控制33/33、桌面桥/界面36/36；有效PNG生命周期17/17覆盖在途清图/换图、未知不重发和完整删除闭包；独立审查后的恢复、本人贡献、旧轮重试、增长及控制/删除/提取47项通过，后台与桌面类型检查通过。新增图片后续文档冻结/摘要复验/删除闭包等相关组合49项及半轮拒绝1项通过，均为合成资料。

真实样本14/14有成功证明（本轮9、既有5），隔离0、pending0、missingTrace0，未整体失败；本轮L1六次新调用已知结算，sample unknown0。Computer Use已核对真实处理卡9图/9图和35文/35文成功。Computer Use在临时隔离视图中实际完成重试交互：合成1项隔离→点击按钮→pending1/等待提取，隔离提示和按钮消失、成功数保持0；没有真实POST或模型调用，控制器CAS临时接线已还原。该结果验证交互闭环，不冒充样本真实图片曾被隔离或重新提取。

最后一次L3已知失败，后续质量调查见issue05；本issue重试交互已通过，临时接线已校验还原。真实L2与结束时开关/范围审计结果见下。

阶段6最终真实结果：图片L1有14/14成功证明（本轮新处理9张、既有5张），真实处理卡9图/9图和35文/35文已通过Computer Use；L2 gen3真实published/succeeded。L3 gen4失败document_contradiction_basis_missing、gen5失败document_profile_unverified；a25dc2a8c修复矛盾引用exact2合同后，用户限定的最后一次gen6仍失败document_profile_unverified，未发布L3。模型调用及预算事实不等于业务核验或发布成功，整体阶段6只能判部分通过。

a25dc2a8c新增8项及既有L3 workspace11项，是实际四文件22项组合中的19项相关绿，不是单独执行19项命令；组合21通过1个旧失败，typecheck通过。另有4个基线失败（3旧裁决reason、1 profile unknown shutdown）已在frozen HEAD与mergeMain930后复现不变，不宣称全suite通过，不因此放宽核验。

最终安全快照：最后一次L3三次调用额度已用尽，同一问题账本累计46次预留/父总上限96；续作stage6-l3-contract执行硬cap46，active0、finally auto0，未新增unknown。全库新增样本调用34次，非样本及无法证明归属计数0；sample unknown0，其他范围原4条unknown不变。14图仍为9新+5既有。不得再发模型、不得放宽guard；任何后续真实复验需要新的明确授权。新round stage6-l3-contract按unchanged结案，旧stage6仅图片目标判improved；最终集成/清理已完成，见下方元数据。

最终集成与清理：main已快进到7d3ab2227，原3项WIP内容SHA完全保留；4份验收TEMP逐项与HEAD校验后还原，controller CAS clean。工作树.env软链接已删、main.env未改，工作树tracked clean，main status仅原3项WIP。backend与desktop typecheck均退出0；最终公开历史扫描覆盖3532 commits/26047 blobs/2061当前files、issues0，diffcheck0。已恢复main普通pnpm run dev（无acceptance/budget/manual/UI临时环境），HTTP与Computer Use均确认总开关关闭，CUA已正常结束。验收私有临时空间仅保留权限600的budget.sqlite，无图片或用户库副本；工具/备份目录、工作树自有.dev/app均清理。不再调用模型。
