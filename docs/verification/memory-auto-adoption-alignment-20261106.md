# 记忆自动采纳对齐腾讯方案实现与验收（2026-11-06）

本文只含计数、原因码、改动提交与验证结论，不含联系人姓名、聊天正文或可识别身份。实施规格与离线重放明细见 `.scratch/memory-auto-adoption-alignment/`（`.scratch` 未入库）；仓库外私有副本与账本不在此描述路径。实施依据 [ADR-174](../../architecture/adr/174-align-tencent-uncertainty-degrade-not-intercept.md)。

## 工程完成度

| 步骤 | 内容 | 提交 |
| --- | --- | --- |
| 01 | 独立关系证据覆盖误拦修复（relationCovered）+ 裁决提示补充 | 460fdf5d5 |
| 02 | keep/noop 自动条件对齐（含 skipped_duplicate 留痕） | f0ad57a41 |
| 03 | 前置门槛拦截改降级（alternatives 自由文本放行、事件标注丢弃） | dee12e2f5 |
| 04 | 提取提示对齐腾讯 + 0.5 置信度兜底（low_value_dropped） | 49b7b5f46 |
| 05 | 原因码拆分、处理中/未完成分栏、ADR-174 与现行规格修订 | fefa2e75c |

自动化验证基线（全为合成数据或旧档输出，不消耗模型预算）：

- 裁决链：`sqlite-memory-adjudication-evidence` 13/13（含新增 X 条行为用例），`adjudication*`×4 + `verified-results` + `content-availability` 31/31。
- 采纳路径：`auto-switch` + `auto-profile` + `content-upgrade` 22/22；候选分页/准入/历史 25/28（余 3 条跨文件偶发为存量，单文件运行全绿）。
- 提取链：`extraction-protocol` 13/13、`extraction-flow` 5/5、`policy-version`/`envelope`/`model-rejected`/`quality-regression` 14/14；`dsh-flow` 2/2。
- 桌面：`tsc --noEmit` 通过；`sqlite-memory-management-view` 37/37（含新增「候选按处理状态分组」用例）。
- 离线重放（不调用模型）：RX 副本（03-30 窗口）3 条 `memory_relation_pending` 全部改判自动采纳；3M 副本（run 917f1f6c）9 条（add 6、keep 3，关系均 `independent`）全部改判；其余原因分布不变。计数见 `.scratch/memory-auto-adoption-alignment/evidence/01-relation-coverage-replay.md`。

## R1：同窗口候选按新规则重跑裁决（真实模型、隔离副本）

执行结论（2026-11-06，子 Agent 实测）：**0 次外发，账本 `adjudication-relation-coverage-rerun`（上限 30 次/90 分钟）全额保留**，实测受阻留证后按 `outcome=unknown` 结案——未消费的外发预算不算改善，也不实作假成功：

- `abandon-unknown` 接口返回 `control_conflict`：目标 run 64a04000 无任何裁决族「未知」占位（历史 8 次调用在库中为「失败」而非「未知」），该入口按设计不适用。
- `continue` 接口返回 `no_pending_history`：HEAD 含步骤 04 的提取提示改动，源链 sourceStamp 已变；101/101 提取目标全部完成后 run 无法推进控制修订，领取候选的 intentRevision 条件全部跳过。
- 因此「存量候选在产品边界内重裁决」需要产品层支持（超出本规格不新增后台能力的前提），R1 的带入模型调用无法按假设发生。
- 离线重放（只读、不调用模型）作为 R1 的替代性计数证据成立：12 条存档 `memory_relation_pending`（RX 3 条、3M 9 条）按新规则全部改判为自动采纳，其余原因分布不变；这是无外发的最强可得证据。
- R1 账本规模、绑定核验（DSH host 进程 OS env 含 `NOTALONE_PROBLEM_BUDGET/ROUND`、provider 同进程安装、账本 0600/父目录 0700）完成；完整记录在子 Agent 证据文件 `evidence-r1.md`（仓库外）。

## R2：同窗口重提取（真实模型、新隔离副本）

执行结论（子 Agent，账本 `extraction-prompt-tencent-alignment-r2`，实际外发 **17/20** 次全部成功，绑定行为级证明=三 run 外发数 8+8+1 与账本 used 一致；`outcome=unknown` 结案，剩 3 次随期作废）：

