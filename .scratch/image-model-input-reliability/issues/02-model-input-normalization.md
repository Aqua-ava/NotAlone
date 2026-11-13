# 02 图片模型输入规范化与批次预算收敛

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 01

- 缺：issue 01 的实测结论；spec 决策 1（是否允许发送规范化版本）。
- 范围：`backend-ts/src/memory/content/image.ts` `prepare()` 内存中生成模型输入版本（限长边、重编码、限单张字节）；`backend-ts/src/memory/sqlite/content.ts:46` 的 8 张／32MiB 常量与 `platform/models/model-images.ts` 限制收敛为同一处，并按规范化后字节计预算。
- 约束：不保存规范化图（ADR-170）；引用依据仍记原图 `file_id` 与 `sha256`；追踪另记发送版本宽高、格式、字节；新增 ADR 并同步 `architecture/current/memory-processing.md`（该目录被 git 忽略，汇报时说明）。
- 测试：透明 PNG、超大尺寸、GIF、EXIF 方向、边界字节；预算边界；回归 `sqlite-image-memory`、`multimodal-memory-flow`、`sqlite-memory-content-availability`。
- 完成条件：合成大图与真实图在规范化后能过真实模型；已运行命令与剩余风险写入 `## Answer`。

## Comments

## Answer

规范化工程及真实合成图、样本图片L1验证完成；真实L2已成功发布，最后一次修后L3仍未通过，整体阶段6部分通过，

已实现内存JPEG85、正常长边1536、降级上限1024、单张2MiB硬上限及共享8张/32MiB限制；原图不超过1024时仍实际缩小，无法产生不同更小版本时不发送相同载荷。来源证明绑定原file_id/sha256，实际发送宽高、格式、字节和层级单独追踪；正式适配器保持有界JPEG，消除二次PNG膨胀。组批使用规范化上界，发送前复核最终字节；不保存规范化图片。

本地提交1f8f64704、5fd77ca42、ae7d61991。ADR179、ADR180、现行规格及ADR153/169/170回链位于ignored architecture，不进入提交。

工程验证：初版规范化/预算13/13；补充小图边界8/8；图文集成12/12；后续相关14项覆盖真实合成文件不可读、规范化与来源失效分流；后台类型检查通过。e39bf0930将正式profile旧PNG字节快照修为JPEG格式/尺寸/像素含义及原图来源验证，相关8项通过。

真实验证：合成PNG1280×1706、2,039,224B（距目标2,043,188B差0.194%，像素复杂度而非尾部填充），沿正常E/V模型路径完成，累计两轮4次合成调用。样本14/14有成功图片追踪（本轮9张、既有5张），隔离0、待处理0、missingTrace0；本轮L1六次新调用已知并结算，sample unknown0。原失败图实际发送1134×1512 JPEG207,252B，引用仍匹配原图sha256，E/V均success/settled。Computer Use已核对实际处理卡本轮9图/9图及35文/35文成功，未记录聊天正文。

限制与待补：未开展独立截图小字逐字质量测评；最后一次修后L3仍为document_profile_unverified，后续质量调查由issue05跟踪；临时接线已校验还原，不据L1或合成结果提前宣称整体完成。

阶段6最终真实结果：图片L1有14/14成功证明（本轮新处理9张、既有5张），真实处理卡9图/9图和35文/35文已通过Computer Use；L2 gen3真实published/succeeded。L3 gen4失败document_contradiction_basis_missing、gen5失败document_profile_unverified；a25dc2a8c修复矛盾引用exact2合同后，用户限定的最后一次gen6仍失败document_profile_unverified，未发布L3。模型调用及预算事实不等于业务核验或发布成功，整体阶段6只能判部分通过。

a25dc2a8c新增8项及既有L3 workspace11项，是实际四文件22项组合中的19项相关绿，不是单独执行19项命令；组合21通过1个旧失败，typecheck通过。另有4个基线失败（3旧裁决reason、1 profile unknown shutdown）已在frozen HEAD与mergeMain930后复现不变，不宣称全suite通过，不因此放宽核验。

最终安全快照：最后一次L3三次调用额度已用尽，同一问题账本累计46次预留/父总上限96；续作stage6-l3-contract执行硬cap46，active0、finally auto0，未新增unknown。全库新增样本调用34次，非样本及无法证明归属计数0；sample unknown0，其他范围原4条unknown不变。14图仍为9新+5既有。不得再发模型、不得放宽guard；任何后续真实复验需要新的明确授权。新round stage6-l3-contract按unchanged结案，旧stage6仅图片目标判improved；最终集成/清理已完成，见下方元数据。

最终集成与清理：main已快进到7d3ab2227，原3项WIP内容SHA完全保留；4份验收TEMP逐项与HEAD校验后还原，controller CAS clean。工作树.env软链接已删、main.env未改，工作树tracked clean，main status仅原3项WIP。backend与desktop typecheck均退出0；最终公开历史扫描覆盖3532 commits/26047 blobs/2061当前files、issues0，diffcheck0。已恢复main普通pnpm run dev（无acceptance/budget/manual/UI临时环境），HTTP与Computer Use均确认总开关关闭，CUA已正常结束。验收私有临时空间仅保留权限600的budget.sqlite，无图片或用户库副本；工具/备份目录、工作树自有.dev/app均清理。不再调用模型。
