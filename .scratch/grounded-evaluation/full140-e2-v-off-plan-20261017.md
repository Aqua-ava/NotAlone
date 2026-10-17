# 封闭 E2 全140评测执行身份

Triage: ready-for-human
State: open

> 2026-10-17 状态登记：合同、离线验证与公开入口已在 `ac194de2` 落盘并随 main 收敛；真实执行尚未开始。须先完成前置验收与独立审查，再以集成后的实际源码重新 prepare／freeze、领取独立新 run；完成或闭账后改 resolved。本文件作为该次真实执行的跟踪票，不认证任何已完成质量。

本次只新增 `full140-grounded-v2-source-v2-v-off-forced` 评测身份，复用现有全140 runner、预算、records、RAW→FULL 审核、owned worker 和 `Full140V4Deadline`（名称沿用，280次及墙钟控制不变）。不修改产品或协议。旧 v4 身份不接受本次参数。

- 固定官方 DeepSeek Flash，原140窗及原顺序，source-fidelity-v2 Gold，E grounded-v2、V legacy-v4、双方默认提示；reference 主16与补3各自报告，不合并替代其他维度。
- E thinking enabled / effort max / tool choice omitted；V thinking disabled / effort none / named forced。这是评测配置，区别于业务双方 high enabled 默认。
- 新 run、cap280（E最多140、V最多140）、零重试；不续跑、不借余额、不接受子集。prepare 不建 ledger、不读凭据；执行时沿原全新领取与独占核验。
- 外围86400秒、内部86380秒、单 HTTP whole600秒、SDK read300秒，沿用现有全140进程与退出规则。
- prepare/freeze/validate、provider 最终请求体、records、phased audit、offline runtime、owned claim 与公开薄入口都必须识别精确新身份；任一固定参数、提示/schema、来源、顺序或旧身份借用在凭据前拒绝。

验证只使用公开合成资料、临时 home、精确 httpx.MockTransport 与实际 SDK。不得发送真实 HTTP、建立真实 ledger、读取凭据、DB、桌面或私有资料；不证明记忆质量、不关闭原07、不挪用核心新56授权。

运行依赖已由整合提交 `7df00e80` 调整：改用 tracked 副本 `desktop/tests/fixtures/grounded_public21.py` 与 `desktop/tests/fixtures/explicit_review_bridge.py`，移除对 `desktop/artifacts/` 忽略产物的运行依赖。新 wrapper、共享 runner、新合同源码及这两份副本均在 `_FULL140_E2_REQUIRED_SOURCES` 中逐字节冻结，worker 领取前和 provider 发送前重新核验。原计划中“沿用忽略产物、必须实际存在并逐字节冻结、不新增快照”的要求由该提交取代；旧忽略文件不再参与本身份，也不以 HEAD 摘要替代实际 tracked 文件。

入口 read 参数固定为整数300，沿原执行器规范化后 manifest 的 `timeout` 为300.0。`summary.dimensions` 保留原 matcher 口径；新 `reference_cohorts.main16/supplement3` 各自记录原运行位置、Gold 位置、原 matcher 与独立 `semantic_audit`。两种口径不能混签，19窗也不补足其他维度。

本地验证已完成：固定身份拒绝的 SDK 红灯、分组报告缺口红灯、records 七项元数据变异红灯，随后对应 green。完整合成 SDK 控制覆盖140E+138V=278/280、所有140次 RAW→FULL、零重试、关闭后拒绝续跑、默认提示漂移、旧身份互借，以及公开克隆中 entry/contract/两 helper 的真实字节漂移。后者均在预算领取、凭据或发送前拒绝。旧两种全140身份的固定配置字节、140份输入/提示/schema合同及来源路径集合与基线 `4fe1cf9526b903e127b9baa2e00bd8a21242a8f9` 相等。（2026-10-17 复核：提示合同相等结论不成立，见下节阻塞项。）

后续真实执行须等待主 Agent 完成前置验收与独立审查，再以集成后的实际源码重新 prepare/freeze，领取独立新 run；此实现与本地 Mock 不构成真实质量验收。

## 前置验收与独立审查（2026-10-17）

在集成后 HEAD 重跑离线复核，未调用真实模型、未创建 ledger、未读取凭据：`test_full140_e2_v_off_public.py` 8/8 通过（39.3 秒，含 140E+138V 全 Mock、冻结变异、默认提示漂移、旧身份互借与 helper 字节漂移负控）；E2 相关后端单测／集成 347 项通过（31.6 秒）；11 个改动文件 mypy 无问题。

独立 Standards／Spec 审查发现以下未关闭项，真实执行暂不启动：

1. **阻塞（契约方向）：** `ac194de2` 改写了共享基底 `GROUNDED_PROMPT`，`GROUNDED_V3_PROMPT`／`GROUNDED_V4_PROMPT` 随之变化，相关测试已重签（v3 `3a73…`→`5e83…`，v4 `253d…`→`331b…`；后继 `1a879c6d` 又新增 4 行基底）。这与 [stable-fact spec](../memory-extraction-accuracy/e2-stable-fact-guidance-spec-20261017.md)「原 GROUNDED_PROMPT 作为 v3/v4 派生基底保持字节」、[ADR-051](../../architecture/adr/051-grounded-memory-extraction.md)「原基底与 v3/v4 提示字节保持」、bounded-e2 spec 及本计划上文相等结论矛盾。需决定：把新增指导隔离到 E2 专用提示并恢复 v3/v4 字节，或接受共享基底演进并同步修改规格、ADR 与旧身份基线。
2. **验证缺口：** negative-role-notes spec 要求「全140给定标签逐字段对账，只允许实际命中候选的 alternatives 变化」；现有 140 矩阵只覆盖 v1／v3／v4（[test_e2_field_semantics.py:446](../../backend/tests/unit/memory_extraction/test_e2_field_semantics.py)），E2 编译尚未做同规模对账。
3. **已处理：** helper 来源改 tracked 副本及计划文字已在上文同步；不改变实际身份合同。

第 1 项属范围／契约决定，故本票转 `ready-for-human`；决定后第 2 项及必要的重签／重冻由 agent 继续。完成前不 prepare/freeze、不领取真实 run，也不把本次 Mock 或审查当作质量通过。