| 指标 | 基线（原 run） | 本轮 | 判定 |
| --- | --- | --- | --- |
| alternatives 非空占比 | 6/18（≈33%） | 0/15 | 达标（显著下降） |
| 候选总数（原始候选） | 22 | 24 | 达标（raw 不降， уничтожен「合并过度砍压」未发生） |
| 真歧义双读保留（两个信号族） | 双读标注在 alternatives | 文本仍在候选（收入族/数字族各≈2 条）但 alternatives 全空、`low_value_dropped`=0、目标 100% 进输入 | 未达成（「合并吸收双读」消除了标注而非保留两读；执行者解释与「局部合并/跨 run 回声」在只读计数下不可区分） |
| 核验拒数不上升 | rejected 4 | rejected 9（未按主体细分） | 未达成（口径不可比待补仪器） |

独立 Agent 复核（仓库外 `verdict-independent.md`）：R1=unknown、R2=unknown；2/4 未达成禁止记 improved，单样本+手术归因混杂+主体细分缺失不足以记 regressed；纯读的离线重放（12 条翻转）认可为工程证据但不可替代真实质量结论；3 条 contact 自动采纳的结构三要素（`adopted` 标记、≥1 引用、`auto/eligible` 版本）满足；主体/说话人正确率抽查因需读正文超出只读边界，如实记为缺口。R2 kept 完整率 62.5% 的口径混入 rejected 上升，最终度量以 raw 候选数（22→24）为准。



## 待用户决策（验证结论后的下一步）

1. **R1 产品缺口**：存量候选按新规则重裁决无产品入口（`decidedWithSameBasis`/intentRevision 硬拦 + 全量提取目标的 run 无 pending 历史）。是否为此开新任务（如「重裁决信任刷新」的产品入口）。
2. **真库重复导入**：窗口每行两份的重复导入是否修复/回滚（窗口级证据一致，全库 294,387 行背景）。
3. **alternatives 全空**：接受「宁缺毋滥」形态还是先迭代提示保留真两读（决定是否以现提示开 R3 整链路预算）。
4. **rejected 细分仪器**：4→9 的上升在缺主体细分仪器时是否先补读层细分再重测。

## 另行发现的资料问题（不在本任务范围）

- 子 Agent 只读盘点 + 独立复核共同证实：真实库中 03-30 窗口的消息在本机某次运行中被重复导入了一倍（窗口 202 行 / 101 个时间戳 / 每戳恰 2 行 / 同戳载荷两两相等；11-05 的基线副本只有 101 行）。副本已做隔离处理（只动副本行），**真实库未做任何修改**。需要用户决策是否修复/回滚，本文不落数据结论。


## 存量与缺口

- 后端存量失败（与本任务无关，已基线对照）：`sqlite-memory-runtime` 2 条（模型装配）、`sqlite-memory-unknown-deletion` 1 条（未知占用）、`sqlite-memory-hybrid-upgrade` 1 条（storage_invalid）、跨文件偶发的 `old-source_stamp`/`跨 memory`/`38升级39` 组合失败。
- 桌面 `npm test` 24/1371 失败（回复冻结策略、偏好、同步优先级、仓库探针等区），与本任务改动文件无交集，疑为环境干扰（待基线复核确认；本任务相关套件全绿）。
- **桌面运行验收缺口**：CUA 助手缺少系统辅助功能授权，本会话未能用 Computer Use 操作真实 App 记忆页；自动化视图测试与类型检查已覆盖分栏与原因文案的渲染行为。授权补齐后按任务 05 工单的桌面验收补执行。

## R2 补充：核验拒绝细分（任务 A）

口径：总拒绝数取 `execution_event(kind=stage_result)` 的 `rejected` 求和（基线 4、R2 三 run 合计 9）；细分取 `kind=verification` 事件，每条候选一行，按 `candidateTraceId` 去重（未发现重试或重用造成的重复）。R2 的 9 条中 2 条在解析阶段即 `structure_rejected`、未进入核验，细分记 unknown。

### verdict

