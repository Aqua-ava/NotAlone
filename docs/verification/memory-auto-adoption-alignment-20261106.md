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
