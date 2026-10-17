# 封闭 E2 全140评测执行身份

Triage: ready-for-agent
State: open

> 2026-10-17 状态登记：合同、离线验证与公开入口已在 `ac194de2` 落盘并随 main 收敛；真实执行尚未开始。须先完成前置验收与独立审查，再以集成后的实际源码重新 prepare／freeze、领取独立新 run；完成或闭账后改 resolved。本文件作为该次真实执行的跟踪票，不认证任何已完成质量。

本次只新增 `full140-grounded-v2-source-v2-v-off-forced` 评测身份，复用现有全140 runner、预算、records、RAW→FULL 审核、owned worker 和 `Full140V4Deadline`（名称沿用，280次及墙钟控制不变）。不修改产品或协议。旧 v4 身份不接受本次参数。

- 固定官方 DeepSeek Flash，原140窗及原顺序，source-fidelity-v2 Gold，E grounded-v2、V legacy-v4、双方默认提示；reference 主16与补3各自报告，不合并替代其他维度。
- E thinking enabled / effort max / tool choice omitted；V thinking disabled / effort none / named forced。这是评测配置，区别于业务双方 high enabled 默认。
- 新 run、cap280（E最多140、V最多140）、零重试；不续跑、不借余额、不接受子集。prepare 不建 ledger、不读凭据；执行时沿原全新领取与独占核验。
- 外围86400秒、内部86380秒、单 HTTP whole600秒、SDK read300秒，沿用现有全140进程与退出规则。
- prepare/freeze/validate、provider 最终请求体、records、phased audit、offline runtime、owned claim 与公开薄入口都必须识别精确新身份；任一固定参数、提示/schema、来源、顺序或旧身份借用在凭据前拒绝。

验证只使用公开合成资料、临时 home、精确 httpx.MockTransport 与实际 SDK。不得发送真实 HTTP、建立真实 ledger、读取凭据、DB、桌面或私有资料；不证明记忆质量、不关闭原07、不挪用核心新56授权。

运行仍依赖现有 `desktop/artifacts/grounded-public21-prepare-20261015/grounded_public21.py` 与 `explicit_review_bridge.py`。两文件虽被 Git 忽略，必须实际存在并逐字节冻结；HEAD 不能替代文件摘要。本次仅复制已有公开 helper 作本地验证，不新增第二套快照或提交 ignored 产物。新 wrapper、共享 runner、新合同源码及这两份 helper 均在 `_FULL140_E2_REQUIRED_SOURCES` 中，worker 领取前和 provider 发送前重新核验。

入口 read 参数固定为整数300，沿原执行器规范化后 manifest 的 `timeout` 为300.0。`summary.dimensions` 保留原 matcher 口径；新 `reference_cohorts.main16/supplement3` 各自记录原运行位置、Gold 位置、原 matcher 与独立 `semantic_audit`。两种口径不能混签，19窗也不补足其他维度。

本地验证已完成：固定身份拒绝的 SDK 红灯、分组报告缺口红灯、records 七项元数据变异红灯，随后对应 green。完整合成 SDK 控制覆盖140E+138V=278/280、所有140次 RAW→FULL、零重试、关闭后拒绝续跑、默认提示漂移、旧身份互借，以及公开克隆中 entry/contract/两 helper 的真实字节漂移。后者均在预算领取、凭据或发送前拒绝。旧两种全140身份的固定配置字节、140份输入/提示/schema合同及来源路径集合与基线 `4fe1cf9526b903e127b9baa2e00bd8a21242a8f9` 相等。

后续真实执行须等待主 Agent 完成前置验收与独立审查，再以集成后的实际源码重新 prepare/freeze，领取独立新 run；此实现与本地 Mock 不构成真实质量验收。