| verdict | 基线 | R2 三 run |
| --- | --- | --- |
| `continue` | 18 | 15 |
| `unverified_rejected` | 3 | 7 |
| `unsupported_rejected` | 1 | 0 |
| 未核验（结构拒绝，unknown） | 0 | 2 |
| 拒绝合计（= `stage_result.rejected` 求和） | 4 | 9 |
| 原始候选数（`candidate_raw`） | 22 | 24 |
| 进入核验的候选数（`verification` 事件） | 22 | 22 |

### issues（拒绝候选主因，互斥）

| issues 主因 | 基线 | R2 三 run |
| --- | --- | --- |
| `subject` | 3 | 5 |
| `meaning` | 1 | 2 |
| `insufficient_evidence` | 0 | 0 |
| 其他 | 0 | 0 |
| 未核验（unknown） | 0 | 2 |

附加 issue 出现次数：基线 `insufficient_evidence` 1；R2 `time` 1、`pragmatics` 1。

### 候选是否由合并产生

| 维度 | 基线 | R2 三 run |
| --- | --- | --- |
| 合并（来源消息 ≥ 2） | 2 | 7 |
| 单句（来源消息 = 1） | 2 | 2 |
| unknown | 0 | 0 |

### 归属

| 归属 | 基线 | R2 三 run |
| --- | --- | --- |
| 联系人（含 shared 归入 contact 1 条） | 3 | 6 |
| 用户本人 | 1 | 3 |
| unknown | 0 | 0 |

### 主体被拒的发送者兜底

| 项 | 基线 | R2 三 run |
| --- | --- | --- |
| 主体被拒（issues 含 `subject`） | 3 | 5 |
| 其中走了发送者兜底（`subject_mentions` 为空且 `resolution=unique_context`） | 0 | 0 |

一句话结论：新增 5 条拒绝中 2 条是未进入核验的解析结构拒绝、3 条是核验拒绝增量（`subject` 2 条、`meaning` 1 条，同时 `unsupported` 由 1 降为 0），5 条全部落在合并候选而单句拒绝数不变，但合并与单句两组拒绝率同时上升、且主体被拒 0 条走发送者兜底（主体提及均为显式），故不能归因于合并或发送者兜底。

## 绑定状态、读取与删除核对（任务 B）

结论 A（设计如此）：被报告为「重复导入」的一位联系人 9436 条消息分属 revoked 与 verified 两个绑定，是 ADR-144 来源重新认证后「旧绑定保留、新绑定重读」的预期存储事实；读取、提取目标、回复上下文、媒体与统计均经当前 verified 绑定过滤（`backend-ts/src/history/sqlite/current-scope.ts:7-21`、`:37-39`，`backend-ts/src/memory/sqlite/runs.ts:145-172`、`:178-181`，`backend-ts/src/reply/sqlite/requests.ts:15-30`，`backend-ts/src/media/sqlite/image-sync-actions.ts:35-40`），不存在按正文搜索消息的路径。

删除闭包覆盖 revoked 绑定（`architecture/current/privacy-deletion.md:118-133`；`backend-ts/src/contacts/sqlite/deletion.ts:55-95`，`backend-ts/src/history/sqlite/deletion.ts:39-107`，`backend-ts/src/history/sqlite/source-deletion.ts:24-42`）。合成夹具（用真实认证流程复刻双绑定结构，纯合成数据）32/32 断言通过：读/提取/覆盖/目录均只计 1 条可见消息；整联系人删除后 message/capture/read_goal/binding_verification 均为 0，两绑定留 revoked 墓碑；单一来源删除同时清除跨绑定两份副本并登记无正文排除。真实库未做任何修改。

附加发现（类 B，仅开发者调试面板）：`backend-ts/src/history/sqlite/recertify-candidates.ts:25`、`:47-53` 按联系人统计 message 行时未按绑定过滤，已完成认证后再被围栏的联系人，「预计需重新读取消息」会显示约两倍（合成验证：面板 2 vs 可见 1）。该入口只在开发模式渲染（ADR-173），不进入读取/提取/删除/模型路径；已另开修复任务。

缺口：媒体在旧的 revoked 绑定下的真实可读性未实测（代码核对通过）；账户级删除与「再次认证产生第三代绑定」的删除闭包未合成实测。

## R3：保留真歧义（提示正反例 + 合成探针 + 同窗口重测）

