# 确定物理约束、旧结构映射与切换验证方案

Triage: ready-for-human
State: claimed
Type: grilling
Map: [SQLite 数据库重建设计决策地图](../map.md)
Blocked by: 08, 09

## Question

如何把已确定的关系模型落为 SQLite 类型、键、外键、CHECK、索引和写入／恢复策略，并建立每个活跃旧功能到新结构的覆盖矩阵？如何验证空库初始化、升级和精确的旧业务清理切换方案？

## 已有输入

- [spec.md](../spec.md)
- [schema-plan.md](../schema-plan.md)
- [data-model-draft.md](../data-model-draft.md)
- [host-storage.ts](../../../backend-ts/src/platform/database/host-storage.ts)
- [schema-prepare.ts](../../../backend-ts/src/platform/database/schema-prepare.ts)

## 完成条件

形成可进入 to-spec 的物理化与覆盖依据、事务和验证接缝、实际切换／清理计划及剩余风险；必要可运行原型另建决策项；此项不实施业务改造或执行真实删库。

## Proposal：先做按需建模审查

用户未认可94表，推荐撤回，Q43暂缓。当前主入口为[逐表审查](../requirements-table-rationale.md)。逐个实体列实际需求、行粒度、独立／合并理由、PK/FK、取舍与状态，不能从旧PG表或消费者反推必须保留。

107逻辑项、3查漏项、2元数据构成112审查对象，不是拟建表数。共享材料仍是未选替代。此前[94表推导](../physical-table-catalog.md)和[覆盖映射](../physical-coverage.md)仅作历史对照。Q36—Q42仍有效；各issue的resolved不代表其中所有物理表获批。

### 共同物理规则

UUID／外部身份／cursor为TEXT，系统时间与版本／代次／金额单位为受约束INTEGER，正文为可擦除TEXT，结构值使用已核验JSON函数且实体关系用真实FK。STRICT、显式NOT NULL、owner/contact条件唯一、完整current-version复合FK及必要延迟NO ACTION；FK不代替查询授权。

共同收敛claim_evidence、claim_required_message、有限kind的Skill操作、唯一model_call_execution、类型化deletion_target和read_exclusion。不可变draft revision已有审核目标集合，review_target沿真实FK派生；Skill和方法祖先图仍分开。质量执行必须有quality_attempt真实分支，不伪造worker。

driver建议当前内嵌node:sqlite，专用存储Worker封装具名短事务；不增加未经核验addon，不在事务等模型／CLI／文件，也不伪造pg.Client兼容池。性能、锁等待配置及完整模块接线仍待实际负载，不把Worker可加载当生产可用。

### Q43与旧结构查漏

Q43暂缓，不能继续要求用户在94／100间选择。旧PG115项仅查漏；诊断、投影及Skill高级学习／审核等须回到真实需求，不能因消费者存在自动保留。

### 实际约束研究探针

[脚本](../../../research/sqlite-constraint-probe.mjs)、[结果](../../../research/sqlite-constraint-results.md)、[JSON](../../../research/sqlite-constraint-results.json)：实际Electron44.7.0 / Node24.21.0 / SQLite3.53.4，纯合成内存与自建临时库11/11组通过，临时目录清理完成。

覆盖STRICT/NULL/复合FK/部分唯一/延迟当前版本/RESTRICT、BigInt、Worker、两连接busy/WAL，以及3种purpose、2种来源的材料归属与合成许可、JSON和WITHOUT ROWID。integrity_check不能代替foreign_key_check，两者分别运行。

不是94表全量DDL／全部材料类型／真实授权测试，也不证明DSH接线、崩溃恢复、真实性能或CLI身份／清空边界；未启动App、接用户库、读私人资料或修改业务代码。

### 切换前置条件

先在隔离库完成结构与接口覆盖、修复CLI稳定身份及精确分界，再集成正式业务模块。新库空初始化不迁旧业务；Skill原目录官方加载、逐项证据接回，不默认全停用、不孤儿误删、不洗审核来源。旧库／副本目标控制账本独立于被drop旧PG；先撤销并排空writer，再精确清理和跨存储复核。配置错误、损坏或版本异常不自动换空库；不额外创建旧PG备份。

任何真实切换仍须按开发热更新规则和已确认范围验证；本项未执行建业务库、迁移、扫描用户目录或删库。精确清空门禁不能以关系模型完成为由跳过。

## 本轮待讨论

- 先审查需求总清单和每张独立必要性，说明合并／不建项。
- 不预设表数；未确认扩展能力不默认进入基础方案，也不视为已获准删现有功能。
- 审查后才讨论Q43和正式schema；完整DDL、源身份／清空adapter和集成验证仍是前置。

## Answer

逻辑草图已收敛于[统一设计](../greenfield-design.md)：74张逻辑表，每表事实/字段/PK/FK/约束/生命周期，另有状态、索引、事务、存储恢复及切换草图。Skill范围仅官方加载与最小业务关联；Q43暂缓。本任务的正式DDL、适配器与集成验证尚未完成，不能把草图完成记为物理实施完成。

## Comments

- 本任务只产生设计决定或事实查证；表数不是硬指标。沿用仓库隐私、手动发送和桌面热更新约束，不读取私人资料，不执行真实删库，不做远端操作。
- 07查证：skill-library.ts:200–207,239–252及skill-cleanup.ts:73–83会清理缺DB引用的隐藏快照／暂存。Q41已按用户修正版确认：保留原目录并继续DSH官方加载，只重建必要业务关联、防止误删，不默认全部停用，仅来源／审核／启用状态无法确认的条目待核验。先禁用空库孤儿清理，核验owner／目录身份和逐项状态证据；不能把缺行当删除授权或将reviewed文件洗成独立包，未知也不冒称停用／启用。本任务尚未执行实际扫描／迁移。
- 08查证门禁：现CLI无法证明精确清空未读历史／同秒新消息分界，必须解决adapter身份、分界、续读失效合同后再验收Q24；不能用时间/max local_id或Q32 raw隔离降格。补read_switch_generation、grant当前唯一性、data_generation/stream_episode检查点及重建contact继承既存渠道边界；普通DELETE不等于页/WAL/副本清除，维护与存储面复核须实测。整库删除账本不得只在被drop旧PG内。
- Q42已确认统一deletion_operation、明确类型的行／文件目标和分面复核；08逻辑决定已resolved。物理化时必须保持各域范围校验、同操作幂等及旧代次限制，不能把统一账本误做无类型target_id或把DB完成当成跨文件原子完成。

## 最新路线修正

用户要求全新设计，94/100/54均非批准方案或目标。当前入口为[从业务事实重新设计](../greenfield-design.md)。上述候选审查保留为过程记录，不再作为新结构起点。先事实、身份、函数依赖和基数，再推导表，最后旧PG查漏；Q43暂缓。

## 2026-10-29 统一收敛稿

最新 Skill 范围已确认：只设计官方加载与最小业务关联。当前唯一入口为[统一设计](../greenfield-design.md)，已整理 74 张逻辑表（68 业务、4 诊断、2 元数据）、逐表字段与键、关系图、生命周期和 115 个旧名称查漏。旧候选结论为历史记录；此稿待整体审阅和 DDL 验证，不代表批准表数或已实现。Q43 继续暂缓。

## 媒体Q11整合（当前状态）

用户已整体确认媒体Q1–Q11。当前主目录共77表（71业务+4诊断+2元数据），含媒体3实体；删除操作已补message_identity和媒体clear/replace范围。旧74表是整合前基础状态，正式DDL/适配/集成仍未执行。
