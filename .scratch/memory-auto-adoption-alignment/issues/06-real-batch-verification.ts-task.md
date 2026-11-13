# 06 同窗口重跑、独立判定与验收记录

Triage: ready-for-human
State: resolved
Blocked by: 01, 02, 03, 04, 05

按 spec.md 第 2、8 节实施；用户已授权预算与方案（沿用「新预算、仅隔离副本、独立 Agent 判定」，质量诊断工作流的账本工具）。

- R1（约 30 次）：01–03 落地后，同一批 18 个已存候选在现有副本重跑裁决（放弃未知并重试）；假设：待确认显著下降。
- R2（约 16–20 次）：04 落地后，prepare-rx.sh 新建副本，同窗口重提取；假设：alternatives 非空占比下降且真歧义保留。R1 与 R2 不并行。
- 每轮先记问题 ID、唯一改动、预期信号、对照基线；账本放仓库外 0700 私有目录。R3 可选（未授权）。
- 判定指标见 spec 8.3；验收记录写 docs/verification/…，只含计数与原因码。

## Comments

- 子 Agent 已按新账本（R1 `adjudication-relation-coverage-rerun` ≤30 次、R2 `extraction-prompt-tencent-alignment-r2` ≤20 次）启动 R1/R2，执行中（2026-11-06）。
- 桌面 Computer Use 运行验收受阻：CUA 助手缺少系统辅助功能授权（需用户在 系统设置→隐私与安全性→辅助功能 授予 ZCode Computer Use.app 后重开）。自动化视图测试与类型检查已覆盖本任务的界面行为（37/37），真实 App 里的人工例行为验收缺口，留待权限补齐后执行。

## Answer（2026-11-06）

独立判定与执行报告已完成（仓库外 verdict-independent.md / evidence-r1.md / evidence-r2.md）：

- R1 outcome=unknown：0 外发（30 次额度保留）；三触发入口实测不可用（无未知占位、sourceStamp 失配且全量完成无法推进）；离线重放 12 条翻转认可为工程证据；结论=「存量候选按新规则重裁决」缺产品入口，属待用户决策。
- R2 outcome=unknown：17/20 次外发全部成功；alternatives 非空 6/18→0/15 达标、raw 候选 22→24 达标；真歧义双读未保留（文本仍在、标注为空、非阈值丢弃）与 rejected 4→9（主体未细分）未达标；禁止 improved、单样本与手术归因混杂不足以 regressed。
- 真库重复导入经独立复核坐实（窗口 202 行/101 时间戳/每戳 2 行/载荷两两相等；11-05 基线为 101 行），真实库未动，待用户决策。
- 验收记录 docs/verification/memory-auto-adoption-alignment-20261106.md 已提交，含待用户决策四项。
- 桌面 Computer Use 运行验收缺口：CUA 助手缺辅助功能授权，待用户授予后补做。
