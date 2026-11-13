# 13：集成明确范围的方法与Skill反馈

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 12
Source unit: U12 / S源票12
Migration mapping: S067→068 (canonical)

## 交付行为

用户普通反馈先修改当前回复，明确停用则立即作用于指定方法、Skill及范围；更新、合并、回滚和旧任务恢复都保留限制，明确撤销后才恢复。

## 范围与兼容

- 复用S独立政策、policy_revision、方法执行投影及明确撤销，追加canonical068；长期修改仍走待审草稿。
- 正文与资源共同过滤，无法可靠分离时回退通用回复；随本票扩展prepare/继续/重试/恢复和联系人缓存。

## 依赖说明

功能承接11审核，结构实际需要12的复合键和067前缀；Blocked by 12已传递11，不制造原功能11/12之间循环。

## 验收标准

- [x] canonical068承接067的Skill复合键，scope/修订/动作回执与删除验证；未知对象/范围先必要澄清。
- [x] 普通措辞意见只改当前回复；长期调整产生草稿，明确方法/整个Skill停用按owner/contact/scene最小范围生效。
- [x] 实际执行正文和资源都排除停用方法；无法可靠分离时回退通用，不能只加prompt提醒。
- [x] 最终writer、继续、重试、恢复及读取后发生的停用均核政策修订，迟到结果拒绝，用户编辑不被覆盖。
- [x] 跨联系人/场景隔离、祖先合并、版本更新和回滚保持停用；明确撤销才恢复，轮询不重开用户已关闭的面板。
- [x] 公开HTTP/PG、React反馈、联系人A→B→A/隐藏缓存/固定快照与完整政策生命周期回归、两轴审查完成。

## 验证入口

沿用skill feedback、执行投影、旧候选/场景恢复和页面；与12合并/回滚、M2异步准备/后台任务组成实际反例。

实施时读取[规格](../spec.md)、[任务图](../planning.md)、[冻结增量](../refreeze-v2.md)、[验证矩阵](../validation-matrix.md)及[来源签收证据](../acceptance-evidence.md)，再按仓库规则/领域路由读取当前约束。来源源码和原票状态一律用固定S核验，不把准备树内的旧源票状态当成当前交付。

## 执行边界

当前已完成固定候选独立最终双轴复查、集成合并及六项AC签收；历史候选和领取记录按原阶段保留。S分叉库保持原样。完成本票不包含合入main、业务迁移、push/PR或部署。

## Comments

- 2026-10-15：按已确认推荐方案发布；未领取、未执行。

- 2026-10-16：12最终候选 `b2e4bf42e3e1cf118e55da7f232fe1c355820339` 经独立Standards／Spec最终完整及增量复查均0新增／未关闭，原Standards P2 closed；无冲突合入 `1f3f711c0b017e8977d65cf429309c15e0b17511` 并签收 `608dd74786a4c45464d37f389fa721c248c7b96a` 后，领取真实就绪的13。canonical068依赖067提供的Skill复合键，按最小owner／contact／scene范围、独立policy_revision及真实正文／资源执行视图推进，保留普通意见只改当前回复、长期修订走待审与明确撤销才恢复。后续独立工作树实施，本集成根本次只记领取元数据，不写产品、不查询068或新建动态资源；六AC仍空，15继续受13阻塞。冻结M2、S分叉库保留、不合main与不动其他会话边界继续有效。

## Answer

2026-10-16：已在`codex/integration-13`形成候选，固定基线`401c8e8ba663e3e54655e2409c24bad4dcb687fc`；当前仍为`claimed`，六AC保持空，等待根Agent对候选字节独立Standards／Spec审查及后续集成签收。

- canonical068逐字承接固定S067（blob `3f049a3eb788d223eb3baf42b97d31b1069878ab`），旧001–067不变。明确方法／整个Skill及四种范围、CAS／指纹／当前结果重放、实际正文与资源过滤、祖先继承、最终writer及旧输入递归复验已接入；目录仍只读许可元数据。
- 准备格式明确为version2／schema5：新增的是白名单`ReplyBasisChange`的严格`reply_skill/skill_policy_changed`值变体，`SkillExecutionView`没有加入prepared编码。旧running继续沿可靠终态／attempt／租约门处理，封旧键后显式重新准备，保留编辑。
- 实际分轮PG最终绿唯一方法40（25＋6＋2＋7），相关纯组381／381；桌面相关Node82→84及后续严格HTTP原因1／会话3／证据目录1分别绑定各轮字节，初轮npm65／65。第三次有限Chrome完整场景通过；前两次页面失败、夹具失败及恢复原样保留，详见[候选验证](../frontier-13-validation.md)。
- 动态执行已停止，26个实际自有库逐名absence、登记进程与lease已核；未执行App／微信／CLI／视觉或外部模型，未碰业务／S／unknown库，不合main、不push／PR或部署。原未知事故保持未知，未追认关闭。

同日独立审查后追加修复候选：政策POST改为目标身份与完整来源元数据许可，不再借用历史正文载荷；递归旧输入门仅允许真正缺字段且相关修订0的兼容，显式null严格拒绝；所选投影共用同事务helper，保留writer原修订／版本／view门。新增反例red→green及受影响组合共30个不同方法通过（2＋27＋1），与原40交集28／新增2／旧有未重跑12。两次政策夹具准备失败及原null重放500等事实保持原样；新9库精确核销，未重跑页面／381／SDK／npm65。仍为`claimed`、六AC空，等待根Agent对固定修复候选完整及增量双轴复审，不自行签收。


### 最终集成签收

2026-10-16：最终固定候选`3a2ff9b2d7bcb93f48748666d855e13f02b6d2f7`经独立Standards／Spec完整与增量复查，原P2及重复投影判断项均closed，两轴新增／未关闭0；无冲突no-ff合入`762405952efad9f0da5aab56b64e4b84fcf4af09`，tree与候选`54d9d9ab0b685a536648b799281beb4fdf3a08f4`一致。六AC签收，State为resolved，详见[最终复查与分轮边界](../frontier-13-validation.md)。

merger本树typecheck、diff检查、canonical001–068／固定前缀原字节／codec2-schema5及TSV合同均通过，merge后main与HEAD的本地publication均issues0。新绿30只对应2／27／1三轮，与旧40交28、并42；旧页面／381／SDK／npm65未在三个产品模块修复后重跑。新9与旧26合计35个本票known-created按原索引核销，旧unknown不补证。没有新增PG／HTTP／Chrome／App／probe／CLI／模型或租约；真实质量与原生渠道另验。15仍open，未以本票代替最终组合验收；S分叉库保留、不合main及不执行远端操作。