执行者自身唯一代码改动：`backend-ts/src/memory/extraction/prompts.ts` 在 `relationshipExtractionContract` 与 `alternatives` 描述加入「必须填」「不要填」的合成对照例，并写明「合并只补全细节、不抹平两读」「合并保留主体归属」，另加两个提示结构断言与一个「提示正文参与策略指纹」用例；策略指纹随源码变更（新 run 不复用旧配置）。合成探针与重测均只使用合成句子或隔离副本，真实库未写入。注意：运行期间工作树另有其它会话的未提交改动（`backend-ts/src/history/sqlite/legacy-physical-suppression.ts`、`recertify-actions.ts`，21:12/21:13 修改、21:29:38 提交，不在提取/解析/核验路径），因此 R2→R3 不是严格单变量对照，但两轮目标集与内容等价。

### 合成探针（10 个合成窗口：5 真两读 + 5 细节没说）

| 指标 | 计数 |
| --- | --- |
| 真两读窗口 `alternatives` 非空（原始候选口径） | 3/5（未达方向性 ≥4/5） |
| 真两读窗口 `alternatives` 非空（进入候选口径） | 1/7 |
| 细节没说窗口 `alternatives` 空（原始候选口径） | 5/5 |
| 原始候选 / 进入候选 | 10 / 7 |
| 解析结构拒绝 / 核验拒绝 / 总拒绝 | 0 / 3（unverified 2、unsupported 1）/ 3 |
| issues `subject` / `meaning` | 2 / 1 |
| 真两读仍被当确定事实自动采纳（`alternatives` 为空且 contact/adopted） | 2/5（对象省略型、指代身份型） |
| 外发（账本 used） | 15（extraction 2、verification 2、adjudication 6、relation_verification 5） |

### 同窗口重测（2026-03-30 10:22–10:42，隔离副本，窗口内容与 R2 等价）

| 指标 | 基线（原 run） | R2 | R3 |
| --- | --- | --- | --- |
| `alternatives` 非空（进入候选口径） | 6/18 | 0/15 | 0/10（0%） |
| `alternatives` 非空（原始候选口径） | 7/22 | 1/24 | 2/27（≈7%） |
| 原始候选 / 进入候选 | 22 / 18 | 24 / 15 | 27 / 10 |
| 核验拒绝（`verification` verdict：unverified + unsupported） | 3+1 | 7+0 | 5+0 |
| 解析结构拒绝 | 0 | 2 | 2 |
| `stage_result.rejected` 求和（记录值） | 4 | 9 | 6 |
| 两条真歧义文本（收入族 2 + 数字族 2）`alternatives` 非空 | — | 0/4 | 0/4 |
| 外发（账本 used） | — | 17 | 17 |
| 覆盖 | 101/101 目标 | 101/101（3 run） | 90/101 目标（2 run，受 17 次上限；第 2 run 末个核验未发出、第 3 run 未开始） |

- 本轮按 R2 同口径（进入候选）仍是 0，未满足「>0/15」；按原始候选口径 2/27 高于 R2 的 1/24、低于基线 7/22，但两条非空候选均来自 run2 且都未发布（1 条核验 unverified、1 条所属批次核验未发出），与 R2 两条真歧义信号候选来源零重叠。两条真歧义族的 4 条候选在 R3 无逐字重现（长度与哈希不同），按来源最大重叠 4/4 匹配后 `alternatives` 全空。核验拒绝记录值未高于 R2，但重测覆盖不完整（2 run、90/101 目标），不能按等覆盖比较。另有 run2 `low_value_dropped` 1 条（置信度 0.3）。
- 探针真两读 3/5 未达方向性标准，且其中 2/5 空 `alternatives` 直接被自动采纳为 active 记忆（防泄漏目标未达成）；细节没说 5/5 为空。两轮合计外发 32/32（探针 15、重测 17），其中探针分项超出计划 3 次、重测未完成计划覆盖，均已报告。
- 独立判定（`r3-verifier`，只读复算、未调用模型）：`outcome=unknown`。三项原目标均未达标，不记 improved；未观察到可比退化但覆盖不全不能排除，不记 regressed；置信度：不记 improved 为高、不记 regressed 为中。流程偏差：两轮在独立判定完成前已按 `unknown` 结案（因总量耗尽、无下一轮），影响有限，如实保留。
- 要得到可判定结论还缺：完整等覆盖的同窗口重测（3 run / 101 目标，估计约 26 次外发，需用户另行授权）；更大的真两读探针（≥10 个）并加旧提示对照；等覆盖的核验拒绝细分；干净工作树或精确代码差异清单以排除并发混杂；第二个真实窗口/联系人样本。当前提示改动未验证通过，不得在真库启用；工作树中该提示改动已回滚并保留补丁。

## 桌面验收（任务 E，开发热更新实例）

Computer Use 实测（复用现有 `pnpm run dev` 实例，未打包、未起第二份）：记忆页可达；记忆自动处理为关闭，全程未触发生成；选中联系人后「正式记忆 本页 5 条」与隔离核对的 active=5 一致，但 5/5 显示「当前无可引用版本。」，无「查看来源」、撤销入口不可达；「待确认记忆」「处理中未完成记忆」两栏均未渲染。原因：真库 277 位联系人带 `history_continuity_fence`（`history_source_continuity_unverified`），唯一无围栏联系人的绑定均 `revoked`，读取层来源资格核验失败后正文与候选被丢弃——属既有数据状态（其他任务在处理），不作为本页实现缺陷判据。未点击采纳/拒绝/撤销，未展开聊天正文，真实库未写入。

自动化实测：`desktop` 视图套件 `sqlite-memory-management-view` 37/37 通过（含候选按处理状态分组、`memory_relation_conflict` 文案、来源可达、撤销经合成桥可达且不写真库）；`backend-ts` 的 `sqlite-memory-adjudication-evidence` 13/13 通过（断言 `memory_relation_evidence_incomplete`/`inconsistent`）。两项均运行当前工作树（含并行任务的未提交改动）。

口径说明：任务书里的「范围变化／名单读取失败／绑定读取失败」是前台定位原因码（`binding_scope_changed`／`binding_session_list_failed`／`binding_verification_unavailable`），不在记忆管理页；记忆页的拆分码是 `relation_conflict`／`evidence_incomplete`／`unsupported`／`inconsistent`。

未覆盖：真库上的候选分栏、真实原因码文案、自动采纳记忆的来源与撤销入口无实测证据（源资格阻断）；撤销真实执行未做（会改真实数据）；前台定位三条码的真实故障场景未构造；`test:app` 隔离实例未使用。

## 代码层兜底：易歧义结构且 alternatives 为空（任务 C 级别 3）

R3 独立判定 unknown 且探针中 2/5 真两读空 `alternatives` 仍被自动采纳后，按 followup 第 4 节第 3 级增加确定性兜底。新模块 `backend-ts/src/memory/extraction/ambiguity-guard.ts`（原因码 `memory_ambiguity_unconfirmed`）：只识别两类字面结构（数量词省略单位、指代词无同条所指），仅在 `alternatives` 为空时命中；命中在裁决领取前置门槛（不建裁决步骤、不发起模型调用）、系统自动采纳/发布入口与 `memory.applyAutomaticDecision` 处降级为待确认，不删除候选、不调用模型；用户手动决定不受影响，已有原因码语义不变。

离线验证（0 外发，只读隔离副本）：合成探针真两读空 `alternatives` 捕获 2/2；细节没说误报 0/5（进入候选口径 0/4）；真实窗口进入候选触发 2/43（4.7%），两条均为 R2 已知真歧义信号，已采纳候选命中 0/8，进入候选口径未观察到误伤（原始候选口径 1/73 为已被核验拒绝的边界指代）。测试：新增 `sqlite-memory-ambiguity-guard` 12/12；相关回归 35/35、18/18；`tsc` 通过；`sqlite-memory-candidate-admission` 3 条存量失败在无本改动的 HEAD 同样失败，非回归。

限制与待办：规则在 R3 同源小样本上调参，存在过拟合风险，只做过离线验证、未做真实小批模型验证；界面原因码文案映射位于用户遗留未提交文件 `desktop/src/renderer/SqliteMemoryManagementPanel.tsx`，本次未触碰，新码暂走未知码兜底文案；回滚方式见 `.scratch/memory-auto-adoption-alignment/evidence/07-ambiguity-guard-offline.md`。
